import { existsSync, readFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { Entry } from './memory.ts';
import { appendJson, atomicWrite } from './store.ts';

export const ORDER_LIMIT = 16_000;
const BACKFILL_BATCH = 20;
const BACKFILL_ATTEMPTS = 3;
const TALK_LIMIT = 2048;
/** `said` is the user's words; `text` is the restatement the ledger and the turn model read. Ledger items carry `text` only. */
export interface StandingOrder { said?: string; text: string; kind: 'rule' | 'goal'; until?: string }
export interface Retirement { retire: (string | number)[] }
interface RetirementEvent extends Retirement { i: number }
export type OrderDirective = StandingOrder | Retirement;
export interface ExtractedOrders { i: number; date: string; orders: OrderDirective[] }
export interface OrderItem extends StandingOrder { from: number[]; date: string }
export interface Ledger { through: number; items: OrderItem[] }
/** A history message for the one-time backfill, with the assistant's talk before and after it for references. */
export interface BackfillItem { i: number; text: string; before?: string; after?: string }
export type OrderInput =
 | { kind: 'consolidate'; ledger: Ledger; records: ExtractedOrders[]; through: number; retry?: string }
 | { kind: 'backfill'; items: BackfillItem[] };
export type OrderTask = (input: OrderInput, signal: AbortSignal) => Promise<unknown>;
const eligible = (entry: Entry) => entry.kind === 'user' && !/^\[[^\]\r\n]+\] /.test(entry.text);
function standing(value: unknown): StandingOrder {
 if (typeof value === 'string' && value.trim()) return { said: value.trim(), text: value.trim(), kind: 'rule' };
 if (typeof value !== 'object' || !value || !('text' in value) || typeof value.text !== 'string' || !value.text.trim()) throw Error('Invalid standing order.');
 const kind = 'kind' in value ? value.kind : 'rule';
 if (kind !== 'rule' && kind !== 'goal') throw Error('Invalid order kind.');
 const until = 'until' in value ? value.until : undefined;
 if (until !== undefined && (kind !== 'goal' || typeof until !== 'string' || !until.trim())) throw Error('Invalid goal done-condition.');
 const text = value.text.trim();
 // A record written before `said` existed reads as its own words.
 const said = 'said' in value && typeof value.said === 'string' && value.said.trim() ? value.said.trim() : text;
 return { said, text, kind, ...(typeof until === 'string' ? { until: until.trim() } : {}) };
}
function retireTargets(value: unknown): (string | number)[] {
 if (!Array.isArray(value) || !value.length || !value.every(v => typeof v === 'string' ? !!v.trim() : Number.isSafeInteger(v) && v >= 0)) throw Error('Invalid retirement targets.');
 return value.map(v => typeof v === 'string' ? v.trim() : v);
}
function directives(value: unknown): OrderDirective[] {
 if (!Array.isArray(value)) throw Error('Orders extraction must return an array.');
 return value.map((v: unknown) => typeof v === 'object' && v && 'retire' in v ? { retire: retireTargets(v.retire) } : standing(v));
}
/** The `{"<id>": [orders]}` object a scan or backfill returns: the asked-for ids, each with valid orders. Ids that were not asked for are ignored, so one stray id does not drop the rest. */
export function orderMap(value: unknown, ids: readonly number[]): Map<number, OrderDirective[]> {
 if (typeof value !== 'object' || !value || Array.isArray(value)) throw Error('Orders must be an object keyed by message id.');
 const found = new Map<number, OrderDirective[]>();
 for (const [key, orders] of Object.entries(value)) {
  const i = Number(key);
  if (!/^\d+$/.test(key) || !ids.includes(i)) continue;
  found.set(i, directives(orders));
 }
 return found;
}
const RETIRE_STOPWORDS: Record<string, true> = { the: true, and: true, for: true, with: true, that: true, this: true, rule: true, order: true, goal: true };
/** A text retire target retires an order when every content word of the phrase appears in the order's text, in any order. Content words are those of 3+ letters or all-caps acronyms, minus RETIRE_STOPWORDS; a phrase with none retires nothing. */
function mentions(text: string, phrase: string) {
 const words = new Set(text.toLowerCase().match(/\p{L}+/gu) ?? []);
 const content = (phrase.match(/\p{L}+/gu) ?? []).filter(run => (run.length >= 3 || (run.length >= 2 && run === run.toUpperCase())) && RETIRE_STOPWORDS[run.toLowerCase()] !== true);
 return content.length > 0 && content.every(word => words.has(word.toLowerCase()));
}
function retired(item: OrderItem, events: readonly RetirementEvent[]) {
 return events.some(event => Math.max(...item.from) <= event.i && event.retire.some(target =>
  typeof target === 'number' ? item.from.includes(target) : mentions(item.text, target)));
}
const CONDITIONS: Record<string, true> = { every: true, each: true, all: true, never: true, always: true, only: true, until: true, unless: true, except: true, before: true, after: true, must: true, without: true };
/** Common words that are shouted in dictation (YOU HAVE TO), not acronyms. */
const SHOUTED: Record<string, true> = { you: true, have: true, to: true, the: true, and: true, for: true, not: true, are: true, this: true, that: true, with: true, from: true, but: true, it: true, is: true, be: true, so: true, my: true, me: true, we: true, he: true, she: true, do: true, on: true, in: true, of: true, at: true, by: true, or: true, as: true, an: true, if: true, go: true, get: true, out: true, up: true, our: true, your: true, they: true, them: true, their: true, what: true, when: true, who: true };
/** Interjections and fillers that dictation capitalises mid-sentence; they are not names. */
const DICTATION: Record<string, true> = { okay: true, ok: true, yeah: true, yes: true, yep: true, so: true, well: true, right: true, like: true, um: true, uh: true, hey: true, hi: true, sure: true, fine: true, cool: true, alright: true, thanks: true, please: true };
/** Must-keep token of a source order: numbers, paths, URLs, ids and code-ish tokens match exactly; condition words and all-caps acronyms match whole words, case-insensitively; a capitalised word that does not start a sentence is a name (5+ letters tolerate edit distance 2). Plain lowercase words are never must-keep. */
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
function classify(token: string, start: boolean): Keep[] {
 if (!/[\p{L}\d]/u.test(token)) return [];
 if (token.includes('/') && !/[.:~]|^\//.test(token)) return token.split('/').flatMap((piece, index) => classify(piece, start && index === 0));
 if (/[._:\/\-\d]/.test(token)) return [{ text: token, match: 'exact' }];
 const found: Keep[] = [];
 for (const run of token.match(/\p{L}+/gu) ?? []) {
  const acronym = run.length >= 2 && run === run.toUpperCase() && /\p{Lu}/u.test(run) && SHOUTED[run.toLowerCase()] !== true;
  if (CONDITIONS[run.toLowerCase()] === true || acronym) found.push({ text: run, match: 'word' });
  else if (!start && run.length >= 2 && /\p{Lu}/u.test(run) && DICTATION[run.toLowerCase()] !== true && SHOUTED[run.toLowerCase()] !== true) found.push({ text: run, match: run.length >= 5 ? 'name' : 'word' });
 }
 return found;
}
function keeps(source: string): Keep[] {
 const raws = source.split(/\s+/);
 return raws.flatMap((raw, index): Keep[] => {
  const token = raw.replace(/^[`"'(\[{*]+|[`"')\]}.,;:!?*]+$/g, '');
  const start = index === 0 || /[.!?]["')\]]*$/.test(raws[index - 1]);
  return raw.includes('`') && /[\p{L}\d]/u.test(token) ? [{ text: token, match: 'exact' }] : classify(token, start);
 });
}
function holds(keep: Keep, restated: string, words: readonly string[]) {
 if (keep.match === 'exact') return new RegExp(`(?<![\\p{L}\\d])${keep.text.replace(/[.*+?^${}()|[\]\\\/]/g, '\\$&')}(?![\\p{L}\\d])`, 'u').test(restated);
 const word = keep.text.toLowerCase();
 return keep.match === 'word' ? words.includes(word) : words.some(v => v === word || distance(v, word) <= 2);
}
/** Must-keep tokens of `source` that `restated` no longer carries; the guard and the retry note both use it. A capitalised word
 * the restatement shares with the context (and not with the source) resolves one missing name: the summarizer heard it in context. */
export function missingTokens(source: string, restated: string, context = ''): string[] {
 const words = restated.toLowerCase().match(/\p{L}+/gu) ?? [];
 const unmet = [...new Map(keeps(source).filter(keep => !holds(keep, restated, words)).map((keep): [string, Keep] => [keep.text, keep])).values()];
 const sourceNames = new Set(source.match(/\p{Lu}\p{L}*/gu) ?? []);
 const contextNames = new Set(context.match(/\p{Lu}\p{L}*/gu) ?? []);
 const spare = (restated.match(/\p{Lu}\p{L}*/gu) ?? []).filter(word => !sourceNames.has(word) && contextNames.has(word));
 return unmet.filter(keep => { if (keep.match !== 'name' || spare.length === 0) return true; spare.shift(); return false; }).map(keep => keep.text);
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
/** Per failing order its ids leave every model item that carried them; every needed order left uncovered by that falls back to its verbatim words. */
function substitute(next: readonly OrderItem[], needed: readonly OrderItem[], gaps: readonly Gap[]): OrderItem[] {
 const ids = new Set(gaps.flatMap(gap => gap.source.from));
 const remaining = next.map(item => ({ ...item, from: item.from.filter(id => !ids.has(id)) })).filter(item => item.from.length);
 return [...remaining, ...needed.filter(source => failing(remaining, [source]).length).map(source => ({ ...source, text: source.said ?? source.text }))];
}
/** A guard failure sets the text to the user's words; a retirement has no words to guard. */
function guarded(order: OrderDirective, context: string): OrderDirective {
 if ('retire' in order || order.said === undefined || !missingTokens(order.said, order.text, context).length) return order;
 return { ...order, text: order.said };
}
/** What the consolidation model sees: restatements only, never the verbatim words. */
function plainDirective(order: OrderDirective): OrderDirective {
 return 'retire' in order ? order : { text: order.text, kind: order.kind, ...(order.until !== undefined ? { until: order.until } : {}) };
}
/** What the ledger keeps: restatements only. */
function ledgerItem(item: OrderItem): OrderItem {
 return { text: item.text, kind: item.kind, ...(item.until !== undefined ? { until: item.until } : {}), from: item.from, date: item.date };
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
const head = (s: string) => s.slice(0, TALK_LIMIT);
const tail = (s: string) => s.slice(-TALK_LIMIT);
/** Independent of the summary tree. A message's orders are recorded by the summarizer call that scans it (or by the one-time
 * backfill of history) and consolidated into the ledger at view batches. */
export class Orders {
 readonly records = new Map<number, ExtractedOrders>();
 ledger: Ledger = { through: -1, items: [] };
 private raw: OrderItem[] = [];
 private retire: RetirementEvent[] = [];
 /** Eligible user messages that no call has recorded yet, with their dates. */
 private unscanned = new Map<number, string>();
 /** Recorded messages not yet consolidated. Persisted, so a restart finishes what a batch had not published. */
 private open = new Set<number>();
 /** History messages already covered by built nodes, waiting for the one-time backfill. */
 private backlog = new Map<number, BackfillItem>();
 private draining: Promise<void> = Promise.resolve();
 private controller = new AbortController();
 private publication: Promise<void> = Promise.resolve();
 private bootstrap: Promise<void> = Promise.resolve();
 /** Batch point saved in ledger.json whose consolidation has not landed yet; blocks the first turn after a restart. */
 private pendingThrough?: number;
 private replay?: Promise<void>;
 private stopped = false;
 private loaded = false;
 constructor(readonly directory: string, private task: OrderTask, private warn: (s: string) => void = console.error, private retryMs = 10_000) {
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
   if (saved.open !== undefined) {
    if (!Array.isArray(saved.open) || !saved.open.every((i: unknown) => Number.isSafeInteger(i) && (i as number) >= 0)) throw Error('Invalid open orders.');
    for (const i of saved.open) this.open.add(i);
   }
  }
  // A record past the ledger boundary is still to consolidate, whether or not a batch had saved it as open.
  for (const r of this.records.values()) if (r.i > this.ledger.through) this.open.add(r.i);
 }
 /** Opens the history. Eligible messages no call has recorded are queued for the summarizer; the ones a built compressed node
  * already covers (`covered`) are backfilled once, batched with their nearby talk, and then the ledger is published. */
 backfill(entries: readonly Entry[], covered: (i: number) => boolean) {
  for (const e of entries) this.append(e);
  let before: string | undefined;
  const awaiting: BackfillItem[] = [];
  for (const e of entries) {
   if (e.kind === 'talk') {
    for (const item of awaiting.splice(0)) item.after = head(e.text);
    before = tail(e.text);
    continue;
   }
   if (!eligible(e) || this.records.has(e.i) || !covered(e.i)) continue;
   const item: BackfillItem = { i: e.i, text: e.text, ...(before !== undefined ? { before } : {}) };
   this.backlog.set(e.i, item); awaiting.push(item);
  }
  this.draining = this.runBackfill();
  const through = entries.length - 1;
  if (this.pendingThrough !== undefined && this.pendingThrough > this.ledger.through) {
   // A restart interrupted this consolidation (see `pending` in ledger.json): finishing it is blocking work.
   this.replay = this.batch(this.pendingThrough);
  } else if (entries.length && !this.loaded) {
   this.bootstrap = this.drain().then(() => this.batch(through)).catch(error => {
    if (!this.stopped) this.warn(`Orders backfill: ${String(error)}`);
   });
  }
 }
 /** Resolves when the history backfill has finished (or was stopped). */
 async drain() { await this.draining; }
 private async runBackfill() {
  const queue = [...this.backlog.values()].sort((a, b) => a.i - b.i);
  for (let at = 0; at < queue.length && !this.stopped; at += BACKFILL_BATCH) {
   const items = queue.slice(at, at + BACKFILL_BATCH);
   const ids = items.map(item => item.i);
   let found: Map<number, OrderDirective[]> | undefined;
   for (let attempt = 0; attempt < BACKFILL_ATTEMPTS && !found && !this.stopped; attempt++) try {
    found = orderMap(await this.task({ kind: 'backfill', items }, this.controller.signal), ids);
   } catch (error) {
    if (this.stopped) return;
    this.warn(`Orders backfill ${ids.join(', ')}: ${String(error)}`);
    if (attempt + 1 < BACKFILL_ATTEMPTS) await new Promise(resolve => setTimeout(resolve, this.retryMs));
   }
   if (found) {
    this.recordAll(found);
    const missing = ids.filter(i => !found.has(i));
    if (missing.length) this.warn(`Orders backfill: no orders returned for msg ${missing.join(', ')}.`);
   }
   for (const i of ids) this.backlog.delete(i);
  }
 }
 append(entry: Entry) {
  if (this.stopped || !eligible(entry) || this.records.has(entry.i)) return;
  this.unscanned.set(entry.i, entry.date);
 }
 /** The unscanned user messages with ids in [from, to], oldest first: what a summarizer call over that span must read for orders. */
 scan(from: number, to: number) {
  return [...this.unscanned.keys()].filter(i => i >= from && i <= to).sort((a, b) => a - b);
 }
/** Records what a summarizer call or the backfill read for each message, before the node that call built is written. A
 * restatement that loses a must-keep token of the user's words falls back to those words; the context (the call's view) lets a
 * name the summarizer heard there count as kept. */
recordAll(scanned: ReadonlyMap<number, readonly OrderDirective[]>, context = '') {
  for (const [i, orders] of scanned) {
   const date = this.unscanned.get(i);
   if (this.records.has(i) || date === undefined) continue;
  const record: ExtractedOrders = { i, date, orders: orders.map(order => guarded(order, context)) };
   appendJson(join(this.directory, 'orders.jsonl'), record);
   this.records.set(i, record); this.unscanned.delete(i); this.backlog.delete(i); this.open.add(i);
  }
 }
 /** Synchronously rewrites ledger.json: the current ledger plus optional extras. A batch's `pending` marker must be on
  * disk before the merge that requested it can save the view, so this never waits. */
 private writeLedger(extra: { pending?: number }) {
  atomicWrite(join(this.directory, 'ledger.json'), JSON.stringify({
   through: this.ledger.through, items: this.ledger.items.map(ledgerItem),
   ...(this.raw.length ? { raw: this.raw.map(ledgerItem) } : {}), ...(this.retire.length ? { retire: this.retire } : {}),
   ...(this.open.size ? { open: [...this.open] } : {}), ...extra,
  }));
 }
 batch(through: number) {
  if (!this.stopped && through > this.ledger.through && through !== this.pendingThrough) {
   this.pendingThrough = through;
   this.writeLedger({ pending: through });
  }
  this.publication = this.publication.then(async () => {
   if (through <= this.ledger.through) return;
   const records = [...this.records.values()].filter(r => this.open.has(r.i) && r.i <= through).sort((a, b) => a.i - b.i);
   const targets = records.flatMap(r => r.orders.flatMap(order => 'retire' in order ? [{ i: r.i, retire: order.retire }] : []));
   const payload = records.map(r => ({ i: r.i, date: r.date, orders: r.orders.map(plainDirective) }));
   let retry: string | undefined;
   for (let attempt = 0; attempt < 3; attempt++) try {
    const next = items(await this.task({ kind: 'consolidate', ledger: this.ledger, records: payload, through, retry }, this.controller.signal)).filter(item => !retired(item, targets));
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
    const ledgerItems = final.map(ledgerItem);
    if (Buffer.byteLength(renderOrders(ledgerItems, through), 'utf8') > ORDER_LIMIT) throw Error('Ledger exceeds 16000 UTF-8 bytes; combine related orders without dropping any.');
    // A newer batch may already be checkpointed; keep its marker when this older consolidation lands first.
    const pendingAgain = this.pendingThrough !== undefined && this.pendingThrough > through ? { pending: this.pendingThrough } : {};
    if (this.pendingThrough === through) this.pendingThrough = undefined;
    for (const r of records) this.open.delete(r.i);
    const saved = { through, items: ledgerItems, ...(this.open.size ? { open: [...this.open] } : {}), ...pendingAgain };
    atomicWrite(join(this.directory, 'ledger.json'), JSON.stringify(saved));
    this.ledger = { through, items: ledgerItems }; this.raw = []; this.retire = []; this.loaded = true; return;
   } catch (error) { if (this.stopped) return; this.warn(`Orders consolidation: ${String(error)}`); }
   this.raw = records.flatMap(r => r.orders.flatMap(order => 'retire' in order ? [] : [ledgerItem({ ...order, from: [r.i], date: r.date })]));
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
 async close() { this.stopped = true; this.controller.abort(); await Promise.all([this.publication, this.bootstrap, this.replay ?? Promise.resolve(), this.draining]); }
}
