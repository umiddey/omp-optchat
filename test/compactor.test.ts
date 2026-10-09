import { test, mock } from 'bun:test';
import assert from 'node:assert/strict';
import * as ai from '@oh-my-pi/pi-ai';
import type { ModelRegistry } from '@oh-my-pi/pi-coding-agent';
import { buildModel } from '@oh-my-pi/pi-catalog/build';
import { compaction } from '../src/prompts.ts';
import { NODE } from '../src/memory.ts';
let streaming: typeof ai.streamSimple;
mock.module('@oh-my-pi/pi-ai', () => ({ ...ai, streamSimple: (...args: Parameters<typeof ai.streamSimple>) => streaming(...args) }));
// Module-loading boundary: install the fake provider before importing its consumer.
const { createCompressor } = await import('../src/compactor.ts');
const model = buildModel({ id: 'fixture', name: 'Fixture', api: 'anthropic-messages', provider: 'fixture', baseUrl: 'https://invalid.local', reasoning: false, input: ['text'], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 200000, maxTokens: 1000 });
// Registry facade implements exactly the two methods the compressor consumes.
const registry = { find: () => model, getApiKey: async () => 'synthetic' } as unknown as ModelRegistry;
const reply = (text: string): ai.AssistantMessage => ({ role: 'assistant', content: [{ type: 'text', text }], api: model.api, provider: model.provider, model: model.id, timestamp: 0, stopReason: 'stop', usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } });
const compressor = () => createCompressor(registry, () => ({ provider: 'fixture', model: 'fixture', thinking: 'off' }));
const input = { context: '<chat>\n</chat>', source: 'user: ' + 'valuable '.repeat(100), part: { l: 0, i: 40 } };
test('recipe ruler, merge ranges and Too long retry; shortest of at most five replies', async () => {
  assert.equal(compaction({ source: 'user: hi', part: { l: 0, i: 40 } }), `Compaction: compress message 40 into one line of at most 512 bytes\n(about 70 words), the length of this ruler:\n${'-'.repeat(NODE)}\n<input>\nuser: hi\n</input>`);
  assert.match(compaction({ source: 'a\nb', part: { l: 3, i: 5 } }), /merge lines 40\+4 and 44\+4/);
  let calls = 0;
  const contexts: ai.Context[] = [];
  streaming = (_model, context, options) => {
    assert.equal(options?.apiKey, 'synthetic'); assert.equal(options?.sessionId, 'optchat-compactor');
    contexts.push(structuredClone(context));
    const stream = ai.createAssistantMessageEventStream();
    const message = reply('x'.repeat([700, 650, 600, 620, 610][calls++]));
    queueMicrotask(() => { stream.push({ type: 'done', reason: 'stop', message }); stream.end(); });
    return stream;
  };
  assert.equal((await compressor()(input, new AbortController().signal)).length, 600);
  assert.equal(calls, 5);
  assert.match(String(contexts[1].messages.at(-1)?.content), /Too long: your line is 700 bytes/);
  assert.ok(String(contexts[1].messages.at(-1)?.content).endsWith('x'.repeat(512) + '| ← LIMIT'));
});
test('fitting lines stop immediately and copied view head is removed', async () => {
  let calls = 0;
  streaming = () => { calls++; const stream = ai.createAssistantMessageEventStream(); const message = reply('12+4|user: kept'); queueMicrotask(() => { stream.push({ type: 'done', reason: 'stop', message }); stream.end(); }); return stream; };
  assert.equal(await compressor()(input, new AbortController().signal), 'user: kept'); assert.equal(calls, 1);
});
test('cold parallel prefixes wait for first response, warm prefix proceeds, cancellation leaves promptly', async () => {
  const calls: { answer: () => void; finish: () => void }[] = [];
  streaming = () => {
    const stream = ai.createAssistantMessageEventStream(), message = reply('summary');
    stream.push({ type: 'start', partial: message });
    calls.push({ answer: () => stream.push({ type: 'text_delta', contentIndex: 0, delta: 'summary', partial: message }), finish: () => { stream.push({ type: 'done', reason: 'stop', message }); stream.end(); } });
    return stream;
  };
  const compress = compressor(), context = '<chat>\n' + '0+1|user: remembered line\n'.repeat(2000) + '</chat>';
  const run = (signal = new AbortController().signal) => compress({ ...input, context }, signal);
  const pause = () => new Promise(r => setTimeout(r, 20));
  const first = run(), cancel = new AbortController();
  const cancelled = run(cancel.signal); const rest = [run(), run()];
  await pause(); assert.equal(calls.length, 1); cancel.abort(); await assert.rejects(cancelled, { name: 'AbortError' });
  calls[0].answer(); await pause(); assert.equal(calls.length, 3);
  calls.forEach(c => { c.answer(); c.finish(); }); await Promise.all([first, ...rest]);
  const warm = run(); await pause(); assert.equal(calls.length, 4); calls[3].answer(); calls[3].finish(); await warm;
});
