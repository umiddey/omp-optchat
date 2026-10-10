import { test, expect } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Orders, type OrderTask } from '../src/orders.ts';
import { projectContext } from '../src/integration.ts';
import type { Entry } from '../src/memory.ts';
import { cachePayload, splitView } from '../src/cache.ts';
import { Memory } from '../src/memory.ts';
const entry = (i: number, text = 'Never push', kind: 'user' | 'talk' = 'user') => ({ i, text, kind, date: '2026-10-10', size: text.length });
async function fixture(run: (o: Orders, dir: string) => Promise<void>, task: OrderTask = async (task) => task.kind === 'extract' ? ['Never push'] : [{ text: 'Never push', from: [0], date: '2026-10-10' }], entries: Entry[] = [], warn: (text: string) => void = () => {}) {
 const dir = mkdtempSync(join(tmpdir(), 'orders-test-')); const o = new Orders(dir, task, warn, 2, 10);
 try { o.backfill(entries); await run(o, dir); } finally { await o.close(); rmSync(dir, { recursive: true, force: true }); }
}
test('extract records every user including empty; skips custom tagged and non-user', async () => {
 await fixture(async (o, dir) => { o.append(entry(0)); o.append(entry(1, 'question?')); o.append(entry(2, '[async-result] result')); o.append(entry(3, '[any-custom] result')); o.append(entry(4, 'reply', 'talk')); await o.extracted();
 expect(readFileSync(join(dir, 'orders.jsonl'), 'utf8').trim().split('\n').map(x => JSON.parse(x))).toEqual([{ i: 0, date: '2026-10-10', orders: ['Never push'] }, { i: 1, date: '2026-10-10', orders: [] }]);
 }, async task => task.kind === 'extract' ? task.entry.i === 0 ? ['Never push'] : [] : []);
});
test('consolidation only at batch; persisted ledger loads without recompute', async () => {
 let calls = 0;
 await fixture(async (o, dir) => { o.append(entry(0)); await o.extracted(); expect(calls).toBe(0); expect(o.render()).toBe(''); await o.batch(0); expect(calls).toBe(1); const rendered = o.render(); const restored = new Orders(dir, async () => { throw Error('must not call'); }); restored.backfill([entry(0)]); await restored.extracted(); expect(restored.render()).toBe(rendered); await restored.close(); }, async task => task.kind === 'extract' ? ['Never push'] : (calls++, [{ text: 'Never push', from: [0], date: '2026-10-10' }]));
});
test('opening orders precede chat and remain byte identical between batches', async () => {
 await fixture(async o => {
  o.append(entry(0)); await o.batch(0); const prefix = o.render();
  o.append(entry(1)); await o.extracted(); expect(o.render()).toBe(prefix);
  const projected = projectContext([{ role: 'user', content: 'hello', timestamp: 1 }], 0, '<chat>\n0+1|user: hello\n</chat>', '', true, 'main', 1, prefix);
  const first = projected[0];
  if (first.role !== 'user' || typeof first.content === 'string') throw Error('Expected projected user blocks');
  expect(first.content[0]).toEqual({ type: 'text', text: prefix });
  expect(first.content[1]).toEqual({ type: 'text', text: '<chat>\n0+1|user: hello\n</chat>' });
 });
});
test('failed consolidation renders old ledger plus raw unconsolidated orders', async () => {
 await fixture(async o => { o.append(entry(0)); await o.batch(0); o.append(entry(1, 'Always verify')); await o.batch(1); expect(o.render()).toContain('0 (2026-10-10): Never push'); expect(o.render()).toContain('1 (2026-10-10): Always verify'); }, async task => task.kind === 'extract' ? [task.entry.text] : task.through === 0 ? [{ text: 'Never push', from: [0], date: '2026-10-10' }] : Promise.reject(Error('offline')));
});
test('16000 UTF-8 byte bound enforced without dropping orders', async () => {
 await fixture(async (o, dir) => { o.append(entry(0)); await o.batch(0); expect(o.render()).toContain('Never push'); expect(JSON.parse(readFileSync(join(dir, 'ledger.json'), 'utf8')).through).toBe(-1); }, async task => task.kind === 'extract' ? ['Never push'] : [{ text: '界'.repeat(6000), from: [0], date: '2026-10-10' }]);
});
test('backfill missing ids once and creates first ledger', async () => {
 let extractions = 0;
 await fixture(async (o, dir) => { await o.settle(); expect(extractions).toBe(2); expect(o.render()).toContain('Never push'); const restored = new Orders(dir, async () => { extractions++; return []; }); restored.backfill([entry(0), entry(1)]); await restored.settle(); expect(extractions).toBe(2); await restored.close(); }, async task => task.kind === 'extract' ? (extractions++, ['Never push']) : [{ text: 'Never push', from: [0, 1], date: '2026-10-10' }], [entry(0), entry(1)]);
});

