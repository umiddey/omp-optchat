import { test } from 'bun:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { AssistantMessage } from '@oh-my-pi/pi-ai';
import { Memory, CAP } from '../src/memory.ts';
import { logMessage } from '../src/transcript.ts';
import { saveImages, loadImages, imageRef } from '../src/images.ts';
import { projectContext, turnStart } from '../src/integration.ts';
test('logging preserves users, replies, tool JSON and shown custom messages, excludes thinking and hidden custom messages', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'optchat-log-'));
  const m = new Memory(dir, async () => 'summary', () => {});
  try {
    const assistant: AssistantMessage = { role: 'assistant', content: [{ type: 'thinking', thinking: 'PRIVATE' }, { type: 'text', text: 'reply' }, { type: 'toolCall', id: 'z1', name: 'zoom', arguments: { id: 1, n: 1 } }], api: 'anthropic-messages', provider: 'fixture', model: 'fixture', stopReason: 'toolUse', timestamp: 1, usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
    logMessage(m, { role: 'user', content: 'u'.repeat(40000), timestamp: 0 });
    logMessage(m, assistant);
    logMessage(m, { role: 'custom', customType: 'fixture', content: 'shown', display: true, timestamp: 2 });
    logMessage(m, { role: 'custom', customType: 'fixture', content: 'HIDDEN', display: false, timestamp: 3 });
    logMessage(m, { role: 'toolResult', toolCallId: 'z1', toolName: 'read', content: [{ type: 'text', text: 'HEAD' + 'x'.repeat(40000) + 'TAIL' }], isError: false, timestamp: 4 });
    assert.deepEqual(m.root.map(e => e.kind), ['user', 'user', 'talk', 'tool', 'user', 'echo']);
    assert.equal(m.root[0].text + m.root[1].text, 'u'.repeat(40000));
    assert.deepEqual(m.root.slice(0, 2).map(e => e.text.length), [30000, 10000]);
    assert.equal(m.root[3].text, 'zoom {"id":1,"n":1}'); assert.equal(m.root[4].text, '[fixture] shown');
    assert.ok(m.root[5].text.length <= CAP); assert.ok(m.root[5].text.includes('HEAD') && m.root[5].text.endsWith('TAIL'));
    assert.ok(!JSON.stringify(m.root).includes('PRIVATE') && !JSON.stringify(m.root).includes('HIDDEN'));
  } finally { await m.close(); rmSync(dir, { recursive: true, force: true }); }
});
test('long async work reports are split without clipping and retain transcript trailers', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'optchat-work-'));
  const memory = new Memory(dir, async () => 'summary', () => {});
  const text = 'HEAD' + 'x'.repeat(40000) + 'TAIL';
  try {
    logMessage(memory, { role: 'custom', customType: 'async-result', content: text, display: true, details: { jobs: [{ jobId: 'Alpha' }] }, timestamp: 1 });
    assert.equal(memory.root.map(e => e.text).join(''), `[async-result] ${text}\nFull chat: zoom("Alpha")`);
    assert.deepEqual(memory.root.map(e => e.kind), ['work', 'work']);
  } finally { await memory.close(); rmSync(dir, { recursive: true, force: true }); }
});
test('images round trip once, with original content-addressed references', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'optchat-images-'));
  const m = new Memory(dir, async () => 'summary');
  try {
    const image = { type: 'image' as const, mimeType: 'image/png', data: Buffer.from([137, 80, 78, 71]).toString('base64') };
    await saveImages(m.store, [image, image]);
    assert.deepEqual(await loadImages(m.store, imageRef(image) + imageRef(image)), [image]);
  } finally { await m.close(); rmSync(dir, { recursive: true, force: true }); }
});
test('side turn projection retains only last run onward; missing boundary refuses history', () => {
  const old = { role: 'user' as const, content: 'OLD FULL HISTORY', timestamp: 0 };
  const last = { role: 'user' as const, content: 'latest turn', timestamp: 1 };
  const aside = { role: 'user' as const, content: 'side question', timestamp: 2 };
  const messages = [old, last, aside];
  const projected = projectContext(messages, turnStart(messages, last), '<chat>\nsummary\n</chat>', '');
  assert.ok(!JSON.stringify(projected).includes('OLD FULL HISTORY')); assert.ok(JSON.stringify(projected).includes('side question'));
  assert.throws(() => turnStart(messages, { ...last, timestamp: 99 }), /refusing historical context/);
});
test('a run started by a shown custom message keeps the view first and its own messages', () => {
  const old = { role: 'user' as const, content: 'OLD FULL HISTORY', timestamp: 0 };
  const report = { role: 'custom' as const, customType: 'async-result', content: 'job done', display: true, timestamp: 5 };
  const steer = { role: 'user' as const, content: 'and then?', timestamp: 6 };
  const messages = [old, report, steer];
  const projected = projectContext(messages, turnStart(messages, report), '<chat>\nsummary\n</chat>', '<memories>m</memories>');
  assert.equal(projected.length, 3);
  const head = projected[0];
  assert.ok(head.role === 'user');
  assert.deepEqual(head.content, [{ type: 'text', text: '<chat>\nsummary\n</chat>' }, { type: 'text', text: '<memories>m</memories>' }]);
  assert.equal(projected[1], report); assert.equal(projected[2], steer);
  assert.ok(!JSON.stringify(projected).includes('OLD FULL HISTORY'));
});
