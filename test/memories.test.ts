import { test } from 'bun:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { AgentMessage } from '@oh-my-pi/pi-agent-core';
import { z, Settings } from '@oh-my-pi/pi-coding-agent';
import type { ExtensionAPI, ExtensionContext } from '@oh-my-pi/pi-coding-agent';
import optchat from '../src/index.ts';
import { loadConfig } from '../src/config.ts';

type Hook = (event: object, ctx: ExtensionContext) => unknown;
const RECALL = '<memories>\nrecalled fact\n</memories>';

/** One OptChat turn whose system prompt carries OMP's per-turn memory recall; returns what the model would receive. */
async function turn(config?: object) {
  const dir = mkdtempSync(join(tmpdir(), 'optchat-memories-')), saved = { home: process.env.OMP_OPTCHAT_HOME, code: process.env.OMPCODE };
  delete process.env.OMPCODE;
  const hooks = new Map<string, Hook>();
  const api = {
    zod: z, registerFlag: () => {}, registerTool: () => {}, getFlag: () => 'profile',
    pi: { settings: Settings.isolated() }, getActiveTools: () => [], setActiveTools: () => {},
    on: (name: string, handler: unknown) => hooks.set(name, handler as Hook),
  } as unknown as ExtensionAPI;
  const ctx = {
    agent: { kind: 'main' }, cwd: dir, mode: 'print', sessionManager: { getSessionFile: () => join(dir, 'main.jsonl') },
    modelRegistry: { find: () => { throw new Error('No model calls expected'); } },
    ui: { notify: () => {}, setStatus: () => {}, setWorkingMessage: () => {} }, abort: () => {},
  } as unknown as ExtensionContext;
  try {
    process.env.OMP_OPTCHAT_HOME = dir;
    if (config) { mkdirSync(join(dir, 'profile')); writeFileSync(join(dir, 'profile', 'config.json'), JSON.stringify(config)); }
    optchat(api);
    await hooks.get('session_start')!({}, ctx);
    const prompt = await hooks.get('before_agent_start')!({ systemPrompt: ['SYSTEM', RECALL, '<project-context>p</project-context>'] }, ctx) as { systemPrompt: string[] };
    await hooks.get('agent_start')!({}, ctx);
    const user: AgentMessage = { role: 'user', content: 'hello', timestamp: 1 };
    await hooks.get('message_end')!({ message: user }, ctx);
    const out = await hooks.get('context')!({ messages: [user] }, ctx) as { messages: AgentMessage[] };
    return { system: prompt.systemPrompt.join('\n'), request: JSON.stringify(out.messages) };
  } finally {
    await hooks.get('session_shutdown')?.({}, ctx);
    if (saved.home === undefined) delete process.env.OMP_OPTCHAT_HOME; else process.env.OMP_OPTCHAT_HOME = saved.home;
    if (saved.code !== undefined) process.env.OMPCODE = saved.code;
    rmSync(dir, { recursive: true, force: true });
  }
}

test('OptChat sessions drop OMP memory recall by default; the system prompt never carries it either way', async () => {
  const off = await turn();
  assert.ok(!off.system.includes('recalled fact'));
  assert.ok(!off.request.includes('recalled fact'), 'default: recall is not sent');
  const explicitOff = await turn({ compactor: { provider: 'anthropic', model: 'claude-haiku-5-5', thinking: 'medium' }, memories: false });
  assert.ok(!explicitOff.request.includes('recalled fact'));
  const on = await turn({ compactor: { provider: 'anthropic', model: 'claude-haiku-5-5', thinking: 'medium' }, memories: true });
  assert.ok(!on.system.includes('recalled fact'));
  assert.ok(on.request.indexOf('recalled fact') > on.request.indexOf('</chat>'), 'opt-in: recall follows the view');
});

test('memories config: default false, written to new profiles, invalid values rejected', () => {
  const dir = mkdtempSync(join(tmpdir(), 'optchat-memcfg-'));
  try {
    assert.equal(loadConfig(join(dir, 'fresh')).memories, false);
    mkdirSync(join(dir, 'bad'));
    writeFileSync(join(dir, 'bad', 'config.json'), JSON.stringify({ compactor: { provider: 'a', model: 'b', thinking: 'low' }, memories: 'yes' }));
    assert.throws(() => loadConfig(join(dir, 'bad')), /memories/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
