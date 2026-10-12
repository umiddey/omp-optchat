import { streamSimple, type Api, type AssistantMessage, type Message, type Model } from '@oh-my-pi/pi-ai';
import { ThinkingLevel } from '@oh-my-pi/pi-agent-core';
import type { ModelRegistry } from '@oh-my-pi/pi-coding-agent';
import { COMPACT, compaction, tooLong } from './prompts.ts';
import { bytes, NODE, type Compressor } from './memory.ts';
import { cachePayload, record, splitView } from './cache.ts';
import { classifyFailure, providerAvailability, waitCancelable } from './fallback.ts';
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
/** A candidate that cannot serve this invocation, for the aggregate error when none can. */
interface Setback { name: string; label: string; until?: number }

export interface CompressorOptions {
  /** Ordered candidates tried after the primary, in the given order, provider/model deduped. Absent (or yielding
   * nothing beyond the primary) keeps the single-provider contract: raw failures, no availability memory. */
  fallbacks?: () => readonly ModelChoice[];
  /** Bounded warning channel: one message per provider transition after a failure, never per skipped candidate or node. */
  warn?: (text: string) => void;
}
/** The HTTP status a thrown provider error carried, when it did — pi-ai throws ProviderHttpError-shaped errors. */
const thrownStatus = (error: unknown): number | undefined => {
  if (typeof error === 'object' && error !== null && 'status' in error && typeof error.status === 'number') return error.status;
  if (typeof error === 'object' && error !== null && 'statusCode' in error && typeof error.statusCode === 'number') return error.statusCode;
  return undefined;
};
/** Warns about one provider transition; silent when nothing follows, since the invocation's own error carries the facts. */
function warnFallback(warn: ((text: string) => void) | undefined, chain: readonly ModelChoice[], c: number, reason: string) {
  const next = chain[c + 1];
  if (warn && next) warn(`Compactor: ${chain[c].provider}/${chain[c].model} ${reason}; falling back to ${next.provider}/${next.model}.`);
}
/** The model is asked for 512 bytes; `accepted` is the longest line kept without a retry (the profile's summary size tolerance). */
export function createCompressor(registry: ModelRegistry, choice: () => ModelChoice,
  onUsage: (message: AssistantMessage) => void = () => {}, accepted = () => NODE,
  instrument?: Instrumentation, options?: CompressorOptions): Compressor {
  const gate = primeFirst();
  return async (input, signal) => {
    const chain: ModelChoice[] = [];
    const seen = new Set<string>();
    for (const candidate of [choice(), ...(options?.fallbacks?.() ?? [])]) {
      const key = `${candidate.provider}/${candidate.model}`;
      if (!seen.has(key)) { seen.add(key); chain.push(candidate); }
    }
    // Without fallback candidates the compressor keeps its single-provider contract: raw failures, no cooldowns, no probes.
    const availability = chain.length > 1 ? providerAvailability() : undefined;
    const warn = options?.warn;
    const step = compaction(input);
    const view = splitView(input.context);
    const setbacks: Setback[] = [];
    let attempt = 0;
    outer: for (let c = 0; c < chain.length; c++) {
      const selected = chain[c];
      const name = `${selected.provider}/${selected.model}`;
      const model = registry.find(selected.provider, selected.model);
      if (!model) {
        if (!availability) throw new Error(`Compactor model unavailable: ${name}. Edit the profile config.json.`);
        setbacks.push({ name, label: `model ${selected.model} not in registry` });
        warnFallback(warn, chain, c, 'is not in the model registry');
        continue;
      }
      const thinking = reasoningFor(model, selected.thinking);
      const prefix = model.api === 'anthropic-messages' && view.length > 1 ? `${model.provider}/${model.id}/${thinking ?? 'off'}\n${view.slice(0, -1).join('')}` : undefined;
      // Each provider's size-retry conversation starts fresh from the original input; a failed provider's output and
      // thinking never reach the next one.
      const messages: Message[] = [{ role: 'user', content: [{ type: 'text', text: input.context }, { type: 'text', text: step }], timestamp: Date.now() }];
      const tries: string[] = [];
      while (attempt < 5) {
        // One probe at a time into a provider of unknown availability; followers wait cancelably and re-evaluate.
        let release: (outcome?: 'up' | 'down') => void = () => {};
        try {
          if (availability) {
            const claim = availability.claim(selected.provider);
            if (claim.kind === 'cooled') { setbacks.push({ name, label: 'cooling down', until: claim.until }); continue outer; }
            if (claim.kind === 'wait') { await waitCancelable(claim.done, signal); continue outer; }
            if (claim.kind === 'probe') release = claim.release;
          }
          const warmed = prefix ? await gate(prefix, signal) : () => {};
          // The provider can cool while this call waited on the prefix cache gate; re-check before sending.
          const cooling = availability?.cooled(selected.provider);
          if (cooling !== undefined) { warmed(false); setbacks.push({ name, label: 'cooling down', until: cooling }); continue outer; }
          const span = (instrument ?? noInstrumentation)({ purpose: 'summary', provider: model.provider, model: model.id,
            attempt: ++attempt, part: input.part });
          let reply: AssistantMessage;
          try {
            let apiKey: string;
            try { apiKey = await registry.getApiKey(model); }
            catch (error) {
              span.settled(failure(error, signal));
              if (signal.aborted || !availability) throw error;
              setbacks.push({ name, label: 'credential unavailable' });
              release();
              warnFallback(warn, chain, c, 'credential unavailable');
              continue outer;
            }
            const stream = streamSimple(model, { systemPrompt: [COMPACT], messages }, {
              // A shared session id is the OpenAI prompt-cache key; SSE because over a websocket Codex would chain unrelated parallel calls on one cached connection.
              apiKey, sessionId: 'optchat-compactor',
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
          } catch (error) {
            span.settled(failure(error, signal));
            // An aborted signal is the caller's cancellation: always exit, never fall back.
            if (signal.aborted || !availability) throw error;
            const lane = classifyFailure(selected.provider, thrownStatus(error), error instanceof Error ? error.message : String(error));
            if (!lane.fallback) { release('up'); throw error; }
            const until = availability.cool(selected.provider, lane.cooldownMs ?? 0);
            setbacks.push({ name, label: lane.label, until });
            release('down');
            warnFallback(warn, chain, c, `${lane.label} until ${new Date(until).toISOString()}`);
            continue outer;
          } finally { warmed(false); }
          onUsage(reply);
          if (reply.stopReason === 'aborted') throw new Error(reply.errorMessage ?? `Compactor aborted`);
          if (reply.stopReason === 'error') {
            if (!availability) throw new Error(reply.errorMessage ?? `Compactor error`);
            const lane = classifyFailure(selected.provider, reply.errorStatus, reply.errorMessage ?? '');
            if (!lane.fallback) { release('up'); throw new Error(reply.errorMessage ?? `Compactor error`); }
            const until = availability.cool(selected.provider, lane.cooldownMs ?? 0);
            setbacks.push({ name, label: lane.label, until });
            release('down');
            warnFallback(warn, chain, c, `${lane.label} until ${new Date(until).toISOString()}`);
            continue outer;
          }
          release('up');
          // The compactions' view shows each line under its id+n| head, which a line can copy.
          const line = reply.content.filter(c => c.type === 'text').map(c => c.text).join('').trim().replace(/^\d+\+\d+\|\s*/, '');
          if (!line) throw new Error('Compactor returned no text.');
          tries.push(line);
          if (bytes(line) <= accepted()) return tries.reduce((a, b) => bytes(a) <= bytes(b) ? a : b);
          messages.push(reply);
          const cut = Buffer.from(line).subarray(0, NODE).toString('utf8').replace(/\uFFFD$/, '');
          messages.push({ role: 'user', content: tooLong(bytes(line), cut), timestamp: Date.now() });
        } finally { release(); }
      }
      if (tries.length > 0) return tries.reduce((a, b) => bytes(a) <= bytes(b) ? a : b);
    }
    // Every candidate is gone: name each setback and when the soonest reset lets a compression try again — never a fake summary.
    const resets = setbacks.flatMap(s => s.until !== undefined ? [s.until] : []);
    const retryAt = resets.length > 0 ? new Date(Math.min(...resets)).toISOString() : undefined;
    throw new Error(`Compactor providers unavailable.${retryAt ? ` Next retry ${retryAt}.` : ''} ${setbacks.map(s => `${s.name}: ${s.label}${s.until !== undefined ? ` until ${new Date(s.until).toISOString()}` : ''}`).join('; ')}`);
  };
}
