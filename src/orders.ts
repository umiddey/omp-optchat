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
export interface MigrationItem extends OrderItem { index: number; sources: { i: number; said: string; before?: string; after?: string }[] }
export type OrderInput =
 | { kind: 'consolidate'; ledger: Ledger; records: ExtractedOrders[]; through: number; retry?: string }
 | { kind: 'backfill'; items: BackfillItem[] }
 | { kind: 'migrate'; items: MigrationItem[] };
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
const NEGATIONS: Record<string, true> = { not: true, no: true, never: true, none: true, nobody: true, nothing: true, neither: true, nor: true, without: true, cannot: true };
const CONDITIONS: Record<string, true> = { every: true, each: true, all: true, always: true, only: true, until: true, unless: true, except: true, before: true, after: true, must: true, ...NEGATIONS };
/** Common words that are shouted in dictation (YOU HAVE TO), not acronyms. */
const SHOUTED: Record<string, true> = { you: true, have: true, to: true, the: true, and: true, for: true, not: true, are: true, this: true, that: true, with: true, from: true, but: true, it: true, is: true, be: true, so: true, my: true, me: true, we: true, he: true, she: true, do: true, on: true, in: true, of: true, at: true, by: true, or: true, as: true, an: true, if: true, go: true, get: true, out: true, up: true, our: true, your: true, they: true, them: true, their: true, what: true, when: true, who: true, fucking: true, ever: true, point: true };
/** Interjections and fillers that dictation capitalises mid-sentence; they are not names. */
const DICTATION: Record<string, true> = { okay: true, ok: true, yeah: true, yes: true, yep: true, so: true, well: true, right: true, like: true, um: true, uh: true, hey: true, hi: true, sure: true, fine: true, cool: true, alright: true, thanks: true, please: true };
/** Hard tokens are numbers, paths, URLs, ids, conditions and acronyms. Ordinary non-initial capitals require contextual corroboration; CamelCase names do not. */
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
function classify(token: string, start: boolean, contextNames: ReadonlySet<string>): Keep[] {
 if (!/[\p{L}\d]/u.test(token)) return [];
 if (token.includes('/') && !/[.:~]|^\//.test(token)) return token.split('/').flatMap((piece, index) => classify(piece, start && index === 0, contextNames));
 if (/[._:\/\-\d]/.test(token)) return [{ text: token, match: 'exact' }];
 const found: Keep[] = [];
 for (const run of token.match(/\p{L}+/gu) ?? []) {
  const acronym = /^\p{Lu}{2,}s?$/u.test(run) && SHOUTED[run.toLowerCase()] !== true;
  if (CONDITIONS[run.toLowerCase()] === true || acronym) found.push({ text: run, match: 'word' });
  else if (run.length >= 2 && (/\p{Ll}\p{Lu}/u.test(run) || (!start && /\p{Lu}/u.test(run) && contextNames.has(run)))
   && DICTATION[run.toLowerCase()] !== true && SHOUTED[run.toLowerCase()] !== true) found.push({ text: run, match: run.length >= 5 ? 'name' : 'word' });
 }
 return found;
}
const capitalCounts = (text: string) => {
 const counts = new Map<string, number>();
 for (const word of text.match(/\p{Lu}\p{L}*/gu) ?? []) counts.set(word, (counts.get(word) ?? 0) + 1);
 return counts;
};
const squash = (text: string) => text.replace(/\s+/g, ' ').trim();
/** Capitalized words the context uses outside the source itself: a scan's view also holds the source message, which must not
 * corroborate its own words. */
function corroborated(source: string, context: string): Set<string> {
 const inContext = capitalCounts(context), inSource = capitalCounts(source);
 const holdsSource = source.trim().length > 0 && squash(context).includes(squash(source));
 return new Set([...inContext].filter(([word, count]) => count - (holdsSource ? inSource.get(word) ?? 0 : 0) > 0).map(([word]) => word));
}
/** Whether each whitespace-separated token of `text` starts a sentence (or a parenthesis, quote or line). */
function tokens(text: string) {
 const matches = [...text.matchAll(/\S+/g)];
 const raws = matches.map(match => match[0]);
 return raws.map((raw, index) => ({ raw, index, raws, start: index === 0 || /^[("'“‘]/.test(raw) || /[.!?:]["')\]]*$/.test(raws[index - 1])
  || text.slice(matches[index - 1].index + raws[index - 1].length, matches[index].index).includes('\n') }));
}
function keeps(source: string, context: string): Keep[] {
 const contextNames = corroborated(source, context);
 return tokens(source).flatMap(({ raw, index, raws, start }): Keep[] => {
  const token = raw.replace(/^[`"'(\[{*]+|[`"')\]}.,;:!?*]+$/g, '');
  if (/n['’]t$/i.test(token)) return [{ text: 'not', match: 'word' }];
  // "and all that" is trailing dictation filler, not a quantified obligation.
  if (token.toLowerCase() === 'all' && /^that\b/i.test(raws[index + 1] ?? '') && /^and$/i.test(raws[index - 1] ?? '')) return [];
  return raw.includes('`') && /[\p{L}\d]/u.test(token) ? [{ text: token, match: 'exact' }] : classify(token, start, contextNames);
 });
}
function holds(keep: Keep, restated: string, words: readonly string[]) {
 if (keep.match === 'exact') return new RegExp(`(?<![\\p{L}\\d])${keep.text.replace(/[.*+?^${}()|[\]\\\/]/g, '\\$&')}(?![\\p{L}\\d])`, 'u').test(restated);
 const word = keep.text.toLowerCase();
 if (keep.match === 'word' && NEGATIONS[word])
  return words.some(word => NEGATIONS[word] || word === 'zero') || /\b\p{L}+n['’]t\b/u.test(restated) || /\b0\b/.test(restated);
 const acronym = /^\p{Lu}{2,}s?$/u.test(keep.text);
 const singular = acronym ? word.replace(/s$/, '') : word;
 return keep.match === 'word' ? words.includes(word) || (acronym && words.some(candidate => candidate === singular || candidate === singular + 's'))
  : words.some(v => v === word || distance(v, word) <= 2);
}
/** Capitalized non-initial words the restatement brings in that neither the source nor the context has: an invented name
 * (OIA → OI, Rappov → a guessed product) fails like a lost one. */
function invented(source: string, restated: string, context: string): string[] {
 const sourceWords = (source.match(/\p{L}+/gu) ?? []).map(word => word.toLowerCase());
 const known = new Set([...sourceWords, ...(context.match(/\p{L}+/gu) ?? []).map(word => word.toLowerCase())]);
 // A near spelling of a source word is a correction (gatefoge → Gateforge), not a new name.
 const corrects = (word: string) => word.length >= 5 && sourceWords.some(source => source.length >= 5 && distance(source, word) <= 2);
 return tokens(restated).flatMap(({ raw, start }) => start ? [] : (raw.match(/\p{L}+/gu) ?? []).filter(run => /\p{Lu}/u.test(run)
  && run.length >= 2 && ![run, run.replace(/s$/, ''), `${run}s`].some(form => known.has(form.toLowerCase())) && !corrects(run.toLowerCase())
  && DICTATION[run.toLowerCase()] !== true && SHOUTED[run.toLowerCase()] !== true && CONDITIONS[run.toLowerCase()] !== true))
  .map(run => `invented ${run}`);
}
/** Missing hard tokens (ordinary capitalized names only when the context corroborates them) plus invented names. */
export function missingTokens(source: string, restated: string, context = ''): string[] {
 const words = restated.toLowerCase().match(/\p{L}+/gu) ?? [];
 return [...new Set([...keeps(source, context).filter(keep => !holds(keep, restated, words)).map(keep => keep.text), ...invented(source, restated, context)])];
}
const wording = (order: StandingOrder) => [order.text, order.until].filter(Boolean).join(' ');
interface Gap { source: OrderItem; omitted: boolean; missing: string[] }
/** Newly extracted orders retain hard-token coverage; existing ledger items use explicit index ownership. */
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
function boundedTalk(text: string, end: boolean): string {
 const bytes = Buffer.from(text);
 if (bytes.length <= TALK_LIMIT) return text;
 if (end) {
  let start = bytes.length - TALK_LIMIT;
  while ((bytes[start] & 0xc0) === 0x80) start++;
  return bytes.subarray(start).toString('utf8');
 }
 let stop = TALK_LIMIT;
 while ((bytes[stop] & 0xc0) === 0x80) stop--;
 return bytes.subarray(0, stop).toString('utf8');
}
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
 private migrationDone = false;
 private migrationStarted = false;
 private migrated?: Ledger;
 private migrationWork: Promise<void> = Promise.resolve();
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
   if (!Number.isSafeInteger(r.i) || r.i < 0 || typeof r.date !== 'string' || this.records.has(r.i)) throw Error('Invalid/duplicate orders record.');
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
   if (saved.migrationDone !== undefined && typeof saved.migrationDone !== 'boolean') throw Error('Invalid ledger migration marker.');
   this.migrationDone = saved.migrationDone === true;
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
    for (const item of awaiting.splice(0)) item.after = boundedTalk(e.text, false);
    before = boundedTalk(e.text, true);
    continue;
   }
   if (!eligible(e) || this.records.has(e.i) || !covered(e.i)) continue;
   const item: BackfillItem = { i: e.i, text: e.text, ...(before !== undefined ? { before } : {}) };
   this.backlog.set(e.i, item); awaiting.push(item);
  }
  this.draining = this.runBackfill();
  if (this.loaded && !this.migrationDone && !this.migrationStarted) {
   this.migrationStarted = true; this.migrationWork = this.migrateLedger(entries);
  }
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
 async drain() { await Promise.all([this.draining, this.migrationWork]); }
 private async migrateLedger(entries: readonly Entry[]) {
  const sources = new Map<number, MigrationItem['sources'][number]>();
  const wanted = new Set(this.ledger.items.flatMap(item => item.from));
  let before: string | undefined;
  const awaiting: MigrationItem['sources'] = [];
  for (const entry of entries) {
   if (entry.kind === 'talk') {
    for (const source of awaiting.splice(0)) source.after = boundedTalk(entry.text, false);
    before = boundedTalk(entry.text, true);
   } else if (wanted.has(entry.i)) {
    const source = { i: entry.i, said: entry.text, ...(before !== undefined ? { before } : {}) };
    sources.set(entry.i, source); awaiting.push(source);
   }
  }
  const original = this.ledger;
  const migrated: OrderItem[] = [];
  for (let at = 0; at < original.items.length && !this.stopped; at += BACKFILL_BATCH) {
   const batch = original.items.slice(at, at + BACKFILL_BATCH).map((item, offset) => ({
    ...ledgerItem(item), index: at + offset, sources: item.from.flatMap(id => sources.has(id) ? [sources.get(id)!] : []),
   }));
   let answer: unknown;
   try { answer = await this.task({ kind: 'migrate', items: batch }, this.controller.signal); }
   catch (error) { if (this.stopped) return; this.warn(`Orders migration: ${String(error)}`); }
   const groups: { indexes: number[]; order: StandingOrder; accepted: MigrationItem[] }[] = [];
   if (Array.isArray(answer)) for (const raw of answer) {
    if (typeof raw !== 'object' || !raw) continue;
    const indexes = 'indexes' in raw ? raw.indexes : 'index' in raw ? [raw.index] : [];
    if (!Array.isArray(indexes) || !indexes.length || !indexes.every(index => Number.isSafeInteger(index) && batch.some(item => item.index === index))) continue;
    try { groups.push({ indexes, order: standing(raw), accepted: [] }); } catch {}
   }
   const fallbacks: OrderItem[] = [];
   for (const item of batch) {
    const owners = groups.flatMap(group => group.indexes.flatMap(index => index === item.index ? [group] : []));
    const candidate = owners.length === 1 ? owners[0] : undefined;
    const context = [...item.sources.flatMap(source => [source.before, source.after]),
     ...original.items.flatMap((other, index) => index === item.index ? [] : [wording(other)])].filter(Boolean).join('\n');
    const reason = !candidate ? `index appears ${owners.length} times`
     : item.kind !== candidate.order.kind ? 'kind changed'
     : item.until && !candidate.order.until ? 'done-condition omitted'
     : !item.until && candidate.order.until ? 'done-condition invented'
     : [...missingTokens(item.text, candidate.order.text, context),
       ...(item.until ? missingTokens(item.until, candidate.order.until!, context) : [])].join(', ');
    if (reason) {
     fallbacks.push(ledgerItem(item));
     this.warn(`Orders migration item ${item.index}: kept verbatim (${reason}): ${item.text}`);
    } else candidate!.accepted.push(item);
   }
   for (const group of groups) if (group.accepted.length) {
    const from = [...new Set(group.accepted.flatMap(item => item.from))];
    const newest = group.accepted.reduce((a, b) => Math.max(...a.from) > Math.max(...b.from) ? a : b);
    migrated.push(ledgerItem({ ...group.order, from, date: newest.date }));
   }
   migrated.push(...fallbacks);
  }
  if (!this.stopped) this.migrated = { through: original.through, items: migrated };
 }
 private coverLedger(next: (OrderItem & { covers: number[] })[], ledger: Ledger, records: ExtractedOrders[], targets: RetirementEvent[]) {
  const accepted = new Map<number, number>();
  const replaced = new Set<number>();
  const fallbacks: OrderItem[] = [];
  for (let index = 0; index < ledger.items.length; index++) {
   const old = ledger.items[index];
   if (retired(old, targets)) continue;
   const owners = next.flatMap((item, owner) => item.covers.flatMap(cover => cover === index ? [owner] : []));
   const owner = owners.length === 1 ? owners[0] : undefined;
   const candidate = owner === undefined ? undefined : next[owner];
   const replacement = candidate && candidate.from.some(id => id > Math.max(...old.from)
    && this.records.get(id)?.orders.some(order => !('retire' in order))
    && (records.some(record => record.i === id) || candidate.covers.some(index => ledger.items[index]?.from.includes(id))))
    && old.from.some(id => candidate.text.includes(`(replaces msg ${id})`));
   const context = ledger.items.filter((_, other) => other !== index).map(wording).join('\n');
   const reason = !candidate ? `index appears ${owners.length} times`
    : replacement ? ''
    : old.kind !== candidate.kind ? 'kind changed'
    : old.until && !candidate.until ? 'done-condition omitted'
    : [...missingTokens(old.text, candidate.text, context),
      ...(old.until ? missingTokens(old.until, candidate.until!, context) : [])].join(', ');
   if (reason) {
    fallbacks.push(ledgerItem(old));
    this.warn(`Orders consolidation item ${index}: kept verbatim (${reason}): ${old.text}`);
   } else {
    accepted.set(index, owner!);
    if (replacement) replaced.add(index);
   }
  }
  const freshIds = new Set(records.filter(record => record.orders.some(order => !('retire' in order))).map(record => record.i));
  const mapped: OrderItem[] = [];
  for (let owner = 0; owner < next.length; owner++) {
   const item = next[owner];
   const covered = [...accepted].flatMap(([index, candidate]) => candidate === owner && !replaced.has(index) ? [ledger.items[index]] : []);
   const from = [...new Set([...covered.flatMap(old => old.from), ...item.from.filter(id => freshIds.has(id))])];
   if (from.length) mapped.push(ledgerItem({ ...item, from }));
  }
  return [...mapped, ...fallbacks];
 }
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
    for (const item of items) {
     const orders = found.get(item.i);
     if (orders) this.recordAll(new Map([[item.i, orders]]), [item.before, item.after].filter(Boolean).join('\n'));
    }
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
/** Records each scanned user message before its summary node is written. Hard-token loss falls back to the user's words;
 * the compaction view corroborates ordinary capitalized names. */
recordAll(scanned: ReadonlyMap<number, readonly OrderDirective[]>, context = '') {
  for (const [i, orders] of scanned) {
   const date = this.unscanned.get(i);
   if (this.records.has(i) || date === undefined) continue;
   const record: ExtractedOrders = { i, date, orders: orders.map(order => guarded('retire' in order ? order : standing(order), context)) };
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
   ...(this.migrationDone ? { migrationDone: true } : {}),
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
   await this.drain();
   const records = [...this.records.values()].filter(r => this.open.has(r.i) && r.i <= through).sort((a, b) => a.i - b.i);
   const ledger = this.migrated ?? this.ledger;
   const targets = records.flatMap(r => r.orders.flatMap(order => 'retire' in order ? [{ i: r.i, retire: order.retire }] : []));
   const payload = records.map(r => ({ i: r.i, date: r.date, orders: r.orders.map(plainDirective) }));
   let retry: string | undefined;
   for (let attempt = 0; attempt < 3; attempt++) try {
    const answer = await this.task({ kind: 'consolidate', ledger, records: payload, through, retry }, this.controller.signal);
    const next = items(answer).map((item, index) => {
     const raw = (answer as unknown[])[index];
     const covers = typeof raw === 'object' && raw && 'covers' in raw && Array.isArray(raw.covers)
      && raw.covers.every(i => Number.isSafeInteger(i) && i >= 0 && i < ledger.items.length) ? raw.covers as number[] : [];
     return { ...item, covers };
    }).filter(item => !retired(item, targets));
    const replacedBy = (previous: OrderItem) => next.some(item => item.from.some(id => records.some(r => r.i === id && r.i > Math.max(...previous.from) && r.orders.some(order => !('retire' in order))))
     && previous.from.some(id => item.text.includes(`(replaces msg ${id})`)));
    const mapped = this.coverLedger(next, ledger, records, targets);
    const fresh = payload.flatMap(r => r.orders.flatMap(order => 'retire' in order ? [] : [{ ...order, from: [r.i], date: r.date }])).filter(order => !retired(order, targets) && !replacedBy(order));
    const needed = fresh;
    const gaps = failing(mapped, needed);
    if (gaps.length && attempt < 2) { retry = retryNote(gaps); continue; }
    const final = gaps.length ? substitute(mapped, needed, gaps) : mapped;
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
    const migrationDone = this.migrationDone || !!this.migrated || !this.loaded;
    const saved = { through, items: ledgerItems, ...(this.open.size ? { open: [...this.open] } : {}),
     ...(migrationDone ? { migrationDone: true } : {}), ...pendingAgain };
    atomicWrite(join(this.directory, 'ledger.json'), JSON.stringify(saved));
    this.migrationDone = migrationDone; this.migrated = undefined;
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
 async close() { this.stopped = true; this.controller.abort(); await Promise.all([this.publication, this.bootstrap, this.replay ?? Promise.resolve(), this.draining, this.migrationWork]); }
}
