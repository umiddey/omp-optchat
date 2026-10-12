import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ExtensionAPI, ExtensionContext } from '@oh-my-pi/pi-coding-agent';
import { lookup } from '@oh-my-pi/pi-coding-agent/config/registry';
import type { AgentMessage } from '@oh-my-pi/pi-agent-core';
import { Memory } from './memory.ts';
import { createCompressor } from './compactor.ts';
import { defaults, profilePath, loadConfig, firstRun, WELCOME } from './config.ts';
import { lockProfile } from './profiles.ts';
import { asUser, boundedMessage, logMessage } from './transcript.ts';
import { saveImages } from './images.ts';
import { preparePrompt, projectContext, providerPayload, rawBytes, turnStart } from './integration.ts';
import { registerMemoryTools } from './tools.ts';
import { AgentIndex } from './agents.ts';
import { MEASURE_DIR_ENV, openMeasurement, type Instrumentation, type Measurement } from './measurement.ts';
import type { CacheState } from './cache.ts';

/** OMP caps every extension handler at 30 s (extensions/runner.ts EXTENSION_HANDLER_TIMEOUT_MS) and keeps the unprojected
 * session history when a `context` handler crosses the cap, so the wait for summaries is bounded at 25 s. Past the budget
 * the turn renders what has landed (unbuilt lines carry the zoom recipe) while the remaining builds continue in the
 * background. OMP_OPTCHAT_SETTLE_BUDGET_MS shrinks the budget in tests only; production keeps the constant. */
export const SETTLE_BUDGET_MS = 25_000;

