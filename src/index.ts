import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ExtensionAPI, ExtensionContext } from '@oh-my-pi/pi-coding-agent';
import { lookup } from '@oh-my-pi/pi-coding-agent/config/registry';
import type { AgentMessage } from '@oh-my-pi/pi-agent-core';
import { Memory } from './memory.ts';
import { createCompressor } from './compactor.ts';
import { profilePath, loadConfig } from './config.ts';
import { lockProfile } from './profiles.ts';
import { asUser, boundedMessage, logMessage } from './transcript.ts';
import { saveImages } from './images.ts';
import { preparePrompt, projectContext, providerPayload, turnStart } from './integration.ts';
import { registerMemoryTools } from './tools.ts';
import { AgentIndex } from './agents.ts';

export default function optchat(pi: ExtensionAPI) {
  pi.registerFlag('optchat', { type: 'string', description: 'Use a never-ending OptChat memory profile (main agent only)' });
  let memory: Memory | undefined, release: (() => Promise<void>) | undefined;
  let agents: AgentIndex | undefined;
  let fault: string | undefined;
  let run: AgentMessage[] = [], logged = 0, running = false;
  /** The run's first message as OMP holds it (asUser turns shown custom messages into user ones for the log). */
  let runFirst: AgentMessage | undefined;
  let view: string | undefined, memories = '', lastStart: AgentMessage | undefined;
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
  const fail = (error: unknown, ctx: ExtensionContext) => {
    fault = error instanceof Error ? error.message : String(error);
    controller.abort(); ctx.abort(); ctx.ui.notify(fault, 'error');
  };
  registerMemoryTools(pi, required, () => {
    if (!agents) throw new Error('OptChat agent index is unavailable.');
    return agents;
  });
  pi.on('session_start', async (_event, ctx) => {
    if (!active(ctx) || memory || fault) return;
    try {
      const dir = profilePath(String(selected()));
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      release = await lockProfile(dir, `OMP PID ${process.pid} (${ctx.cwd})`);
      const config = loadConfig(dir);
      memory = await Memory.open(dir, createCompressor(ctx.modelRegistry, () => config.compactor), text => ctx.ui.notify(text, 'warning'));
      agents = new AgentIndex(dir, text => ctx.ui.notify(text, 'warning'), () => ctx.sessionManager.getSessionFile());
      const setting = lookup('compaction.enabled');
      if (!setting) throw new Error('OMP compaction.enabled setting unavailable.');
      setting.override(pi.pi.settings, false);
      pi.setActiveTools([...new Set([...pi.getActiveTools(), 'zoom', 'date'])]);
      ctx.ui.setStatus('optchat', `OptChat: ${selected()}`);
    } catch (error) {
      fail(error, ctx); await release?.(); release = undefined;
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
    memories = prepared.memories;
    return { systemPrompt: prepared.systemPrompt };
  });
  pi.on('agent_start', (_event, ctx) => {
    if (!active(ctx)) return;
    controller.abort(); controller = new AbortController();
    run = []; runFirst = undefined; logged = 0; view = undefined; running = true;
  });
  pi.on('message_end', async (event, ctx) => {
    if (!active(ctx) || !running) return;
    try {
      const message = boundedMessage(event.message), shown = asUser(message);
      agents!.recordMessage(event.message, ctx.sessionManager.getSessionFile());
      if (shown.role === 'user' || (shown.role === 'toolResult' && shown.toolName !== 'zoom')) await saveImages(required().store, shown.content);
      runFirst ??= event.message;
      run.push(message);
      if (view !== undefined) flush();
    } catch (error) { fail(error, ctx); }
  });
  pi.on('context', async (event, ctx) => {
    if (!active(ctx)) return;
    try {
      const m = required();
      if (running && view === undefined) {
        const show = () => ctx.ui.setWorkingMessage(`Waiting for OptChat summaries…${m.lastError ? ` ${m.lastError}` : ''}`);
        show(); const unsubscribe = m.onChange(show);
        try { await m.settle(controller.signal); } finally { unsubscribe(); ctx.ui.setWorkingMessage(); }
        view = m.render(); flush();
      }
      const first = running ? runFirst : lastStart;
      const at = turnStart(event.messages, first);
      if (running) lastStart = event.messages[at];
      return { messages: projectContext(event.messages, at, running ? view! : m.render(), memories) };
    } catch (error) {
      fail(error, ctx);
      return { messages: [{ role: 'developer' as const, content: 'OptChat context unavailable. Stop.', timestamp: 0 }] };
    }
  });
  pi.on('before_provider_request', (event, ctx) => {
    if (!active(ctx)) return;
    try {
      required();
      const payload = providerPayload(event.payload, true, ctx.agent.kind, ctx.model?.api);
      const dir = process.env.OMP_OPTCHAT_DUMP_DIR;
      if (dir) { mkdirSync(dir, { recursive: true, mode: 0o700 }); writeFileSync(join(dir, `${String(++sequence).padStart(6, '0')}-${ctx.agent.kind}.json`), JSON.stringify(payload, null, 2), { mode: 0o600 }); }
      return payload;
    } catch (error) { fail(error, ctx); throw error; }
  });
  pi.on('agent_end', (_event, ctx) => {
    if (!active(ctx)) return;
    try { flush(); agents!.scan(ctx.sessionManager.getSessionFile()); } catch (error) { fail(error, ctx); }
    running = false;
  });
  pi.on('session_shutdown', async (_event, ctx) => {
    if (!active(ctx)) return;
    controller.abort(); await memory?.close(); await release?.(); release = undefined;
  });
}
