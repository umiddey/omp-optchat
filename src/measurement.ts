import { randomUUID } from 'node:crypto';
import { closeSync, fstatSync, fsyncSync, mkdirSync, openSync, readFileSync, readSync, writeSync } from 'node:fs';
import { join } from 'node:path';
import { isView } from './memory.ts';
import { record, splitView } from './cache.ts';

/** Runtime measurement: one JSONL row per background provider invocation in `usage.jsonl`, and one per wire request in
 * `request-composition.jsonl`. Rows carry only metadata, byte counts and provider-reported usage — never message
 * content. The sink reuses the store's append conventions (own `a+` handle, torn last line ended before appending) but
 * skips the per-row fsync: these files are reproducible measurements, not the memory log. Every entry point catches its
 * own failures — telemetry can warn, never fault the plugin. */

/** Moves both files out of the profile for benchmark runs; unset, they sit beside the profile's memory log. */
export const MEASURE_DIR_ENV = 'OMP_OPTCHAT_MEASURE_DIR';
export const measureFiles = (directory: string) => ({ usage: join(directory, 'usage.jsonl'), composition: join(directory, 'request-composition.jsonl') });

/** One background provider invocation: a summary compaction attempt or an orders task call. */
export interface InvokeMeta {
  purpose: 'summary' | 'backfill' | 'migrate' | 'consolidate';
  provider: string;
  model: string;
  /** 1-based index of the provider call within one compressor invocation (summary retries count up); orders calls are 1. */
  attempt: number;
  /** The summary node this call builds. */
  part?: { l: number; i: number };
  /** Unscanned message ids whose orders this summary also reads. */
  scan?: readonly number[];
  /** True when the orders task re-asks with the wording-loss note (which is never logged: it quotes order wording). */
  retry?: true;
}
/** How one invocation ended. `usage` is the actual pi-ai usage when the provider reported one, undefined otherwise. */
export interface SettledMeta { status: 'ok' | 'error' | 'aborted' | 'thrown'; usage?: unknown; error?: string }
export interface Span {
  readonly id: string;
  /** Appends the composition row for the final, cache-transformed payload; `view` is the exact view text the payload carries when the caller knows it. Reads the payload, never changes it. */
  payload(payload: unknown, view?: string): void;
  /** Appends the terminal usage row. The first call wins; later calls are ignored, so a span settles exactly once. */
  settled(settled: SettledMeta): void;
}
export type Instrumentation = (meta: InvokeMeta) => Span;

export interface Measurement {
  /** Opens a span: a `background-start` row now, a `background` row when it settles. Pending calls are starts without a settle. */
  invoke(meta: InvokeMeta): Span;
  /** Appends a main-chat composition row; usage accounting for these requests lives in the OMP session journal. */
  request(payload: unknown, model?: { provider: string; id: string }, view?: string): void;
  /** Flushes and closes the files. Appends after close simply reopen the file. */
  close(): void;
}

/** The block partition `requestComposition` returns; a composition row embeds it beside `totalBytes`. */
export interface Composition { blocks: Record<BlockKey, BlockBytes>; totalBytes: number }

/** The parseable shape of both files' rows (start rows lack `status`/`durationMs`/`usage`; terminal rows carry them). */
export interface UsageRow {
  schema: 1;
  type: 'background-start' | 'background';
  id: string;
  timestamp: string;
  purpose: InvokeMeta['purpose'];
  provider: string;
  model: string;
  attempt: number;
  durationMs?: number;
  status?: 'ok' | 'error' | 'aborted' | 'thrown';
  /** Actual pi-ai usage, or null when the provider reported none (thrown or aborted before any answer). */
  usage?: unknown;
  error?: string;
  part?: { l: number; i: number };
  scan?: number[];
  retry?: true;
}
export interface BlockBytes { bytes: number; estimatedTokens: number }
export type BlockKey = 'tools' | 'system' | 'orders' | 'view' | 'memories' | 'history' | 'other';
export interface CompositionRow {
  schema: 1;
  type: 'request';
  id: string;
  timestamp: string;
  /** The invocation's purpose, or `main` for foreground chat requests. */
  purpose: string;
  provider?: string;
  model?: string;
  blocks: Record<BlockKey, BlockBytes>;
  totalBytes: number;
  tokenEstimateMethod: 'utf8-bytes/4';
}
export const TOKEN_ESTIMATE_METHOD = 'utf8-bytes/4' as const;

const BLOCK_KEYS = ['tools', 'system', 'orders', 'view', 'memories', 'history', 'other'] as const;
const utf8 = (value: unknown) => Buffer.byteLength(JSON.stringify(value) ?? '', 'utf8');
const ORDERS_OPEN = '<orders through="';
const MEMORIES_OPEN = '<memories>';

/** The OptChat context bucket of one text unit, or undefined when it is ordinary history. `view` also matches the whole,
 * unsplit view text (string content is never split by the cache transform). */
function contextBucket(text: string, view: string | undefined): 'view' | 'orders' | 'memories' | undefined {
  if (text === view || isView(text)) return 'view';
  if (text.startsWith(ORDERS_OPEN)) return 'orders';
  if (text.startsWith(MEMORIES_OPEN)) return 'memories';
  return undefined;
}

