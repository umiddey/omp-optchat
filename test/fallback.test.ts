import { test, mock, setSystemTime } from 'bun:test';
import assert from 'node:assert/strict';
import * as ai from '@oh-my-pi/pi-ai';
import type { AssistantMessageEventStream } from '@oh-my-pi/pi-ai';
import type { ModelRegistry } from '@oh-my-pi/pi-coding-agent';
import { buildModel } from '@oh-my-pi/pi-catalog/build';
import { classifyFailure, retryHintMs } from '../src/fallback.ts';
import type { Instrumentation, InvokeMeta, SettledMeta, Span } from '../src/measurement.ts';
let streaming: typeof ai.streamSimple;
mock.module('@oh-my-pi/pi-ai', () => ({ ...ai, streamSimple: (...args: Parameters<typeof ai.streamSimple>) => streaming(...args) }));
// Module-loading boundary: install the fake provider before importing its consumer (static import would bind the real streamSimple).
const { createCompressor } = await import('../src/compactor.ts');

const build = (provider: string, id: string, api: ai.Api) => buildModel({ id, name: id, api, provider, baseUrl: 'https://invalid.local', reasoning: false, input: ['text'], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 200000, maxTokens: 1000 });
const anthropic = build('anthropic', 'claude-haiku-5-5', 'anthropic-messages');
const zai = build('zai', 'glm-5.3-flash', 'openai-completions');
const google = build('google-antigravity', 'gemini-3.8-flash', 'google-generative-ai');
const models = new Map<string, ai.Model<ai.Api>>([
  ['anthropic/claude-haiku-5-5', anthropic], ['zai/glm-5.3-flash', zai], ['google-antigravity/gemini-3.8-flash', google],
]);
const keys = new Map<string, string>([['anthropic', 'k-anthropic'], ['zai', 'k-zai'], ['google-antigravity', 'k-google']]);
// Registry facade implements exactly the two methods the compressor consumes.
const registry = {
  find: (provider: string, id: string) => models.get(`${provider}/${id}`),
  getApiKey: async (model: ai.Model<ai.Api>) => {
    const key = keys.get(model.provider);
    if (!key) throw new Error(`No api key found for provider ${model.provider}.`);
    return key;
  },
} as unknown as ModelRegistry;
const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
const reply = (model: ai.Model<ai.Api>, text: string, over: Partial<ai.AssistantMessage> = {}): ai.AssistantMessage =>
  ({ role: 'assistant', content: [{ type: 'text', text }], api: model.api, provider: model.provider, model: model.id, timestamp: 0, stopReason: 'stop', usage, ...over });
const input = { context: '<chat>\n</chat>', source: 'user: ' + 'valuable '.repeat(100), part: { l: 0, i: 40 } };
const primary = () => ({ provider: 'anthropic', model: 'claude-haiku-5-5', thinking: 'off' as const });
const zaiChoice = { provider: 'zai', model: 'glm-5.3-flash', thinking: ai.Effort.High };
const googleChoice = { provider: 'google-antigravity', model: 'gemini-3.8-flash', thinking: ai.Effort.Medium };
const httpError = (status: number, message: string): Error => Object.assign(new Error(message), { status });
/** Drains the microtask queue deterministically: two hops let a started call reach its first real suspension point. */
const settle = () => {
  const { promise, resolve } = Promise.withResolvers<void>();
  queueMicrotask(() => queueMicrotask(resolve));
  return promise;
};

/** A resolved provider error: pi-ai settles the stream with the failed reply instead of throwing. */
const errorStream = (model: ai.Model<ai.Api>, status: number, message: string) => {
  const stream = ai.createAssistantMessageEventStream();
  const failed = reply(model, '', { stopReason: 'error', errorMessage: message, errorStatus: status });
  queueMicrotask(() => { stream.push({ type: 'error', reason: 'error', error: failed }); stream.end(); });
  return stream;
};
/** A stream that answers nothing until its controller fires, so gates and probes are observable. */
const heldStream = (model: ai.Model<ai.Api>, fire: (stream: AssistantMessageEventStream, held: ai.Model<ai.Api>) => void) => {
  const stream = ai.createAssistantMessageEventStream();
  fire(stream, model);
  return stream;
};
const okStream = (model: ai.Model<ai.Api>, text = 'user: kept') => {
  const stream = ai.createAssistantMessageEventStream();
  queueMicrotask(() => { stream.push({ type: 'done', reason: 'stop', message: reply(model, text) }); stream.end(); });
  return stream;
};
const recorder = () => {
  const spans: { meta: InvokeMeta; settled?: SettledMeta }[] = [];
  const instrument: Instrumentation = meta => {
    const span: { meta: InvokeMeta; settled?: SettledMeta } = { meta };
    spans.push(span);
    const handle: Span = { id: `s${spans.length}`, payload() {}, settled: settled => { span.settled ??= settled; } };
    return handle;
  };
  return { spans, instrument };
};

