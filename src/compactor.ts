import { streamSimple, type Api, type AssistantMessage, type Message, type Model } from '@oh-my-pi/pi-ai';
import { ThinkingLevel } from '@oh-my-pi/pi-agent-core';
import type { ModelRegistry } from '@oh-my-pi/pi-coding-agent';
import { COMPACT, compaction, tooLong } from './prompts.ts';
import { bytes, NODE, type Compressor } from './memory.ts';
import { cachePayload, record, splitView } from './cache.ts';
import { EXTRACT_ORDERS, MIGRATE_LEDGER, CONSOLIDATE_ORDERS } from './prompts.ts';
import { orderMap, type OrderDirective, type OrderTask } from './orders.ts';
import { noInstrumentation, type Instrumentation, type SettledMeta } from './measurement.ts';

export interface ModelChoice { provider: string; model: string; thinking: ThinkingLevel }
/** OMP's streamSimple resolves the selected effort against the model's capabilities. */
export const reasoningFor = (model: Model<Api>, level: ThinkingLevel) => {
  const thinking = model.reasoning ? level : 'off';
  return thinking === 'off' || thinking === 'inherit' ? undefined : thinking;
};
const WARM_MS = 4 * 60_000; // Anthropic's short cache lives 5 minutes from its last use.

/** Parallel calls can't read a cache entry that isn't written yet, so one call primes a cold prefix and the rest wait until it answers.
 * Parallel compactions end their views at different messages, so a call also waits for a primer of a shorter prefix of its own view. */
function primeFirst() {
  const warm = new Map<string, number | Promise<void>>();
  return async (prefix: string, signal: AbortSignal) => {
    const priming = () => { for (const [k, state] of warm) if (typeof state !== 'number' && prefix.startsWith(k)) return state; };
    for (let state = warm.get(prefix) ?? priming(); state !== undefined; state = warm.get(prefix) ?? priming()) {
      if (typeof state === 'number') { if (Date.now() - state < WARM_MS) break; warm.delete(prefix); continue; }
      // A cancelled waiter leaves at once instead of waiting for someone else's primer.
      signal.throwIfAborted();
      let wake = () => {};
      const aborted = new Promise<void>(resolve => { wake = resolve; });
      signal.addEventListener('abort', wake, { once: true });
      await Promise.race([state, aborted]);
      signal.removeEventListener('abort', wake);
      signal.throwIfAborted();
    }
    let release = () => {};
    const pending = warm.has(prefix) ? undefined : new Promise<void>(resolve => { release = resolve; });
    if (pending) warm.set(prefix, pending);
    return (ok: boolean) => {
      if (ok) { for (const [k, at] of warm) if (typeof at === 'number' && Date.now() - at >= WARM_MS) warm.delete(k); warm.set(prefix, Date.now()); }
      else if (warm.get(prefix) === pending) warm.delete(prefix);
      release();
    };
  };
}
/** One reply's ORDERS JSON. Invalid JSON, or orders for ids the call did not scan, leave the messages unscanned for the next covering call. */
function parseOrders(text: string, ids: readonly number[]) {
  try { return orderMap(JSON.parse(text.trim().replace(/^```(?:json)?\s*/, '').replace(/\s*```$/, '')), ids); }
  catch { return undefined; }
}
/** How a settled provider call is accounted: pi-ai resolves error and aborted streams into replies rather than throws,
 * so the status comes from the reply when there is one; `usage` is what the provider actually reported — or unknown. */
function outcome(reply: AssistantMessage): SettledMeta {
  if (reply.stopReason === 'aborted') return { status: 'aborted', usage: measured(reply.usage), error: reply.errorMessage };
  if (reply.stopReason === 'error') return { status: 'error', usage: measured(reply.usage), error: reply.errorMessage };
  return { status: 'ok', usage: reply.usage };
}
/** pi-ai initializes a reply's usage all-zero before the provider reports, so a failed or aborted reply carrying only
 * zeros has no measurement behind it: it files as unknown, never as a free failed call. Any nonzero counter is a real
 * provider report and passes through. A successful reply's usage is never second-guessed (see the contract). */
