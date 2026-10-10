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
export type OrderInput = OrderExtraction | { kind: 'consolidate'; ledger: Ledger; records: ExtractedOrders[]; through: number };
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
function retired(item: OrderItem, events: readonly RetirementEvent[]) {
 return events.some(event => Math.max(...item.from) <= event.i && event.retire.some(target =>
  typeof target === 'number' ? item.from.includes(target) : item.text.toLowerCase().includes(target.toLowerCase())));
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
   for (let attempt = 0; attempt < 3; attempt++) try {
    const next = items(await this.task({ kind: 'consolidate', ledger: this.ledger, records, through }, this.controller.signal)).filter(item => !retired(item, targets));
    const goals = records.flatMap(r => r.orders.flatMap(order => !('retire' in order) && order.kind === 'goal' ? [{ ...order, from: [r.i], date: r.date }] : []));
    for (const previous of [...this.ledger.items, ...goals]) {
     if (retired(previous, targets)) continue;
     const retained = next.some(item => item.from.some(id => previous.from.includes(id))
      && item.kind === previous.kind
      && (item.text.includes(previous.text) || (previous.kind === 'goal' && previous.until !== undefined && item.until?.includes(previous.until))));
     const replaced = next.some(item => item.from.some(id => records.some(r => r.i === id && r.i > Math.max(...previous.from) && r.orders.some(order => !('retire' in order))))
      && previous.from.some(id => item.text.includes(`(replaces msg ${id})`)));
     if (!retained && !replaced) throw Error(`Only user words can retire or replace an order; model omitted active order: ${previous.text}`);
    }
    const sources = new Map<number, string>();
    for (const item of this.ledger.items) for (const id of item.from) sources.set(id, item.date);
    for (const r of records) if (r.orders.some(order => !('retire' in order))) sources.set(r.i, r.date);
    for (const item of next) {
     if (item.from.some(id => !sources.has(id))) throw Error('Ledger invented a source id.');
     item.date = sources.get(Math.max(...item.from))!;
    }
    if (Buffer.byteLength(renderOrders(next, through), 'utf8') > ORDER_LIMIT) throw Error('Ledger exceeds 16000 UTF-8 bytes; combine related orders without dropping any.');
    // A newer batch may already be checkpointed; keep its marker when this older consolidation lands first.
    const pendingAgain = this.pendingThrough !== undefined && this.pendingThrough > through ? { pending: this.pendingThrough } : {};
    if (this.pendingThrough === through) this.pendingThrough = undefined;
    const saved = { through, items: next, ...pendingAgain };
    atomicWrite(join(this.directory, 'ledger.json'), JSON.stringify(saved)); this.ledger = { through, items: next }; this.raw = []; this.retire = []; this.loaded = true; return;
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