test('failure lanes: 400 and local failures are terminal; quota, outage, throttle and credential lanes fall back', () => {
  assert.equal(classifyFailure('x', 400, 'you exceeded your quota').fallback, false);
  assert.equal(classifyFailure('x', 422, 'malformed request body').fallback, false);
  assert.equal(classifyFailure('x', undefined, 'TypeError: cannot read properties of undefined').fallback, false);
  assert.equal(classifyFailure('x', undefined, 'fetch failed').fallback, true);
  assert.equal(classifyFailure('x', 503, 'upstream overloaded').fallback, true);
  assert.equal(classifyFailure('x', 429, 'Please retry in 5s').fallback, true);
  assert.equal(classifyFailure('x', 401, 'invalid api key').fallback, true);
  assert.equal(classifyFailure('x', 429, 'quota will reset tomorrow').cooldownMs, 30 * 60_000);
});

test('retry hints: retry-after-ms honored, ZAI stamps read as Beijing wall clock, never the host zone', () => {
  setSystemTime(Date.parse('2026-10-12T10:00:00.000Z'));
  try {
    assert.equal(retryHintMs('zai', '429 已达到 5 小时的使用上限。您的限额将在 2026-10-12 20:06:00 重置。'), 7_560_000);
    assert.equal(retryHintMs('zai', 'Your limit will reset at 2026-10-12 20:06:00'), 7_560_000);
    assert.equal(retryHintMs('anthropic', 'retry-after-ms=98497000'), 98_497_000);
    assert.equal(retryHintMs('anthropic', 'usage limit reached'), undefined);
  } finally { setSystemTime(); }
});

test('a resolved 429 cools the primary and the compression advances to the fallback, with accurate telemetry', async () => {
  const { spans, instrument } = recorder();
  const usageSeen: ai.AssistantMessage[] = [];
  const warnings: string[] = [];
  const calls: string[] = [];
  streaming = model => { calls.push(`${model.provider}/${model.id}`);
    return model.provider === 'anthropic' ? errorStream(model, 429, 'rate_limit_error: account rate limit, retry-after-ms=7200000') : okStream(model); };
  const compress = createCompressor(registry, primary, m => usageSeen.push(m), undefined, instrument,
    { fallbacks: () => [zaiChoice], warn: w => warnings.push(w) });
  assert.equal(await compress(input, new AbortController().signal), 'user: kept');
  assert.deepEqual(calls, ['anthropic/claude-haiku-5-5', 'zai/glm-5.3-flash']);
  assert.deepEqual(spans.map(s => [s.meta.provider, s.meta.attempt, s.settled?.status]), [['anthropic', 1, 'error'], ['zai', 2, 'ok']]);
  assert.equal(usageSeen.length, 2);
  assert.equal(usageSeen[0].stopReason, 'error');
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /anthropic\/claude-haiku-5-5 .*zai\/glm-5\.3-flash/);
});

test('a thrown 5xx cools the primary and advances to the fallback', async () => {
  const calls: string[] = [];
  streaming = model => { calls.push(`${model.provider}/${model.id}`);
    if (model.provider !== 'anthropic') return okStream(model);
    throw httpError(503, 'HTTP 503 from upstream'); };
  const compress = createCompressor(registry, primary, undefined, undefined, undefined, { fallbacks: () => [zaiChoice] });
  assert.equal(await compress(input, new AbortController().signal), 'user: kept');
  assert.deepEqual(calls, ['anthropic/claude-haiku-5-5', 'zai/glm-5.3-flash']);
});

test('a cooled primary is skipped on later calls and retried first again after its reset', async () => {
  const t0 = Date.parse('2026-10-12T08:00:00.000Z');
  setSystemTime(t0);
  try {
    const calls: string[] = [];
    streaming = model => { calls.push(`${model.provider}/${model.id}`);
      return model.provider === 'anthropic' ? errorStream(model, 429, 'rate limited: retry-after-ms=7200000') : okStream(model); };
    const compress = createCompressor(registry, primary, undefined, undefined, undefined, { fallbacks: () => [zaiChoice] });
    await compress(input, new AbortController().signal);
    await compress(input, new AbortController().signal);
    assert.deepEqual(calls, ['anthropic/claude-haiku-5-5', 'zai/glm-5.3-flash', 'zai/glm-5.3-flash']);
    setSystemTime(t0 + 7_200_001);
    await compress(input, new AbortController().signal);
    assert.deepEqual(calls, ['anthropic/claude-haiku-5-5', 'zai/glm-5.3-flash', 'zai/glm-5.3-flash', 'anthropic/claude-haiku-5-5', 'zai/glm-5.3-flash']);
  } finally { setSystemTime(); }
});