/** Attributes the serialized bytes of one message item's OptChat context (orders head, view, memories) to their buckets
 * and returns the total classified, so the rest of the item can be filed under history without double counting.
 * With `pieces`, the view is matched positionally: cachePayload splits it into exactly `splitView(view)` consecutive
 * text blocks; a partial run classifies only the matched head as view (never overcounts). Without a match, a single
 * text unit equal to the view or opening it counts as one. String content carries at most one context unit. */
function classifyContext(content: unknown, pieces: readonly string[] | undefined, view: string | undefined, bytes: Record<BlockKey, number>): number {
  if (typeof content === 'string') {
    const bucket = contextBucket(content, view);
    if (bucket === undefined) return 0;
    // utf8(content) is exactly the bytes the string occupies inside the item's JSON: quoted and escaped.
    const size = utf8(content);
    bytes[bucket] += size;
    return size;
  }
  if (!Array.isArray(content)) return 0;
  const texts = content.map(block => record(block) && typeof block.text === 'string' ? block.text : undefined);
  let start = -1, run = 0;
  if (pieces) {
    for (let at = 0; at < texts.length; at++) {
      let matched = 0;
      while (matched < pieces.length && texts[at + matched] === pieces[matched]) matched++;
      if (matched > 0) { start = at; run = matched; break; }
    }
  }
  if (start < 0) {
    const at = texts.findIndex(text => text !== undefined && contextBucket(text, view) === 'view');
    if (at >= 0) { start = at; run = 1; }
  }
  let classified = 0;
  for (let at = 0; at < content.length; at++) {
    const text = texts[at];
    if (text === undefined) continue;
    const bucket = at >= start && at < start + run ? 'view' : contextBucket(text, view);
    if (bucket === undefined) continue;
    const size = utf8(content[at]);
    bytes[bucket] += size;
    classified += size;
  }
  return classified;
}

/** Classifies a wire payload's serialized UTF-8 bytes into an exact partition. `JSON.stringify` is deterministic, so
 * every member's serialization is exactly its substring of the whole. Rules:
 * - `tools`: the top-level `tools` array (both API families name it `tools`).
 * - `system`: the Anthropic top-level `system` member, plus OpenAI `messages`/`input` items whose role is
 *   `developer` or `system` (whole item bytes), plus the OpenAI Responses top-level `instructions` string.
 * - `orders`/`view`/`memories`: text units of the remaining message items (content blocks, or a string `content`
 *   carrying one unit whole), by marker (opening `<orders through="` / `<memories>`) or by view match as in
 *   `classifyContext`.
 * - `history`: each remaining message item's serialized bytes minus the bytes its context units contributed (its JSON
 *   structure included); a message array can be Anthropic `messages` or OpenAI `messages`/`input`.
 * - `other`: everything else — all JSON syntax and keys, and unclassified top-level members (`model`, `max_tokens`, …)
 *   — computed as the residual, so the seven blocks always sum to `totalBytes` exactly.
 * Bytes-derived token estimates (`utf8-bytes/4`) are never the provider's measured tokens. */
export function requestComposition(payload: unknown, view?: string): Composition {
  const bytes: Record<BlockKey, number> = { tools: 0, system: 0, orders: 0, view: 0, memories: 0, history: 0, other: 0 };
  const total = utf8(payload);
  if (record(payload)) {
    if (Array.isArray(payload.tools)) bytes.tools += utf8(payload.tools);
    const pieces = view === undefined ? undefined : splitView(view);
    const wire = Array.isArray(payload.messages) ? payload.messages : Array.isArray(payload.input) ? payload.input : [];
    for (const item of wire) {
      if (record(item) && (item.role === 'developer' || item.role === 'system')) { bytes.system += utf8(item); continue; }
      // The classifier adds orders/view/memories bytes to their buckets and returns the total, which leaves history.
      const classified = record(item) ? classifyContext(item.content, pieces, view, bytes) : 0;
      bytes.history += utf8(item) - classified;
    }
    if (payload.system !== undefined && payload.system !== null) bytes.system += utf8(payload.system);
    // OpenAI Responses carries developer instructions as a top-level string, not as an input item.
    if (typeof payload.instructions === 'string') bytes.system += utf8(payload.instructions);
  }
  bytes.other = total - BLOCK_KEYS.slice(0, -1).reduce((sum, key) => sum + bytes[key], 0);
  const blocks = {} as Record<BlockKey, BlockBytes>;
  for (const key of BLOCK_KEYS) blocks[key] = { bytes: bytes[key], estimatedTokens: Math.floor(bytes[key] / 4) };
  return { blocks, totalBytes: total };
}

function compositionRow(payload: unknown, info: { id: string; purpose: string; provider?: string; model?: string }, view?: string): CompositionRow {
  return {
    schema: 1, type: 'request', id: info.id, timestamp: new Date().toISOString(), purpose: info.purpose,
    ...(info.provider ? { provider: info.provider } : {}), ...(info.model ? { model: info.model } : {}),
    ...requestComposition(payload, view), tokenEstimateMethod: TOKEN_ESTIMATE_METHOD,
  };
}

