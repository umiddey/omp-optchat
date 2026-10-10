import { EventEmitter } from 'node:events';
import { FileStore, storeFor, type Saved, type Store } from './store.ts';
import { pageText } from './paging.ts';
import { Orders, type OrderTask } from './orders.ts';

export const NODE = 512;
export const VIEW = 128_000;
export const CAP = 30_000;
export { PAGE } from './paging.ts';
export const KINDS = ['user', 'talk', 'tool', 'echo', 'note', 'work'] as const;
export type Kind = typeof KINDS[number];
export interface Entry { i: number; kind: Kind; text: string; size: number; date: string; receipt?: string }
export interface Part { l: number; i: number }
export interface Summary extends Part { text: string; size: number }
/** `part` is the node to build: a message's leaf, or the merge of its two halves. */
export interface Compression { context: string; source: string; part: Part }
export type Compressor = (input: Compression, signal: AbortSignal) => Promise<string>;
const key = ({ l, i }: Part) => l * 2 ** 40 + i;
const UNBUILT = '(not summarized yet: zoom it)';
export const start = ({ l, i }: Part) => i * 2 ** l;
export const end = (part: Part) => start(part) + 2 ** part.l;
export const bytes = (s: string) => Buffer.byteLength(s, 'utf8');
const UNBUILT_BYTES = bytes(UNBUILT);
export const flat = (s: string) => s.replace(/[\r\n]+/g, ' ');
const lineBytes = (s: string) => bytes(flat(s));
const notice = (omitted: number) => `\n[${omitted} characters omitted; head and tail retained]\n`;
const VIEW_OPEN = '<chat>\n';
export const isView = (text: string) => text.startsWith(VIEW_OPEN);
export function cap(text: string, limit = CAP) {
  if (text.length <= limit) return text;
  const half = Math.floor((limit - notice(text.length).length) / 2);
  const head = text.slice(0, /[\ud800-\udbff]/.test(text[half - 1]) ? half - 1 : half);
  const tail = text.slice(/[\udc00-\udfff]/.test(text[text.length - half]) ? text.length - half + 1 : text.length - half);
  return head + notice(text.length - head.length - tail.length) + tail;
}
/** The index of the view's most due pair of sibling lines whose parent is built, or -1 (recipe §3.2). A pair is as due as
 * long ago it ended, in its own line size; equal pairs go oldest first. This is the order of Taelin's rollback push. */
export function mostDue(view: readonly Part[], total: number, built: (part: Part) => boolean) {
  let best = -1, due = -Infinity;
  for (let j = 0; j + 1 < view.length; j++) {
    const a = view[j], b = view[j + 1];
    if (a.l !== b.l || a.i % 2 || b.i !== a.i + 1) continue;
    const age = (total - (end(b) - 1)) / 2 ** a.l;
    if (age > due && built({ l: a.l + 1, i: a.i / 2 })) { best = j; due = age; }
  }
  return best;
}
/** A view (recipe §3.2): lines that tile the log, oldest first. It grows a line per message and, once over `high` bytes or when
 * forced, merges its most due pairs in one batch down to `low`, merging what it can at each change until then. */
