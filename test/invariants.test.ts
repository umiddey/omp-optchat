import { test } from 'bun:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { AgentMessage } from '@oh-my-pi/pi-agent-core';
import { Memory } from '../src/memory.ts';
import { cachePayload, splitView } from '../src/cache.ts';
import { sequence, compare } from '../src/cache-analysis.ts';
import { preparePrompt, projectContext, providerPayload } from '../src/integration.ts';
const control = { type: 'ephemeral', ttl: '1h' };
const payload = (view: string, question = 'question') => ({ tools: [{ name: 'zoom', cache_control: control }], system: [{ type: 'text', text: 'stable system', cache_control: control }], messages: [{ role: 'user', content: [{ type: 'text', text: '<system-reminder>\nToday: 2026-10-09 cwd fixture\n</system-reminder>' }, { type: 'text', text: view }, { type: 'text', text: '<memories>volatile</memories>' }, { type: 'text', text: question }] }] });
test('I1/I2 three consecutive runs, including a loop with several tool calls', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'optchat-invariants-'));
  const memory = new Memory(dir, async () => 'merged', () => {});
  try {
    for (let i = 0; i < 200; i++) memory.append('note', `decision ${i} ${'remembered detail '.repeat(10)}`);
    await memory.settle(undefined, 'tree');
    let previous: ReturnType<typeof sequence> | undefined;
    for (let run = 0; run < 4; run++) {
      const request = payload(memory.render(), `question ${run}`);
      const first = sequence(cachePayload(structuredClone(request)));
      if (previous) {
        const lastWhole = previous.findLastIndex(b => b.whole);
        const shared = compare(previous, first);
        assert.ok(shared.prefix > lastWhole, 'I2 old whole view is identical'); assert.ok(shared.reusable);
      }
      // Three call/result pairs in the same run. Previous content is never rewritten.
      let old = first;
      for (let call = 0; call < 3; call++) {
        request.messages.push({ role: 'assistant', content: [{ type: 'tool_use', id: `tool-${call}`, name: 'zoom', input: { id: call } }] } as unknown as typeof request.messages[number]);
        request.messages.push({ role: 'user', content: [{ type: 'tool_result', tool_use_id: `tool-${call}`, content: 'result' }] } as unknown as typeof request.messages[number]);
        const next = sequence(cachePayload(structuredClone(request)));
        assert.equal(compare(old, next).prefix, old.length, 'I1 prefix unchanged in tool loop');
        assert.ok(compare(old, next).reusable);
        old = next;
      }
      previous = old;
      memory.append('user', `question ${run}`); memory.append('talk', `answer ${run}`);
      await memory.settle(undefined, 'tree');
    }
  } finally { await memory.close(); rmSync(dir, { recursive: true, force: true }); }
});
test('I3 a >128000-byte batch shrinks to <=64000 and breaks the prefix once', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'optchat-batch-invariant-'));
  const memory = new Memory(dir, async () => 's'.repeat(300), () => {});
  try {
    let previous = '', breaks = 0;
    let previousBlocks: ReturnType<typeof sequence> = [];
    for (let i = 0; i < 435; i++) {
      memory.append('note', `${i} ${'x'.repeat(600)}`); await memory.settle(undefined, 'tree');
      const view = memory.render();
      const blocks = sequence(cachePayload(payload(view)));
      const batch = !!previous && !view.startsWith(previous.slice(0, -'</chat>'.length));
      if (batch) { breaks++; assert.ok(memory.size <= 64000); }
      if (previousBlocks.length) {
        const shared = compare(previousBlocks, blocks);
        const lastWhole = previousBlocks.findLastIndex(b => b.whole);
        if (batch) assert.ok(shared.prefix <= lastWhole, 'only batch rewrites old view blocks');
        else { assert.ok(shared.prefix > lastWhole); if (lastWhole >= 0) assert.ok(shared.reusable); }
      }
      previous = view; previousBlocks = blocks;
    }
    assert.equal(breaks, 1);
  } finally { await memory.close(); rmSync(dir, { recursive: true, force: true }); }
});
test('I4 system bytes static; memories stashed after the view; allowlist preserved', () => {
  let stable: string[] | undefined;
  for (let i = 0; i < 4; i++) {
    const result = preparePrompt(['identity', `<memories>recall ${i}</memories>`, '<project-context>fixed cwd</project-context>']);
    if (stable) assert.deepEqual(result.systemPrompt, stable); stable = result.systemPrompt;
    assert.ok(!stable.join('').includes('<memories>'));
    const notice: AgentMessage = { role: 'custom', customType: 'tool-roster-notice', content: 'fixed delta', display: false, timestamp: 0 };
    const old: AgentMessage = { role: 'user', content: 'OLD SECRET HISTORY', timestamp: 1 };
    const current: AgentMessage = { role: 'user', content: 'new', timestamp: 2 };
    const projected = projectContext([notice, old, current], 2, '<chat>\n</chat>', result.memories);
    assert.equal(projected[0], notice); assert.ok(!JSON.stringify(projected).includes('OLD SECRET HISTORY'));
    assert.ok(JSON.stringify(projected).indexOf('<chat>') < JSON.stringify(projected).indexOf('<memories>'));
  }
});
test('I5 <=4 identical OMP TTL marks, date follows view, no cache object means no marks', () => {
  const view = '<chat>\n' + '0+1|note: remembered\n'.repeat(240) + '</chat>';
  const request = payload(view); cachePayload(request);
  const marks = JSON.stringify(request).match(/cache_control/g) ?? []; assert.equal(marks.length, 4);
  for (const block of [...request.tools, ...request.system, ...request.messages.flatMap(m => m.content)]) if ('cache_control' in block) assert.equal(block.cache_control, control);
  const texts = request.messages[0].content.map(b => b.text);
  assert.equal(texts.slice(0, splitView(view).length).join(''), view); assert.ok(texts[splitView(view).length].startsWith('<system-reminder>\nToday:'));
  const without = { messages: [{ role: 'user', content: [{ type: 'text', text: view }] }] }; cachePayload(without); assert.ok(!JSON.stringify(without).includes('cache_control'));
  const thinking = payload(view); thinking.messages.push({ role: 'assistant', content: [{ type: 'thinking', thinking: 'private' }, { type: 'redacted_thinking', data: 'private' }, { type: 'text', text: '' }] } as unknown as typeof thinking.messages[number]);
  cachePayload(thinking); assert.equal(sequence(thinking).filter(b => b.marked).length, 4);
});
test('the system prompt stays cached when the view has no reusable mark (new profile, huge turn)', () => {
  const lines = (n: number) => '<chat>\n' + Array.from({ length: n }, (_, i) => `${i}+1|note: line ${i}\n`).join('') + '</chat>';
  for (const [before, after] of [[1, 3], [10, 400]]) {
    const first = payload(lines(before), 'q1'), second = payload(lines(after), 'q2');
    cachePayload(first); cachePayload(second);
    const result = compare(sequence(first), sequence(second));
    assert.ok(result.reusable, `${before} -> ${after} lines reuses nothing`);
  }
});
test('I6/I7 inactive and child/advisor contexts prompts payloads untouched', () => {
  const prompts = ['identity', '<memories>recall</memories>'];
  const messages: AgentMessage[] = [{ role: 'user', content: 'original', timestamp: 0 }];
  for (const [active, kind] of [[false, 'main'], [true, 'sub'], [true, 'advisor']] as const) {
    const request = payload('<chat>\n</chat>'), before = structuredClone(request);
    assert.equal(providerPayload(request, active, kind, 'anthropic-messages'), request); assert.deepEqual(request, before);
    assert.equal(preparePrompt(prompts, active, kind).systemPrompt, prompts);
    assert.equal(projectContext(messages, 0, 'view', 'recall', active, kind), messages);
  }
});
