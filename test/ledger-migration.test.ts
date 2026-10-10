import { test, expect } from 'bun:test';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Orders, type OrderTask, type OrderItem } from '../src/orders.ts';
const date = '2026-10-10';
const rule = (text: string, id: number) => ({ text, kind: 'rule' as const, from: [id], date });
async function fixture(items: OrderItem[], task: OrderTask, run: (orders: Orders, dir: string) => Promise<void>) {
 const dir = mkdtempSync(join(tmpdir(), 'ledger-structural-'));
 writeFileSync(join(dir, 'ledger.json'), JSON.stringify({ through: Math.max(30, ...items.flatMap(item => item.from)), items }));
 const o = new Orders(dir, task, () => {});
 try { await run(o, dir); } finally { await o.close(); rmSync(dir, { recursive: true, force: true }); }
}
test('migration missing an index keeps that ledger item verbatim until next-batch publication', async () => {
 const old = rule('The disk is the truth, not the handover text.', 24);
 await fixture([old], async input => input.kind === 'migrate' ? [] : [{ ...old, covers: [0] }], async (o, dir) => {
  const before = o.render(); o.backfill([], () => false); await o.drain(); expect(o.render()).toBe(before);
  await o.batch(31); expect(o.ledger.items).toContainEqual(old);
  expect(JSON.parse(readFileSync(join(dir, 'ledger.json'), 'utf8')).migrationDone).toBe(true);
 });
});
test('migration pulls a path-losing member out of its merge group and keeps the remaining members merged', async () => {
 const old = [rule('Read /rules/a.md before work.', 1), rule('Read /rules/b.md before work.', 2), rule('Read /rules/c.md before work.', 3)];
 await fixture(old, async input => input.kind === 'migrate'
  ? [{ indexes: [0, 1, 2], text: 'Read /rules/b.md and /rules/c.md before work.', kind: 'rule' }]
  : input.kind === 'consolidate' ? input.ledger.items.map((item, index) => ({ ...item, covers: [index] })) : Promise.reject(Error('No re-extraction')), async o => {
   o.backfill([], () => false); await o.drain(); await o.batch(31);
   expect(o.ledger.items).toContainEqual(old[0]);
   expect(o.ledger.items).toContainEqual({ text: 'Read /rules/b.md and /rules/c.md before work.', kind: 'rule', from: [2, 3], date });
   expect(o.ledger.items).toHaveLength(2);
  });
});
test('migration restates only current ledger items and leaves records byte-identical; replaced orders cannot resurrect', async () => {
 const current = rule('OIA must not raise PR; AutomataDore does it. (replaces msg 815)', 850);
 let migrated = 0;
 await fixture([current], async input => {
  if (input.kind === 'migrate') { migrated++; expect(input.items).toHaveLength(1); expect(input.items[0].text).toBe(current.text); return [{ index: 0, text: current.text, kind: 'rule' }]; }
  if (input.kind === 'consolidate') return input.ledger.items.map((item, index) => ({ ...item, covers: [index] }));
  throw Error('Legacy records must not be re-extracted');
 }, async (o, dir) => {
  const history = JSON.stringify({ i: 815, date, orders: [{ text: 'OIA should raise merge requests.', kind: 'goal' }] }) + '\n';
  writeFileSync(join(dir, 'orders.jsonl'), history);
  o.backfill([], () => false); await o.drain(); await o.batch(851);
  expect(o.render()).not.toContain('should raise merge requests'); expect(readFileSync(join(dir, 'orders.jsonl'), 'utf8')).toBe(history);
  await o.close(); const reopened = new Orders(dir, async input => {
   if (input.kind !== 'consolidate') throw Error('Migration and history extraction must not repeat');
   return input.ledger.items.map((item, index) => ({ ...item, covers: [index] }));
  });
  try {
   reopened.backfill([], () => false); await reopened.drain(); expect(reopened.render()).toBe(o.render());
   await reopened.batch(852); expect(reopened.render()).not.toContain('should raise merge requests');
   expect(readFileSync(join(dir, 'orders.jsonl'), 'utf8')).toBe(history);
  } finally { await reopened.close(); }
  expect(migrated).toBe(1);
 });
});
test('consolidation without an explicit old-item coverage index preserves that item verbatim', async () => {
 const old = rule('Always review code before release.', 24);
 await fixture([old], async () => [{ text: 'Always review changes before release.', kind: 'rule', from: [24], date, covers: [] }], async o => {
  await o.batch(31); expect(o.ledger.items).toContainEqual(old);
 });
});
test('ledger migration batches at 20 and bounds each source talk context to 2048 UTF-8 bytes', async () => {
 const old = Array.from({ length: 22 }, (_, i) => rule('Never push with 0 waived.', i + 1));
 const batches: number[] = [], contexts: string[] = [];
 await fixture(old, async input => {
  if (input.kind === 'migrate') {
   batches.push(input.items.length);
   for (const item of input.items) for (const source of item.sources) contexts.push(source.before!, source.after!);
   return input.items.map(item => ({ index: item.index, text: 'Push.', kind: 'rule' }));
  }
  if (input.kind === 'consolidate') return input.ledger.items.map((item, index) => ({ ...item, covers: [index] }));
  throw Error('No re-extraction');
 }, async o => {
  const entry = (i: number, kind: 'talk' | 'user', text: string) => ({ i, kind, text, date, size: Buffer.byteLength(text) });
  o.backfill([entry(0, 'talk', '界'.repeat(2000)), ...old.map(item => entry(item.from[0], 'user', item.text)), entry(23, 'talk', '界'.repeat(2000))], () => false);
  await o.drain(); await o.batch(31);
  expect(batches).toEqual([20, 2]);
  for (const context of contexts) { expect(Buffer.byteLength(context)).toBeLessThanOrEqual(2048); expect(context).not.toContain('\uFFFD'); }
  for (const item of old) expect(o.ledger.items).toContainEqual(item);
 });
});
test('structural consolidation can resolve an existing ledger conflict using the newer active user-order source', async () => {
 const dir = mkdtempSync(join(tmpdir(), 'ledger-existing-replacement-'));
 const goal = { text: 'OIA should raise merge requests.', kind: 'goal' as const, from: [815], date };
 const newer = rule('OIA must not raise PR; AutomataDore does it.', 850);
 writeFileSync(join(dir, 'ledger.json'), JSON.stringify({ through: 850, items: [goal, newer], migrationDone: true }));
 writeFileSync(join(dir, 'orders.jsonl'), JSON.stringify({ i: 850, date, orders: [{ said: newer.text, text: newer.text, kind: 'rule' }] }) + '\n');
 const o = new Orders(dir, async () => [{ ...newer, text: newer.text + ' (replaces msg 815)', covers: [0, 1] }], () => {});
 try {
  await o.batch(851);
  expect(o.ledger.items).toEqual([{ ...newer, text: newer.text + ' (replaces msg 815)' }]);
 } finally { await o.close(); rmSync(dir, { recursive: true, force: true }); }
});