class Sawtooth {
  readonly parts: Part[] = [];
  private measured = 0;
  private merging = false;
  constructor(private readonly high: number, private readonly low: number, private readonly node: (part: Part) => Summary | undefined) {}
  private lineSize(part: Part) { return this.node(part)?.size ?? UNBUILT_BYTES; }
  get size() { return this.measured; }
  push(part: Part) { this.parts.push(part); this.measured += this.lineSize(part); }
  /** The line covering message `at`. The lines tile the log in order, so a binary search finds it. */
  covering(at: number): Part | undefined {
    for (let lo = 0, hi = this.parts.length - 1; lo <= hi;) {
      const mid = (lo + hi) >> 1, p = this.parts[mid];
      if (end(p) <= at) lo = mid + 1;
      else if (start(p) > at) hi = mid - 1;
      else return p;
    }
  }
  /** A message got its node. Its line is usually still shown, but after a damaged tree file a saved parent can already hide it. */
  built(i: number) { if (this.covering(i)?.l === 0) this.measured += this.lineSize({ l: 0, i }) - UNBUILT_BYTES; }
  /** Returns whether any lines merged. */
  fit(total: number, force = false) {
    const lines = this.parts.length;
    if (force || this.measured > this.high) this.merging = true;
    for (let best: number; this.merging && this.measured > this.low && (best = mostDue(this.parts, total, part => !!this.node(part))) >= 0;) {
      const a = this.parts[best], b = this.parts[best + 1], parent = { l: a.l + 1, i: a.i / 2 };
      this.measured += this.lineSize(parent) - this.lineSize(a) - this.lineSize(b);
      this.parts.splice(best, 2, parent);
    }
    if (this.measured <= this.low) this.merging = false;
    return this.parts.length < lines;
  }
}
function object(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
export function isEntry(value: unknown): value is Entry {
  return object(value) && Number.isSafeInteger(value.i) && typeof value.kind === 'string'
    && KINDS.some(kind => kind === value.kind)
    && typeof value.text === 'string' && typeof value.date === 'string';
}
function isSummary(value: unknown): value is Summary {
  return object(value) && Number.isSafeInteger(value.l) && Number.isSafeInteger(value.i)
    && typeof value.text === 'string';
}

/** The log is authoritative. The tree and the view follow the recipe: the view grows a line per message and, once it passes
 * `budget`, merges its most due pairs in one batch down to half of it, so between batches it only grows at its end.
 * Compactions get their own view (recipe §4): the chat's merged further, to between an eighth and a quarter of the budget,
 * and again whenever the chat's merges, so parallel compactions read it from the cache. */
export class Memory {
  readonly root: Entry[] = [];
  readonly tree = new Map<number, Summary>();
  private readonly events = new EventEmitter();
  private readonly controller = new AbortController();
  private readonly busy = new Map<number, Promise<void>>();
  private readonly retryAt = new Map<number, number>();
  private readonly reported = new Set<number>();
  /** Messages without their node, and merges whose halves are built, oldest first, so the scheduler never scans the tree for work (recipe §4). */
  private readonly unbuilt = new Set<number>();
  private readonly merges = new Map<number, Part>();
  private retryTimer?: ReturnType<typeof setTimeout>;
  /** The most summaries owed at once since none were last owed. */
  private peak = 0;
  private scheduled = false;
  private stopped = false;
  private readonly chat: Sawtooth;
  private readonly compaction: Sawtooth;
  /** The last store write still running, if any. Once an append fails, later writes are skipped and appends throw, as after a failed file write. */
  private writing?: Promise<void>;
  private failed?: string;
  /** Directory containing this memory's persisted log, tree and view. */
  readonly directory: string;
  readonly store: Store;
  lastError?: string;
  orders?: Orders;

  /** Opens the memory in `directory` through the store `storeFor` picks, after its load. */
  static async open(directory: string, compress: Compressor, warn: (s: string) => void = console.error, budget = VIEW, jobs = 8, orderTask?: OrderTask) {
    const store = storeFor(directory, warn);
    // Orders is attached before construction so merges while replaying the saved view checkpoint `pending` and wait for their records.
    const orders = orderTask ? new Orders(directory, orderTask, warn, jobs) : undefined;
    return new Memory({ directory, store, saved: await store.load(), orders }, compress, warn, budget, jobs);
  }
  /** A directory alone opens a FileStore there. `jobs`: summaries built at once, and how many unbuilt lines a new message's node
   * waits behind. The main chat keeps at most eight workers. */
  constructor(source: string | { directory: string; store: Store; saved: Saved; orders?: Orders }, private readonly compress: Compressor,
    private readonly warn: (s: string) => void = console.error,
    readonly budget = VIEW, private readonly jobs = 8, private readonly retryMs = 10_000) {
    this.chat = new Sawtooth(budget, budget / 2, part => this.node(part));
    this.compaction = new Sawtooth(budget / 4, budget / 8, part => this.node(part));
    let saved: Saved;
    if (typeof source === 'string') { const store = new FileStore(source, warn); this.directory = source; this.store = store; saved = store.load(); }
    else ({ directory: this.directory, store: this.store, saved, orders: this.orders } = source);
    const log = saved.entries;
    const entries = log.every(isEntry) ? log.sort((a, b) => a.i - b.i) : undefined;
    if (!entries || entries.some((entry, i) => entry.i !== i)) throw new Error('Invalid/noncontiguous OptChat log; refusing to change it.');
    for (const value of entries) this.root.push({ ...value, size: bytes(`${value.kind}: ${value.text}`) });
    for (const value of saved.tree) {
      if (!isSummary(value) || value.l < 0 || value.i < 0 || end(value) > this.root.length)
        throw new Error('Invalid OptChat summary record.');
      this.tree.set(key(value), { ...value, size: lineBytes(value.text) });
    }
    for (const node of this.tree.values()) this.queueParent(node);
    for (let i = 0; i < this.root.length; i++) if (!this.node({ l: 0, i })) this.unbuilt.add(i);
    // Before any view merge can run: backfill queues extraction, replays a saved `pending` batch as blocking work, and
    // lets every merge below checkpoint the ledger before the view is saved.
    this.orders?.backfill(this.root);
    // Refolding the log gives a different view than the live one, and every cache entry would miss, so the view is saved.
    const loaded = this.load(saved.view);
    for (const part of this.view) this.compaction.push(part);
    this.compaction.fit(loaded, true);
    for (let i = loaded; i < this.root.length; i++) { this.push(i); this.fit(i + 1); }
    this.fit(); this.save(); this.schedule();
  }
  append(kind: Kind, text: string, date = new Date().toISOString(), receipt?: string): Entry {
    if (this.stopped) throw new Error('Memory is closed.');
    if (this.failed) throw new Error(`Memory could not be saved: ${this.failed}`);
    // The recipe gives no non-tool chunk size; use the tool budget, without cutting any text.
    if (kind !== 'echo' && text.length > CAP) {
      let first: Entry | undefined;
      for (let at = 0; at < text.length;) {
        let to = Math.min(at + CAP, text.length);
        if (to < text.length && /[\ud800-\udbff]/.test(text[to - 1]) && /[\udc00-\udfff]/.test(text[to])) to--;
        const entry = this.append(kind, text.slice(at, to), date, receipt);
        first ??= entry; at = to;
      }
      return first!;
    }
    // A failed call is eligible again at the next message, even before the availability timer.
    for (const id of this.retryAt.keys()) this.retryAt.set(id, 0);
    const entry: Entry = { i: this.root.length, kind, text, date, size: bytes(`${kind}: ${text}`), ...(receipt ? { receipt } : {}) };
    void this.enqueue(() => this.store.append(entry), error => {
      this.failed ??= error instanceof Error ? error.message : String(error);
      this.warn(`Memory could not be saved: ${this.failed}`);
    });
    this.root.push(entry); this.push(entry.i); if (this.fit()) this.save(); this.schedule();
    this.orders?.append(entry);
    return entry;
  }
  node(part: Part) { return this.tree.get(key(part)); }
  private text(part: Part) { return this.node(part)?.text ?? UNBUILT; }
  /** Runs a store write at once when none is running, so a store that finishes its writes as it returns (FileStore) throws here
   * as before; otherwise after the running ones, so writes land in the order Memory makes them. Returns the queued write, settled
   * through `failed`, unless it finished at once. */
  private enqueue(write: () => Promise<void> | undefined, failed: (error: unknown) => void) {
    const run = () => this.failed ? undefined : write();
    const started = this.writing ? this.writing.then(run) : run();
    if (!started) return;
    const settled = started.catch(failed);
    const tail: Promise<void> = settled.catch(() => {}).then(() => { if (this.writing === tail) this.writing = undefined; });
    this.writing = tail;
    return settled;
  }
  /** Takes the saved view if it still tiles the log from the start, and returns how many messages it covers. */
  private load(view: string | undefined) {
    if (view === undefined) return 0;
    const rebuild = () => { this.warn('Rebuilt the memory view: the saved one does not match the log.'); return 0; };
    let saved: unknown;
    try { saved = JSON.parse(view); } catch { return rebuild(); }
    if (!Array.isArray(saved)) return rebuild();
    const parts: Part[] = [];
    let covered = 0;
    for (const value of saved) {
      const [l, i] = Array.isArray(value) ? value : [];
      const part = { l, i };
      if (!Number.isSafeInteger(l) || !Number.isSafeInteger(i) || l < 0 || start(part) !== covered || end(part) > this.root.length || (l > 0 && !this.node(part)))
        return rebuild();
      parts.push(part); covered = end(part);
    }
    for (const part of parts) this.chat.push(part);
    return covered;
  }
  /** Saved when it merges: a view that only grew is the saved one plus a line per later message, as `load` replays it.
   * The log stays authoritative, so a failed save only warns. */
  private save() {
    const failed = (error: unknown) => { this.warn(`Could not save the memory view: ${error instanceof Error ? error.message : String(error)}`); };
    try { void this.enqueue(() => this.store.saveView(JSON.stringify(this.view.map(p => [p.l, p.i]))), failed); }
    catch (error) { failed(error); }
  }
  private push(i: number) {
    const part = { l: 0, i };
    this.chat.push(part); this.compaction.push(part);
    if (!this.node(part)) this.unbuilt.add(i);
  }
  get view(): readonly Part[] { return this.chat.parts; }
  render() { return `${VIEW_OPEN}${this.view.map(p => `${start(p)}+${2 ** p.l}|${flat(this.text(p))}`).join('\n')}\n</chat>`; }
  get ready() { return this.view.every(p => this.node(p)); }
  get pending() { return this.unbuilt.size; }
  get active() { return this.busy.size; }
  get size() { return this.chat.size; }
  /** Summaries built out of the backlog since it was last empty, and when the next failed one is retried. */
  progress(now = Date.now()) {
    const due = Math.min(...[...this.retryAt.values()].filter(t => t > now));
    return { done: this.peak - this.owed(), total: this.peak, retryIn: Number.isFinite(due) ? due - now : undefined };
  }
  private owed() { return this.expectedNodes() - this.tree.size; }
  onChange(listener: () => void) { this.events.on('change', listener); return () => { this.events.off('change', listener); }; }
  /** The view line covering message `at`. */
  covering(at: number) { return this.chat.covering(at); }
  /** Returns whether the chat's view merged. */
  private fit(total = this.root.length) {
    const merged = this.chat.fit(total);
    this.compaction.fit(total, merged);
    if (merged) void this.orders?.batch(total - 1);
    const owed = this.owed();
    this.peak = owed > 0 ? Math.max(this.peak, owed) : 0;
    this.events.emit('change');
    return merged;
  }
  private schedule() {
    if (this.scheduled || this.stopped) return;
    this.scheduled = true;
    queueMicrotask(() => { this.scheduled = false; this.pump(); });
  }
  private pump() {
    if (this.stopped) return;
    // One clock reading: skipping a part and arming its retry timer must agree on what is due.
    const now = Date.now();
    const run = (part: Part) => {
      const id = key(part);
      if (this.busy.has(id) || (this.retryAt.get(id) ?? 0) > now) return;
      const promise = this.build(part).catch(error => {
        if (this.stopped) return;
        this.lastError = error instanceof Error ? error.message : String(error);
        if (!this.reported.has(id)) { this.reported.add(id); this.warn(`Compactor ${start(part)}+${2 ** part.l}: ${this.lastError}`); }
        this.retryAt.set(id, Date.now() + this.retryMs);
        if (!this.retryTimer) this.retryTimer = setTimeout(() => { this.retryTimer = undefined; this.schedule(); }, this.retryMs);
      // Schedule before telling waiters, so a turn never mistakes the gap before the next pump for a stall.
      }).finally(() => { this.busy.delete(id); this.schedule(); this.events.emit('change'); });
      this.busy.set(id, promise);
    };
    // A message's node starts once fewer than `jobs` lines before it are unbuilt; a merge, once both halves are built.
    let ahead = 0;
    for (const i of this.unbuilt) {
      if (ahead++ === this.jobs) break;
      if (this.busy.size >= this.jobs) return;
      run({ l: 0, i });
    }
    for (const part of this.merges.values()) {
      if (this.busy.size >= this.jobs) return;
      run(part);
    }
    // A later failure can have a later deadline than the timer installed by the first.
    const deadlines = [...this.retryAt.values()].filter(t => t > now);
    if (deadlines.length && !this.retryTimer) this.retryTimer = setTimeout(() => { this.retryTimer = undefined; this.schedule(); }, Math.max(1, Math.min(...deadlines) - now));
    if (this.stalled) this.events.emit('change');
  }
  /** Nothing is being built, nothing more can start, and something failed: only a retry can make progress. */
  private get stalled() { return this.busy.size === 0 && !this.scheduled && this.retryAt.size > 0; }
  private async build(part: Part) {
    const source = part.l === 0 ? `${this.root[part.i].kind}: ${this.root[part.i].text}`
      : [0, 1].map(offset => this.text({ l: part.l - 1, i: 2 * part.i + offset })).join('\n');
    const mergeSource = part.l > 0 ? [0, 1].map(offset => flat(this.text({ l: part.l - 1, i: 2 * part.i + offset }))).join('\n') : source;
    const text = bytes(source) <= NODE ? source : (await this.compress({ context: this.compactionView(part), source: mergeSource, part }, this.controller.signal)).trim();
    if (this.stopped) return;
    if (!text) throw new Error('Compactor returned an empty summary.');
    const node = { ...part, text, size: lineBytes(text) };
    // A failed node write fails the build, which is retried.
    const written = this.enqueue(() => this.store.appendNode(node), error => { throw error; });
    if (written) await written;
    this.tree.set(key(part), node); this.retryAt.delete(key(part)); this.merges.delete(key(part)); this.queueParent(part);
    if (!part.l) { this.unbuilt.delete(part.i); this.chat.built(part.i); this.compaction.built(part.i); }
    if (!this.retryAt.size) this.lastError = undefined;
    if (this.fit()) this.save();
  }
  /** The compactions' view stops at the first unbuilt line (recipe §4). */
  private compactionView(part: Part) {
    const boundary = part.l === 0 ? start(part) : end(part), lines: string[] = [];
    for (const p of this.compaction.parts) { if (end(p) > boundary || !this.node(p)) break; lines.push(`${start(p)}+${2 ** p.l}|${flat(this.text(p))}`); }
    return `${VIEW_OPEN}${lines.join('\n')}\n</chat>`;
  }
  private queueParent({ l, i }: Part) {
    const parent = { l: l + 1, i: Math.floor(i / 2) };
    if (!this.node(parent) && this.node({ l, i: i % 2 ? i - 1 : i + 1 })) this.merges.set(key(parent), parent);
  }
  /** A 'turn' waits until every part of the view is built, or until everything pending has failed: it then goes on with placeholders
   * for the missing lines, `lastError` says why, and the failed nodes are still retried in the background. 'tree' waits for every
   * node, through failures. The view may run over budget until pending merges land. */
  async settle(signal?: AbortSignal, until: 'turn' | 'tree' = 'turn'): Promise<void> {
    const done = () => until === 'tree' ? this.ready && this.busy.size === 0 && this.tree.size === this.expectedNodes()
      : this.ready || this.stalled;
    if (done()) { await this.orders?.settle(signal, true); return; }
    if (this.stopped || signal?.aborted) throw new Error('Memory wait cancelled.');
    await new Promise<void>((resolve, reject) => {
      const cleanup = () => { this.events.off('change', check); signal?.removeEventListener('abort', abort); };
      const abort = () => { cleanup(); reject(new Error('Memory wait cancelled.')); };
      const check = () => { if (this.stopped) abort(); else if (done()) { cleanup(); resolve(); } };
      this.events.on('change', check); signal?.addEventListener('abort', abort, { once: true }); check();
    });
    await this.orders?.settle(signal, true);
  }
  private expectedNodes() {
    let count = 0;
    for (let n = this.root.length; n > 0; n = Math.floor(n / 2)) count += n;
    return count;
  }
  /** n = 1 gives the message whole, or, when it is longer than `limit` or `offset` is given, the page of up to `limit` characters from `offset`.
   * Paging a message that fits in one page is allowed, but the page says so. */
  zoom(id: number, n: number, offset?: number, limit?: number) {
    if (!Number.isSafeInteger(id) || id < 0 || !Number.isSafeInteger(n) || n < 1 || !Number.isInteger(Math.log2(n)) || id % n || id + n > this.root.length)
      throw new Error(`No line ${id}+${n}.`);
    if (n === 1) {
      const { kind, text } = this.root[id];
      return `${id}+0|${kind}: ${pageText(text, `Message ${id}`, offset, limit)}`;
    }
    if (offset !== undefined) throw new Error('offset and limit page one message: use them with n = 1.');
    const l = Math.log2(n) - 1, i = 2 * id / n;
    return [0, 1].map(offset => {
      const part = { l, i: i + offset }, node = this.node(part);
      if (!node) throw new Error('This range is not summarized yet.');
      return `${start(part)}+${2 ** l}|${flat(node.text)}`;
    }).join('\n');
  }
  date(id: number) {
    if (!Number.isSafeInteger(id) || !this.root[id]) throw new Error(`No message ${id}.`);
    return new Date(this.root[id].date).toString();
  }
  async close() {
    this.stopped = true; this.controller.abort(); clearTimeout(this.retryTimer);
    this.events.emit('change'); await Promise.allSettled(this.busy.values()); await this.writing;
    await this.orders?.close();
  }
}
