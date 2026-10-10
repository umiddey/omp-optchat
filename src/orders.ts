import { existsSync, readFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { Entry } from './memory.ts';
import { appendJson, atomicWrite } from './store.ts';

export const ORDER_LIMIT = 16_000;
export interface ExtractedOrders { i: number; date: string; orders: string[] }
export interface OrderItem { text: string; from: number[]; date: string }
export interface Ledger { through: number; items: OrderItem[] }
export type OrderInput = { kind: 'extract'; entry: Entry } | { kind: 'consolidate'; ledger: Ledger; records: ExtractedOrders[]; through: number };
export type OrderTask = (input: OrderInput, signal: AbortSignal) => Promise<unknown>;
const eligible = (entry: Entry) => entry.kind === 'user' && !/^\[[^\]\r\n]+\] /.test(entry.text);
function strings(value: unknown): string[] {
 if (!Array.isArray(value) || !value.every(s => typeof s === 'string' && s.trim())) throw Error('Orders extraction must return an array of nonempty strings.');
 return value.map(s => s.trim());
}
function items(value: unknown): OrderItem[] {
 if (!Array.isArray(value)) throw Error('Ledger must be an array.');
 return value.map((v: unknown) => {
  if (typeof v !== 'object' || !v || !('text' in v) || typeof v.text !== 'string' || !v.text.trim() || !('date' in v) || typeof v.date !== 'string' || !('from' in v) || !Array.isArray(v.from) || !v.from.length || !v.from.every(i => Number.isSafeInteger(i) && i >= 0)) throw Error('Invalid ledger item.');
  return { text: v.text.trim(), from: v.from as number[], date: v.date };
 });
}
export function renderOrders(list: readonly OrderItem[]) {
 return list.length ? `<orders>\n${list.map(item => `${Math.max(...item.from)} (${item.date.slice(0, 10)}): ${item.text}`).join('\n')}\n</orders>` : '';
}
/** Independent of the summary tree. Extraction is background; only batch/first-backfill publication changes the prefix. */
export class Orders {
 readonly records = new Map<number, ExtractedOrders>();
 ledger: Ledger = { through: -1, items: [] };
 private raw: OrderItem[] = [];
 private pending = new Map<number, Entry>();
 private busy = new Map<number, Promise<void>>();
 private retry = new Map<number, number>();
 private timer?: ReturnType<typeof setTimeout>;
 private controller = new AbortController();
 private publication: Promise<void> = Promise.resolve();
 private bootstrap: Promise<void> = Promise.resolve();
 private stopped = false;
 private loaded = false;
 private changed = new Set<() => void>();
 constructor(readonly directory: string, private task: OrderTask, private warn: (s: string) => void = console.error, private jobs = 8, private retryMs = 10_000) {
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const file = join(directory, 'orders.jsonl');
  if (existsSync(file)) for (const line of readFileSync(file, 'utf8').split('\n').filter(Boolean)) {
   const r = JSON.parse(line);
   if (!Number.isSafeInteger(r.i) || typeof r.date !== 'string' || this.records.has(r.i)) throw Error('Invalid/duplicate orders record.');
   this.records.set(r.i, { i: r.i, date: r.date, orders: strings(r.orders) });
  }
  const ledger = join(directory, 'ledger.json');
  if (existsSync(ledger)) {
   const saved = JSON.parse(readFileSync(ledger, 'utf8'));
   if (!Number.isSafeInteger(saved.through) || saved.through < -1) throw Error('Invalid ledger boundary.');
   this.ledger = { through: saved.through, items: items(saved.items) }; this.loaded = true;
   if (saved.raw !== undefined) this.raw = items(saved.raw);
  }
 }
 backfill(entries: readonly Entry[]) {
  for (const e of entries) this.append(e);
  if (entries.length && !this.loaded) {
   const through = entries.length - 1;
   this.bootstrap = this.extracted(through).then(() => this.batch(through)).catch(error => {
    if (!this.stopped) this.warn(`Orders backfill: ${String(error)}`);
   });
  }
 }
 append(entry: Entry) {
  for (const id of this.retry.keys()) this.retry.set(id, 0);
  this.pump();
  if (!eligible(entry) || this.records.has(entry.i) || this.pending.has(entry.i) || this.stopped) return;
  this.pending.set(entry.i, entry); this.pump();
 }
 private notify() { for (const fn of this.changed) fn(); }
 private pump() {
  if (this.stopped) return;
  clearTimeout(this.timer); this.timer = undefined;
  for (const [i, entry] of this.pending) {
   if (this.busy.size >= this.jobs) break;
   if (this.busy.has(i) || (this.retry.get(i) ?? 0) > Date.now()) continue;
   const work = Promise.resolve().then(async () => {
    const orders = strings(await this.task({ kind: 'extract', entry }, this.controller.signal));
    if (this.stopped) return;
    const record = { i, date: entry.date, orders };
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
 batch(through: number) {
  this.publication = this.publication.then(async () => {
   await this.extracted(through);
   const records = [...this.records.values()].filter(r => r.i > this.ledger.through && r.i <= through).sort((a, b) => a.i - b.i);
   if (through <= this.ledger.through) return;
   for (let attempt = 0; attempt < 3; attempt++) try {
    const next = items(await this.task({ kind: 'consolidate', ledger: this.ledger, records, through }, this.controller.signal));
    const sources = new Map<number, string>();
    for (const item of this.ledger.items) for (const id of item.from) sources.set(id, item.date);
    for (const r of records) sources.set(r.i, r.date);
    for (const item of next) {
     if (item.from.some(id => !sources.has(id))) throw Error('Ledger invented a source id.');
     item.date = sources.get(Math.max(...item.from))!;
    }
    if (Buffer.byteLength(renderOrders(next), 'utf8') > ORDER_LIMIT) throw Error('Ledger exceeds 16000 UTF-8 bytes; combine related orders without dropping any.');
    const saved = { through, items: next };
    atomicWrite(join(this.directory, 'ledger.json'), JSON.stringify(saved)); this.ledger = saved; this.raw = []; this.loaded = true; return;
   } catch (error) { if (this.stopped) return; this.warn(`Orders consolidation: ${String(error)}`); }
   this.raw = records.flatMap(r => r.orders.map(text => ({ text, from: [r.i], date: r.date })));
   atomicWrite(join(this.directory, 'ledger.json'), JSON.stringify({ ...this.ledger, raw: this.raw }));
  }).catch(error => { if (!this.stopped) this.warn(`Orders publication: ${String(error)}`); });
  return this.publication;
 }
 async settle(signal?: AbortSignal, backgroundBackfill = false) {
  signal?.throwIfAborted();
  const work = backgroundBackfill ? this.publication : Promise.all([this.bootstrap, this.publication]);
  await Promise.race([work, new Promise<never>((_, reject) => {
   if (!signal) return;
   const abort = () => reject(Error('Orders wait cancelled.'));
   signal.addEventListener('abort', abort, { once: true });
   void work.finally(() => signal.removeEventListener('abort', abort));
  })]);
 }
 render() { return renderOrders([...this.ledger.items, ...this.raw]); }
 async close() { this.stopped = true; this.controller.abort(); clearTimeout(this.timer); this.notify(); await Promise.allSettled(this.busy.values()); await this.publication; await this.bootstrap; }
}
