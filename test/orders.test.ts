import { test, expect } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Orders, type OrderTask } from '../src/orders.ts';
import { projectContext } from '../src/integration.ts';
import type { Entry } from '../src/memory.ts';
import { cachePayload, splitView } from '../src/cache.ts';
import { Memory } from '../src/memory.ts';
import { EXTRACT_ORDERS, CONSOLIDATE_ORDERS, OPTCHAT_PROMPT } from '../src/prompts.ts';
const entry = (i: number, text = 'Never push', kind: 'user' | 'talk' = 'user') => ({ i, text, kind, date: '2026-10-10', size: text.length });
async function fixture(run: (o: Orders, dir: string) => Promise<void>, task: OrderTask = async (task) => task.kind === 'extract' ? ['Never push'] : [{ text: 'Never push', from: [0], date: '2026-10-10' }], entries: Entry[] = [], warn: (text: string) => void = () => {}) {
 const dir = mkdtempSync(join(tmpdir(), 'orders-test-')); const o = new Orders(dir, task, warn, 2, 10);
 try { o.backfill(entries); await run(o, dir); } finally { await o.close(); rmSync(dir, { recursive: true, force: true }); }
}
test('extract records every user including empty; skips custom tagged and non-user', async () => {
 await fixture(async (o, dir) => { o.append(entry(0)); o.append(entry(1, 'question?')); o.append(entry(2, '[async-result] result')); o.append(entry(3, '[any-custom] result')); o.append(entry(4, 'reply', 'talk')); await o.extracted();
 expect(readFileSync(join(dir, 'orders.jsonl'), 'utf8').trim().split('\n').map(x => JSON.parse(x))).toEqual([{ i: 0, date: '2026-10-10', orders: [{ text: 'Never push', kind: 'rule' }] }, { i: 1, date: '2026-10-10', orders: [] }]);
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
 await fixture(async o => { o.append(entry(0)); await o.batch(0); o.append(entry(1, 'Always verify')); await o.batch(1); expect(o.render()).toContain('0 [rule] (2026-10-10): Never push'); expect(o.render()).toContain('1 [rule] (2026-10-10): Always verify'); }, async task => task.kind === 'extract' ? [task.entry.text] : task.through === 0 ? [{ text: 'Never push', from: [0], date: '2026-10-10' }] : Promise.reject(Error('offline')));
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
  async task => task.kind === 'extract' ? ['Never push'] : (batches++, [...task.ledger.items, ...task.records.flatMap(r => r.orders.flatMap(order => 'retire' in order ? [] : [{ ...order, from: [r.i], date: r.date }]))]));
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

test('A live extraction resolves lasting option from immediately preceding assistant reply, not later replies', async () => {
 const choice = '"eclude and delete, yeah." (chosen: Exclude generated files from coverage and delete stale generated files.)';
 await fixture(async o => {
  o.append(entry(0, 'Exclude generated files from coverage and delete stale generated files.', 'talk'));
  o.append(entry(1, 'eclude and delete, yeah.'));
  o.append(entry(2, 'Unrelated later reply', 'talk'));
  await o.extracted();
  expect(o.records.get(1)?.orders).toEqual([{ text: choice, kind: 'rule' }]);
 }, async input => input.kind === 'extract' && 'context' in input && input.context === 'Exclude generated files from coverage and delete stale generated files.' ? [choice] : []);
});
test('A backfill supplies nearest reply chunks capped to 4000 valid UTF-8 bytes, retaining their end', async () => {
 let captured: unknown;
 const text = 'prefix' + '界'.repeat(2000) + ' END chosen policy';
 await fixture(async o => {
  await o.settle();
  expect(typeof captured).toBe('string');
  if (typeof captured !== 'string') throw Error('Missing extraction context');
  expect(Buffer.byteLength(captured)).toBeLessThanOrEqual(4000);
  expect(captured.endsWith(' END chosen policy')).toBe(true);
  expect(captured).not.toContain('prefix');
  expect(captured).not.toContain('\uFFFD');
 }, async input => { if (input.kind === 'extract') { captured = 'context' in input ? input.context : undefined; return []; } return []; },
 [entry(0, 'older unrelated reply', 'talk'), entry(1, 'previous user question'), entry(2, text.slice(0, 3000), 'talk'), entry(3, text.slice(3000), 'talk'), entry(4, 'that option, yeah')]);
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
  o.append(entry(0)); await o.batch(0);
  expect(o.ledger.items[0]).toMatchObject({ kind: 'goal', until: 'CP MR !103 merged' });
  expect(o.render()).toContain('<orders through="0">');
  expect(o.render()).toContain('0 [goal until: CP MR !103 merged] (2026-10-10): Watch CP MR !103');
 }, async input => input.kind === 'extract' ? [{ text: 'Watch CP MR !103', kind: 'goal', until: 'CP MR !103 merged' }] : [{ text: 'Watch CP MR !103', kind: 'goal', until: 'CP MR !103 merged', from: [0], date: '2026-10-10' }]);
});
test('D legacy string extraction records load as rules without rewriting history', async () => {
 const dir = mkdtempSync(join(tmpdir(), 'orders-legacy-')); const file = join(dir, 'orders.jsonl');
 const text = JSON.stringify({ i: 0, date: '2026-10-10', orders: ['Never push'] }) + '\n';
 writeFileSync(file, text); const o = new Orders(dir, async () => []);
 try { expect(o.records.get(0)?.orders).toEqual([{ text: 'Never push', kind: 'rule' }]); expect(readFileSync(file, 'utf8')).toBe(text); } finally { await o.close(); rmSync(dir, { recursive: true, force: true }); }
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
test('D empty extraction cannot become a new authority source for an existing goal', async () => {
 const dir = mkdtempSync(join(tmpdir(), 'orders-source-authority-'));
 const goal = { text: 'Watch CP MR !103', kind: 'goal', until: 'CP MR !103 merged', from: [0], date: '2026-10-10' };
 writeFileSync(join(dir, 'ledger.json'), JSON.stringify({ through: 0, items: [goal] }));
 const o = new Orders(dir, async input => input.kind === 'extract' ? [] : [{ ...goal, from: [0, 1] }], () => {});
 try { o.append(entry(1, 'Is it done?')); await o.batch(1); expect(o.ledger.items[0].from).toEqual([0]); expect(o.render()).toContain('Watch CP MR !103'); } finally { await o.close(); rmSync(dir, { recursive: true, force: true }); }
});