test('concurrent compressions send one probe to a failing primary; followers re-evaluate and all advance', async () => {
  const calls: string[] = [];
  let failProbe = () => {};
  streaming = model => { calls.push(`${model.provider}/${model.id}`);
    if (model.provider !== 'anthropic') return okStream(model);
    return heldStream(model, (stream, held) => { failProbe = () => {
      stream.push({ type: 'error', reason: 'error', error: reply(held, '', { stopReason: 'error', errorMessage: 'account rate limit', errorStatus: 429 }) });
      stream.end();
    }; }); };
  const compress = createCompressor(registry, primary, undefined, undefined, undefined, { fallbacks: () => [zaiChoice] });
  const runs = [compress(input, new AbortController().signal), compress(input, new AbortController().signal), compress(input, new AbortController().signal)];
  await settle();
  assert.deepEqual(calls, ['anthropic/claude-haiku-5-5']);
  failProbe();
  assert.deepEqual(await Promise.all(runs), ['user: kept', 'user: kept', 'user: kept']);
  assert.equal(calls.filter(c => c === 'anthropic/claude-haiku-5-5').length, 1);
  assert.equal(calls.filter(c => c === 'zai/glm-5.3-flash').length, 3);
});

test('followers of a successful availability probe stay on the primary', async () => {
  const calls: string[] = [];
  let finish = () => {};
  streaming = model => {
    calls.push(model.provider);
    if (calls.length > 1) return okStream(model);
    return heldStream(model, (stream, held) => {
      finish = () => { stream.push({ type: 'done', reason: 'stop', message: reply(held, 'user: kept') }); stream.end(); };
    });
  };
  const compress = createCompressor(registry, primary, undefined, undefined, undefined, { fallbacks: () => [zaiChoice] });
  const runs = [compress(input, new AbortController().signal), compress(input, new AbortController().signal)];
  await settle();
  assert.deepEqual(calls, ['anthropic']);
  finish();
  assert.deepEqual(await Promise.all(runs), ['user: kept', 'user: kept']);
  assert.deepEqual(calls, ['anthropic', 'anthropic']);
});

test('a fallback gets its own full five-attempt size budget after an unavailable primary', async () => {
  let fallbackCalls = 0;
  streaming = model => {
    if (model.provider === 'anthropic') return errorStream(model, 429, 'rate limited');
    return okStream(model, 'x'.repeat(++fallbackCalls === 5 ? 100 : 700));
  };
  const compress = createCompressor(registry, primary, undefined, undefined, undefined, { fallbacks: () => [zaiChoice] });
  assert.equal(await compress(input, new AbortController().signal), 'x'.repeat(100));
  assert.equal(fallbackCalls, 5);
});

test('cancellation exits at once and never falls back', async () => {
  const calls: string[] = [];
  streaming = (model, _context, options) => { calls.push(`${model.provider}/${model.id}`);
    return heldStream(model, (stream, held) => { options?.signal?.addEventListener('abort', () => {
      stream.push({ type: 'error', reason: 'aborted', error: reply(held, '', { stopReason: 'aborted', errorMessage: 'Request was aborted.' }) });
      stream.end();
    }); }); };
  const controller = new AbortController();
  const compress = createCompressor(registry, primary, undefined, undefined, undefined, { fallbacks: () => [zaiChoice] });
  const run = compress(input, controller.signal);
  await settle();
  assert.deepEqual(calls, ['anthropic/claude-haiku-5-5']);
  controller.abort();
  await assert.rejects(run, /aborted/);
  assert.equal(calls.filter(c => c.startsWith('zai')).length, 0);
});

test('too-long summaries retry the same provider and never fall back', async () => {
  let calls = 0;
  streaming = model => { calls++; assert.equal(model.provider, 'anthropic');
    const stream = ai.createAssistantMessageEventStream();
    const text = 'x'.repeat([700, 650, 600, 620, 610][calls - 1] ?? 600);
    queueMicrotask(() => { stream.push({ type: 'done', reason: 'stop', message: reply(model, text) }); stream.end(); });
    return stream; };
  const compress = createCompressor(registry, primary, undefined, undefined, undefined, { fallbacks: () => [zaiChoice] });
  assert.equal((await compress(input, new AbortController().signal)).length, 600);
  assert.equal(calls, 5);
});

