import { test, afterAll } from 'bun:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { z, Settings } from '@oh-my-pi/pi-coding-agent';
import type { AgentMessage } from '@oh-my-pi/pi-agent-core';
import type { ExtensionAPI, ExtensionContext } from '@oh-my-pi/pi-coding-agent';
import optchat from '../src/index.ts';
import { Memory, type Entry } from '../src/memory.ts';
import { Orders, type ExtractedOrders, type OrderDirective, type OrderTask } from '../src/orders.ts';

type Hook = (event: { message?: AgentMessage; messages?: AgentMessage[] }, ctx: ExtensionContext) => unknown;

// The settle wait under test must be bounded by OMP's 30 s handler cap. The fake settle hangs forever, like a batch
// consolidation against a slow model; the env gate keeps the patch a plain passthrough for every other test in the run.
const REAL_SETTLE = Memory.prototype.settle;
Memory.prototype.settle = function (signal?: AbortSignal, until?: 'turn' | 'tree'): Promise<void> {
  if (process.env.OMP_OPTCHAT_TEST_HANG_SETTLE === '1') return Promise.withResolvers<never>().promise;
  return REAL_SETTLE.call(this, signal, until);
};
afterAll(() => { Memory.prototype.settle = REAL_SETTLE; });

const entry = (i: number, text = 'Never push'): Entry => ({ i, text, kind: 'user', date: '2026-10-10', size: text.length });

/** Waits for `gate`, unless the consolidation's controller aborts first (a close must never deadlock a failing test). */
async function awaitGate(signal: AbortSignal, gate: Promise<void>) {
  signal.throwIfAborted();
  const stop = Promise.withResolvers<never>();
  signal.addEventListener('abort', () => stop.reject(Error('stopped')), { once: true });
  await Promise.race([gate, stop.promise]);
}

// Real-clock guards on purpose: the code under test is a setTimeout race against a settle that never resolves, and fake
// timers cannot drive the production timer alongside the extension's real async memory and store I/O. The 3 s guard only
// bounds the wait so an unbounded-settle regression fails at the guard, not at the runner's timeout.
function guard<T>(promise: Promise<T>, note: string): Promise<T> {
  const stop = Promise.withResolvers<never>();
  const timer = setTimeout(() => stop.reject(Error(note)), 3000);
  return Promise.race([promise, stop.promise]).finally(() => clearTimeout(timer));
}

function harness(dir: string) {
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
  return { api, hooks, ctx, faults };
}

async function startRun(hooks: Map<string, Hook>, ctx: ExtensionContext, user: AgentMessage) {
  await hooks.get('session_start')!({}, ctx);
  await hooks.get('agent_start')!({}, ctx);
  await hooks.get('message_end')!({ message: user }, ctx);
}

function withBoundBudget(dir: string, saved: string | undefined) {
  process.env.OMP_OPTCHAT_HOME = dir;
  process.env.OMP_OPTCHAT_TEST_HANG_SETTLE = '1';
  process.env.OMP_OPTCHAT_SETTLE_BUDGET_MS = '200';
  return () => {
    delete process.env.OMP_OPTCHAT_TEST_HANG_SETTLE;
    delete process.env.OMP_OPTCHAT_SETTLE_BUDGET_MS;
    if (saved === undefined) delete process.env.OMP_OPTCHAT_HOME; else process.env.OMP_OPTCHAT_HOME = saved;
  };
}

test('the context handler resolves within the settle budget when settle never resolves', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'optchat-bound-'));
  const { api, hooks, ctx, faults } = harness(dir);
  const restore = withBoundBudget(dir, process.env.OMP_OPTCHAT_HOME);
  // A line over NODE (512 bytes) needs the compactor; the throwing registry keeps its summary pending, so the render
  // must carry the recipe placeholder (short messages build literal nodes without any model call).
  const user: AgentMessage = { role: 'user', content: `hello ${'x'.repeat(600)}`, timestamp: 1 };
  try {
    optchat(api);
    await startRun(hooks, ctx, user);
    const at = Date.now();
    await guard(hooks.get('context')!({ messages: [user] }, ctx) as Promise<unknown>, 'the context handler did not resolve within 3 s');
    const elapsed = Date.now() - at;
    assert.deepEqual(faults, [], 'budget expiry is not a failure');
    assert.ok(elapsed >= 150, `the handler resolved after only ${elapsed} ms despite a settle that never resolves`);
    assert.ok(elapsed < 10_000, `the handler took ${elapsed} ms, far past the 200 ms budget`);
  } finally {
    restore();
    await hooks.get('session_shutdown')?.({}, ctx);
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the bounded turn renders the chat opening with the unbuilt placeholder', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'optchat-bound-'));
  const { api, hooks, ctx, faults } = harness(dir);
  const restore = withBoundBudget(dir, process.env.OMP_OPTCHAT_HOME);
  // A line over NODE (512 bytes) keeps its summary pending against the throwing registry, so the render shows the placeholder.
  const user: AgentMessage = { role: 'user', content: `hello ${'x'.repeat(600)}`, timestamp: 1 };
  const reply = { role: 'assistant', content: [{ type: 'text', text: 'hi' }], stopReason: 'stop', timestamp: 2 } as unknown as AgentMessage;
  const result: AgentMessage = { role: 'custom', customType: 'async-result', display: true, content: 'job done', timestamp: 3 };
  try {
    optchat(api);
    await hooks.get('session_start')!({}, ctx);
    await hooks.get('agent_start')!({}, ctx);
    await hooks.get('message_end')!({ message: user }, ctx);
    // The first request opens at the user message itself, so its view is history-only and still empty; the summary of the
    // logged line stays unbuilt (the registry throws), and the next run's view must carry the placeholder line.
    await guard(hooks.get('context')!({ messages: [user] }, ctx) as Promise<unknown>, 'the context handler did not resolve within 3 s');
    await hooks.get('message_end')!({ message: reply }, ctx);
    await hooks.get('agent_end')!({}, ctx);
    await hooks.get('agent_start')!({}, ctx);
    const out = await guard(hooks.get('context')!({ messages: [user, reply, result] }, ctx) as Promise<{ messages: AgentMessage[] }>, 'the context handler did not resolve within 3 s');
    assert.deepEqual(faults, [], 'budget expiry is not a failure');
    const first = out.messages[0];
    assert.equal(first.role, 'user');
    const view = (Array.isArray(first.content) ? first.content : [])
      .map(block => block as { type?: string; text?: string }).filter(block => block.type === 'text').map(block => block.text ?? '').join('\n');
    assert.ok(view.includes('<chat>'), 'the projected opening carries the chat view');
    assert.ok(view.includes('(not summarized yet: zoom it)'), 'the unbuilt line shows the zoom recipe placeholder');
  } finally {
    restore();
    await hooks.get('session_shutdown')?.({}, ctx);
    rmSync(dir, { recursive: true, force: true });
  }
});

