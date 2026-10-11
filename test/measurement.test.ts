import { test, mock } from 'bun:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as ai from '@oh-my-pi/pi-ai';
import type { ModelRegistry } from '@oh-my-pi/pi-coding-agent';
import { buildModel } from '@oh-my-pi/pi-catalog/build';
import { NODE } from '../src/memory.ts';
import { measureFiles, openMeasurement, readCompositionLog, readUsageLog, requestComposition } from '../src/measurement.ts';

let streaming: typeof ai.streamSimple;
mock.module('@oh-my-pi/pi-ai', () => ({ ...ai, streamSimple: (...args: Parameters<typeof ai.streamSimple>) => streaming(...args) }));
// Module-loading boundary (deliberate dynamic import): a static import would bind the real streamSimple into
// src/compactor.ts before mock.module installs the fake, so the consumer must be imported after the mock.
const { createCompressor, createOrderTask } = await import('../src/compactor.ts');
const model = buildModel({ id: 'fixture', name: 'Fixture', api: 'anthropic-messages', provider: 'fixture', baseUrl: 'https://invalid.local', reasoning: false, input: ['text'], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 200000, maxTokens: 1000 });
const registry = { find: () => model, getApiKey: async () => 'synthetic' } as unknown as ModelRegistry;
const usage = { input: 3, output: 5, cacheRead: 7, cacheWrite: 11, totalTokens: 26, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
const reply = (text: string): ai.AssistantMessage => ({ role: 'assistant', content: [{ type: 'text', text }], api: model.api, provider: model.provider, model: model.id, timestamp: 0, stopReason: 'stop', usage });
const utf8 = (value: unknown) => Buffer.byteLength(JSON.stringify(value), 'utf8');
const scratch = () => mkdtempSync(join(tmpdir(), 'optchat-measure-'));
const input = { context: '<chat>\n</chat>', source: 'user: hi', part: { l: 2, i: 7 }, scan: [28, 29] };
const done = (message: ai.AssistantMessage) => { const stream = ai.createAssistantMessageEventStream(); queueMicrotask(() => { stream.push({ type: 'done', reason: 'stop', message }); stream.end(); }); return stream; };

test('every provider invocation starts before it settles; retries get distinct ids and attempts; onUsage is unchanged', async () => {
  const dir = scratch(), files = measureFiles(dir), measure = openMeasurement(dir);
  let calls = 0;
  streaming = () => done(reply('x'.repeat([700, 650, 400][calls++])));
  const seen: ai.AssistantMessage[] = [];
  const compress = createCompressor(registry, () => ({ provider: 'fixture', model: 'fixture', thinking: 'off' }),
    message => seen.push(message), () => NODE, meta => measure.invoke(meta));
  // The scan makes this a summary-with-orders call: the fitting attempt wins with whatever orders it scanned (none here).
  assert.deepEqual(await compress(input, new AbortController().signal), { text: 'x'.repeat(400), orders: new Map() });
  measure.close();
  const { rows } = readUsageLog(files.usage);
  const starts = rows.filter(row => row.type === 'background-start'), settled = rows.filter(row => row.type === 'background');
  assert.equal(starts.length, 3);
  assert.equal(settled.length, 3);
  assert.deepEqual(settled.map(row => row.attempt), [1, 2, 3]);
  assert.equal(new Set(settled.map(row => row.id)).size, 3);
  for (const row of settled) {
    const start = starts.find(candidate => candidate.id === row.id);
    assert.ok(start, 'every settled row has a start row with its id');
    assert.ok(rows.indexOf(start!) < rows.indexOf(row), 'the start row precedes the settle row');
    assert.equal(row.purpose, 'summary');
    assert.equal(row.provider, 'fixture');
    assert.equal(row.model, 'fixture');
    assert.deepEqual(row.part, { l: 2, i: 7 });
    assert.deepEqual(row.scan, [28, 29]);
    assert.equal(row.status, 'ok');
    assert.deepEqual(row.usage, usage);
    assert.equal(typeof row.durationMs, 'number');
    assert.ok(row.durationMs! >= 0);
    assert.ok(!Number.isNaN(Date.parse(row.timestamp)));
  }
  assert.deepEqual(seen.map(message => message.usage), [usage, usage, usage]);
});

test('an error reply settles with its status, error text and reported usage; the call still throws', async () => {
  const dir = scratch(), measure = openMeasurement(dir);
  streaming = () => {
    const stream = ai.createAssistantMessageEventStream(), message = reply('ignored');
    message.stopReason = 'error';
    message.errorMessage = 'overloaded';
    queueMicrotask(() => { stream.push({ type: 'error', reason: 'error', error: message }); stream.end(); });
    return stream;
  };
  const compress = createCompressor(registry, () => ({ provider: 'fixture', model: 'fixture', thinking: 'off' }), () => {}, () => NODE, meta => measure.invoke(meta));
  await assert.rejects(compress(input, new AbortController().signal), /overloaded/);
  measure.close();
  const settled = readUsageLog(measureFiles(dir).usage).rows.filter(row => row.type === 'background');
  assert.equal(settled.length, 1);
  assert.equal(settled[0].status, 'error');
  assert.equal(settled[0].error, 'overloaded');
  assert.deepEqual(settled[0].usage, usage);
});

test('a thrown request settles with usage exactly null', async () => {
  const dir = scratch(), measure = openMeasurement(dir);
  const noKey = { find: () => model, getApiKey: async () => { throw new Error('no key'); } } as unknown as ModelRegistry;
  const compress = createCompressor(noKey, () => ({ provider: 'fixture', model: 'fixture', thinking: 'off' }), () => {}, () => NODE, meta => measure.invoke(meta));
  await assert.rejects(compress(input, new AbortController().signal), /no key/);
  measure.close();
  const settled = readUsageLog(measureFiles(dir).usage).rows.filter(row => row.type === 'background');
  assert.equal(settled.length, 1);
  assert.equal(settled[0].status, 'thrown');
  assert.equal(settled[0].usage, null);
  assert.equal(settled[0].error, 'no key');
});

test('oversized error text is capped', async () => {
  const dir = scratch(), measure = openMeasurement(dir);
  const noKey = { find: () => model, getApiKey: async () => { throw new Error('x'.repeat(2000)); } } as unknown as ModelRegistry;
  const compress = createCompressor(noKey, () => ({ provider: 'fixture', model: 'fixture', thinking: 'off' }), () => {}, () => NODE, meta => measure.invoke(meta));
  await assert.rejects(compress(input, new AbortController().signal));
  measure.close();
  const settled = readUsageLog(measureFiles(dir).usage).rows.filter(row => row.type === 'background');
  assert.equal(settled[0].error!.length, 501);
});

test('a failed call whose only usage is zero counters files unknown, not a free call; partial usage is kept', async () => {
  const dir = scratch(), measure = openMeasurement(dir);
  const zero = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
  const failWith = (usage: typeof zero, stop: 'error' | 'aborted', message: string) => {
    streaming = () => {
      const stream = ai.createAssistantMessageEventStream(), failed = reply('ignored');
      failed.usage = usage;
      failed.stopReason = stop;
      failed.errorMessage = message;
      queueMicrotask(() => { stream.push({ type: 'error', reason: stop, error: failed }); stream.end(); });
      return stream;
    };
  };
  const compress = createCompressor(registry, () => ({ provider: 'fixture', model: 'fixture', thinking: 'off' }), () => {}, () => NODE, meta => measure.invoke(meta));
  failWith(zero, 'error', 'overloaded');
  await assert.rejects(compress(input, new AbortController().signal), /overloaded/);
  failWith({ ...zero, output: 2 }, 'aborted', 'cut');
  await assert.rejects(compress(input, new AbortController().signal), /cut/);
  measure.close();
  const settled = readUsageLog(measureFiles(dir).usage).rows.filter(row => row.type === 'background');
  assert.deepEqual(settled.map(row => row.status), ['error', 'aborted']);
  // All-zero counters are pi-ai's pre-report default, not a provider measurement; any nonzero counter is real.
  assert.equal(settled[0].usage, null);
  assert.deepEqual(settled[1].usage, { ...zero, output: 2 });
});

test('an aborted stream settles as aborted', async () => {
  const dir = scratch(), measure = openMeasurement(dir);
  streaming = () => {
    const stream = ai.createAssistantMessageEventStream(), message = reply('ignored');
    message.stopReason = 'aborted';
    message.errorMessage = 'cancelled';
    queueMicrotask(() => { stream.push({ type: 'error', reason: 'aborted', error: message }); stream.end(); });
    return stream;
  };
  const compress = createCompressor(registry, () => ({ provider: 'fixture', model: 'fixture', thinking: 'off' }), () => {}, () => NODE, meta => measure.invoke(meta));
  await assert.rejects(compress(input, new AbortController().signal), /cancelled/);
  measure.close();
  const settled = readUsageLog(measureFiles(dir).usage).rows.filter(row => row.type === 'background');
  assert.equal(settled[0].status, 'aborted');
  assert.equal(settled[0].error, 'cancelled');
});

test('an abort while only waiting for a primer writes no rows at all', async () => {
  const dir = scratch(), files = measureFiles(dir), measure = openMeasurement(dir);
  const calls: { answer: () => void; finish: () => void }[] = [];
  streaming = () => {
    const stream = ai.createAssistantMessageEventStream(), message = reply('summary');
    stream.push({ type: 'start', partial: message });
    calls.push({ answer: () => stream.push({ type: 'text_delta', contentIndex: 0, delta: 'summary', partial: message }), finish: () => { stream.push({ type: 'done', reason: 'stop', message }); stream.end(); } });
    return stream;
  };
  const compress = createCompressor(registry, () => ({ provider: 'fixture', model: 'fixture', thinking: 'off' }), () => {}, () => NODE, meta => measure.invoke(meta));
  const context = '<chat>\n' + '0+1|user: remembered line\n'.repeat(2000) + '</chat>';
  const first = compress({ ...input, context }, new AbortController().signal);
  const cancel = new AbortController();
  const cancelled = compress({ ...input, context }, cancel.signal);
  // The primer registers synchronously, so the second call is parked on it before abort() runs: no timers needed.
  cancel.abort();
  await assert.rejects(cancelled, { name: 'AbortError' });
  assert.equal(calls.length, 1); // only the first call ever reached the provider
  calls[0].answer();
  calls[0].finish();
  await first;
  measure.close();
  const { rows } = readUsageLog(files.usage);
  assert.equal(rows.filter(row => row.type === 'background-start').length, 1);
  assert.equal(rows.filter(row => row.type === 'background').length, 1);
});

test('orders calls record their purpose and retry flag, and their composition links to the same id', async () => {
  const dir = scratch(), files = measureFiles(dir), measure = openMeasurement(dir);
  streaming = (_model, _context, options) => {
    const wire = { model: 'fixture', system: [{ type: 'text', text: 'orders prompt' }], messages: [{ role: 'user', content: [{ type: 'text', text: '[]' }] }] };
    options?.onPayload?.(wire);
    return done(reply('[]'));
  };
  const task = createOrderTask(registry, () => ({ provider: 'fixture', model: 'fixture', thinking: 'off' }), () => {}, meta => measure.invoke(meta));
  await task({ kind: 'consolidate', ledger: { through: -1, items: [] }, records: [], through: 0, retry: 'Restate them again.' }, new AbortController().signal);
  await task({ kind: 'backfill', items: [] }, new AbortController().signal);
  measure.close();
  const { rows } = readUsageLog(files.usage);
  const settled = rows.filter(row => row.type === 'background');
  assert.deepEqual(settled.map(row => row.purpose), ['consolidate', 'backfill']);
  assert.equal(settled[0].retry, true);
  assert.equal(settled[1].retry, undefined);
  assert.deepEqual(settled.map(row => row.attempt), [1, 1]);
  const compositions = readCompositionLog(files.composition).rows;
  assert.deepEqual(compositions.map(row => row.purpose), ['consolidate', 'backfill']);
  assert.deepEqual(compositions.map(row => row.id), settled.map(row => row.id));
  assert.equal(compositions[0].blocks.view.bytes, 0);
  assert.ok(compositions[0].blocks.system.bytes > 0);
  assert.ok(compositions[0].blocks.history.bytes > 0);
});

test('background composition reads the payload as sent, after the cache split, without changing it', async () => {
  const dir = scratch(), files = measureFiles(dir), measure = openMeasurement(dir);
  const context = '<chat>\n' + '0+1|user: kept line\n'.repeat(6) + '</chat>';
  const wire = { model: 'fixture', max_tokens: 1000, system: [{ type: 'text', text: 'sys' }], messages: [{ role: 'user', content: [{ type: 'text', text: context }] }] };
  let sent: unknown;
  streaming = (_model, _context, options) => {
    sent = options?.onPayload?.(wire) ?? wire;
    return done(reply('0+1|kept'));
  };
  const compress = createCompressor(registry, () => ({ provider: 'fixture', model: 'fixture', thinking: 'off' }), () => {}, () => NODE, meta => measure.invoke(meta));
  assert.equal(await compress({ ...input, context, scan: undefined }, new AbortController().signal), 'kept');
  measure.close();
  const compositions = readCompositionLog(files.composition).rows;
  assert.equal(compositions.length, 1);
  const row = compositions[0];
  assert.equal(row.purpose, 'summary');
  assert.equal(row.tokenEstimateMethod, 'utf8-bytes/4');
  // The cache transform mutates the payload in place and returns it, so `sent` is the same object as `wire`.
  assert.equal(sent, wire);
  // The row still accounts exactly the view's own bytes even though the transform split it into pieces.
  assert.equal(wire.messages[0].content.length, 2);
  assert.equal(row.blocks.view.bytes, Buffer.byteLength(context, 'utf8'));
  assert.equal(row.blocks.system.bytes, utf8([{ type: 'text', text: 'sys' }]));
  assert.equal(row.totalBytes, utf8(sent));
  const sum = Object.values(row.blocks).reduce((total, block) => total + block.bytes, 0);
  assert.equal(sum, row.totalBytes);
  for (const block of Object.values(row.blocks)) assert.equal(block.estimatedTokens, Math.floor(block.bytes / 4));
  const settled = readUsageLog(files.usage).rows.filter(candidate => candidate.type === 'background');
  assert.equal(row.id, settled[0].id);
});

test('composition classification: anthropic system/messages/tools and openai developer/system/input shapes', () => {
  const view = '<chat>\n0+1|a\n4+1|b\n8+1|c\n</chat>';
  const ordersBlock = { type: 'text', text: '<orders through="5">\nnever push\n</orders>' };
  const memoriesBlock = { type: 'text', text: '<memories>\nsome recall\n</memories>' };
  const payload = {
    model: 'fixture', max_tokens: 100,
    system: [{ type: 'text', text: 'stable system' }],
    tools: [{ name: 'zoom', input_schema: { type: 'object' } }],
    messages: [
      { role: 'user', content: [ordersBlock, { type: 'text', text: view }, memoriesBlock, { type: 'text', text: 'typed message' }] },
      { role: 'assistant', content: [{ type: 'text', text: 'answer' }] },
    ],
  };
  const composition = requestComposition(payload, view);
  assert.equal(composition.totalBytes, utf8(payload));
  assert.equal(Object.values(composition.blocks).reduce((total, block) => total + block.bytes, 0), composition.totalBytes);
  assert.equal(composition.blocks.view.bytes, Buffer.byteLength(view, 'utf8'));
  assert.equal(composition.blocks.orders.bytes, utf8(ordersBlock));
  assert.equal(composition.blocks.memories.bytes, utf8(memoriesBlock));
  assert.equal(composition.blocks.tools.bytes, utf8(payload.tools));
  assert.equal(composition.blocks.system.bytes, utf8(payload.system));
  const messageBytes = utf8(payload.messages[0]) + utf8(payload.messages[1]);
  assert.equal(composition.blocks.history.bytes, messageBytes - utf8(ordersBlock) - Buffer.byteLength(view, 'utf8') - utf8(memoriesBlock));
  for (const block of Object.values(composition.blocks)) assert.equal(block.estimatedTokens, Math.floor(block.bytes / 4));
  // Without the view text, the single unsplit view block is still found by its opening marker.
  assert.equal(requestComposition(payload).blocks.view.bytes, Buffer.byteLength(view, 'utf8'));
  const openai = {
    model: 'fixture',
    instructions: 'top-level instructions',
    input: [
      { role: 'developer', content: [{ type: 'input_text', text: 'dev instructions' }] },
      { role: 'system', content: 'system string' },
      { role: 'user', content: [{ type: 'input_text', text: view }, { type: 'input_text', text: 'typed message' }] },
      { role: 'assistant', content: [{ type: 'output_text', text: 'answer' }] },
    ],
    tools: [{ type: 'function', name: 'zoom', parameters: {} }],
  };
  const openaiComposition = requestComposition(openai, view);
  assert.equal(openaiComposition.totalBytes, utf8(openai));
  assert.equal(Object.values(openaiComposition.blocks).reduce((total, block) => total + block.bytes, 0), openaiComposition.totalBytes);
  assert.equal(openaiComposition.blocks.system.bytes, utf8(openai.input[0]) + utf8(openai.input[1]) + utf8('top-level instructions'));
  assert.equal(openaiComposition.blocks.view.bytes, Buffer.byteLength(view, 'utf8'));
  assert.equal(openaiComposition.blocks.tools.bytes, utf8(openai.tools));
  assert.ok(openaiComposition.blocks.history.bytes > 0);
  assert.equal(openaiComposition.blocks.orders.bytes, 0);
  assert.equal(openaiComposition.blocks.memories.bytes, 0);
  // String content carries its context unit whole: a full view or an orders block is attributed, plain text stays history.
  const stringPayload = {
    model: 'fixture',
    input: [
      { role: 'user', content: view },
      { role: 'user', content: '<orders through="5">\nnever push\n</orders>' },
      { role: 'user', content: 'plain words' },
    ],
  };
  const stringComposition = requestComposition(stringPayload, view);
  assert.equal(stringComposition.totalBytes, utf8(stringPayload));
  assert.equal(Object.values(stringComposition.blocks).reduce((total, block) => total + block.bytes, 0), stringComposition.totalBytes);
  // A string occupies its quoted, escaped serialization inside the item's JSON — exactly utf8 of the string.
  assert.equal(stringComposition.blocks.view.bytes, utf8(view));
  assert.equal(stringComposition.blocks.orders.bytes, utf8('<orders through="5">\nnever push\n</orders>'));
  for (const block of Object.values(stringComposition.blocks)) assert.ok(block.bytes >= 0);
  // And the same attribution works when the caller does not know the view text.
  assert.equal(requestComposition(stringPayload).blocks.view.bytes, utf8(view));
});

test('main requests get composition rows with purpose main, provider and model', () => {
  const dir = scratch(), files = measureFiles(dir), measure = openMeasurement(dir);
  const payload = { model: 'fixture', system: [{ type: 'text', text: 'sys' }], messages: [{ role: 'user', content: [{ type: 'text', text: '<chat>\n</chat>' }] }] };
  measure.request(payload, { provider: 'fixture', id: 'fixture' }, '<chat>\n</chat>');
  measure.close();
  const rows = readCompositionLog(files.composition).rows;
  assert.equal(rows.length, 1);
  assert.equal(rows[0].purpose, 'main');
  assert.equal(rows[0].provider, 'fixture');
  assert.equal(rows[0].model, 'fixture');
  assert.equal(rows[0].blocks.view.bytes, Buffer.byteLength('<chat>\n</chat>', 'utf8'));
  assert.equal(rows[0].totalBytes, utf8(payload));
});

test('telemetry failures warn boundedly, never throw, and eventually go inert; the session call still succeeds', async () => {
  const dir = scratch();
  mkdirSync(join(dir, 'usage.jsonl')); // a directory where the file must be: every usage append fails
  const warnings: string[] = [];
  const measure = openMeasurement(dir, message => warnings.push(message));
  const first = measure.invoke({ purpose: 'summary', provider: 'p', model: 'm', attempt: 1 });
  first.settled({ status: 'ok', usage: null });
  assert.equal(warnings.length, 1);
  const second = measure.invoke({ purpose: 'summary', provider: 'p', model: 'm', attempt: 2 });
  assert.equal(warnings.length, 2); // third consecutive failure disables the file and warns once more
  second.settled({ status: 'thrown', usage: null });
  second.settled({ status: 'thrown', usage: null }); // a span settles once; later calls are ignored
  measure.request({ model: 'fixture' });
  measure.invoke({ purpose: 'summary', provider: 'p', model: 'm', attempt: 3 }).settled({ status: 'ok', usage: null });
  assert.equal(warnings.length, 2);
  assert.doesNotThrow(() => measure.close());
  // End to end: a broken sink must not fault the compressor.
  const broken = openMeasurement(dir, () => {});
  streaming = () => done(reply('12+4|user: kept'));
  const compress = createCompressor(registry, () => ({ provider: 'fixture', model: 'fixture', thinking: 'off' }), () => {}, () => NODE, meta => broken.invoke(meta));
  assert.equal(await compress({ ...input, scan: undefined }, new AbortController().signal), 'user: kept');
  broken.close();
});

test('no request content ever reaches the measurement files', async () => {
  const dir = scratch(), files = measureFiles(dir), measure = openMeasurement(dir);
  const marker = 'valuable-private-content-marker';
  streaming = (_model, _context, options) => {
    // Exercise the composition hook too, so both files exist and both are checked for leaks.
    options?.onPayload?.({ model: 'fixture', messages: [{ role: 'user', content: [{ type: 'text', text: `user: ${marker}` }] }] });
    return done(reply('12+4|kept'));
  };
  const compress = createCompressor(registry, () => ({ provider: 'fixture', model: 'fixture', thinking: 'off' }), () => {}, () => NODE, meta => measure.invoke(meta));
  await compress({ ...input, source: `user: ${marker}` }, new AbortController().signal);
  measure.close();
  for (const file of [files.usage, files.composition]) assert.ok(!readFileSync(file, 'utf8').includes(marker));
});

test('readers skip damaged lines and count them', () => {
  const dir = scratch(), files = measureFiles(dir);
  writeFileSync(files.usage, `${JSON.stringify({ schema: 1, type: 'background', id: 'a' })}\ngarbage\n${JSON.stringify({ schema: 1, type: 'background', id: 'b' })}\n`);
  const { rows, damaged } = readUsageLog(files.usage);
  assert.deepEqual(rows.map(row => row.id), ['a', 'b']);
  assert.equal(damaged, 1);
  // A missing file is reported, never mistaken for a complete empty run.
  const missing = readUsageLog(join(dir, 'absent.jsonl'));
  assert.deepEqual(missing.rows, []);
  assert.equal(missing.damaged, 0);
  assert.match(missing.error!, /No such file/);
});