test('a 400 is terminal: raw failure, no fallback, and no cooldown on the next call', async () => {
  const calls: string[] = [];
  streaming = model => { calls.push(`${model.provider}/${model.id}`);
    return model.provider === 'anthropic' && calls.length === 1 ? errorStream(model, 400, 'invalid_request_error: messages are malformed') : okStream(model); };
  const compress = createCompressor(registry, primary, undefined, undefined, undefined, { fallbacks: () => [zaiChoice] });
  await assert.rejects(compress(input, new AbortController().signal), /malformed/);
  assert.equal(calls.filter(c => c.startsWith('zai')).length, 0);
  await compress(input, new AbortController().signal);
  assert.deepEqual(calls, ['anthropic/claude-haiku-5-5', 'anthropic/claude-haiku-5-5']);
});

test('a missing credential moves to the next provider and records the attempt', async () => {
  keys.delete('anthropic');
  try {
    const { spans, instrument } = recorder();
    const calls: string[] = [];
    streaming = model => { calls.push(`${model.provider}/${model.id}`); return okStream(model); };
    const compress = createCompressor(registry, primary, undefined, undefined, instrument, { fallbacks: () => [zaiChoice] });
    assert.equal(await compress(input, new AbortController().signal), 'user: kept');
    assert.deepEqual(calls, ['zai/glm-5.3-flash']);
    assert.deepEqual(spans.map(s => [s.meta.provider, s.meta.attempt, s.settled?.status]), [['anthropic', 1, 'thrown'], ['zai', 2, 'ok']]);
  } finally { keys.set('anthropic', 'k-anthropic'); }
});

test('a model missing from the registry falls back; a single-provider chain keeps the legacy error', async () => {
  const calls: string[] = [];
  streaming = model => { calls.push(`${model.provider}/${model.id}`); return okStream(model); };
  const compress = createCompressor(registry, () => ({ provider: 'nosuch', model: 'missing', thinking: 'off' }), undefined, undefined, undefined,
    { fallbacks: () => [zaiChoice] });
  assert.equal(await compress(input, new AbortController().signal), 'user: kept');
  assert.deepEqual(calls, ['zai/glm-5.3-flash']);
  const legacy = createCompressor(registry, () => ({ provider: 'nosuch', model: 'missing', thinking: 'off' }));
  await assert.rejects(legacy(input, new AbortController().signal), /Compactor model unavailable: nosuch\/missing\. Edit the profile config\.json\./);
});

test('when every candidate is unavailable the error names each setback and the next retry time', async () => {
  const t0 = Date.parse('2026-10-12T08:00:00.000Z');
  setSystemTime(t0);
  try {
    streaming = model => {
      if (model.provider !== 'anthropic') throw httpError(503, 'upstream overloaded');
      return errorStream(model, 429, 'rate limited: retry-after-ms=7200000');
    };
    const until = new Date(t0 + 7_200_000).toISOString();
    const compress = createCompressor(registry, primary, undefined, undefined, undefined, { fallbacks: () => [zaiChoice] });
    await assert.rejects(compress(input, new AbortController().signal), (error: Error) => {
      assert.match(error.message, /Compactor providers unavailable\. Next retry \d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/, error.message);
      assert.ok(error.message.includes(`anthropic/claude-haiku-5-5: rate limited until ${until}`), error.message);
      assert.match(error.message, /zai\/glm-5\.3-flash: service overloaded until /, error.message);
      return true;
    });
  } finally { setSystemTime(); }
});

