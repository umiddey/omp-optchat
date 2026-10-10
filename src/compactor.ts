import { streamSimple, type Api, type AssistantMessage, type Message, type Model } from '@oh-my-pi/pi-ai';
import type { ThinkingLevel } from '@oh-my-pi/pi-agent-core';
import type { ModelRegistry } from '@oh-my-pi/pi-coding-agent';
import { COMPACT, compaction, tooLong } from './prompts.ts';
import { bytes, NODE, type Compressor } from './memory.ts';
import { cachePayload, splitView } from './cache.ts';

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
/** The model is asked for 512 bytes; `accepted` is the longest line kept without a retry (the profile's summary size tolerance). */
export function createCompressor(registry: ModelRegistry, choice: () => ModelChoice,
  onUsage: (message: AssistantMessage) => void = () => {}, accepted = () => NODE): Compressor {
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
    const tries: string[] = [];
    for (let attempt = 0; attempt < 5; attempt++) {
      const warmed = prefix ? await gate(prefix, signal) : () => {};
      let reply: AssistantMessage;
      try {
        const stream = streamSimple(model, { systemPrompt: [COMPACT], messages }, {
          // A shared session id is the OpenAI prompt-cache key; SSE because over a websocket Codex would chain unrelated parallel calls on one cached connection.
          apiKey: await registry.getApiKey(model), sessionId: 'optchat-compactor',
          reasoning: thinking, signal, cacheRetention: 'short',
          onPayload: payload => model.api === 'anthropic-messages' ? cachePayload(payload) : payload,
        });
        // The cache entry is usable once the model starts answering.
        for await (const event of stream) if (event.type !== 'start') { warmed(event.type !== 'error'); break; }
        reply = await stream.result();
      } finally { warmed(false); }
      onUsage(reply);
      if (reply.stopReason === 'error' || reply.stopReason === 'aborted') throw new Error(reply.errorMessage ?? `Compactor ${reply.stopReason}`);
      // The compactions' view shows each line under its id+n| head, which a line can copy.
      const line = reply.content.filter(c => c.type === 'text').map(c => c.text).join('').trim().replace(/^\d+\+\d+\|\s*/, '');
      if (!line) throw new Error('Compactor returned no text.');
      tries.push(line);
      if (bytes(line) <= accepted()) break;
      messages.push(reply);
      const cut = Buffer.from(line).subarray(0, NODE).toString('utf8').replace(/\uFFFD$/, '');
      messages.push({ role: 'user', content: tooLong(bytes(line), cut), timestamp: Date.now() });
    }
    return tries.reduce((a, b) => bytes(a) <= bytes(b) ? a : b);
  };
}
