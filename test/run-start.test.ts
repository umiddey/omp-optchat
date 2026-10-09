import { test } from 'bun:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { AgentMessage } from '@oh-my-pi/pi-agent-core';
import { z, Settings } from '@oh-my-pi/pi-coding-agent';
import type { ExtensionAPI, ExtensionContext } from '@oh-my-pi/pi-coding-agent';
import optchat from '../src/index.ts';

type Hook = (event: { message?: AgentMessage; messages?: AgentMessage[] }, ctx: ExtensionContext) => unknown;

// OMP's agent-core emits message_end fire-and-forget (agent-session.ts "message_end handling is fire-and-forget"), so the first
// provider request of a run can reach `context` before the run's first message_end handler ran. A run started by a background
// result must still open at that result, not at the previous turn's user message (live: 45k tokens of old turn re-sent).
test('a run started by a background result opens at the result even when context precedes its message_end', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'optchat-runstart-')), oldHome = process.env.OMP_OPTCHAT_HOME;
  const hooks = new Map<string, Hook>(), faults: string[] = [];
  const api = {
    zod: z, registerFlag: () => {}, registerTool: () => {}, getFlag: () => 'profile',
    pi: { settings: Settings.isolated() }, getActiveTools: () => [], setActiveTools: () => {},
    on: (name: string, handler: unknown) => hooks.set(name, handler as Hook),
  } as unknown as ExtensionAPI;
  const ctx = {
    agent: { kind: 'main' }, cwd: dir, mode: 'print',
    sessionManager: { getSessionFile: () => join(dir, 'main.jsonl') },
    modelRegistry: { find: () => { throw new Error('No model calls expected'); } },
    ui: { notify: (text: string, kind: string) => { if (kind === 'error') faults.push(text); }, setStatus: () => {}, setWorkingMessage: () => {} },
    abort: () => faults.push('abort'),
  } as unknown as ExtensionContext;
  const user: AgentMessage = { role: 'user', content: 'hello', timestamp: 1 };
  const reply = { role: 'assistant', content: [{ type: 'text', text: 'hi' }], stopReason: 'stop', timestamp: 2 } as unknown as AgentMessage;
  const result: AgentMessage = { role: 'custom', customType: 'async-result', display: true, content: 'job done', timestamp: 3 };
  try {
    process.env.OMP_OPTCHAT_HOME = dir; optchat(api);
    await hooks.get('session_start')!({}, ctx);
    await hooks.get('agent_start')!({}, ctx);
    await hooks.get('message_end')!({ message: user }, ctx);
    await hooks.get('context')!({ messages: [user] }, ctx);
    await hooks.get('message_end')!({ message: reply }, ctx);
    await hooks.get('agent_end')!({}, ctx);

    await hooks.get('agent_start')!({}, ctx);
    const out = await hooks.get('context')!({ messages: [user, reply, result] }, ctx) as { messages: AgentMessage[] };
    await hooks.get('message_end')!({ message: result }, ctx);
    assert.deepEqual(faults, []);
    assert.deepEqual(out.messages.map(m => m.role), ['user', 'custom'], 'the view opens the run; the old turn is not re-sent');
    assert.equal(out.messages[1], result);
    const second = await hooks.get('context')!({ messages: [user, reply, result, reply] }, ctx) as { messages: AgentMessage[] };
    assert.deepEqual(second.messages.map(m => m.role), ['user', 'custom', 'assistant'], 'later requests keep the same opening');
    assert.deepEqual(second.messages[0], out.messages[0]);
  } finally {
    await hooks.get('session_shutdown')?.({}, ctx);
    if (oldHome === undefined) delete process.env.OMP_OPTCHAT_HOME; else process.env.OMP_OPTCHAT_HOME = oldHome;
    rmSync(dir, { recursive: true, force: true });
  }
});
