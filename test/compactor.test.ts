import { test, mock } from 'bun:test';
import assert from 'node:assert/strict';
import * as ai from '@oh-my-pi/pi-ai';
import type { ModelRegistry } from '@oh-my-pi/pi-coding-agent';
import { buildModel } from '@oh-my-pi/pi-catalog/build';
import { compaction } from '../src/prompts.ts';
import { NODE, type CompressorResult } from '../src/memory.ts';
import { ThinkingLevel } from '@oh-my-pi/pi-agent-core';
let streaming: typeof ai.streamSimple;
mock.module('@oh-my-pi/pi-ai', () => ({ ...ai, streamSimple: (...args: Parameters<typeof ai.streamSimple>) => streaming(...args) }));
// Module-loading boundary: install the fake provider before importing its consumer.
const { createCompressor, createOrderTask } = await import('../src/compactor.ts');
const model = buildModel({ id: 'fixture', name: 'Fixture', api: 'anthropic-messages', provider: 'fixture', baseUrl: 'https://invalid.local', reasoning: false, input: ['text'], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 200000, maxTokens: 1000 });
// Registry facade implements exactly the two methods the compressor consumes.
const registry = { find: () => model, getApiKey: async () => 'synthetic' } as unknown as ModelRegistry;
const reply = (text: string): ai.AssistantMessage => ({ role: 'assistant', content: [{ type: 'text', text }], api: model.api, provider: model.provider, model: model.id, timestamp: 0, stopReason: 'stop', usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } });
const compressor = () => createCompressor(registry, () => ({ provider: 'fixture', model: 'fixture', thinking: 'off' }));
const summaryOf = (r: CompressorResult) => typeof r === 'string' ? r : r.text;
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
  assert.equal(summaryOf(await compressor()(input, new AbortController().signal)).length, 600);
  assert.equal(calls, 5);
  assert.match(String(contexts[1].messages.at(-1)?.content), /Too long: your line is 700 bytes/);
  assert.ok(String(contexts[1].messages.at(-1)?.content).endsWith('x'.repeat(512) + '| ← LIMIT'));
});
test('fitting lines stop immediately and copied view head is removed', async () => {
  let calls = 0;
  streaming = () => { calls++; const stream = ai.createAssistantMessageEventStream(); const message = reply('12+4|user: kept'); queueMicrotask(() => { stream.push({ type: 'done', reason: 'stop', message }); stream.end(); }); return stream; };
  assert.equal(await compressor()(input, new AbortController().signal), 'user: kept'); assert.equal(calls, 1);
});
test('a fitting line needs no retry even if it is longer than its source', async () => {
  let calls = 0;
  streaming = () => { calls++; const stream = ai.createAssistantMessageEventStream(); const message = reply('user: contextualized decision'); queueMicrotask(() => { stream.push({ type: 'done', reason: 'stop', message }); stream.end(); }); return stream; };
  assert.equal(await compressor()({ ...input, source: 'user: yes' }, new AbortController().signal), 'user: contextualized decision');
  assert.equal(calls, 1);
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
test('a failing primer releases a waiting longer prefix instead of hanging', async () => {
  const calls: { fail: () => void; finish: () => void }[] = [];
  streaming = () => {
    const stream = ai.createAssistantMessageEventStream(), message = reply('summary');
    stream.push({ type: 'start', partial: message });
    calls.push({
      fail: () => { message.stopReason = 'error'; message.errorMessage = 'overloaded'; stream.push({ type: 'error', reason: 'error', error: message }); stream.end(); },
      finish: () => { stream.push({ type: 'done', reason: 'stop', message }); stream.end(); },
    });
    return stream;
  };
  const compress = compressor(), context = '<chat>\n' + '0+1|note: remembered\n'.repeat(2000) + '</chat>';
  const first = compress({ ...input, context }, new AbortController().signal).catch((e: Error) => e.message);
  const longer = compress({ ...input, context: context.replace('</chat>', '0+1|note: newer\n'.repeat(4) + '</chat>') }, new AbortController().signal);
  await new Promise(r => setTimeout(r, 20)); assert.equal(calls.length, 1);
  calls[0].fail(); await new Promise(r => setTimeout(r, 20)); assert.equal(calls.length, 2);
  calls[1].finish(); assert.equal(await first, 'overloaded'); assert.equal(await longer, 'summary');
});
const streamOnce = (text: (k: number) => string) => { let calls = 0; streaming = () => { const k = calls++; const stream = ai.createAssistantMessageEventStream(); const message = reply(text(k)); queueMicrotask(() => { stream.push({ type: 'done', reason: 'stop', message }); stream.end(); }); return stream; }; return () => calls; };
test('(a) the summary line is the 512-byte line; ORDERS come back beside it, and the compaction task asks for them', async () => {
  const orders = { '40': [{ said: 'Never push', text: 'Never push', kind: 'rule' }] };
  const calls = streamOnce(() => `user: kept\nORDERS:\n${JSON.stringify(orders)}`);
  const result = await compressor()({ ...input, scan: [40] }, new AbortController().signal);
  assert.deepEqual(result, { text: 'user: kept', orders: new Map([[40, [{ said: 'Never push', text: 'Never push', kind: 'rule' }]]]) });
  assert.equal(calls(), 1);
  assert.match(compaction({ source: 'user: hi', part: { l: 0, i: 40 }, scan: [40] }), /ORDERS:/);
});
test('(c) the ORDERS section is not counted in the 512-byte line, so long orders do not force a retry', async () => {
  const orders = { '40': [{ said: 'z'.repeat(700), text: 'short', kind: 'rule' }] };
  const calls = streamOnce(() => `user: kept\nORDERS:\n${JSON.stringify(orders)}`);
  const result = await compressor()({ ...input, scan: [40] }, new AbortController().signal);
  assert.equal(calls(), 1);
  assert.ok(typeof result !== 'string'); assert.equal(result.text, 'user: kept');
});
test('(c) a too-long line retries, and the shortest line keeps the orders of its own reply', async () => {
  const lengths = [700, 650, 600, 620, 610];
  const calls = streamOnce(k => `${'x'.repeat(lengths[k])}\nORDERS:\n${JSON.stringify({ '40': [{ said: `order-${k}`, text: `order-${k}`, kind: 'rule' }] })}`);
  const result = await compressor()({ ...input, scan: [40] }, new AbortController().signal);
  assert.equal(calls(), 5);
  assert.ok(typeof result !== 'string'); assert.equal(result.text.length, 600);
  assert.deepEqual(result.orders?.get(40), [{ said: 'order-2', text: 'order-2', kind: 'rule' }]);
});
test('(d) invalid ORDERS JSON leaves the scanned messages unrecorded and does not fail the line', async () => {
  const calls = streamOnce(() => 'user: kept\nORDERS:\n{"40": [oops');
  const result = await compressor()({ ...input, scan: [40] }, new AbortController().signal);
  assert.ok(typeof result !== 'string'); assert.equal(result.text, 'user: kept');
  assert.equal(calls(), 1);
  assert.equal(result.orders?.has(40) ?? false, false);
});
test('(h) order tasks think at medium even when the compactor is set to xhigh', async () => {
  const thinking = buildModel({ id: 'reasoner', name: 'Reasoner', api: 'anthropic-messages', provider: 'fixture', baseUrl: 'https://invalid.local', reasoning: true, input: ['text'], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 200000, maxTokens: 1000 });
  const seen: unknown[] = [];
  streaming = (_model, _context, options) => { seen.push(options?.reasoning); const stream = ai.createAssistantMessageEventStream(); const message = reply('[]'); queueMicrotask(() => { stream.push({ type: 'done', reason: 'stop', message }); stream.end(); }); return stream; };
  const reasonRegistry = { find: () => thinking, getApiKey: async () => 'synthetic' } as unknown as ModelRegistry;
  const task = createOrderTask(reasonRegistry, () => ({ provider: 'fixture', model: 'reasoner', thinking: ThinkingLevel.XHigh }));
  await task({ kind: 'consolidate', ledger: { through: -1, items: [] }, records: [], through: 0 }, new AbortController().signal);
  await task({ kind: 'backfill', items: [] }, new AbortController().signal);
  assert.deepEqual(seen, ['medium', 'medium']);
});
