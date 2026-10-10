import { test, expect } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z, Settings, type ExtensionAPI, type ExtensionContext } from '@oh-my-pi/pi-coding-agent';
import type { AgentMessage } from '@oh-my-pi/pi-agent-core';
import optchat from '../src/index.ts';
import { defaults, loadConfig } from '../src/config.ts';
import { projectContext, rawBytes } from '../src/integration.ts';

type Hook = (event: { message?: AgentMessage; messages?: AgentMessage[] }, ctx: ExtensionContext) => Promise<{ messages: AgentMessage[] }>;
class Hooks extends Map<string, Hook> {
  override get(name: string): Hook {
    const hook = super.get(name);
    if (!hook) throw Error(`Missing hook ${name}`);
    return hook;
  }
}
const assistant = (timestamp: number, text: string) => ({ role: 'assistant', content: [{ type: 'thinking', thinking: 'keep this thinking' }, { type: 'text', text }, { type: 'toolCall', id: `call${timestamp}`, name: 'bash', arguments: { command: 'true' } }], stopReason: 'toolUse', timestamp }) as unknown as AgentMessage;
const result = (timestamp: number, text: string): AgentMessage => ({ role: 'toolResult', toolCallId: `call${timestamp - 1}`, toolName: 'bash', content: [{ type: 'text', text }], isError: false, timestamp });
async function harness(limit: number, fn: (hooks: Hooks, ctx: ExtensionContext) => Promise<void>) {
  const dir = mkdtempSync(join(tmpdir(), 'optchat-runlimit-'));
  const oldHome = process.env.OMP_OPTCHAT_HOME, oldCode = process.env.OMPCODE;
  const hooks = new Hooks(), faults: string[] = [];
  mkdirSync(join(dir, 'profile')); writeFileSync(join(dir, 'profile', 'config.json'), JSON.stringify({ ...defaults, runLimit: limit }));
  const api = { zod: z, registerFlag() {}, registerTool() {}, getFlag: () => 'profile', pi: { settings: Settings.isolated() }, getActiveTools: () => [], setActiveTools() {}, on: (name: string, hook: unknown) => hooks.set(name, hook as Hook) } as unknown as ExtensionAPI;
  const ctx = { agent: { kind: 'main' }, cwd: dir, mode: 'print', sessionManager: { getSessionFile: () => join(dir, 'main.jsonl') }, modelRegistry: { find: () => { throw Error('Unexpected model call'); } }, ui: { notify: (text: string, kind: string) => { if (kind === 'error') faults.push(text); }, setStatus() {}, setWorkingMessage() {} }, abort: () => faults.push('abort') } as unknown as ExtensionContext;
  try { process.env.OMP_OPTCHAT_HOME = dir; delete process.env.OMPCODE; optchat(api); await hooks.get('session_start')({}, ctx); await hooks.get('agent_start')({}, ctx); await fn(hooks, ctx); expect(faults).toEqual([]); }
  finally { await hooks.get('session_shutdown')?.({}, ctx); if (oldHome === undefined) delete process.env.OMP_OPTCHAT_HOME; else process.env.OMP_OPTCHAT_HOME = oldHome; if (oldCode === undefined) delete process.env.OMPCODE; else process.env.OMPCODE = oldCode; rmSync(dir, { recursive: true, force: true }); }
}
const first: AgentMessage = { role: 'user', content: 'Keep the original task visible', timestamp: 1 };
test('rollover logs missing message_end prefix and keeps latest assistant and tool results byte-identical', async () => {
  await harness(100, async (hooks, ctx) => {
    await hooks.get('message_end')({ message: first }, ctx);
    await hooks.get('context')({ messages: [first] }, ctx);
    const old = assistant(2, 'EARLIER TALK'), echo = result(3, 'EARLIER RESULT ' + 'é'.repeat(60));
    const latest = assistant(4, 'LATEST TALK'), tail = result(5, 'LATEST RESULT');
    const injected: AgentMessage = { role: 'custom', customType: 'async-result', display: true, content: 'injected', timestamp: 6 };
    const out = await hooks.get('context')({ messages: [first, old, echo, latest, tail, injected] }, ctx);
    expect(out.messages.slice(1)).toEqual([latest, tail, injected]);
    expect(out.messages[1]).toBe(latest);
    expect(JSON.stringify(out.messages[1])).toBe(JSON.stringify(latest));
    const opening = JSON.stringify(out.messages[0]);
    expect(opening).toContain('EARLIER TALK'); expect(opening).toContain('EARLIER RESULT'); expect(opening).toContain('Keep the original task visible');
    for (const message of [old, echo, latest, tail, injected]) await hooks.get('message_end')({ message }, ctx);
    const again = await hooks.get('context')({ messages: [first, old, echo, latest, tail, injected] }, ctx);
    expect(again.messages).toEqual(out.messages);
  });
});
test('between cuts the opening is fixed and the tail only appends', async () => {
  await harness(1000, async (hooks, ctx) => {
    await hooks.get('message_end')({ message: first }, ctx); await hooks.get('context')({ messages: [first] }, ctx);
    const old = assistant(2, 'old'), echo = result(3, 'x'.repeat(1100)), latest = assistant(4, 'new');
    const a = await hooks.get('context')({ messages: [first, old, echo, latest] }, ctx);
    const b = await hooks.get('context')({ messages: [first, old, echo, latest, result(5, 'small')] }, ctx);
    expect(a.messages.length).toBe(2); expect(b.messages.slice(0, 2)).toEqual(a.messages);
  });
});
test('under runLimit projection is unchanged', async () => {
  await harness(10000, async (hooks, ctx) => {
    await hooks.get('message_end')({ message: first }, ctx);
    const a = await hooks.get('context')({ messages: [first] }, ctx);
    const message = a.messages[0];
    if (!message || !('content' in message)) throw Error('Missing opening');
    const opening = message.content;
    if (!Array.isArray(opening) || opening[0]?.type !== 'text') throw Error('Missing view');
    const view = opening[0].text;
    const messages = [first, assistant(2, 'small'), result(3, 'small')];
    const b = await hooks.get('context')({ messages }, ctx);
    expect(b.messages).toEqual(projectContext(messages, 0, view, ''));
  });
});
test('runLimit config loads, defaults for existing profiles, and rejects invalid values', () => {
  const dir = mkdtempSync(join(tmpdir(), 'optchat-runlimit-config-'));
  try {
    writeFileSync(join(dir, 'config.json'), JSON.stringify({ compactor: defaults.compactor })); expect(loadConfig(dir)).toHaveProperty('runLimit', 256000);
    writeFileSync(join(dir, 'config.json'), JSON.stringify({ ...defaults, runLimit: 6000 })); expect(loadConfig(dir)).toHaveProperty('runLimit', 6000);
    for (const runLimit of [0, -1, 1.5, '6000', null, 9007199254740992]) { writeFileSync(join(dir, 'config.json'), JSON.stringify({ ...defaults, runLimit })); expect(() => loadConfig(dir)).toThrow(/Invalid runLimit configuration/); }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('raw byte accounting includes UTF-8, thinking, tool names/JSON arguments, results and custom content', () => {
  const talk = assistant(2, 'é');
  const echo = result(3, '🦉');
  const custom: AgentMessage = { role: 'custom', customType: 'async-result', display: true, content: 'é', timestamp: 4 };
  expect(rawBytes([first, talk, echo, custom], 1)).toBe(Buffer.byteLength('keep this thinkingébash{\"command\":\"true\"}🦉é'));
});

test('an oversized last assistant batch does not cut again until a newer assistant exists', async () => {
  await harness(100, async (hooks, ctx) => {
    await hooks.get('message_end')({ message: first }, ctx);
    await hooks.get('context')({ messages: [first] }, ctx);
    const old = assistant(2, 'old'), echo = result(3, 'x'.repeat(200)), latest = assistant(4, 'latest'), large = result(5, 'y'.repeat(200));
    const messages = [first, old, echo, latest, large];
    const a = await hooks.get('context')({ messages }, ctx);
    const b = await hooks.get('context')({ messages }, ctx);
    expect(b.messages).toEqual(a.messages);
    expect(b.messages.slice(1)).toEqual([latest, large]);
    const next = assistant(6, 'next');
    const c = await hooks.get('context')({ messages: [...messages, next] }, ctx);
    expect(c.messages.slice(1)).toEqual([next]);
    expect(JSON.stringify(c.messages[0])).toContain('latest');
  });
});

test('rollover cut follows its message when history inserts a message before it', async () => {
  await harness(100, async (hooks, ctx) => {
    await hooks.get('message_end')({ message: first }, ctx);
    await hooks.get('context')({ messages: [first] }, ctx);
    const old = assistant(2, 'old'), echo = result(3, 'x'.repeat(200)), latest = assistant(4, 'latest'), tail = result(5, 'small');
    const a = await hooks.get('context')({ messages: [first, old, echo, latest, tail] }, ctx);
    const inserted: AgentMessage = { role: 'custom', customType: 'async-result', display: true, content: 'insert', timestamp: 10 };
    const b = await hooks.get('context')({ messages: [first, old, echo, inserted, latest, tail] }, ctx);
    expect(b.messages).toEqual(a.messages);
    expect(b.messages.slice(1)).toEqual([latest, tail]);
  });
});

test('missing rollover cut falls back to the opening tail without faulting', async () => {
  await harness(100, async (hooks, ctx) => {
    await hooks.get('message_end')({ message: first }, ctx);
    await hooks.get('context')({ messages: [first] }, ctx);
    const old = assistant(2, 'old'), echo = result(3, 'x'.repeat(200)), latest = assistant(4, 'latest'), tail = result(5, 'small');
    await hooks.get('context')({ messages: [first, old, echo, latest, tail] }, ctx);
    const b = await hooks.get('context')({ messages: [first, old, echo, tail] }, ctx);
    expect(b.messages.slice(1)).toEqual([old, echo, tail]);
    const next = assistant(6, 'next');
    const c = await hooks.get('context')({ messages: [first, old, echo, tail, next] }, ctx);
    expect(c.messages.slice(1)).toEqual([next]);
  });
});

test('missing cut can select a fresh latest assistant on the same request', async () => {
  await harness(100, async (hooks, ctx) => {
    await hooks.get('message_end')({ message: first }, ctx);
    await hooks.get('context')({ messages: [first] }, ctx);
    const old = assistant(2, 'old'), echo = result(3, 'x'.repeat(200)), removed = assistant(4, 'removed'), next = assistant(6, 'next');
    await hooks.get('context')({ messages: [first, old, echo, removed] }, ctx);
    const out = await hooks.get('context')({ messages: [first, old, echo, next] }, ctx);
    expect(out.messages.slice(1)).toEqual([next]);
  });
});