test('nonempty ledger does not shift chat four-line blocks or tools/system mark across turns', async () => {
 await fixture(async o => {
  o.append(entry(0)); await o.batch(0);
  const control = { type: 'ephemeral', ttl: '1h' };
  const view = `<chat>\n${Array.from({ length: 80 }, (_, i) => `${i}+1|summary`).join('\n')}\n</chat>`;
  const payload = (question: string) => ({ tools: [{ name: 'zoom' }], system: [{ type: 'text', text: 'stable', cache_control: control }], messages: [{ role: 'user', content: [{ type: 'text', text: o.render() }, { type: 'text', text: view }, { type: 'text', text: question }] }] });
  const one = payload('one'), two = payload('two'); cachePayload(one); cachePayload(two);
  expect(one.messages[0].content.slice(0, -1)).toEqual(two.messages[0].content.slice(0, -1));
  expect(one.system[0].cache_control).toEqual(control);
  expect(one.messages[0].content[0].text).toBe(o.render());
  expect(one.messages[0].content.slice(1, -1).map(b => b.text)).toEqual(splitView(view));
 });
});
test('first backfill is background for normal turns and fallback survives restart', async () => {
 let release = () => {};
 const gate = new Promise<void>(resolve => { release = resolve; });
 await fixture(async (o, dir) => {
  await o.settle(undefined, true); expect(o.render()).toBe('');
  release(); await o.settle(); expect(o.render()).toContain('Never push');
  const restored = new Orders(dir, async () => { throw Error('no recomputation'); });
  restored.backfill([entry(0)]); await restored.settle();
  expect(restored.render()).toBe(o.render()); await restored.close();
 }, async task => { if (task.kind === 'extract') { await gate; return ['Never push']; } throw Error('offline'); }, [entry(0)]);
});

test('Memory publishes ledger on actual view merges, not ordinary append or tree merges', async () => {
 const dir = mkdtempSync(join(tmpdir(), 'orders-memory-')); let batches = 0;
 const memory = await Memory.open(dir, async () => 's'.repeat(100), () => {}, 200, 2,
  async task => task.kind === 'extract' ? ['Never push'] : (batches++, task.records.flatMap(r => r.orders.map(text => ({ text, from: [r.i], date: r.date })))));
 try {
  memory.append('user', 'Never push ' + 'x'.repeat(600)); await memory.settle(undefined, 'tree');
  await memory.orders!.extracted(); expect(batches).toBe(0);
  memory.append('user', 'Always verify ' + 'x'.repeat(600)); await memory.settle(undefined, 'tree');
  expect(batches).toBe(0);
  memory.append('user', 'Keep constraints ' + 'x'.repeat(600)); await memory.settle(undefined, 'tree');
  expect(batches).toBeGreaterThan(0); expect(memory.orders!.render()).toContain('Never push');
 } finally { await memory.close(); rmSync(dir, { recursive: true, force: true }); }
});
test('failed extraction retries on next message and persists exactly once with bounded concurrency', async () => {
 let failures = 1, active = 0, peak = 0;
 const failed = Promise.withResolvers<void>();
 await fixture(async (o, dir) => {
  o.append(entry(0)); await failed.promise;
  o.append(entry(1)); o.append(entry(2)); await o.extracted();
  expect(peak).toBeLessThanOrEqual(2);
  expect(readFileSync(join(dir, 'orders.jsonl'), 'utf8').trim().split('\n').length).toBe(3);
 }, async task => {
  if (task.kind !== 'extract') return [];
  active++; peak = Math.max(peak, active);
  try { if (task.entry.i === 0 && failures-- > 0) throw Error('transient'); await Promise.resolve(); return [task.entry.text]; } finally { active--; }
 }, [], () => failed.resolve());
});
