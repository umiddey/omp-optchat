import { test } from 'bun:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import type { AgentMessage } from '@oh-my-pi/pi-agent-core';
import { Memory, PAGE, CAP } from '../src/memory.ts';
import { logMessage } from '../src/transcript.ts';
import { registerMemoryTools } from '../src/tools.ts';
import { AgentIndex, renderTranscript } from '../src/agents.ts';
import { z, Settings } from '@oh-my-pi/pi-coding-agent';
import type { ExtensionAPI, ExtensionContext } from '@oh-my-pi/pi-coding-agent';
import optchat from '../src/index.ts';

interface TestTool {
  description: string;
  parameters: { safeParse(value: unknown): { success: boolean } };
  execute(id: string, params: { id: number | string; n?: number; offset?: number; limit?: number }, signal: undefined, update: undefined, ctx: ExtensionContext): Promise<{ content: { type: string; text?: string }[] }>;
}

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'optchat-agents-'));
  const profile = join(dir, 'profile'); mkdirSync(profile);
  const session = join(dir, '2026-10-01_main.jsonl');
  const childDir = session.slice(0, -6); mkdirSync(childDir);
  return { dir, profile, session, childDir, close: () => rmSync(dir, { recursive: true, force: true }) };
}
const task = (ids: string[], timestamp = 1): Extract<AgentMessage, { role: 'toolResult' }> => ({ role: 'toolResult', toolName: 'task', toolCallId: 'task1', content: [{ type: 'text', text: 'report' }], details: { progress: ids.map(id => ({ id })), results: [{ id: ids[0] }] }, isError: false, timestamp });
const custom = (customType: string, details: unknown, timestamp = 2): Extract<AgentMessage, { role: 'custom' }> => ({ role: 'custom', customType, display: true, content: 'report', details, timestamp });
function transcript(file: string, text: string, date = '2026-10-01T00:00:00.000Z') {
  writeFileSync(file, JSON.stringify({ type: 'session', timestamp: date }) + '\n' + JSON.stringify({ type: 'message', message: { role: 'user', content: text, timestamp: 1 } }) + '\n');
}