function measured(usage: unknown): unknown {
  if (!record(usage)) return undefined;
  return ['input', 'output', 'cacheRead', 'cacheWrite', 'totalTokens']
    .some(key => typeof usage[key] === 'number' && Number(usage[key]) > 0) ? usage : undefined;
}
/** A provider call that ended in a throw: an aborted signal means the caller cancelled it, anything else is thrown. */
function failure(error: unknown, signal: AbortSignal): SettledMeta {
  return { status: signal.aborted ? 'aborted' : 'thrown', error: error instanceof Error ? error.message : String(error) };
}
/** The model is asked for 512 bytes; `accepted` is the longest line kept without a retry (the profile's summary size tolerance). */
export function createCompressor(registry: ModelRegistry, choice: () => ModelChoice,
  onUsage: (message: AssistantMessage) => void = () => {}, accepted = () => NODE,
  instrument?: Instrumentation): Compressor {
  const gate = primeFirst();
  return async (input, signal) => {
    const selected = choice();
    const model = registry.find(selected.provider, selected.model);
    if (!model) throw new Error(`Compactor model unavailable: ${selected.provider}/${selected.model}. Edit the profile config.json.`);
    const thinking = reasoningFor(model, selected.thinking);
    const step = compaction(input);
    const messages: Message[] = [{ role: 'user', content: [{ type: 'text', text: input.context }, { type: 'text', text: step }], timestamp: Date.now() }];
    const view = splitView(input.context);
    const prefix = model.api === 'anthropic-messages' && view.length > 1 ? `${model.provider}/${model.id}/${thinking ?? 'off'}\n${view.slice(0, -1).join('')}` : undefined;
    const tries: { line: string; orders?: Map<number, OrderDirective[]> }[] = [];
    for (let attempt = 0; attempt < 5; attempt++) {
      const warmed = prefix ? await gate(prefix, signal) : () => {};
      const span = (instrument ?? noInstrumentation)({ purpose: 'summary', provider: model.provider, model: model.id,
        attempt: attempt + 1, part: input.part, ...(input.scan ? { scan: input.scan } : {}) });
      let reply: AssistantMessage;
      try {
        const stream = streamSimple(model, { systemPrompt: [COMPACT], messages }, {
          // A shared session id is the OpenAI prompt-cache key; SSE because over a websocket Codex would chain unrelated parallel calls on one cached connection.
          apiKey: await registry.getApiKey(model), sessionId: 'optchat-compactor',
          reasoning: thinking, signal, cacheRetention: 'short',
          onPayload: payload => {
            // Composition is read off the payload as sent, after the cache transform, which it never changes.
            const transformed = model.api === 'anthropic-messages' ? cachePayload(payload) : payload;
            span.payload(transformed, input.context);
            return transformed;
          },
        });
        // The cache entry is usable once the model starts answering.
        for await (const event of stream) if (event.type !== 'start') { warmed(event.type !== 'error'); break; }
        reply = await stream.result();
        span.settled(outcome(reply));
      } catch (error) { span.settled(failure(error, signal)); throw error; } finally { warmed(false); }
      onUsage(reply);
      if (reply.stopReason === 'error' || reply.stopReason === 'aborted') throw new Error(reply.errorMessage ?? `Compactor ${reply.stopReason}`);
      // The compactions' view shows each line under its id+n| head, which a line can copy.
      const raw = reply.content.filter(c => c.type === 'text').map(c => c.text).join('').trim();
      // With a scan, the orders follow the line after an `ORDERS:` line; they are not part of the line's 512 bytes.
      const at = raw.search(/^ORDERS:/m);
      const line = (at < 0 ? raw : raw.slice(0, at)).trim().replace(/^\d+\+\d+\|\s*/, '');
      if (!line) throw new Error('Compactor returned no text.');
      tries.push({ line, orders: input.scan && at >= 0 ? parseOrders(raw.slice(at + 'ORDERS:'.length), input.scan) : undefined });
      if (bytes(line) <= accepted()) break;
      messages.push(reply);
      const cut = Buffer.from(line).subarray(0, NODE).toString('utf8').replace(/\uFFFD$/, '');
      messages.push({ role: 'user', content: tooLong(bytes(line), cut), timestamp: Date.now() });
    }
    const chosen = tries.reduce((a, b) => bytes(a.line) <= bytes(b.line) ? a : b);
    if (!input.scan) return chosen.line;
    // Each try scans the same messages, so when the accepted line's orders are invalid, the first valid ones this call produced stand.
    return { text: chosen.line, orders: chosen.orders ?? tries.find(t => t.orders)?.orders ?? new Map() };
  };
}

/** Orders reuse the profile's compactor model at medium effort, and never enter the summary tree. */
export function createOrderTask(registry: ModelRegistry, choice: () => ModelChoice,
  onUsage: (message: AssistantMessage) => void = () => {}, instrument?: Instrumentation): OrderTask {
  return async (input, signal) => {
    const selected = choice(), model = registry.find(selected.provider, selected.model);
    if (!model) throw Error(`Compactor model unavailable: ${selected.provider}/${selected.model}`);
    const note = input.kind === 'consolidate' && input.retry ? `${input.retry}\n` : '';
    const messages: Message[] = [{ role: 'user', content: `${note}${JSON.stringify(input.kind === 'consolidate' ? { ...input, retry: undefined } : input)}`, timestamp: Date.now() }];
    const span = (instrument ?? noInstrumentation)({ purpose: input.kind, provider: model.provider, model: model.id,
      attempt: 1, ...(input.kind === 'consolidate' && input.retry ? { retry: true } : {}) });
    let reply: AssistantMessage;
    try {
      reply = await streamSimple(model, {
        systemPrompt: [input.kind === 'backfill' ? EXTRACT_ORDERS : input.kind === 'migrate' ? MIGRATE_LEDGER : CONSOLIDATE_ORDERS], messages,
      }, { apiKey: await registry.getApiKey(model), sessionId: 'optchat-orders', reasoning: reasoningFor(model, ThinkingLevel.Medium),
        signal, cacheRetention: 'short',
        // The composition reads the payload as sent; orders carry no cache transform, so it passes through untouched.
        onPayload: payload => { span.payload(payload); return payload; } }).result();
      span.settled(outcome(reply));
    } catch (error) { span.settled(failure(error, signal)); throw error; }
    onUsage(reply);
    if (reply.stopReason === 'error' || reply.stopReason === 'aborted') throw Error(reply.errorMessage ?? `Orders ${reply.stopReason}`);
    const text = reply.content.filter(c => c.type === 'text').map(c => c.text).join('').trim();
    return JSON.parse(text.replace(/^```(?:json)?\s*/, '').replace(/\s*```$/, ''));
  };
}
