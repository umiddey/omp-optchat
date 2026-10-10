import { test, afterAll } from 'bun:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Orders, type OrderTask } from '../src/orders.ts';
import { Memory, type Compression, type Entry } from '../src/memory.ts';

const entry = (i: number, text = 'Never push', kind: 'user' | 'talk' = 'user'): Entry => ({ i, text, kind, date: '2026-10-10', size: text.length });
const rule = (said: string, text = said) => ({ said, text, kind: 'rule' as const });
const dirs: string[] = [];
const scratch = () => { const dir = mkdtempSync(join(tmpdir(), 'summarized-orders-')); dirs.push(dir); return dir; };

test('(a) a long user message is scanned by its own leaf call: its orders come back with the summary, with no order call', async () => {
  const calls: Compression[] = [], orderCalls: string[] = [];
  const compress = async (input: Compression) => {
    calls.push(input);
    const scan = input.scan ?? [];
    return { text: input.source.slice(0, 170), orders: new Map(scan.map(i => [i, [rule(i ? 'Always verify' : 'Never push')]])) };
  };
  const memory = await Memory.open(scratch(), compress, () => {}, 1500, 2, async input => { orderCalls.push(input.kind); return []; });
  try {
    memory.append('user', 'Never push ' + 'x'.repeat(600));
    await memory.settle(AbortSignal.timeout(5000), 'tree');
    assert.deepEqual(calls.map(c => c.scan), [[0]]);
    assert.deepEqual(orderCalls, []);
    assert.deepEqual(memory.orders!.records.get(0)?.orders, [rule('Never push')]);
  } finally { await memory.close(); }
});

test('(b) short user messages are scanned by the first merge call covering them, never by literal merges', async () => {
  const calls: Compression[] = [];
  const compress = async (input: Compression) => {
    calls.push(input);
    const scan = input.scan ?? [];
    return { text: input.source.slice(0, 170), orders: new Map(scan.map(i => [i, [rule(i ? 'Always verify' : 'Never push')]])) };
  };
  const memory = await Memory.open(scratch(), compress, () => {}, 1500, 2, async () => []);
  try {
    memory.append('user', 'Never push ' + 'a'.repeat(300));
    memory.append('user', 'Always verify ' + 'b'.repeat(300));
    await memory.settle(AbortSignal.timeout(5000), 'tree');
    assert.deepEqual(calls.filter(c => c.part.l === 0), []);
    assert.deepEqual(calls.map(c => c.scan), [[0, 1]]);
    const first = memory.orders!.records.get(1)?.orders[0];
    assert.ok(first && !('retire' in first));
    assert.equal(first.said, 'Always verify');
  } finally { await memory.close(); }
});

test('(e) a restatement that loses a must-keep token falls back to the verbatim said', async () => {
  const o = new Orders(scratch(), async () => [], () => {}, 10);
  try {
    o.append(entry(0, 'Merge CP MR !103 once green'));
    o.recordAll(new Map([[0, [{ said: 'Merge CP MR !103 once green', text: 'Merge the merge request once green', kind: 'rule' as const }]]]));
    assert.deepEqual(o.records.get(0)?.orders, [{ said: 'Merge CP MR !103 once green', text: 'Merge CP MR !103 once green', kind: 'rule' }]);
  } finally { await o.close(); }
});

test('(f) a short message scanned after a batch is consolidated at the next batch, not the earlier one', async () => {
  const seen: number[][] = [], sent: string[] = [];
  const task: OrderTask = async input => {
    if (input.kind !== 'consolidate') return [];
    seen.push(input.records.map(r => r.i)); sent.push(JSON.stringify(input.records));
    return [...input.ledger.items, ...input.records.flatMap(r => r.orders.flatMap(order => 'retire' in order ? [] : [{ text: order.text, kind: 'rule' as const, from: [r.i], date: r.date }]))];
  };
  const o = new Orders(scratch(), task, () => {}, 10);
  try {
    for (const i of [0, 1, 2, 3]) o.append(entry(i, `Never push ${i}`));
    o.append(entry(4, 'reply', 'talk'));
    o.recordAll(new Map([0, 1, 2, 3].map(i => [i, [rule(`Never push ${i}`)]])));
    await o.batch(3);
    o.append(entry(5, 'Always verify'));
    o.recordAll(new Map([[5, [rule('Always verify')]]]));
    await o.batch(5);
    assert.deepEqual(seen, [[0, 1, 2, 3], [5]]);
    assert.ok(sent.every(s => !s.includes('"said"')), 'consolidation input carries text only');
  } finally { await o.close(); }
});

test('(g) history backfill sends at most 20 messages per call, and new messages never use it', async () => {
  const batches: number[][] = [];
  const task: OrderTask = async input => {
    if (input.kind === 'consolidate') return input.ledger.items;
    if (input.kind !== 'backfill') return [];
    batches.push(input.items.map(item => item.i));
    return Object.fromEntries(input.items.map(item => [String(item.i), [rule(`Order ${item.i} keep`)]]));
  };
  const history = Array.from({ length: 45 }, (_, i) => entry(i, `Order ${i} keep`));
  const o = new Orders(scratch(), task, () => {}, 10);
  try {
    o.backfill(history, i => i < 45);
    await o.drain();
    assert.deepEqual(batches.map(b => b.length), [20, 20, 5]);
    assert.deepEqual(batches.flat(), history.map(h => h.i));
    assert.equal(o.records.size, 45);
    o.append(entry(45, 'Never push new'));
    await o.drain();
    assert.equal(batches.length, 3);
    assert.deepEqual(o.scan(45, 45), [45]);
  } finally { await o.close(); }
});

afterAll(() => { for (const dir of dirs) rmSync(dir, { recursive: true, force: true }); });
test('(i) a name the summarizer heard in its view counts as kept; without that view the verbatim words fall back', async () => {
  const o = new Orders(scratch(), async () => [], () => {}, 10);
  try {
    o.append(entry(0, 'Send it to Rappov'));
    o.append(entry(1, 'Send it to Rappov'));
    const order = { said: 'Send it to Rappov', text: 'Send it to Gateforge', kind: 'rule' as const };
    o.recordAll(new Map([[0, [order]]]), 'user: Send it to Rappov\nassistant: The Gateforge repo is ready');
    o.recordAll(new Map([[1, [order]]]));
    assert.deepEqual(o.records.get(0)?.orders, [{ said: 'Send it to Rappov', text: 'Send it to Gateforge', kind: 'rule' }]);
    assert.deepEqual(o.records.get(1)?.orders, [{ said: 'Send it to Rappov', text: 'Send it to Rappov', kind: 'rule' }]);
  } finally { await o.close(); }
});
