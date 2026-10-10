import { test, expect } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Orders, type OrderDirective, type OrderTask } from '../src/orders.ts';
import { projectContext } from '../src/integration.ts';
import type { Entry } from '../src/memory.ts';
import { cachePayload, splitView } from '../src/cache.ts';
import { Memory } from '../src/memory.ts';
import { EXTRACT_ORDERS, CONSOLIDATE_ORDERS, OPTCHAT_PROMPT } from '../src/prompts.ts';
import { FileStore } from '../src/store.ts';
const entry = (i: number, text = 'Never push', kind: 'user' | 'talk' = 'user') => ({ i, text, kind, date: '2026-10-10', size: text.length });
/** The consolidation's default answer: every recorded standing order, as the ledger would hold it. */
const consolidate: OrderTask = async task => task.kind === 'consolidate'
 ? task.records.flatMap(r => r.orders.flatMap(order => 'retire' in order ? [] : [{ ...order, from: [r.i], date: r.date }]))
 : [];
async function fixture(run: (o: Orders, dir: string) => Promise<void>, task: OrderTask = consolidate, entries: Entry[] = [], warn: (text: string) => void = () => {}) {
 const dir = mkdtempSync(join(tmpdir(), 'orders-test-')); const o = new Orders(dir, task, warn, 10);
 try { for (const e of entries) o.append(e); await run(o, dir); } finally { await o.close(); rmSync(dir, { recursive: true, force: true }); }
}
/** Appends a user message and records what a summarizer call read for it, as the compactor does before the node is written. */
function seed(o: Orders, i: number, orders: OrderDirective[], text = 'Never push') {
 o.append(entry(i, text)); o.recordAll(new Map([[i, orders]]));
}
test('records every scanned message, empty included; custom-tagged and non-user messages are never scanned', async () => {
 await fixture(async (o, dir) => {
  o.append(entry(0)); o.append(entry(1, 'question?')); o.append(entry(2, '[async-result] result')); o.append(entry(3, '[any-custom] result')); o.append(entry(4, 'reply', 'talk'));
  expect(o.scan(0, 4)).toEqual([0, 1]);
  o.recordAll(new Map([[0, [{ said: 'Never push', text: 'Never push', kind: 'rule' }]], [1, []]]));
  expect(o.scan(0, 4)).toEqual([]);
  expect(readFileSync(join(dir, 'orders.jsonl'), 'utf8').trim().split('\n').map(x => JSON.parse(x))).toEqual([
   { i: 0, date: '2026-10-10', orders: [{ said: 'Never push', text: 'Never push', kind: 'rule' }] }, { i: 1, date: '2026-10-10', orders: [] }]);
 });
});
test('consolidation only at batch; persisted ledger loads without consolidating', async () => {
 let calls = 0;
 await fixture(async (o, dir) => {
  seed(o, 0, [{ text: 'Never push', kind: 'rule' }]);
  expect(calls).toBe(0); expect(o.render()).toBe('');
  await o.batch(0); expect(calls).toBe(1);
  const rendered = o.render();
  const restored = new Orders(dir, async () => { throw Error('must not call'); }); restored.backfill([entry(0)], () => false);
  await restored.settle(); expect(restored.render()).toBe(rendered); await restored.close();
 }, async task => { calls++; return consolidate(task, new AbortController().signal); });
});
test('opening orders precede chat and remain byte identical between batches', async () => {
 await fixture(async o => {
  seed(o, 0, [{ text: 'Never push', kind: 'rule' }]); await o.batch(0); const prefix = o.render();
  seed(o, 1, [], 'hello'); await o.settle(); expect(o.render()).toBe(prefix);
  const projected = projectContext([{ role: 'user', content: 'hello', timestamp: 1 }], 0, '<chat>\n0+1|user: hello\n</chat>', '', true, 'main', 1, prefix);
  const first = projected[0];
  if (first.role !== 'user' || typeof first.content === 'string') throw Error('Expected projected user blocks');
  expect(first.content[0]).toEqual({ type: 'text', text: prefix });
  expect(first.content[1]).toEqual({ type: 'text', text: '<chat>\n0+1|user: hello\n</chat>' });
 });
});
test('failed consolidation renders old ledger plus raw unconsolidated orders', async () => {
 await fixture(async o => {
  seed(o, 0, [{ text: 'Never push', kind: 'rule' }]); await o.batch(0);
  seed(o, 1, [{ text: 'Always verify', kind: 'rule' }], 'Always verify'); await o.batch(1);
  expect(o.render()).toContain('0 [rule] (2026-10-10): Never push'); expect(o.render()).toContain('1 [rule] (2026-10-10): Always verify');
 }, async task => task.kind === 'consolidate' && task.through === 0 ? [{ text: 'Never push', kind: 'rule', from: [0], date: '2026-10-10' }] : Promise.reject(Error('offline')));
});
test('16000 UTF-8 byte bound enforced without dropping orders', async () => {
 await fixture(async (o, dir) => {
  seed(o, 0, [{ text: 'Never push', kind: 'rule' }]); await o.batch(0);
  expect(o.render()).toContain('Never push'); expect(JSON.parse(readFileSync(join(dir, 'ledger.json'), 'utf8')).through).toBe(-1);
 }, async task => task.kind === 'consolidate' ? [{ text: 'Never push ' + '界'.repeat(6000), kind: 'rule', from: [0], date: '2026-10-10' }] : []);
});
test('cache: a nonempty ledger does not shift chat four-line blocks or tools/system mark across turns', async () => {
 await fixture(async o => {
  seed(o, 0, [{ text: 'Never push', kind: 'rule' }]); await o.batch(0);
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
test('Memory publishes ledger on actual view merges, not ordinary append or tree merges', async () => {
 const dir = mkdtempSync(join(tmpdir(), 'orders-memory-')); let batches = 0;
 const memory = await Memory.open(dir, async input => input.scan ? { text: 's'.repeat(100), orders: new Map(input.scan.map(i => [i, [{ text: 'Never push', kind: 'rule' as const }]])) } : 's'.repeat(100), () => {}, 200, 2,
  async task => { if (task.kind === 'consolidate') batches++; return consolidate(task, new AbortController().signal); });
 try {
  memory.append('user', 'Never push ' + 'x'.repeat(600)); await memory.settle(undefined, 'tree');
  await memory.orders!.settle(); expect(batches).toBe(0);
  memory.append('user', 'Always verify ' + 'x'.repeat(600)); await memory.settle(undefined, 'tree');
  expect(batches).toBe(0);
  memory.append('user', 'Keep constraints ' + 'x'.repeat(600)); await memory.settle(undefined, 'tree');
  expect(batches).toBeGreaterThan(0); expect(memory.orders!.render()).toContain('Never push');
 } finally { await memory.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('B extraction policy excludes task-scoped agent/deployment approvals while retaining ongoing conditional goals', () => {
 expect(EXTRACT_ORDERS).toContain('keeps applying beyond the current task');
 for (const example of ['use agent Y for this task', 'you may do number one', 'push this', 'install and restart']) expect(EXTRACT_ORDERS).toContain(example);
 expect(EXTRACT_ORDERS).toContain('goals of an ongoing stream with conditions');
 expect(EXTRACT_ORDERS).toContain('Context is for resolving references only');
 expect(EXTRACT_ORDERS).toContain('never a source of orders by itself');
});
test('C consolidation forbids interpretation and only permits replacement/resolved-choice annotations', () => {
 expect(CONSOLIDATE_ORDERS).toContain('Do not interpret');
 expect(CONSOLIDATE_ORDERS).toContain('only allowed annotations');
 expect(CONSOLIDATE_ORDERS).toContain('(replaces msg N)');
 expect(CONSOLIDATE_ORDERS).toContain('(chosen:');
 for (const forbidden of ['Possibly an exception', 'as written', 'unclear', 'typed']) expect(CONSOLIDATE_ORDERS).toContain(forbidden);
});

test('D kind and goal done-condition survive consolidation and render with through header', async () => {
 await fixture(async o => {
  seed(o, 0, [{ text: 'Watch CP MR !103', kind: 'goal', until: 'CP MR !103 merged' }], 'Watch CP MR !103'); await o.batch(0);
  expect(o.ledger.items[0]).toMatchObject({ kind: 'goal', until: 'CP MR !103 merged' });
  expect(o.render()).toContain('<orders through="0">');
  expect(o.render()).toContain('0 [goal until: CP MR !103 merged] (2026-10-10): Watch CP MR !103');
 });
});
test('D legacy string records load as rules without rewriting history', async () => {
 const dir = mkdtempSync(join(tmpdir(), 'orders-legacy-')); const file = join(dir, 'orders.jsonl');
 const text = JSON.stringify({ i: 0, date: '2026-10-10', orders: ['Never push'] }) + '\n';
 writeFileSync(file, text); const o = new Orders(dir, consolidate);
 try { expect(o.records.get(0)?.orders).toEqual([{ said: 'Never push', text: 'Never push', kind: 'rule' }]); expect(readFileSync(file, 'utf8')).toBe(text); } finally { await o.close(); rmSync(dir, { recursive: true, force: true }); }
});
test('one superseding record loads and wins; a second superseding record is rejected', async () => {
 const dir = mkdtempSync(join(tmpdir(), 'orders-supersede-')), file = join(dir, 'orders.jsonl');
 const original = { i: 0, date: '2026-10-10', orders: [{ text: 'push when green please', kind: 'rule' }] };
 const replacement = { i: 0, date: '2026-10-10', orders: [{ said: 'push when green please', text: 'Push when green.', kind: 'rule' as const }], supersedes: true };
 writeFileSync(file, [original, replacement].map(r => JSON.stringify(r)).join('\n') + '\n');
 let o: Orders | undefined;
 try {
  expect(() => { o = new Orders(dir, consolidate); }).not.toThrow();
  expect(o!.records.get(0)?.orders).toEqual(replacement.orders);
  await o!.close(); o = undefined;
  writeFileSync(file, JSON.stringify(replacement) + '\n', { flag: 'a' });
  expect(() => new Orders(dir, consolidate)).toThrow('duplicate orders');
 } finally { await o?.close(); rmSync(dir, { recursive: true, force: true }); }
});
test('legacy migration runs once in bounded backfill and changes the ledger only at the next batch', async () => {
 const dir = mkdtempSync(join(tmpdir(), 'orders-migrate-')), file = join(dir, 'orders.jsonl');
 const original = { i: 1, date: '2026-10-10', orders: [{ text: 'push when green please', kind: 'rule' as const }] };
 const oldLedger = { through: 3, items: [{ text: 'push when green please', kind: 'rule', from: [1], date: '2026-10-10' }] };
 writeFileSync(file, JSON.stringify(original) + '\n'); writeFileSync(join(dir, 'ledger.json'), JSON.stringify(oldLedger));
 const history = [entry(0, 'a'.repeat(3000), 'talk'), entry(1, 'push when green please'), entry(2, 'b'.repeat(3000), 'talk'), entry(3, 'other', 'talk')];
 let scans = 0, batches = 0, o: Orders | undefined;
 const task: OrderTask = async input => {
  if (input.kind === 'backfill') {
   scans++; expect(input.items.length).toBeLessThanOrEqual(20);
   expect(input.items[0]).toEqual({ i: 1, text: 'push when green please', before: 'a'.repeat(2048), after: 'b'.repeat(2048), previous: original.orders });
   return { 1: [{ said: 'push when green please', text: 'Push when green.', kind: 'rule' }] };
  }
  batches++; expect(input.ledger.items).toEqual([]);
  return consolidate(input, new AbortController().signal);
 };
 try {
  o = new Orders(dir, task); const before = o.render(); o.backfill(history, () => false); await o.drain();
  expect(scans).toBe(1); expect(batches).toBe(0); expect(o.render()).toBe(before);
  expect(readFileSync(file, 'utf8').startsWith(JSON.stringify(original) + '\n')).toBe(true);
  expect(JSON.parse(readFileSync(file, 'utf8').trim().split('\n')[1]).supersedes).toBe(true);
  await o.close(); o = new Orders(dir, task); o.backfill(history, () => false); await o.drain();
  expect(scans).toBe(1); expect(o.render()).toBe(before);
  await o.batch(4); expect(o.render()).toContain('Push when green.'); expect(o.render()).not.toContain('please');
  expect(batches).toBe(1);
  await o.close(); o = new Orders(dir, task); o.backfill(history, () => false); await o.drain(); await o.settle();
  expect(scans).toBe(1); expect(batches).toBe(1); expect(o.render()).toContain('Push when green.');
 } finally { await o?.close(); rmSync(dir, { recursive: true, force: true }); }
});
test('legacy backfill batches at 20, bounds UTF-8 talk context, and guards every restatement', async () => {
 const dir = mkdtempSync(join(tmpdir(), 'orders-migrate-bounded-'));
 const records = Array.from({ length: 22 }, (_, i) => ({ i: i + 1, date: '2026-10-10', orders: [{ text: 'Never push with 0 waived.', kind: 'rule' }] }));
 writeFileSync(join(dir, 'orders.jsonl'), records.map(r => JSON.stringify(r)).join('\n') + '\n');
 writeFileSync(join(dir, 'ledger.json'), JSON.stringify({ through: 23, items: [] }));
 const batches: number[] = [];
 const contexts: string[] = [];
 const o = new Orders(dir, async input => {
  if (input.kind !== 'backfill') throw Error('No consolidation outside a view batch');
  batches.push(input.items.length);
  for (const item of input.items) {
   contexts.push(item.before!, item.after!);
  }
  return Object.fromEntries(input.items.map(item => [item.i, [{ said: item.text, text: 'Push.', kind: 'rule' }]]));
 });
 try {
  o.backfill([entry(0, '界'.repeat(2000), 'talk'), ...records.map(r => entry(r.i, 'Never push with 0 waived.')), entry(23, '界'.repeat(2000), 'talk')], () => false);
  await o.drain();
  expect(batches).toEqual([20, 2]);
  for (const context of contexts) {
   expect(Buffer.byteLength(context)).toBeLessThanOrEqual(2048);
   expect(context).not.toContain('\uFFFD');
  }
  for (const record of o.records.values()) expect(record.orders).toEqual([{ said: 'Never push with 0 waived.', text: 'Never push with 0 waived.', kind: 'rule' }]);
 } finally { await o.close(); rmSync(dir, { recursive: true, force: true }); }
});
test('a next-batch migrated actor prohibition replaces the incompatible goal and merges duplicate source ids', async () => {
 const dir = mkdtempSync(join(tmpdir(), 'orders-migrate-conflict-'));
 const records = [
  { i: 0, date: '2026-10-10', orders: [{ text: 'AgentA should raise merge requests.', kind: 'goal' }] },
  { i: 1, date: '2026-10-10', orders: [{ text: 'AgentA must never raise merge requests; AgentB should do it.', kind: 'rule' }] },
  { i: 2, date: '2026-10-10', orders: [{ text: 'Always review code.', kind: 'rule' }] },
  { i: 3, date: '2026-10-10', orders: [{ text: 'Always review code.', kind: 'rule' }] },
 ];
 writeFileSync(join(dir, 'orders.jsonl'), records.map(r => JSON.stringify(r)).join('\n') + '\n');
 writeFileSync(join(dir, 'ledger.json'), JSON.stringify({ through: 3, items: records.flatMap(r => r.orders.map(order => ({ ...order, from: [r.i], date: r.date }))) }));
 const o = new Orders(dir, async input => input.kind === 'backfill'
  ? Object.fromEntries(input.items.map(item => [item.i, records[item.i].orders.map(order => ({ ...order, said: order.text }))]))
  : [
   { ...records[1].orders[0], text: records[1].orders[0].text + ' (replaces msg 0)', from: [1], date: records[1].date },
   { ...records[2].orders[0], from: [2, 3], date: records[3].date },
  ]);
 try {
  o.backfill(records.map(r => entry(r.i, r.orders[0].text)), () => false); await o.drain(); await o.batch(4);
  expect(o.ledger.items).toHaveLength(2);
  expect(o.ledger.items.some(item => item.from.includes(0))).toBe(false);
  expect(o.ledger.items[0].text).toContain('(replaces msg 0)');
  expect(o.ledger.items[1].from).toEqual([2, 3]);
 } finally { await o.close(); rmSync(dir, { recursive: true, force: true }); }
});
test('migration preserves a finite goal done-condition while recovering its conditional permission', async () => {
 const dir = mkdtempSync(join(tmpdir(), 'orders-migrate-until-'));
 writeFileSync(join(dir, 'orders.jsonl'), JSON.stringify({ i: 0, date: '2026-10-10', orders: [{ text: 'ensure we fix them eventually', kind: 'goal', until: 'the 1858 gate entries are fixed' }] }) + '\n');
 const warnings: string[] = [], o = new Orders(dir, consolidate, warning => warnings.push(warning));
 try {
  o.recordAll(new Map([[0, [{ said: 'okay to push with no verify but ensure we fix them eventually', text: 'Push with no verify is permitted provided the gaps are eventually fixed.', kind: 'rule' }]]]));
  expect(o.records.get(0)?.orders).toEqual([{ said: 'okay to push with no verify but ensure we fix them eventually', text: 'Push with no verify is permitted provided the gaps are eventually fixed.', kind: 'goal', until: 'the 1858 gate entries are fixed' }]);
  expect(warnings).toHaveLength(1);
 } finally { await o.close(); rmSync(dir, { recursive: true, force: true }); }
});
test('D user retire record removes targeted item only at the next consolidation', async () => {
 const dir = mkdtempSync(join(tmpdir(), 'orders-retire-')); let o: Orders | undefined;
 const keep = { text: 'Always verify', kind: 'rule', from: [2], date: '2026-10-10' };
 writeFileSync(join(dir, 'orders.jsonl'), [{ i: 0, date: '2026-10-10', orders: ['Watch CP MR !103'] }, { i: 2, date: '2026-10-10', orders: ['Always verify'] }, { i: 3, date: '2026-10-10', orders: [{ retire: [0] }] }].map(r => JSON.stringify(r)).join('\n') + '\n');
 writeFileSync(join(dir, 'ledger.json'), JSON.stringify({ through: 2, items: [{ text: 'Watch CP MR !103', kind: 'goal', until: 'CP MR !103 merged', from: [0], date: '2026-10-10' }, keep] }));
 try {
  expect(() => { o = new Orders(dir, async input => input.kind === 'consolidate' ? input.ledger.items : [], () => {}); }).not.toThrow();
  if (!o) throw Error('Orders failed to load retire history');
  expect(o.render()).toContain('Watch CP MR !103'); await o.batch(3);
  expect(o.render()).not.toContain('Watch CP MR !103'); expect(o.render()).toContain('Always verify');
  expect(o.render()).toContain('<orders through="3">');
  expect(readFileSync(join(dir, 'orders.jsonl'), 'utf8')).toContain('\"retire\":[0]');
 } finally { await o?.close(); rmSync(dir, { recursive: true, force: true }); }
});
test('B a text retire phrase retires only the items carrying its content words, not every item sharing a stopword', async () => {
 const dir = mkdtempSync(join(tmpdir(), 'orders-retire-b-')); let o: Orders | undefined;
 writeFileSync(join(dir, 'orders.jsonl'), [{ i: 3, date: '2026-10-10', orders: [{ retire: ['The MR watch rule'] }] }].map(r => JSON.stringify(r)).join('\n') + '\n');
 writeFileSync(join(dir, 'ledger.json'), JSON.stringify({ through: 2, items: [{ text: 'Watch CP MR !103', kind: 'goal', until: 'CP MR !103 merged', from: [0], date: '2026-10-10' }, { text: 'Always check the rule', kind: 'rule', from: [2], date: '2026-10-10' }] }));
 try {
  o = new Orders(dir, async input => input.kind === 'consolidate' ? input.ledger.items : [], () => {});
  await o.batch(3);
  expect(o.render()).not.toContain('Watch CP MR !103'); expect(o.render()).toContain('Always check the rule');
 } finally { await o?.close(); rmSync(dir, { recursive: true, force: true }); }
});
test('D assistant completion and model judgement cannot retire a goal', async () => {
 const dir = mkdtempSync(join(tmpdir(), 'orders-no-expiry-'));
 writeFileSync(join(dir, 'ledger.json'), JSON.stringify({ through: 0, items: [{ text: 'Watch CP MR !103', kind: 'goal', until: 'CP MR !103 merged', from: [0], date: '2026-10-10' }] }));
 const o = new Orders(dir, async () => [], () => {});
 try { o.append(entry(1, 'CP MR !103 merged; that goal is done.', 'talk')); await o.batch(1); expect(o.render()).toContain('Watch CP MR !103'); } finally { await o.close(); rmSync(dir, { recursive: true, force: true }); }
});
test('D turn prompt gives newer user changes precedence and requires user-confirmed retirement', () => {
 expect(OPTCHAT_PROMPT).toContain('standing orders as of message N');
 expect(OPTCHAT_PROMPT).toContain('newer messages in the view can change or retire them and then win');
 expect(OPTCHAT_PROMPT).toContain('ask the user whether to retire it');
 expect(OPTCHAT_PROMPT).toContain("never treat it as retired without the user's words");
});
test('D goal typing does not expand eligibility and persistent gate-scope choices are policies', () => {
 expect(EXTRACT_ORDERS).toContain('Classify eligibility before assigning kind');
 expect(EXTRACT_ORDERS).toContain('persistent coverage or gate scope');
 expect(EXTRACT_ORDERS).toContain('Approving a local implementation/test execution plan is not adopting its steps as standing goals or rules');
});
test('D a newer user can reintroduce a retired order within the same batch', async () => {
 const dir = mkdtempSync(join(tmpdir(), 'orders-reintroduce-'));
 const goal = { text: 'Watch CP MR !103', kind: 'goal', until: 'CP MR !103 merged', from: [0], date: '2026-10-10' };
 writeFileSync(join(dir, 'ledger.json'), JSON.stringify({ through: 2, items: [goal] }));
 writeFileSync(join(dir, 'orders.jsonl'), [{ i: 3, date: '2026-10-10', orders: [{ retire: ['Watch CP MR !103'] }] }, { i: 4, date: '2026-10-10', orders: [{ text: goal.text, kind: goal.kind, until: goal.until }] }].map(r => JSON.stringify(r)).join('\n') + '\n');
 const o = new Orders(dir, async () => [{ ...goal, from: [4] }], () => {});
 try { await o.batch(4); expect(o.render()).toContain('4 [goal until: CP MR !103 merged]'); expect(o.render()).toContain('<orders through="4">'); } finally { await o.close(); rmSync(dir, { recursive: true, force: true }); }
});
test('D a later user prohibition replaces a conflicting goal without waiting for completion', () => {
 expect(CONSOLIDATE_ORDERS).toContain('User-authorized replacement is not model-owned expiry');
 expect(CONSOLIDATE_ORDERS).toContain('remove the earlier goal even if its done-condition has not been met');
});
test('D overlap, broader goals and ambiguous tension do not authorize replacement', () => {
 expect(CONSOLIDATE_ORDERS).toContain('only if the user says it changes/replaces it, or both cannot be followed at the same time');
 expect(CONSOLIDATE_ORDERS).toContain('Overlap or a broader goal is not a replacement');
 expect(CONSOLIDATE_ORDERS).toContain('keep both verbatim and add no interpretation');
});
test('D an empty scan cannot become a new authority source for an existing goal', async () => {
 const dir = mkdtempSync(join(tmpdir(), 'orders-source-authority-'));
 const goal = { text: 'Watch CP MR !103', kind: 'goal', until: 'CP MR !103 merged', from: [0], date: '2026-10-10' };
 writeFileSync(join(dir, 'ledger.json'), JSON.stringify({ through: 0, items: [goal] }));
 const o = new Orders(dir, async () => [{ ...goal, from: [0, 1] }], () => {});
 try { o.append(entry(1, 'Is it done?')); await o.batch(1); expect(o.ledger.items[0].from).toEqual([0]); expect(o.render()).toContain('Watch CP MR !103'); } finally { await o.close(); rmSync(dir, { recursive: true, force: true }); }
});

// Ledger durability: a batch must leave a pending checkpoint before any merged view is saved, survive an interrupted close,
// block the first turn after a restart until it lands, and keep the block byte-identical when there is no pending work.
const ledgerOf = (dir: string): { through: number; items: unknown[]; raw?: unknown[]; retire?: unknown[]; pending?: number } =>
 JSON.parse(readFileSync(join(dir, 'ledger.json'), 'utf8'));
const pendingOf = (dir: string) => { try { return ledgerOf(dir).pending; } catch { return undefined; } };
const BANANA = 'Standing rule from now on: always end every answer with BANANA.';
const DROP = 'The BANANA rule is done, drop it.';
/** A batch(1) whose consolidation model call is killed by close(), as when OMP shuts down mid-batch. */
async function interruptedBatch(dir: string) {
 const o = new Orders(dir, async (task, signal) => {
  // A model client rejects at once when the signal was already aborted before the call.
  const { promise, reject } = Promise.withResolvers<never>();
  if (signal.aborted) reject(Error('closed'));
  else signal.addEventListener('abort', () => reject(Error('closed')), { once: true });
  return promise;
 }, () => {}, 10);
 o.append(entry(0, BANANA)); o.recordAll(new Map([[0, [{ text: BANANA, kind: 'rule' }]]]));
 o.append(entry(1, DROP)); o.recordAll(new Map([[1, [{ retire: ['BANANA rule'] }]]]));
 void o.batch(1);
 expect(pendingOf(dir)).toBe(1);
 await o.close();
}
/** Reopens after an interrupted batch; the consolidation runs once and is gated until `release`, `started` fires when it begins. */
function reopened(dir: string) {
 const gate = Promise.withResolvers<void>(), started = Promise.withResolvers<void>();
 let consolidations = 0;
 const restored = new Orders(dir, async task => {
  if (task.kind !== 'consolidate') throw Error('the summarizer must not be asked for orders at restart');
  consolidations++;
  started.resolve();
  await gate.promise;
  return [];
 }, () => {}, 10);
 restored.backfill([entry(0, BANANA), entry(1, DROP)], () => false);
 return { restored, release: () => gate.resolve(), ran: () => consolidations, started: started.promise };
}
const opening = (orders: string) => projectContext([{ role: 'user', content: 'hello', timestamp: 1 }], 0, '<chat>\n0+1|user: hello\n</chat>', '', true, 'main', 1, orders)[0];

test('batch checkpoints pending in ledger.json synchronously and before the merged view is saved', async () => {
 await fixture(async (o, dir) => {
  seed(o, 0, [{ text: BANANA, kind: 'rule' }], BANANA);
  const saving = o.batch(0);
  expect(pendingOf(dir)).toBe(0);
  await saving;
  expect(ledgerOf(dir).through).toBe(0);
  expect(pendingOf(dir)).toBeUndefined();
 });
 const dir = mkdtempSync(join(tmpdir(), 'orders-checkpoint-'));
 const proto = FileStore.prototype.saveView;
 let saves = 0, pendingAtViewSave: unknown = 'no view save after open';
 const viewSaved = Promise.withResolvers<void>();
 FileStore.prototype.saveView = function (this: FileStore, view: string) {
  if (this.directory === dir && ++saves > 1) {
   try { pendingAtViewSave = ledgerOf(dir).pending; } catch { pendingAtViewSave = 'no ledger yet'; }
   viewSaved.resolve();
  }
  return proto.call(this, view);
 };
 const gate = Promise.withResolvers<void>();
 let memory: Memory | undefined;
 try {
  memory = await Memory.open(dir, async input => input.scan ? { text: 's'.repeat(100), orders: new Map(input.scan.map(i => [i, i === 0 ? [{ text: BANANA, kind: 'rule' as const }] : []])) } : 's'.repeat(100), () => {}, 200, 2, async (task, signal) => {
   await gate.promise;
   return consolidate(task, signal);
  });
  memory.append('user', `${BANANA} ${'x'.repeat(600)}`);
  await memory.settle(undefined, 'tree');
  memory.append('user', `also keep this ${'x'.repeat(600)}`);
  await memory.settle(undefined, 'tree');
  memory.append('user', `and this one forces the first merge ${'x'.repeat(600)}`);
  const settling = memory.settle(undefined, 'tree');
  await viewSaved.promise;
  expect(pendingAtViewSave).toBe(2);
  expect(pendingOf(dir)).toBe(2);
  gate.resolve();
  await settling;
  expect(ledgerOf(dir).through).toBe(2);
  expect(pendingOf(dir)).toBeUndefined();
 } finally { FileStore.prototype.saveView = proto; await memory?.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('close during a batch keeps pending and the restart blocks the first settle until consolidation lands', async () => {
 const dir = mkdtempSync(join(tmpdir(), 'orders-interrupt-'));
 try {
  await interruptedBatch(dir);
  expect(pendingOf(dir)).toBe(1);
  expect(ledgerOf(dir).through).toBe(-1);
  const { restored, release, ran, started } = reopened(dir);
  let settled = false;
  const first = restored.settle().then(() => { settled = true; });
  await started;
  expect(ran()).toBe(1);
  expect(settled).toBe(false);
  release();
  await first;
  expect(ledgerOf(dir).through).toBe(1);
  expect(pendingOf(dir)).toBeUndefined();
  expect(restored.render()).not.toContain('BANANA');
  await restored.close();
 } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('two consecutive turns after the replayed consolidation render byte-identical openings', async () => {
 const dir = mkdtempSync(join(tmpdir(), 'orders-stable-'));
 try {
  await interruptedBatch(dir);
  const { restored, release, started } = reopened(dir);
  const first = restored.settle();
  await started;
  release();
  await first;
  expect(ledgerOf(dir).through).toBe(1);
  expect(restored.render()).not.toContain('BANANA');
  const afterReplay = restored.render(), blocks = opening(restored.render());
  await restored.settle();
  expect(restored.render()).toBe(afterReplay);
  expect(opening(restored.render())).toEqual(blocks);
  await restored.close();
 } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('restart with no pending work renders a byte-identical orders block', async () => {
 await fixture(async (o, dir) => {
  seed(o, 0, [{ text: 'Always verify claims before answering.', kind: 'rule' }], 'Always verify claims before answering.');
  await o.batch(0);
  const before = o.render();
  await o.close();
  const restored = new Orders(dir, async task => { if (task.kind !== 'consolidate') throw Error('must not consolidate at start'); return []; }, () => {}, 10);
  restored.backfill([entry(0, 'Always verify claims before answering.')], () => false);
  await restored.settle();
  expect(restored.render()).toBe(before);
  await restored.close();
 });
});

test('consolidation failing after retries keeps pending and renders raw orders for the pending range', async () => {
 let attempts = 0;
 await fixture(async (o, dir) => {
  seed(o, 0, [{ text: 'Always verify claims before answering.', kind: 'rule' }], 'Always verify claims before answering.');
  await o.batch(0);
  expect(attempts).toBe(3);
  expect(o.render()).toContain('Always verify claims');
  const saved = ledgerOf(dir);
  expect(saved.through).toBe(-1);
  expect(saved.raw).toHaveLength(1);
  expect(saved.pending).toBe(0);
  let retries = 0;
  const restored = new Orders(dir, async task => {
   if (task.kind !== 'consolidate') throw Error('no summarizer call at restart');
   retries++;
   throw Error('offline');
  }, () => {}, 10);
  restored.backfill([entry(0, 'Always verify claims before answering.')], () => false);
  await restored.settle();
  expect(retries).toBe(3);
  expect(pendingOf(dir)).toBe(0);
  expect(restored.render()).toContain('Always verify claims');
  await restored.close();
 }, async () => { attempts++; throw Error('offline'); });
});

test('E a restated item that drops a number or path is rejected and retried with the missing tokens named', async () => {
 const source = 'Every endpoint must pass the PM gate with 0 waived and 0 baselined, see docs/gate.md.';
 const retries: string[] = [];
 await fixture(async o => {
  seed(o, 0, [{ text: source, kind: 'rule' }], source); await o.batch(0);
  expect(retries).toHaveLength(2); expect(retries[0]).toBe('');
  for (const token of ['"0"', '"docs/gate.md"']) expect(retries[1]).toContain(token);
  expect(o.ledger.items.map(item => item.text)).toEqual(['Every endpoint must pass the PM gate with 0 waived and 0 baselined; see docs/gate.md.']);
 }, async task => {
  if (task.kind !== 'consolidate') throw Error('unexpected');
  retries.push(task.retry ?? '');
  return [{ text: retries.length === 1 ? 'Every endpoint must pass the PM gate.' : 'Every endpoint must pass the PM gate with 0 waived and 0 baselined; see docs/gate.md.', kind: 'rule', from: [0], date: '2026-10-10' }];
 });
});
test('E gatefoge typo fixed to Gateforge and one order spread over two messages pass as one merged item', async () => {
 let consolidations = 0;
 await fixture(async o => {
  seed(o, 0, [{ text: 'gatefoge must never push without review.', kind: 'rule' }], 'gatefoge must never push without review.');
  seed(o, 1, [{ text: 'Never push to main without review.', kind: 'rule' }], 'Never push to main without review.');
  await o.batch(1);
  expect(consolidations).toBe(1);
  expect(o.ledger.items).toEqual([{ text: 'Gateforge must never push to main without review.', kind: 'rule', from: [0, 1], date: '2026-10-10' }]);
  expect(o.render()).toContain('1 [rule] (2026-10-10): Gateforge must never push to main without review.');
 }, async () => {
  consolidations++;
  return [{ text: 'Gateforge must never push to main without review.', kind: 'rule', from: [0, 1], date: '2026-10-10' }];
 });
});
test('E after failed attempts only the failing order falls back to verbatim; the others keep restated wording', async () => {
 let consolidations = 0; const warnings: string[] = [];
 await fixture(async o => {
  seed(o, 0, [{ text: 'Always verify claims before answering.', kind: 'rule' }], 'Always verify claims before answering.');
  seed(o, 1, [{ text: 'PM gate: 0 baselined, see docs/gate.md.', kind: 'rule' }], 'PM gate: 0 baselined, see docs/gate.md.');
  seed(o, 2, [{ text: 'Never push to main.', kind: 'rule' }], 'Never push to main.');
  await o.batch(2);
  expect(consolidations).toBe(3);
  expect(o.ledger.through).toBe(2);
  const textOf = (id: number) => o.ledger.items.find(item => item.from.includes(id))?.text;
  expect(textOf(0)).toBe('Always verify claims before answering anything.');
  expect(textOf(1)).toBe('PM gate: 0 baselined, see docs/gate.md.');
  expect(textOf(2)).toBe('Never push to main.');
  expect(o.ledger.items).toHaveLength(3);
  expect(warnings).toHaveLength(1);
 }, async task => {
  if (task.kind !== 'consolidate') throw Error('unexpected');
  consolidations++;
  return [
   { text: 'Always verify claims before answering anything.', kind: 'rule', from: [0], date: '2026-10-10' },
   { text: 'PM gate must stay clean.', kind: 'rule', from: [1], date: '2026-10-10' },
   { text: 'Never push to main.', kind: 'rule', from: [2], date: '2026-10-10' },
  ];
 }, [], text => warnings.push(text));
});
test('E an order whose ids are covered but whose number changed (663 to 661) fails the guard', async () => {
 let consolidations = 0; const retries: string[] = []; const warnings: string[] = [];
 await fixture(async o => {
  seed(o, 0, [{ text: 'Keep the PM gate at 663 tests green.', kind: 'rule' }], 'Keep the PM gate at 663 tests green.'); await o.batch(0);
  expect(consolidations).toBe(3);
  expect(retries[1]).toContain('"663"');
  expect(o.render()).toContain('0 [rule] (2026-10-10): Keep the PM gate at 663 tests green.');
  expect(o.render()).not.toContain('661');
  expect(warnings).toHaveLength(1);
 }, async task => {
  if (task.kind !== 'consolidate') throw Error('unexpected');
  consolidations++; retries.push(task.retry ?? '');
  return [{ text: 'Keep the PM gate at 661 tests green.', kind: 'rule', from: [0], date: '2026-10-10' }];
 }, [], text => warnings.push(text));
});
test('E a newly recorded order the consolidation omits is appended verbatim after its retries instead of silently dropped', async () => {
 let consolidations = 0;
 await fixture(async o => {
  seed(o, 0, [{ text: 'Always verify claims.', kind: 'rule' }], 'Always verify claims.');
  seed(o, 1, [{ text: 'Never push to main.', kind: 'rule' }], 'Never push to main.');
  await o.batch(1);
  expect(consolidations).toBe(3);
  expect(o.render()).toContain('1 [rule] (2026-10-10): Never push to main.');
 }, async task => {
  if (task.kind !== 'consolidate') throw Error('unexpected');
  consolidations++;
  return [{ text: 'Always verify claims.', kind: 'rule', from: [0], date: '2026-10-10' }];
 });
});
test('E an order retired later in the same batch is not required in the consolidation', async () => {
 let consolidations = 0;
 await fixture(async o => {
  seed(o, 0, [{ text: 'Watch CP MR !103 until merged.', kind: 'rule' }], 'Watch CP MR !103 until merged.');
  seed(o, 1, [{ retire: [0] }], 'Drop the CP MR !103 watch.');
  await o.batch(1);
  expect(consolidations).toBe(1);
  expect(o.ledger.items).toEqual([]);
 }, async task => {
  if (task.kind !== 'consolidate') throw Error('unexpected');
  consolidations++;
  return [];
 });
});
test('E a previous order replaced by a newer user message needs no restated tokens of its own', async () => {
 const dir = mkdtempSync(join(tmpdir(), 'orders-replace-'));
 writeFileSync(join(dir, 'ledger.json'), JSON.stringify({ through: 0, items: [{ text: 'Watch CP MR !103 until merged.', kind: 'rule', from: [0], date: '2026-10-10' }] }));
 writeFileSync(join(dir, 'orders.jsonl'), JSON.stringify({ i: 1, date: '2026-10-10', orders: ['Stop watching CP MR !103 from now on.'] }) + '\n');
 const o = new Orders(dir, async () => [{ text: 'Stop watching CP MR !103 from now on. (replaces msg 0)', kind: 'rule', from: [1], date: '2026-10-10' }], () => {});
 try { await o.batch(1); expect(o.ledger.items).toEqual([{ text: 'Stop watching CP MR !103 from now on. (replaces msg 0)', kind: 'rule', from: [1], date: '2026-10-10' }]); } finally { await o.close(); rmSync(dir, { recursive: true, force: true }); }
});
test('E consolidation restates orders in clear wording, fixes typos and names, and keeps every condition', () => {
 expect(CONSOLIDATE_ORDERS).toContain('Restate each order');
 expect(CONSOLIDATE_ORDERS).toContain('Fix typos and names');
 expect(CONSOLIDATE_ORDERS).toContain('Keep every condition, number, name, path, id and quantifier');
 expect(CONSOLIDATE_ORDERS).not.toContain('correct spelling, normalize names');
});
test('E turn prompt says orders are restated and zoom(id, 1) shows the exact words', () => {
 expect(OPTCHAT_PROMPT).toContain('restated in clear wording');
 expect(OPTCHAT_PROMPT).toContain("zoom(id, 1) shows the user's exact words");
 expect(OPTCHAT_PROMPT).toContain('check the original with zoom(id, 1) before acting');
});
test('F a verbatim fallback keeps coverage of a passing order that shares a message with a failing one', async () => {
 const warnings: string[] = [];
 await fixture(async o => {
  seed(o, 0, [{ text: 'Never push to main.', kind: 'rule' }, { text: 'Always verify claims.', kind: 'rule' }], 'Never push to main. Always verify claims.'); await o.batch(0);
  expect(o.ledger.through).toBe(0);
  expect(o.render()).toContain('Never push to main.');
  expect(o.render()).toContain('Always verify claims.');
  expect(warnings).toHaveLength(1);
 }, async task => {
  if (task.kind !== 'consolidate') throw Error('unexpected');
  return [{ text: 'Always verify claims.', kind: 'rule', from: [0], date: '2026-10-10' }];
 }, [], text => warnings.push(text));
});