test('agent index appends durable records and resolves after restart without rewriting', async () => {
  const f = fixture();
  try {
    const a = new AgentIndex(f.profile); a.recordMessage(task(['Alpha', 'Beta']), f.session);
    const file = join(f.profile, 'agents.jsonl'), first = readFileSync(file, 'utf8');
    const records = first.trim().split('\n').map(line => JSON.parse(line));
    assert.equal(records.length, 2); assert.equal(records[0].path, resolve(f.childDir, 'Alpha.jsonl'));
    assert.equal(records[0].sessionFile, f.session); assert.equal(records[0].date, new Date(1).toISOString());
    a.recordMessage(task(['Alpha']), f.session); assert.equal(readFileSync(file, 'utf8'), first);
    a.recordMessage(custom('async-result', { jobs: [{ jobId: 'Gamma' }] }), f.session);
    a.recordMessage(custom('irc:incoming', { from: 'Delta' }), f.session);
    assert.ok(readFileSync(file, 'utf8').startsWith(first));
    const reopened = new AgentIndex(f.profile);
    assert.equal(reopened.resolve('Alpha').match.path, records[0].path);
    assert.equal(reopened.resolve('Gamma').match.path, join(f.childDir, 'Gamma.jsonl'));
    assert.equal(reopened.resolve('Delta').match.path, join(f.childDir, 'Delta.jsonl'));
  } finally { f.close(); }
});
test('agent_end discovery recursively indexes unmentioned transcripts, not sibling sessions', async () => {
  const f = fixture();
  try {
    mkdirSync(join(f.childDir, 'Parent')); transcript(join(f.childDir, 'Parent', 'Nested.jsonl'), 'nested');
    transcript(join(f.childDir, 'Parent.jsonl'), 'parent'); transcript(join(f.dir, 'Sibling.jsonl'), 'sibling');
    const a = new AgentIndex(f.profile); a.scan(f.session);
    assert.equal(a.resolve('Nested').match.path, join(f.childDir, 'Parent', 'Nested.jsonl'));
    assert.equal(a.resolve('Nested').match.date, '2026-10-01T00:00:00.000Z');
    assert.throws(() => a.resolve('Sibling'), /Unknown agent/);
    const first = readFileSync(join(f.profile, 'agents.jsonl'), 'utf8'); a.scan(f.session);
    assert.equal(readFileSync(join(f.profile, 'agents.jsonl'), 'utf8'), first);
  } finally { f.close(); }
});
test('duplicate names choose newest and expose dated exact selectors across restarts', async () => {
  const f = fixture();
  try {
    const old = join(f.childDir, 'Alpha.jsonl'); transcript(old, 'old');
    const newer = join(f.dir, '2026-10-02_main.jsonl'); mkdirSync(newer.slice(0, -6));
    const newest = join(newer.slice(0, -6), 'Alpha.jsonl'); transcript(newest, 'new', '2026-10-02T00:00:00.000Z');
    const a = new AgentIndex(f.profile); a.scan(newer); a.scan(f.session);
    const reopened = new AgentIndex(f.profile); assert.equal(reopened.resolve('Alpha').match.path, newest);
    const page = reopened.zoom('Alpha'); assert.match(page, /user\|new/); assert.ok(page.includes('Alpha@2026-10-01T00:00:00.000Z'));
    assert.match(reopened.zoom('Alpha@2026-10-01T00:00:00.000Z'), /user\|old/);
    assert.match(reopened.zoom(`Alpha@${old}`), /user\|old/);
  } finally { f.close(); }
});
test('unknown names list nearest matches and missing transcripts give a clear error', async () => {
  const f = fixture();
  try {
    const a = new AgentIndex(f.profile); a.recordMessage(task(['Alpha', 'Beta']), f.session);
    assert.throws(() => a.zoom('Alph'), /Unknown agent.*Closest names: Alpha/);
    assert.throws(() => a.zoom('Alpha'), /Transcript.*Alpha.*no longer exists/);
    assert.throws(() => a.resolve('Alpha@missing'), /No transcript.*Alpha/);
  } finally { f.close(); }
});
test('renderer includes briefs, replies, tool JSON, bounded echoes and told messages but not private thinking', async () => {
  const f = fixture();
  try {
    const file = join(f.childDir, 'Alpha.jsonl');
    const entries = [
      { type: 'message', message: { role: 'developer', content: 'instructions' } },
      { type: 'message', message: { role: 'user', content: [{ type: 'text', text: 'task\nbrief' }, { type: 'image', mimeType: 'image/png', data: 'SECRET_IMAGE' }] } },
      { type: 'message', message: { role: 'assistant', content: [{ type: 'thinking', thinking: 'SECRET' }, { type: 'text', text: 'reply' }, { type: 'toolCall', name: 'read', arguments: { path: 'x' } }] } },
      { type: 'message', message: { role: 'toolResult', toolName: 'read', content: [{ type: 'text', text: 'HEAD' + 'x'.repeat(2000) + 'TAIL' }] } },
      { type: 'custom_message', customType: 'irc:incoming', content: 'told', display: true },
      { type: 'message', message: { role: 'custom', customType: 'fixture', content: 'HIDDEN', display: false } },
    ]; writeFileSync(file, entries.map(e => JSON.stringify(e)).join('\n'));
    const text = renderTranscript(file); assert.match(text, /^developer\|instructions\nuser\|task\\nbrief \[image: image\/png\]\ntalk\|reply\ntool\|read {"path":"x"}\necho\|read: HEAD/);
    assert.ok(text.includes('TAIL\nwork|[irc:incoming] told')); assert.ok(text.length < 1500);
    assert.ok(!/SECRET|HIDDEN/.test(text));
  } finally { f.close(); }
});
test('transcript pages match memory offsets, limits and surrogate boundaries exactly', async () => {
  const f = fixture();
  const memory = new Memory(f.profile, async () => 'summary', () => {});
  try {
    const file = join(f.childDir, 'Alpha.jsonl'); transcript(file, 'a'.repeat(PAGE - 6) + '😀' + 'b'.repeat(40000));
    const a = new AgentIndex(f.profile); a.scan(f.session); const text = renderTranscript(file); memory.append('user', text);
    for (const [offset, limit] of [[undefined, undefined], [PAGE, undefined], [PAGE, 1], [10, 5]] as const) {
      const expected = memory.zoom(0, 1, offset, limit).slice('0+0|user: '.length);
      assert.equal(a.zoom('Alpha', offset, limit), expected);
    }
    let rebuilt = '', offset = 0, pages = 0;
    while (offset < text.length) { const page = a.zoom('Alpha', offset); assert.ok(page.length < CAP);
      const match = /^([\s\S]*)\n\[showing characters (\d+)-(\d+) of (\d+)/.exec(page)!;
      assert.equal(Number(match[2]), offset); rebuilt += match[1]; offset = Number(match[3]); pages++;
    }
    assert.equal(rebuilt, text); assert.equal(pages, 3);
    assert.throws(() => a.zoom('Alpha', text.length), /offset must be/);
    assert.throws(() => a.zoom('Alpha', -1), /offset must be/);
    assert.throws(() => a.zoom('Alpha', 0, 0), /positive integer/);
    transcript(file, 'short'); assert.equal(a.zoom('Alpha'), 'user|short');
    assert.match(a.zoom('Alpha', 0, 2), /fits in one zoom/);
  } finally { await memory.close(); f.close(); }
});
test('shown reports log as work and task/async reports end with one trailer per agent even when capped', async () => {
  const f = fixture(), memory = new Memory(f.profile, async () => 'summary', () => {});
  try {
    const message = task(['Alpha', 'Beta']); message.content = [{ type: 'text', text: 'x'.repeat(40000) }]; logMessage(memory, message);
    logMessage(memory, custom('async-result', { jobs: [{ jobId: 'Gamma' }, { jobId: 'Delta' }] }));
    logMessage(memory, custom('irc:incoming', { from: 'Alpha' }));
    logMessage(memory, { ...custom('async-result', { jobs: [{ jobId: 'Hidden' }] }), display: false });
    assert.deepEqual(memory.root.map(e => e.kind), ['echo', 'work', 'work']);
    assert.ok(memory.root[0].text.length <= CAP); assert.ok(memory.root[0].text.endsWith('Full chat: zoom("Alpha")\nFull chat: zoom("Beta")'));
    assert.ok(memory.root[1].text.endsWith('Full chat: zoom("Gamma")\nFull chat: zoom("Delta")'));
    assert.equal(memory.root[2].text, '[irc:incoming] report');
  } finally { await memory.close(); f.close(); }
});
test('registered zoom accepts string ids with paging and leaves numeric zoom behavior unchanged', async () => {
  const f = fixture();
  const memory = new Memory(f.profile, async () => 'summary', () => {});
  try {
    transcript(join(f.childDir, 'Alpha.jsonl'), 'brief'); const a = new AgentIndex(f.profile); a.scan(f.session); memory.append('user', 'original');
    const tools: TestTool[] = [];
    // Test-only API capture: registration and zoom use precisely these members.
    const api = { zod: z, registerTool: (tool: unknown) => tools.push(tool as TestTool) } as unknown as ExtensionAPI;
    registerMemoryTools(api, () => memory, () => a);
    const tool = tools[0]; assert.ok(tool.parameters.safeParse({ id: 'Alpha', offset: 0, limit: 10 }).success);
    // Tool execution consults only the agent kind; other OMP context members are not used.
    const ctx = { agent: { kind: 'main' } } as unknown as ExtensionContext;
    assert.equal((await tool.execute('', { id: 'Alpha' }, undefined, undefined, ctx)).content[0].text, 'user|brief');
    assert.equal((await tool.execute('', { id: 0 }, undefined, undefined, ctx)).content[0].text, '0+0|user: original');
    const child = { agent: { kind: 'subagent' } } as unknown as ExtensionContext;
    await assert.rejects(tool.execute('', { id: 'Alpha' }, undefined, undefined, child), /child sessions/);
    assert.ok(tool.description.includes('Name@')); assert.ok(tool.description.includes('25'));
  } finally { await memory.close(); f.close(); }
});

test('a nested sender indexes its actual transcript rather than a missing direct-child path', () => {
  const f = fixture();
  try {
    mkdirSync(join(f.childDir, 'Parent')); const path = join(f.childDir, 'Parent', 'Nested.jsonl'); transcript(path, 'nested');
    const a = new AgentIndex(f.profile); a.recordMessage(custom('irc:incoming', { from: 'Nested' }, Date.now()), f.session);
    a.scan(f.session);
    assert.equal(a.resolve('Nested').match.path, path);
    assert.equal(a.zoom('Nested'), 'user|nested');
    assert.equal(readFileSync(join(f.profile, 'agents.jsonl'), 'utf8').trim().split('\n').length, 1);
  } finally { f.close(); }
});

test('main lifecycle indexes task/custom messages and recursively discovers transcripts at agent_end', async () => {
  const f = fixture(), oldHome = process.env.OMP_OPTCHAT_HOME;
  const hooks = new Map<string, (event: { message?: AgentMessage }, ctx: ExtensionContext) => unknown>();
  const faults: string[] = [];
  // Test-only extension boundary: no OMP session or provider is launched.
  const api = {
    zod: z, registerFlag: () => {}, registerTool: () => {}, getFlag: () => 'profile',
    pi: { settings: Settings.isolated() }, getActiveTools: () => [], setActiveTools: () => {},
    on: (name: string, handler: unknown) => hooks.set(name, handler as (event: { message?: AgentMessage }, ctx: ExtensionContext) => unknown),
  } as unknown as ExtensionAPI;
  const ctx = {
    agent: { kind: 'main' }, cwd: f.dir, mode: 'print',
    sessionManager: { getSessionFile: () => f.session },
    modelRegistry: { find: () => { throw new Error('No model calls expected'); } },
    ui: { notify: (text: string, kind: string) => { if (kind === 'error') faults.push(text); }, setStatus: () => {} },
    abort: () => faults.push('abort'),
  } as unknown as ExtensionContext;
  try {
    process.env.OMP_OPTCHAT_HOME = f.dir; optchat(api);
    await hooks.get('session_start')!({}, ctx); await hooks.get('agent_start')!({}, ctx);
    await hooks.get('message_end')!({ message: task(['Alpha']) }, ctx);
    await hooks.get('message_end')!({ message: custom('async-result', { jobs: [{ jobId: 'Beta' }] }) }, ctx);
    await hooks.get('message_end')!({ message: custom('irc:incoming', { from: 'Gamma' }) }, ctx);
    transcript(join(f.childDir, 'Unmentioned.jsonl'), 'unmentioned');
    await hooks.get('agent_end')!({}, ctx); await hooks.get('session_shutdown')!({}, ctx);
    assert.deepEqual(faults, []);
    const index = new AgentIndex(f.profile);
    for (const name of ['Alpha', 'Beta', 'Gamma', 'Unmentioned']) assert.equal(index.resolve(name).match.path, join(f.childDir, `${name}.jsonl`));
    const memory = await Memory.open(f.profile, async () => 'summary', () => {});
    try {
      assert.deepEqual(memory.root.map(entry => entry.kind), ['echo', 'work', 'work']);
      assert.ok(memory.root[0].text.endsWith('Full chat: zoom(\"Alpha\")'));
      assert.ok(memory.root[1].text.endsWith('Full chat: zoom(\"Beta\")'));
    } finally { await memory.close(); }
  } finally {
    await hooks.get('session_shutdown')?.({}, ctx);
    if (oldHome === undefined) delete process.env.OMP_OPTCHAT_HOME; else process.env.OMP_OPTCHAT_HOME = oldHome;
    f.close();
  }
});