/** One append-only JSONL file. Warnings are bounded: the first failure warns once; three failures in a row disable the
 * file for the rest of the session and warn once more. A torn last line (a crash mid-write) is ended before appending,
 * as the memory store does, so readers never merge two records. */
class Jsonl {
  private fd?: number;
  private failures = 0;
  private warned = false;
  constructor(private readonly file: string, private readonly warn: (s: string) => void) {}
  ensure(): void {
    try { if (this.fd === undefined) this.open(); }
    catch (error) { this.failed(error instanceof Error ? error.message : String(error)); }
  }
  append(value: unknown): void {
    if (this.failures >= 3) return;
    try {
      if (this.fd === undefined) this.open();
      const line = Buffer.from(`${JSON.stringify(value)}\n`, 'utf8');
      if (writeSync(this.fd!, line) !== line.length) throw new Error(`Incomplete write: ${this.file}`);
      this.failures = 0;
    } catch (error) { this.failed(error instanceof Error ? error.message : String(error)); }
  }
  private open() {
    this.fd = openSync(this.file, 'a+', 0o600);
    const length = fstatSync(this.fd).size, last = Buffer.alloc(1);
    if (length > 0 && readSync(this.fd, last, 0, 1, length - 1) === 1 && last[0] !== 0x0a) writeSync(this.fd, '\n');
  }
  private failed(message: string) {
    this.failures++;
    if (!this.warned) { this.warned = true; this.warn(`OptChat telemetry: ${this.file} writes are failing (${message}); the session continues without these rows.`); }
    if (this.failures >= 3) {
      this.close();
      this.warn(`OptChat telemetry disabled for this session: ${this.file} failed three times in a row (${message}).`);
    }
  }
  close(): void {
    const fd = this.fd;
    this.fd = undefined;
    if (fd === undefined) return;
    try { fsyncSync(fd); } catch { /* A failed flush sacrifices durability, not the session. */ }
    try { closeSync(fd); } catch { /* Already closed. */ }
  }
}

/** Opens the measurement sink for one directory (created if missing). `warn` receives at most two messages per file. */
export function openMeasurement(directory: string, warn: (s: string) => void = console.error): Measurement {
  try { mkdirSync(directory, { recursive: true, mode: 0o700 }); } catch { /* open() reports it. */ }
  const files = measureFiles(directory);
  const usage = new Jsonl(files.usage, warn), composition = new Jsonl(files.composition, warn);
  // An empty file means instrumentation ran and made no calls; absence means measurements are unavailable.
  usage.ensure(); composition.ensure();
  return {
    invoke(meta: InvokeMeta): Span {
      const id = randomUUID();
      const shared = {
        id, purpose: meta.purpose, provider: meta.provider, model: meta.model, attempt: meta.attempt,
        ...(meta.part && { part: meta.part }),
        ...(meta.scan && { scan: [...meta.scan] }),
        ...(meta.retry && { retry: true as const }),
      };
      const started = performance.now();
      usage.append({ schema: 1, type: 'background-start', timestamp: new Date().toISOString(), ...shared });
      let open = true;
      return {
        id,
        payload: (transformed, view) => {
          if (open) composition.append(compositionRow(transformed, { id, purpose: meta.purpose, provider: meta.provider, model: meta.model }, view));
        },
        settled: settled => {
          if (!open) return;
          open = false;
          usage.append({
            schema: 1, type: 'background', timestamp: new Date().toISOString(), ...shared,
            durationMs: Math.max(0, Math.round(performance.now() - started)), status: settled.status,
            usage: record(settled.usage) ? settled.usage : null,
            ...(settled.error !== undefined && settled.error !== ''
              && { error: settled.error.length > 500 ? `${settled.error.slice(0, 500)}…` : settled.error }),
          });
        },
      };
    },
    request: (payload, model, view) => composition.append(compositionRow(payload, {
      id: randomUUID(), purpose: 'main', ...(model && { provider: model.provider, model: model.id }),
    }, view)),
    close() { usage.close(); composition.close(); },
  };
}

/** A span that records nothing, for callers created without a sink. One shared instance: no per-call allocation. */
const INERT: Span = { id: '', payload() {}, settled() {} };
export const noInstrumentation: Instrumentation = () => INERT;

/** Tolerant JSONL reader for the two files: parsed rows in order, damaged lines counted and skipped. An unreadable or
 * missing file is NOT empty: `error` names the failure, so absent telemetry can never masquerade as a complete run. */
function readJsonl<T>(file: string): { rows: T[]; damaged: number; error?: string } {
  const rows: T[] = [];
  let text: string;
  try { text = readFileSync(file, 'utf8'); } catch (error) {
    return { rows, damaged: 0, error: error instanceof Error ? error.message : String(error) };
  }
  let damaged = 0;
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try { rows.push(JSON.parse(line) as T); } catch { damaged++; }
  }
  return { rows, damaged };
}
export const readUsageLog = (file: string) => readJsonl<UsageRow>(file);
export const readCompositionLog = (file: string) => readJsonl<CompositionRow>(file);