/** The batch's records as the ledger would hold them: each record's standing orders with their own id and date. */
function echoOrders(records: ExtractedOrders[]) {
  return records.flatMap(r => r.orders.flatMap(o => 'retire' in o ? [] : [{ ...o, from: [r.i], date: r.date }]));
}

test('during an in-flight consolidation the pending records stay rendered; the landed ledger replaces them', async () => {
  const gate = Promise.withResolvers<void>();
  let calls = 0;
  const task: OrderTask = async (input, signal) => {
    if (input.kind !== 'consolidate') return [];
    if (++calls === 1) return echoOrders(input.records);
    await awaitGate(signal, gate.promise);
    return [{ text: 'Never push; always verify', kind: 'rule', from: [1], date: '2026-10-10' }];
  };
  const dir = mkdtempSync(join(tmpdir(), 'orders-inflight-'));
  const o = new Orders(dir, task, () => {}, 10);
  try {
    o.append(entry(0)); o.recordAll(new Map([[0, [{ text: 'Never push', kind: 'rule' }]]]));
    await o.batch(0);
    o.append(entry(1, 'Always verify')); o.recordAll(new Map([[1, [{ text: 'Always verify', kind: 'rule' }]]]));
    void o.batch(1);
    const inflight = o.render();
    assert.ok(inflight.includes('0 [rule] (2026-10-10): Never push'), 'the landed ledger still shows');
    assert.ok(inflight.includes('1 [rule] (2026-10-10): Always verify'), 'the pending records stay rendered while the batch is in flight');
    gate.resolve();
    await o.settle();
    const landed = o.render();
    assert.ok(landed.includes('1 [rule] (2026-10-10): Never push; always verify'), 'the landed ledger shows');
    assert.ok(!landed.includes(': Always verify'), 'the landed ledger replaces the pending raw records');
    assert.equal(calls, 2, 'one consolidation call per batch');
  } finally {
    gate.resolve();
    await o.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a restart with a checkpointed batch that has not landed renders the pending records until it replays', async () => {
  const gate = Promise.withResolvers<void>();
  const dir = mkdtempSync(join(tmpdir(), 'orders-pending-'));
  let second: Orders | undefined;
  try {
    let firstCalls = 0;
    const firstTask: OrderTask = async (input, signal) => {
      if (input.kind !== 'consolidate') return [];
      if (++firstCalls === 1) return echoOrders(input.records);
      // Never lands: the close below aborts the controller, which must leave the checkpointed batch unpublished.
      return awaitGate(signal, Promise.withResolvers<never>().promise).then(() => []);
    };
    const first = new Orders(dir, firstTask, () => {}, 10);
    first.append(entry(0)); first.recordAll(new Map([[0, [{ text: 'Never push', kind: 'rule' }]]]));
    await first.batch(0);
    first.append(entry(1, 'Always verify')); first.recordAll(new Map([[1, [{ text: 'Always verify', kind: 'rule' }]]]));
    void first.batch(1); // checkpoints `pending: 1`; the consolidation hangs and close aborts it before it lands
    await first.close();
    const saved = JSON.parse(readFileSync(join(dir, 'ledger.json'), 'utf8'));
    assert.equal(saved.through, 0);
    assert.equal(saved.pending, 1, 'the batch point is checkpointed');

    let replayCalls = 0;
    const replayTask: OrderTask = async (input, signal) => {
      if (input.kind !== 'consolidate') return [];
      replayCalls++;
      await awaitGate(signal, gate.promise);
      return [{ text: 'Never push; always verify', kind: 'rule', from: [1], date: '2026-10-10' }];
    };
    second = new Orders(dir, replayTask, () => {}, 10);
    second.backfill([entry(0), entry(1, 'Always verify')], () => false);
    const inflight = second.render();
    assert.ok(inflight.includes('0 [rule] (2026-10-10): Never push'), 'the published ledger still shows');
    assert.ok(inflight.includes('1 [rule] (2026-10-10): Always verify'), 'a restart with a pending checkpoint renders the unconsolidated records');
    gate.resolve();
    await second.settle();
    assert.equal(replayCalls, 1, 'the restart replayed the checkpointed batch once');
    const landed = second.render();
    assert.ok(landed.includes('1 [rule] (2026-10-10): Never push; always verify'), 'the replayed batch landed');
    assert.ok(!landed.includes(': Always verify'), 'the landed ledger replaces the pending raw records');
    assert.equal(JSON.parse(readFileSync(join(dir, 'ledger.json'), 'utf8')).through, 1);
  } finally {
    gate.resolve();
    await second?.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