export default function optchat(pi: ExtensionAPI) {
  pi.registerFlag('optchat', { type: 'string', description: 'Use a never-ending OptChat memory profile (main agent only)' });
  let memory: Memory | undefined, release: (() => Promise<void>) | undefined;
  let measurement: Measurement | undefined;
  let agents: AgentIndex | undefined;
  const cache: CacheState = {};
  let fault: string | undefined;
  let run: AgentMessage[] = [], logged = 0, running = false;
  /** The run's first message as OMP holds it (asUser turns shown custom messages into user ones for the log). */
  let runFirst: AgentMessage | undefined;
  let view: string | undefined, memories = '', lastStart: AgentMessage | undefined;
  let runLimit = defaults.runLimit, recall = defaults.memories, cut: AgentMessage | undefined;
  const seen = new Set<string>();
  /** The previous run's last message: everything after it opens the next run, even before that run's first message_end ran. */
  let lastEnd: AgentMessage | undefined;
  let controller = new AbortController(), sequence = 0;
  // OMP marks shells it spawns with OMPCODE=1: an omp started from one inherits OMP_OPTCHAT but must not take the profile.
  const selected = () => pi.getFlag('optchat') || (process.env.OMPCODE === '1' ? undefined : process.env.OMP_OPTCHAT);
  const active = (ctx: ExtensionContext) => ctx.agent.kind === 'main' && !!selected();
  const required = () => {
    if (fault) throw new Error(fault);
    if (!memory) throw new Error('OptChat profile is unavailable.');
    return memory;
  };
  const flush = () => { const m = required(); while (logged < run.length) { logMessage(m, run[logged]); logged++; } };
  const settleBudget = () => {
    const injected = Number(process.env.OMP_OPTCHAT_SETTLE_BUDGET_MS);
    return Number.isSafeInteger(injected) && injected > 0 ? injected : SETTLE_BUDGET_MS;
  };
  /** Waits for the summaries at most SETTLE_BUDGET_MS: OMP caps every extension handler at 30 s and keeps the unprojected
   * history when a `context` handler crosses it. Past the budget (or once settle finishes) the caller renders; the
   * background work is left running. The working message shows as today, and expiry is normal, not a fault. */
  const waitSummaries = async (m: Memory, ctx: ExtensionContext) => {
    const show = () => ctx.ui.setWorkingMessage(`Waiting for OptChat summaries…${m.lastError ? ` ${m.lastError}` : ''}`);
    show(); const unsubscribe = m.onChange(show);
    try {
      const budget = Promise.withResolvers<void>();
      const timer = setTimeout(budget.resolve, settleBudget());
      try { await Promise.race([m.settle(controller.signal), budget.promise]); } finally { clearTimeout(timer); }
    } finally { unsubscribe(); ctx.ui.setWorkingMessage(); }
  };
  // context can precede fire-and-forget message_end. Claim before awaiting image I/O so catch-up cannot log twice.
  const recordMessage = async (original: AgentMessage, ctx: ExtensionContext) => {
    const key = `${original.role}:${original.timestamp}:${original.role === 'toolResult' ? original.toolCallId : original.role === 'custom' ? original.customType : ''}`;
    if (seen.has(key)) return;
    seen.add(key);
    const message = boundedMessage(original), shown = asUser(message);
    agents!.recordMessage(original, ctx.sessionManager.getSessionFile());
    runFirst ??= original;
    run.push(message);
    if (shown.role === 'user' || (shown.role === 'toolResult' && shown.toolName !== 'zoom')) await saveImages(required().store, shown.content);
    if (view !== undefined) flush();
  };
  const fail = (error: unknown, ctx: ExtensionContext) => {
    fault = error instanceof Error ? error.message : String(error);
    controller.abort(); ctx.abort(); ctx.ui.notify(fault, 'error');
  };
  registerMemoryTools(pi, required, () => {
    if (!agents) throw new Error('OptChat agent index is unavailable.');
    return agents;
  });
  pi.on('session_start', async (_event, ctx) => {
    if (!active(ctx)) {
      // UI only, never model context: a plain session's prompt and cache stay untouched.
      // A read-only or broken OptChat home must never disturb a plain session; the hint is simply skipped.
      try { if (ctx.agent.kind === 'main' && ctx.mode === 'tui' && process.env.OMPCODE !== '1' && firstRun()) ctx.ui.notify(WELCOME, 'info'); } catch {}
      return;
    }
    if (memory || fault) return;
    try {
      firstRun();
      const dir = profilePath(String(selected()));
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      cache.file = join(dir, 'cache.json');
      release = await lockProfile(dir, `OMP PID ${process.pid} (${ctx.cwd})`);
      const config = loadConfig(dir);
      runLimit = config.runLimit; recall = config.memories;
      // Telemetry lands in the profile, or wherever OMP_OPTCHAT_MEASURE_DIR points for benchmark runs; it never
      // faults the session — openMeasurement warns boundedly and keeps working, or drops rows.
      const telemetry = openMeasurement(process.env[MEASURE_DIR_ENV] ?? dir, text => ctx.ui.notify(text, 'warning'));
      measurement = telemetry;
      // The span source is the sink itself, not the `measurement` slot: a straggling background call at shutdown
      // must settle into the (closed, appendable-again) files instead of dereferencing a cleared variable.
      const instrument: Instrumentation = meta => telemetry.invoke(meta);
      memory = await Memory.open(dir, createCompressor(ctx.modelRegistry, () => config.compactor, undefined, undefined, instrument,
        { fallbacks: () => config.compactorFallbacks, warn: text => ctx.ui.notify(text, 'warning') }), text => ctx.ui.notify(text, 'warning'), undefined, undefined);
      agents = new AgentIndex(dir, text => ctx.ui.notify(text, 'warning'), () => ctx.sessionManager.getSessionFile());
      const setting = lookup('compaction.enabled');
      if (!setting) throw new Error('OMP compaction.enabled setting unavailable.');
      setting.override(pi.pi.settings, false);
      pi.setActiveTools([...new Set([...pi.getActiveTools(), 'zoom', 'date'])]);
      ctx.ui.setStatus('optchat', `OptChat: ${selected()}`);
    } catch (error) {
      fail(error, ctx); await release?.(); release = undefined;
      measurement?.close(); measurement = undefined;
      if (ctx.mode !== 'tui') throw error;
    }
  });
  pi.on('input', (_event, ctx) => {
    if (!active(ctx) || !fault) return;
    if (ctx.mode === 'tui') { ctx.ui.notify(fault, 'error'); return { handled: true }; }
    throw new Error(fault);
  });
  pi.on('session_before_compact', (_event, ctx) => { if (active(ctx)) return { cancel: true }; });
  pi.on('before_agent_start', (event, ctx) => {
    if (!active(ctx)) return;
    const prepared = preparePrompt(event.systemPrompt);
    memories = recall ? prepared.memories : '';
    return { systemPrompt: prepared.systemPrompt };
  });
  pi.on('agent_start', (_event, ctx) => {
    if (!active(ctx)) return;
    controller.abort(); controller = new AbortController();
    run = []; runFirst = undefined; logged = 0; view = undefined; cut = undefined; seen.clear(); running = true;
  });
  pi.on('message_end', async (event, ctx) => {
    if (!active(ctx) || !running) return;
    try {
      await recordMessage(event.message, ctx);
    } catch (error) { fail(error, ctx); }
  });
  pi.on('context', async (event, ctx) => {
    if (!active(ctx)) return;
    // A newer message (agent_start) or shutdown aborts this signal: the wait ends and this run is superseded, not broken.
    const signal = controller.signal;
    try {
      const m = required();
      if (running && view === undefined) {
        await waitSummaries(m, ctx);
        view = m.render(); flush();
      }
      // OMP emits message_end fire-and-forget, so the first request of a run can arrive before runFirst is set.
      if (running && !runFirst && lastEnd) {
        const end = lastEnd, at = event.messages.findLastIndex(m => m.role === end.role && m.timestamp === end.timestamp);
        if (at >= 0) runFirst = event.messages[at + 1];
      }
      const first = running ? runFirst : lastStart;
      let at = turnStart(event.messages, first);
      // OMP may insert or rewrite history between requests; anchor the cut like the run's first message.
      const anchor = cut;
      let from = anchor ? event.messages.findLastIndex(message => message.role === anchor.role && message.timestamp === anchor.timestamp) : -1;
      if (from <= at) { from = at + 1; cut = undefined; }
      if (running) {
        lastStart = event.messages[at];
        if (rawBytes(event.messages, from) > runLimit) {
          const next = event.messages.findLastIndex(message => message.role === 'assistant');
          if (next > from) {
            // Flush even messages whose message_end has not run yet, before waiting for their summaries.
            for (const message of event.messages.slice(at, next)) await recordMessage(message, ctx);
            flush();
            await waitSummaries(m, ctx);
            view = m.render(); cut = event.messages[next]; from = next;
            // Messages typed into a running turn join this run; after the fold the newest of them is the current message,
            // not the run opener (else the model answers a stale prompt while the new one sits only in the view).
            const newest = event.messages.findLastIndex((message, index) => index > at && index < next && message.role === 'user');
            if (newest > at) { at = newest; runFirst = lastStart = event.messages[at]; }
          }
        }
      }
      return { messages: projectContext(event.messages, at, running ? view! : m.render(), memories, true, 'main', from) };
    } catch (error) {
      if (signal.aborted && !fault) return { messages: [{ role: 'developer' as const, content: 'OptChat: superseded by a newer message. Stop.', timestamp: 0 }] };
      fail(error, ctx);
      return { messages: [{ role: 'developer' as const, content: 'OptChat context unavailable. Stop.', timestamp: 0 }] };
    }
  });
  pi.on('before_provider_request', (event, ctx) => {
    if (!active(ctx)) return;
    try {
      required();
      const payload = providerPayload(event.payload, true, ctx.agent.kind, ctx.model?.api, cache);
      // Composition of the request as sent, read after the cache transform; the payload itself is returned unchanged.
      // Usage for these foreground calls is OMP's own session journal, so only the composition is recorded here.
      if (measurement) measurement.request(payload, ctx.model ? { provider: ctx.model.provider, id: ctx.model.id } : undefined, running ? view : undefined);
      const dir = process.env.OMP_OPTCHAT_DUMP_DIR;
      if (dir) { mkdirSync(dir, { recursive: true, mode: 0o700 }); writeFileSync(join(dir, `${String(++sequence).padStart(6, '0')}-${ctx.agent.kind}.json`), JSON.stringify(payload, null, 2), { mode: 0o600 }); }
      return payload;
    } catch (error) { fail(error, ctx); throw error; }
  });
  pi.on('agent_end', (_event, ctx) => {
    if (!active(ctx)) return;
    try { flush(); lastEnd = run.at(-1) ?? lastEnd; agents!.scan(ctx.sessionManager.getSessionFile()); } catch (error) { fail(error, ctx); }
    running = false;
  });
  pi.on('session_shutdown', async (_event, ctx) => {
    if (!active(ctx)) return;
    controller.abort(); await memory?.close(); await release?.(); release = undefined;
    measurement?.close(); measurement = undefined;
  });
}
