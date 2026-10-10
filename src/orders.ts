import { existsSync, readFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { Entry } from './memory.ts';
import { appendJson, atomicWrite } from './store.ts';

export const ORDER_LIMIT = 16_000;
export interface StandingOrder { text: string; kind: 'rule' | 'goal'; until?: string }
export interface Retirement { retire: (string | number)[] }
interface RetirementEvent extends Retirement { i: number }
export type OrderDirective = StandingOrder | Retirement;
export interface ExtractedOrders { i: number; date: string; orders: OrderDirective[] }
export interface OrderItem extends StandingOrder { from: number[]; date: string }
export interface Ledger { through: number; items: OrderItem[] }
export interface OrderExtraction { kind: 'extract'; entry: Entry; context: string }
export type OrderInput = OrderExtraction | { kind: 'consolidate'; ledger: Ledger; records: ExtractedOrders[]; through: number; retry?: string };
export type OrderTask = (input: OrderInput, signal: AbortSignal) => Promise<unknown>;
const eligible = (entry: Entry) => entry.kind === 'user' && !/^\[[^\]\r\n]+\] /.test(entry.text);
function standing(value: unknown): StandingOrder {
 if (typeof value === 'string' && value.trim()) return { text: value.trim(), kind: 'rule' };
 if (typeof value !== 'object' || !value || !('text' in value) || typeof value.text !== 'string' || !value.text.trim()) throw Error('Invalid standing order.');
 const kind = 'kind' in value ? value.kind : 'rule';
 if (kind !== 'rule' && kind !== 'goal') throw Error('Invalid order kind.');
 const until = 'until' in value ? value.until : undefined;
 if (until !== undefined && (kind !== 'goal' || typeof until !== 'string' || !until.trim())) throw Error('Invalid goal done-condition.');
 return { text: value.text.trim(), kind, ...(typeof until === 'string' ? { until: until.trim() } : {}) };
}
function retireTargets(value: unknown): (string | number)[] {
 if (!Array.isArray(value) || !value.length || !value.every(v => typeof v === 'string' ? !!v.trim() : Number.isSafeInteger(v) && v >= 0)) throw Error('Invalid retirement targets.');
 return value.map(v => typeof v === 'string' ? v.trim() : v);
}
function directives(value: unknown): OrderDirective[] {
 if (!Array.isArray(value)) throw Error('Orders extraction must return an array.');
 return value.map((v: unknown) => typeof v === 'object' && v && 'retire' in v ? { retire: retireTargets(v.retire) } : standing(v));
}
/** A text retire target retires an order when each of its words appears in the order's text, in any order. */
function mentions(text: string, phrase: string) {
 const words = new Set(text.toLowerCase().match(/\p{L}+/gu) ?? []);
 return (phrase.toLowerCase().match(/\p{L}+/gu) ?? []).every(word => words.has(word));
}
function retired(item: OrderItem, events: readonly RetirementEvent[]) {
 return events.some(event => Math.max(...item.from) <= event.i && event.retire.some(target =>
  typeof target === 'number' ? item.from.includes(target) : mentions(item.text, target)));
}
const CONDITIONS: Record<string, true> = { every: true, each: true, all: true, any: true, never: true, always: true, only: true, until: true, unless: true, except: true, before: true, after: true, must: true, without: true };
/** Must-keep token of a source order: numbers, paths, URLs, ids and code-ish tokens match exactly; condition words match whole words; names of 5+ letters tolerate edit distance 2. */
interface Keep { text: string; match: 'exact' | 'word' | 'name' }
function distance(a: string, b: string) {
 let row = Array.from({ length: b.length + 1 }, (_, j) => j);
 for (let i = 1; i <= a.length; i++) {
  const next = [i];
  for (let j = 1; j <= b.length; j++) next[j] = Math.min(row[j] + 1, next[j - 1] + 1, row[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
  row = next;
 }
 return row[b.length];
}
function classify(token: string): Keep[] {
 if (!/[\p{L}\d]/u.test(token)) return [];
 if (token.includes('/') && !/[.:~]|^\//.test(token)) return token.split('/').flatMap(classify);
 if (/[._:\/\-\d]/.test(token)) return [{ text: token, match: 'exact' }];
 const found: Keep[] = [];
 for (const run of token.match(/\p{L}+/gu) ?? []) {
  if (CONDITIONS[run.toLowerCase()] === true) found.push({ text: run, match: 'word' });
  else if (run.length >= 5) found.push({ text: run, match: 'name' });
 }
 return found;
}
function keeps(source: string): Keep[] {
 return source.split(/\s+/).flatMap((raw): Keep[] => {
  const token = raw.replace(/^[`"'(\[{*]+|[`"')\]}.,;:!?*]+$/g, '');
  return raw.includes('`') && /[\p{L}\d]/u.test(token) ? [{ text: token, match: 'exact' }] : classify(token);
 });
}
function holds(keep: Keep, restated: string, words: readonly string[]) {
 if (keep.match === 'exact') return new RegExp(`(?<![\\p{L}\\d])${keep.text.replace(/[.*+?^${}()|[\]\\\/]/g, '\\$&')}(?![\\p{L}\\d])`, 'u').test(restated);
 const word = keep.text.toLowerCase();
 return keep.match === 'word' ? words.includes(word) : words.some(v => v === word || distance(v, word) <= 2);
}
/** Must-keep tokens of `source` that `restated` no longer carries; the guard and the retry note both use it. */
export function missingTokens(source: string, restated: string): string[] {
 const words = restated.toLowerCase().match(/\p{L}+/gu) ?? [];
 return [...new Set(keeps(source).filter(keep => !holds(keep, restated, words)).map(keep => keep.text))];
}
const wording = (order: StandingOrder) => [order.text, order.until].filter(Boolean).join(' ');
interface Gap { source: OrderItem; omitted: boolean; missing: string[] }
/** Each needed order must be restated by an item of its kind that shares one of its ids and keeps its must-keep tokens. */
function failing(next: readonly OrderItem[], needed: readonly OrderItem[]): Gap[] {
 return needed.flatMap((source): Gap[] => {
  const covering = next.filter(item => item.kind === source.kind && item.from.some(id => source.from.includes(id)));
  if (!covering.length) return [{ source, omitted: true, missing: [] }];
  const missing = covering.map(item => missingTokens(wording(source), wording(item))).reduce((best, current) => current.length < best.length ? current : best);
  return missing.length ? [{ source, omitted: false, missing }] : [];
 });
}
function retryNote(gaps: readonly Gap[]) {
 return `These orders lost wording while being restated. Restate each one again, keeping every listed word, number, path and id; typos and names may be fixed.\n${gaps.map(gap => `msg ${gap.source.from.join(', ')} "${wording(gap.source)}": ${gap.omitted ? 'no item covers it' : `missing ${gap.missing.map(t => JSON.stringify(t)).join(', ')}`}`).join('\n')}`;
}
/** Per failing order its ids leave every model item that carried them; every needed order left uncovered by that falls back to its verbatim text. */
function substitute(next: readonly OrderItem[], needed: readonly OrderItem[], gaps: readonly Gap[]): OrderItem[] {
 const ids = new Set(gaps.flatMap(gap => gap.source.from));
 const remaining = next.map(item => ({ ...item, from: item.from.filter(id => !ids.has(id)) })).filter(item => item.from.length);
 return [...remaining, ...needed.filter(source => failing(remaining, [source]).length).map(source => ({ ...source }))];
}
function items(value: unknown): OrderItem[] {
 if (!Array.isArray(value)) throw Error('Ledger must be an array.');
 return value.map((v: unknown) => {
  if (typeof v !== 'object' || !v || !('text' in v) || typeof v.text !== 'string' || !v.text.trim() || !('date' in v) || typeof v.date !== 'string' || !('from' in v) || !Array.isArray(v.from) || !v.from.length || !v.from.every(i => Number.isSafeInteger(i) && i >= 0)) throw Error('Invalid ledger item.');
  return { ...standing(v), from: v.from as number[], date: v.date };
 });
}
export function renderOrders(list: readonly OrderItem[], through: number) {
 return list.length ? `<orders through="${through}">\n${list.map(item => `${Math.max(...item.from)} [${item.kind}${item.until ? ` until: ${item.until}` : ''}] (${item.date.slice(0, 10)}): ${item.text}`).join('\n')}\n</orders>` : '';
}
/** Independent of the summary tree. Extraction is background; only batch/first-backfill publication changes the prefix. */
export class Orders {
 readonly records = new Map<number, ExtractedOrders>();
 ledger: Ledger = { through: -1, items: [] };
 private raw: OrderItem[] = [];
 private retire: RetirementEvent[] = [];
 private pending = new Map<number, OrderExtraction>();
 private lastReply = '';
 private replyContinues = false;
 private busy = new Map<number, Promise<void>>();
 private retry = new Map<number, number>();
 private timer?: ReturnType<typeof setTimeout>;
 private controller = new AbortController();
 private publication: Promise<void> = Promise.resolve();
 private bootstrap: Promise<void> = Promise.resolve();
 /** Batch point saved in ledger.json whose consolidation has not landed yet; blocks the first turn after a restart. */
 private pendingThrough?: number;
 private replay?: Promise<void>;
 private stopped = false;
 private loaded = false;
 private changed = new Set<() => void>();
 constructor(readonly directory: string, private task: OrderTask, private warn: (s: string) => void = console.error, private jobs = 8, private retryMs = 10_000) {
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const file = join(directory, 'orders.jsonl');
  if (existsSync(file)) for (const line of readFileSync(file, 'utf8').split('\n').filter(Boolean)) {
   const r = JSON.parse(line);
   if (!Number.isSafeInteger(r.i) || typeof r.date !== 'string' || this.records.has(r.i)) throw Error('Invalid/duplicate orders record.');
   this.records.set(r.i, { i: r.i, date: r.date, orders: directives(r.orders) });
  }
  const ledger = join(directory, 'ledger.json');
  if (existsSync(ledger)) {
   const saved = JSON.parse(readFileSync(ledger, 'utf8'));
   if (!Number.isSafeInteger(saved.through) || saved.through < -1) throw Error('Invalid ledger boundary.');
   this.ledger = { through: saved.through, items: items(saved.items) }; this.loaded = true;
   if (saved.pending !== undefined) {
    if (!Number.isSafeInteger(saved.pending) || saved.pending < -1) throw Error('Invalid pending batch marker.');
    if (saved.pending > saved.through) this.pendingThrough = saved.pending;
   }
   if (saved.raw !== undefined) this.raw = items(saved.raw);
   if (saved.retire !== undefined) {
    if (!Array.isArray(saved.retire)) throw Error('Invalid pending retirements.');
    this.retire = saved.retire.map((event: unknown) => {
     if (typeof event !== 'object' || !event || !('i' in event) || typeof event.i !== 'number' || !Number.isSafeInteger(event.i) || event.i < 0 || !('retire' in event)) throw Error('Invalid pending retirement.');
     return { i: event.i, retire: retireTargets(event.retire) };
    });
   }
  }
 }
 backfill(entries: readonly Entry[]) {
  for (const e of entries) this.append(e);
  const through = entries.length - 1;
  if (this.pendingThrough !== undefined && this.pendingThrough > this.ledger.through) {
   // A restart interrupted this consolidation (see `pending` in ledger.json): finishing it is blocking work.
   const pending = this.pendingThrough;
   this.replay = this.extracted(pending).then(() => this.batch(pending)).catch(error => {
    if (!this.stopped) this.warn(`Orders replay: ${String(error)}`);
   });
  } else if (entries.length && !this.loaded) {
   this.bootstrap = this.extracted(through).then(() => this.batch(through)).catch(error => {
    if (!this.stopped) this.warn(`Orders backfill: ${String(error)}`);
   });
  }
 }
 append(entry: Entry) {
  if (entry.kind === 'talk') {
   const reply = Buffer.from((this.replyContinues ? this.lastReply : '') + entry.text);
   let at = Math.max(0, reply.length - 4000);
   while (at < reply.length && (reply[at] & 0xc0) === 0x80) at++;
   this.lastReply = reply.subarray(at).toString('utf8');
   this.replyContinues = true;
  } else this.replyContinues = false;
  for (const id of this.retry.keys()) this.retry.set(id, 0);
  this.pump();
  if (!eligible(entry) || this.stopped) return;
  const context = this.lastReply;
  this.lastReply = '';
  if (this.records.has(entry.i) || this.pending.has(entry.i)) return;
  this.pending.set(entry.i, { kind: 'extract', entry, context }); this.pump();
 }
 private notify() { for (const fn of this.changed) fn(); }
 private pump() {
  if (this.stopped) return;
  clearTimeout(this.timer); this.timer = undefined;
  for (const [i, input] of this.pending) {
   if (this.busy.size >= this.jobs) break;
   if (this.busy.has(i) || (this.retry.get(i) ?? 0) > Date.now()) continue;
   const work = Promise.resolve().then(async () => {
    const orders = directives(await this.task(input, this.controller.signal));
    if (this.stopped) return;
    const record = { i, date: input.entry.date, orders };
    appendJson(join(this.directory, 'orders.jsonl'), record);
    this.records.set(i, record); this.pending.delete(i); this.retry.delete(i);
   }).catch(error => { if (!this.stopped) { this.warn(`Orders ${i}: ${String(error)}`); this.retry.set(i, Date.now() + this.retryMs); } })
    .finally(() => { this.busy.delete(i); this.pump(); this.notify(); });
   this.busy.set(i, work);
  }
  const deadlines = [...this.retry.values()].filter(t => t > Date.now());
  if (deadlines.length) this.timer = setTimeout(() => this.pump(), Math.max(1, Math.min(...deadlines) - Date.now()));
 }
 async extracted(through = Infinity, signal?: AbortSignal) {
  while ([...this.pending.keys()].some(i => i <= through)) {
   if (this.stopped || signal?.aborted) throw Error('Orders wait cancelled.');
   await new Promise<void>((resolve, reject) => {
    const cleanup = () => { this.changed.delete(wake); signal?.removeEventListener('abort', abort); };
    const wake = () => { cleanup(); resolve(); };
    const abort = () => { cleanup(); reject(Error('Orders wait cancelled.')); };
    this.changed.add(wake); signal?.addEventListener('abort', abort, { once: true });
   });
  }
 }
 /** Synchronously rewrites ledger.json: the current ledger plus optional extras. A batch's `pending` marker must be on
  * disk before the merge that requested it can save the view, so this never waits. */
 private writeLedger(extra: { pending?: number }) {
  atomicWrite(join(this.directory, 'ledger.json'), JSON.stringify({
   ...this.ledger, ...(this.raw.length ? { raw: this.raw } : {}), ...(this.retire.length ? { retire: this.retire } : {}), ...extra,
  }));
 }
 batch(through: number) {
  if (!this.stopped && through > this.ledger.through && through !== this.pendingThrough) {
   this.pendingThrough = through;
   this.writeLedger({ pending: through });
  }
  this.publication = this.publication.then(async () => {
   await this.extracted(through);
   const records = [...this.records.values()].filter(r => r.i > this.ledger.through && r.i <= through).sort((a, b) => a.i - b.i);
   if (through <= this.ledger.through) return;
   const targets = records.flatMap(r => r.orders.flatMap(order => 'retire' in order ? [{ i: r.i, retire: order.retire }] : []));
   let retry: string | undefined;
   for (let attempt = 0; attempt < 3; attempt++) try {
    const next = items(await this.task({ kind: 'consolidate', ledger: this.ledger, records, through, retry }, this.controller.signal)).filter(item => !retired(item, targets));
    const replacedBy = (previous: OrderItem) => next.some(item => item.from.some(id => records.some(r => r.i === id && r.i > Math.max(...previous.from) && r.orders.some(order => !('retire' in order))))
     && previous.from.some(id => item.text.includes(`(replaces msg ${id})`)));
    const kept = this.ledger.items.filter(item => !retired(item, targets) && !replacedBy(item));
    const fresh = records.flatMap(r => r.orders.flatMap(order => 'retire' in order ? [] : [{ ...order, from: [r.i], date: r.date }])).filter(order => !retired(order, targets));
    const needed = [...kept, ...fresh];
    const gaps = failing(next, needed);
    const omitted = gaps.find(gap => gap.omitted && kept.includes(gap.source));
    if (omitted) throw Error(`Only user words can retire or replace an order; model omitted active order: ${omitted.source.text}`);
    if (gaps.length && attempt < 2) { retry = retryNote(gaps); continue; }
    const final = gaps.length ? substitute(next, needed, gaps) : next;
    if (failing(final, needed).length) throw Error('Verbatim fallback did not restore coverage.');
    if (gaps.length) this.warn(`Orders consolidation: kept the verbatim wording of ${gaps.length} order(s) that lost conditions after retries (msg ${gaps.map(gap => gap.source.from.join(', ')).join('; ')}).`);
    const dates = new Map<number, string>();
    for (const item of this.ledger.items) for (const id of item.from) dates.set(id, item.date);
    for (const r of records) if (r.orders.some(order => !('retire' in order))) dates.set(r.i, r.date);
    for (const item of final) {
     if (item.from.some(id => !dates.has(id))) throw Error('Ledger invented a source id.');
     item.date = dates.get(Math.max(...item.from))!;
    }
    if (Buffer.byteLength(renderOrders(final, through), 'utf8') > ORDER_LIMIT) throw Error('Ledger exceeds 16000 UTF-8 bytes; combine related orders without dropping any.');
    // A newer batch may already be checkpointed; keep its marker when this older consolidation lands first.
    const pendingAgain = this.pendingThrough !== undefined && this.pendingThrough > through ? { pending: this.pendingThrough } : {};
    if (this.pendingThrough === through) this.pendingThrough = undefined;
    const saved = { through, items: final, ...pendingAgain };
    atomicWrite(join(this.directory, 'ledger.json'), JSON.stringify(saved)); this.ledger = { through, items: final }; this.raw = []; this.retire = []; this.loaded = true; return;
   } catch (error) { if (this.stopped) return; this.warn(`Orders consolidation: ${String(error)}`); }
   this.raw = records.flatMap(r => r.orders.flatMap(order => 'retire' in order ? [] : [{ ...order, from: [r.i], date: r.date }]));
   this.retire = targets;
   // Failed after its retries: raw orders stay rendered and `pending` survives for the next attempt (this session's next batch or a restart).
   this.writeLedger({ pending: Math.max(through, this.pendingThrough ?? through) });
  }).catch(error => { if (!this.stopped) this.warn(`Orders publication: ${String(error)}`); });
  return this.publication;
 }
 async settle(signal?: AbortSignal, backgroundBackfill = false) {
  signal?.throwIfAborted();
  // Replayed pending work always blocks a turn; the first backfill's consolidation blocks only a foreground wait.
  const work = backgroundBackfill ? Promise.all([this.publication, this.replay ?? Promise.resolve()])
   : Promise.all([this.bootstrap, this.publication, this.replay ?? Promise.resolve()]);
  await Promise.race([work, new Promise<never>((_, reject) => {
   if (!signal) return;
   const abort = () => reject(Error('Orders wait cancelled.'));
   signal.addEventListener('abort', abort, { once: true });
   void work.finally(() => signal.removeEventListener('abort', abort));
  })]);
 }
 render() { return renderOrders([...this.ledger.items, ...this.raw].filter(item => !retired(item, this.retire)), this.ledger.through); }
 async close() { this.stopped = true; this.controller.abort(); clearTimeout(this.timer); this.notify(); await Promise.allSettled(this.busy.values()); await Promise.all([this.publication, this.bootstrap, this.replay ?? Promise.resolve()]); }
}