test('a real Google quota reset (RetryInfo retryDelay / quotaResetTimeStamp) sets the cooldown, not a generic default', async () => {
  const t0 = Date.parse('2026-10-12T12:05:13.000Z');
  setSystemTime(t0);
  try {
    const quotaMessage = JSON.stringify({ error: { code: 429, message: 'Quota exceeded for model gemini-3.8-flash.', status: 'RESOURCE_EXHAUSTED',
      details: [{ '@type': 'type.googleapis.com/google.rpc.RetryInfo', retryDelay: '114167.020171488s' }],
      metadata: { quotaResetTimeStamp: '2026-10-13T19:48:00Z', quotaResetDelay: '31h42m47.020171488s' } } });
    const lane = classifyFailure('google-antigravity', 429, quotaMessage);
    assert.equal(lane.fallback, true);
    assert.ok(Math.abs((lane.cooldownMs ?? 0) - 114_167_020.171488) < 1);
    assert.equal(retryHintMs('google-antigravity', JSON.stringify({ metadata: { quotaResetTimeStamp: '2026-10-13T19:48:00Z' } })), 114_167_000);
    const calls: string[] = [];
    streaming = model => { calls.push(`${model.provider}/${model.id}`);
      if (model.provider === 'anthropic') return errorStream(model, 429, 'usage limit reached');
      if (model.provider === 'google-antigravity') return errorStream(model, 429, quotaMessage);
      return okStream(model); };
    const compress = createCompressor(registry, primary, undefined, undefined, undefined,
      { fallbacks: () => [googleChoice, zaiChoice] });
    assert.equal(await compress(input, new AbortController().signal), 'user: kept');
    // Half an hour later Google's 31h42m reset still holds: Google is skipped, not hammered at a generic interval.
    setSystemTime(t0 + 30 * 60_000);
    await compress(input, new AbortController().signal);
    assert.deepEqual(calls, ['anthropic/claude-haiku-5-5', 'google-antigravity/gemini-3.8-flash', 'zai/glm-5.3-flash',
      'anthropic/claude-haiku-5-5', 'zai/glm-5.3-flash']);
  } finally { setSystemTime(); }
});

test('a warm provider runs parallel calls; a failure while a peer waits on the prefix gate sends the peer to the fallback', async () => {
  const calls: string[] = [];
  const controllers: (() => void)[] = [];
  streaming = model => { calls.push(`${model.provider}/${model.id}`);
    if (model.provider !== 'anthropic') return okStream(model, 'summary');
    if (calls.length === 1) return okStream(model, 'summary');
    return heldStream(model, (stream, held) => { controllers.push(() => {
      stream.push({ type: 'error', reason: 'error', error: reply(held, '', { stopReason: 'error', errorMessage: 'account rate limit', errorStatus: 429 }) });
      stream.end();
    }); }); };
  const compress = createCompressor(registry, primary, undefined, undefined, undefined, { fallbacks: () => [zaiChoice] });
  assert.equal(await compress(input, new AbortController().signal), 'summary');
  // The provider is warm now; two fresh calls share a cold long prefix, so one primes it and the other waits on the gate.
  const context = '<chat>\n' + '0+1|user: remembered line\n'.repeat(2000) + '</chat>';
  const primer = compress({ ...input, context }, new AbortController().signal);
  const waiter = compress({ ...input, context }, new AbortController().signal);
  await settle();
  assert.deepEqual(calls.filter(c => c === 'anthropic/claude-haiku-5-5'), ['anthropic/claude-haiku-5-5', 'anthropic/claude-haiku-5-5']);
  controllers[0]();
  assert.equal(await primer, 'summary');
  assert.equal(await waiter, 'summary');
  assert.equal(calls.filter(c => c === 'anthropic/claude-haiku-5-5').length, 2);
  assert.equal(calls.filter(c => c === 'zai/glm-5.3-flash').length, 2);
});

test('fallback starts a fresh conversation from the original input while attempts stay monotonic', async () => {
  const contexts: ai.Context[] = [];
  const calls: string[] = [];
  const { spans, instrument } = recorder();
  let anthropicCalls = 0;
  streaming = (model, context) => { calls.push(`${model.provider}/${model.id}`); contexts.push(structuredClone(context));
    if (model.provider === 'anthropic') {
      if (anthropicCalls++ === 0) { const stream = ai.createAssistantMessageEventStream(); queueMicrotask(() => { stream.push({ type: 'done', reason: 'stop', message: reply(model, 'x'.repeat(700)) }); stream.end(); }); return stream; }
      throw httpError(503, 'HTTP 503 from upstream');
    }
    const stream = ai.createAssistantMessageEventStream();
    queueMicrotask(() => { stream.push({ type: 'done', reason: 'stop', message: reply(model, 'user: kept') }); stream.end(); });
    return stream; };
  const compress = createCompressor(registry, primary, undefined, undefined, instrument, { fallbacks: () => [zaiChoice] });
  assert.equal(await compress(input, new AbortController().signal), 'user: kept');
  assert.deepEqual(calls, ['anthropic/claude-haiku-5-5', 'anthropic/claude-haiku-5-5', 'zai/glm-5.3-flash']);
  assert.deepEqual(spans.map(s => [s.meta.attempt, s.meta.provider, s.settled?.status]), [[1, 'anthropic', 'ok'], [2, 'anthropic', 'thrown'], [3, 'zai', 'ok']]);
  assert.match(String(contexts[1].messages.at(-1)?.content), /Too long/);
  assert.equal(contexts[2].messages.length, 1);
  assert.equal(String(contexts[2].messages.at(-1)?.content).includes('Too long'), false);
});
