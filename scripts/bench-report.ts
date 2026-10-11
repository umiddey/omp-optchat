import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { basename, isAbsolute, join, resolve } from 'node:path';
import { record } from '../src/cache.ts';

/** Report CLI for matched native-OMP vs OptChat benchmark runs and for historical sessions. Parses OMP session JSONL
 * (active branch only, so abandoned branches never double count), the background usage.jsonl (schema1: usage
 * actual|null, purpose, attempt, status, duration, id, provider, model) and request-composition.jsonl (per-class
 * bytes plus a byte/4 estimate). Accounting rules, enforced everywhere below: assistant usage counts once;
 * purpose-classified model_usage entries are comparator costs; native compaction model calls are NOT journaled by
 * OMP 18.8.3 anywhere, so they are counted as events with unknown usage and force an incomplete verdict; null or
 * pending usage propagates incompleteness; no savings claim is ever derived from request counts; absent logs are
 * reported as unrecorded, never fabricated. */

export interface UsageTotals {
  calls: number; callsWithUsage: number; input: number; output: number;
  cacheRead: number; cacheWrite: number; costUsd: number; costKnownCalls: number; unknown: number;
}
export interface SessionPurpose extends UsageTotals { role?: string; provider?: string; model?: string }
export interface ParsedSession {
  sessionFile: string; branchResolution: 'branch' | 'linear';
  main: UsageTotals;
  modelUsage: Record<string, SessionPurpose>;
  compaction: { events: number; branchSummaries: number; tokensBefore: number[]; usageKnown: false };
  requests: number;
  totals: UsageTotals;
}
export interface CompositionLog {
  recorded: boolean; file?: string; requests: number; leaks: number;
  classes: Record<string, number>; bytesTotal: number; tokensEstimate: number;
  purposes: Record<string, { requests: number; bytesTotal: number }>;
}
export interface RunReport {
  label: string; mode: 'native' | 'optchat' | 'unknown'; workload: string;
  session: ParsedSession | undefined; background: UsageLog; composition: CompositionLog;
  backgroundSettled: boolean;
  nativeCompactionUsage?: WireCompactionUsage;
  completeness: { complete: boolean; reasons: string[] };
  evidence: string;
  savingsClaim: string;
  requests: number;
}

const emptyTotals = (): UsageTotals => ({ calls: 0, callsWithUsage: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, costUsd: 0, costKnownCalls: 0, unknown: 0 });
const addUsage = (into: UsageTotals, usage: Record<string, unknown>) => {
  const num = (value: unknown) => (typeof value === 'number' && Number.isFinite(value) ? value : 0);
  into.callsWithUsage++;
  into.input += num(usage.input); into.output += num(usage.output);
  into.cacheRead += num(usage.cacheRead); into.cacheWrite += num(usage.cacheWrite);
  const cost = record(usage.cost) ? num(usage.cost.total) : num(usage.costUsd);
  into.costUsd += cost;
  if (cost > 0 || record(usage.cost)) into.costKnownCalls++;
};
const addInto = (into: UsageTotals, from: UsageTotals) => {
  into.calls += from.calls; into.callsWithUsage += from.callsWithUsage; into.input += from.input;
  into.output += from.output; into.cacheRead += from.cacheRead; into.cacheWrite += from.cacheWrite;
  into.costUsd += from.costUsd; into.costKnownCalls += from.costKnownCalls; into.unknown += from.unknown;
};

interface SessionEntryLike { type?: string; id?: unknown; parentId?: unknown; message?: unknown; purpose?: unknown; role?: unknown; model?: unknown; provider?: unknown; usage?: unknown; stopReason?: unknown; errorMessage?: unknown; tokensBefore?: unknown; timestamp?: unknown }

function entriesOf(file: string): { entries: SessionEntryLike[] } {
  const lines = readFileSync(file, 'utf8').split('\n');
  const entries: SessionEntryLike[] = [];
  for (const line of lines) {
    if (!line.trim()) continue;
    let value: unknown;
    try { value = JSON.parse(line); } catch { continue; }
    if (record(value)) {
      // Read-model cast: parsed JSON has no static shape; SessionEntryLike types only the fields read below,
      // and every consumption site re-checks its field with typeof guards.
      entries.push(value as SessionEntryLike);
    }
  }
  return { entries };
}

/** Walk leaf→root over the parentId tree and return the active branch in append order. The active leaf is the
 * deepest branch (most progressed conversation), tie-broken by the latest timestamp; linear fallback for legacy
 * files without ids (flagged `linear`), which can double count after branch forks. */
export function activeBranch(entries: SessionEntryLike[]): { branch: SessionEntryLike[]; resolution: 'branch' | 'linear' } {
  const byId = new Map<string, SessionEntryLike>();
  const referenced = new Set<string>();
  for (const entry of entries) {
    if (typeof entry.id === 'string') byId.set(entry.id, entry);
    if (typeof entry.parentId === 'string') referenced.add(entry.parentId);
  }
  const leaves = entries.filter(entry => typeof entry.id === 'string' && !referenced.has(entry.id as string));
  if (!byId.size || !leaves.length) return { branch: entries, resolution: 'linear' };
  const chains = leaves.map(leaf => {
    const chain: SessionEntryLike[] = [];
    for (let at: SessionEntryLike | undefined = leaf; at; at = typeof at.parentId === 'string' ? byId.get(at.parentId) : undefined) {
      chain.push(at);
      if (chain.length > entries.length + 1) return { chain: entries, timestamp: '' };
    }
    return { chain: chain.reverse(), timestamp: typeof leaf.timestamp === 'string' ? leaf.timestamp : '' };
  });
  chains.sort((a, b) => b.chain.length - a.chain.length || (a.timestamp < b.timestamp ? 1 : -1));
  return { branch: chains[0].chain, resolution: 'branch' };
}

/** The active conversation chain plus every off-chain usage/compaction entry attached to it. model_usage rows are
 * recorded as dead-end side branches (appendModelUsage restores the leaf), so a pure parent walk misses them;
 * compaction/branch_summary entries are included the same way for sessions that hung them off the side. */
export function activeBranchWithUsage(entries: SessionEntryLike[]): { branch: SessionEntryLike[]; resolution: 'branch' | 'linear' } {
  const { branch, resolution } = activeBranch(entries);
  const chainIds = new Set(branch.map(entry => entry.id).filter((id): id is string => typeof id === 'string'));
  const sides = entries.filter(entry =>
    (entry.type === 'model_usage' || entry.type === 'compaction' || entry.type === 'branch_summary')
    && typeof entry.parentId === 'string' && chainIds.has(entry.parentId)
    && !(typeof entry.id === 'string' && chainIds.has(entry.id)));
  if (!sides.length) return { branch, resolution };
  const merged = [...branch, ...sides].sort((a, b) => entries.indexOf(a) - entries.indexOf(b));
  return { branch: merged, resolution };
}

const billed = (usage: unknown): usage is Record<string, unknown> =>
  record(usage) && (typeof usage.input === 'number' || typeof usage.output === 'number'
    || typeof usage.cacheRead === 'number' || typeof usage.cacheWrite === 'number');

/** Parse one OMP session file into purpose-classified usage totals. */
export function parseSession(file: string): ParsedSession {
  const { entries } = entriesOf(file);
  const { branch, resolution } = activeBranchWithUsage(entries);
  const parsed: ParsedSession = {
    sessionFile: resolve(file), branchResolution: resolution,
    main: emptyTotals(),
    modelUsage: {},
    compaction: { events: 0, branchSummaries: 0, tokensBefore: [], usageKnown: false },
    requests: 0, totals: emptyTotals(),
  };
  for (const entry of branch) {
    if (entry.type === 'message') {
      const message = record(entry.message) ? entry.message : undefined;
      if (!message || message.role !== 'assistant') continue;
      parsed.main.calls++;
      parsed.requests++;
      if (message.stopReason === 'aborted') { parsed.main.unknown++; continue; }
      if (!billed(message.usage) || message.stopReason === 'error') {
        if (billed(message.usage)) addUsage(parsed.main, message.usage);
        else parsed.main.unknown++;
        continue;
      }
      addUsage(parsed.main, message.usage);
    } else if (entry.type === 'model_usage') {
      const purpose = typeof entry.purpose === 'string' && entry.purpose ? entry.purpose : 'unclassified';
      const bucket = parsed.modelUsage[purpose] ??= { ...emptyTotals(), provider: typeof entry.provider === 'string' ? entry.provider : undefined, model: typeof entry.model === 'string' ? entry.model : undefined, role: typeof entry.role === 'string' ? entry.role : undefined };
      bucket.calls++;
      parsed.requests++;
      if (entry.stopReason === 'aborted') { bucket.unknown++; continue; }
      if (billed(entry.usage)) addUsage(bucket, entry.usage);
      else bucket.unknown++;
    } else if (entry.type === 'compaction' || entry.type === 'branch_summary') {
      if (entry.type === 'compaction') parsed.compaction.events++;
      else parsed.compaction.branchSummaries++;
      if (typeof entry.tokensBefore === 'number') parsed.compaction.tokensBefore.push(entry.tokensBefore);
    }
  }
  addInto(parsed.totals, parsed.main);
  for (const bucket of Object.values(parsed.modelUsage)) addInto(parsed.totals, bucket);
  return parsed;
}

const EMPTY_USAGE: UsageLog = { recorded: false, purposes: {}, attempts: 0, pending: 0, failed: 0, unknown: 0, durationMs: 0 };

export interface UsageLog {
  recorded: boolean; file?: string; purposes: Record<string, UsageTotals & { attempts: number; failed: number; durationMs: number }>;
  attempts: number; pending: number; failed: number; unknown: number; durationMs: number;
}

/** Parse a background usage.jsonl per the settled measurement contract: `background-start`/`background` row pairs
 * joined by `id`; usage is the actual pi-ai Usage object or literal null (never fabricated zeros). `pending` counts
 * only unresolved invocations (a start without its terminal row, or a start with no id); a settled terminal with
 * null usage is `unknown`, never pending and never free. Absent file → recorded:false; the report never invents
 * history. */
export function parseUsageLog(file: string | undefined): UsageLog {
  if (!file || !existsSync(file)) return { ...EMPTY_USAGE, purposes: {} };
  const log: UsageLog = { recorded: true, file: resolve(file), purposes: {}, attempts: 0, pending: 0, failed: 0, unknown: 0, durationMs: 0 };
  const bucket = (purpose: string) => log.purposes[purpose] ??= { ...emptyTotals(), attempts: 0, failed: 0, durationMs: 0 };
  const open = new Map<string, string>();
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    let value: unknown;
    try { value = JSON.parse(line); } catch { continue; }
    if (!record(value)) continue;
    const purpose = typeof value.purpose === 'string' && value.purpose ? value.purpose : 'unclassified';
    const id = typeof value.id === 'string' ? value.id : '';
    if (value.type === 'background-start') {
      log.attempts++;
      bucket(purpose).attempts++;
      if (id) open.set(id, purpose);
      else log.pending++;
      continue;
    }
    if (value.type !== 'background') continue;
    const orphanTerminal = !id || !open.has(id);
    if (orphanTerminal) { log.attempts++; bucket(purpose).attempts++; }
    if (id) open.delete(id);
    const duration = typeof value.durationMs === 'number' ? value.durationMs : 0;
    log.durationMs += duration;
    bucket(purpose).durationMs += duration;
    if (typeof value.status === 'string' && value.status !== 'ok') { bucket(purpose).failed++; log.failed++; }
    if (record(value.usage) && billed(value.usage)) addUsage(bucket(purpose), value.usage);
    else { bucket(purpose).unknown++; log.unknown++; }
  }
  // Starts without a terminal row: the call was still running or the process died mid-call — pending, never billed.
  for (const purpose of open.values()) {
    bucket(purpose).unknown++;
    log.unknown++;
    log.pending++;
  }
  return log;
}

const EMPTY_COMPOSITION: CompositionLog = { recorded: false, requests: 0, leaks: 0, classes: {}, bytesTotal: 0, tokensEstimate: 0, purposes: {} };

/** Parse request-composition.jsonl rows (schema 1): exact per-class byte partition plus floor(bytes/4) estimates,
 * foreground `purpose:"main"` rows and background rows keyed to their usage-row ids. `leakFile` (native runs) counts
 * OptChat-leak flags the bench observer wrote. */
export function parseCompositionLog(file: string | undefined, leakFile?: string): CompositionLog {
  if (!file || !existsSync(file)) return { ...EMPTY_COMPOSITION, classes: {}, purposes: {} };
  const log: CompositionLog = { recorded: true, file: resolve(file), requests: 0, leaks: 0, classes: {}, bytesTotal: 0, tokensEstimate: 0, purposes: {} };
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    let value: unknown;
    try { value = JSON.parse(line); } catch { continue; }
    if (!record(value)) continue;
    log.requests++;
    const purpose = typeof value.purpose === 'string' && value.purpose ? value.purpose : 'unclassified';
    const purposeBucket = log.purposes[purpose] ??= { requests: 0, bytesTotal: 0 };
    purposeBucket.requests++;
    if (typeof value.totalBytes === 'number') { log.bytesTotal += value.totalBytes; purposeBucket.bytesTotal += value.totalBytes; }
    if (record(value.blocks))
      for (const [name, block] of Object.entries(value.blocks)) {
        if (!record(block) || typeof block.bytes !== 'number') continue;
        log.classes[name] = (log.classes[name] ?? 0) + block.bytes;
        if (typeof block.estimatedTokens === 'number') log.tokensEstimate += block.estimatedTokens;
      }
  }
  if (leakFile && existsSync(leakFile))
    log.leaks = readFileSync(leakFile, 'utf8').split('\n').filter(line => line.trim()).length;
  return log;
}

export interface SessionExchange { role: string; text: string }

/** The user prompts and assistant texts of a session's active branch, in order — the correctness surface for
 * benchmark evaluation. */
export function sessionExchanges(file: string): SessionExchange[] {
  const lines = readFileSync(file, 'utf8').split('\n');
  const entries: SessionEntryLike[] = [];
  for (const line of lines) {
    if (!line.trim()) continue;
    let value: unknown;
    try { value = JSON.parse(line); } catch { continue; }
    if (record(value)) {
      // Read-model cast: parsed JSON has no static shape; SessionEntryLike types only the fields read below.
      entries.push(value as SessionEntryLike);
    }
  }
  const { branch } = activeBranch(entries);
  const exchanges: SessionExchange[] = [];
  const textOf = (message: Record<string, unknown>): string => {
    if (typeof message.content === 'string') return message.content;
    if (!Array.isArray(message.content)) return '';
    return message.content.filter(record)
      .map(block => block.type === 'text' && typeof block.text === 'string' ? block.text : '')
      .filter(Boolean).join('\n');
  };
  for (const entry of branch) {
    if (entry.type !== 'message' || !record(entry.message)) continue;
    const message = entry.message;
    if (message.role === 'user') exchanges.push({ role: 'user', text: textOf(message) });
    else if (message.role === 'assistant') exchanges.push({ role: 'assistant', text: textOf(message) });
  }
  return exchanges;
}

const fmt = (n: number) => n.toLocaleString('en-US');
const fmtCost = (n: number) => `$${n.toFixed(4)}`;

export interface RunReportInput {
  label: string; mode: 'native' | 'optchat' | 'unknown'; workload: string;
  session?: ParsedSession; background: UsageLog; composition: CompositionLog; backgroundSettled?: boolean;
  /** Wire-derived (PI_REQ_DEBUG) actual token usage for native compaction calls, catalog-priced. */
  nativeCompactionUsage?: WireCompactionUsage;
}
/** Actual token counters from the compaction request wire responses; costUsd is a catalog-priced estimate. */
export interface WireCompactionUsage {
  requests: number; input: number; output: number; cacheRead: number; cacheWrite: number;
  costUsd: number; unpriced: number;
}

/** Completeness + verdict rules for one measured run. */
export function completenessOf(run: RunReportInput): RunReport['completeness'] {
  const reasons: string[] = [];
  const session = run.session;
  if (!session) reasons.push('no session parsed');
  else {
    if (session.main.unknown) reasons.push(`${session.main.unknown} main calls without usable usage (error/aborted/unanswered)`);
    for (const [purpose, bucket] of Object.entries(session.modelUsage))
      if (bucket.unknown) reasons.push(`${bucket.unknown} ${purpose} calls without usable usage`);
    if (session.compaction.events > 0) {
      const wire = run.nativeCompactionUsage;
      if (!wire || wire.requests === 0)
        reasons.push(`${session.compaction.events} native compaction call(s) with no wire-captured usage — cost unknown`);
      else {
        if (wire.unpriced) reasons.push(`${wire.unpriced} native compaction call(s) on providers without catalog pricing — cost unknown`);
        // Tokens are actual (wire SSE counters); USD is a catalog-priced estimate, never billed actuals.
        reasons.push(`native compaction USD is a catalog-priced estimate over ${wire.requests} wire-captured call(s) (actual tokens), not provider-billed actuals`);
      }
    }
    if (session.branchResolution === 'linear')
      reasons.push('session lacks id/parentId links; linear parse may double count branched sessions');
  }
  if (run.mode === 'optchat' && !run.background.recorded)
    reasons.push('background usage.jsonl absent (OptChat compactor/order calls unaccounted — measurement instrumentation not active)');
  if (run.background.pending) reasons.push(`${run.background.pending} background invocations unresolved (no terminal row) — accounting incomplete`);
  if (run.background.unknown) reasons.push(`${run.background.unknown} background attempts with unknown/null usage (failed-billed-unknown, never free)`);
  if (run.background.failed) reasons.push(`${run.background.failed} failed background attempts recorded`);
  if (run.backgroundSettled === false)
    reasons.push('background accounting did not settle within the bounded wait; usage.jsonl may still be draining (retained, not discarded)');
  if (!run.composition.recorded) reasons.push('request composition log absent');
  if (run.composition.leaks) reasons.push(`${run.composition.leaks} request(s) leaked OptChat context into the native comparator`);
  return { complete: reasons.length === 0, reasons };
}

export function buildRunReport(input: RunReportInput): RunReport {
  const completeness = completenessOf(input);
  const smoke = input.workload !== 'long';
  return {
    ...input,
    session: input.session,
    backgroundSettled: input.backgroundSettled !== false,
    completeness,
    evidence: smoke
      ? 'smoke — NOT long-context evidence'
      : 'long-context benchmark workload (compaction/rollover exercised)',
    savingsClaim: completeness.complete
      ? 'eligible (complete accounting on this run; comparison still needs both sides complete)'
      : 'none — incomplete accounting; see completeness.reasons',
    requests: input.session?.requests ?? 0,
  };
}

/** Cross-mode comparison. Request counts are informational only and never a savings basis. */
export interface ComparisonTotals {
  costDeltaUsd?: number; inputTokensDelta?: number; cacheReadTokensDelta?: number; cacheWriteTokensDelta?: number;
}
export interface ComparisonVerdict {
  eligible: boolean;
  verdict: string;
  requestCounts: { native: number; optchat: number; note: string };
  totals: ComparisonTotals;
}
export type RunComparison = ComparisonVerdict & { native: string; optchat: string };

export function compareRuns(native: RunReport, optchat: RunReport): ComparisonVerdict {
  const eligible = native.completeness.complete && optchat.completeness.complete
    && native.workload === optchat.workload;
  const delta = (a: number, b: number) => b - a;
  const totals = {
    costDeltaUsd: eligible ? delta(native.session!.totals.costUsd, optchat.session!.totals.costUsd) : undefined,
    inputTokensDelta: eligible ? delta(native.session!.totals.input, optchat.session!.totals.input) : undefined,
    cacheReadTokensDelta: eligible ? delta(native.session!.totals.cacheRead, optchat.session!.totals.cacheRead) : undefined,
    cacheWriteTokensDelta: eligible ? delta(native.session!.totals.cacheWrite, optchat.session!.totals.cacheWrite) : undefined,
  };
  return {
    eligible,
    verdict: eligible
      ? `complete accounting on both sides: native ${fmtCost(native.session!.totals.costUsd)} vs optchat ${fmtCost(optchat.session!.totals.costUsd)} (delta ${fmtCost(totals.costDeltaUsd!)}); savings verdict is a cost comparison, not a request-count comparison`
      : 'no savings verdict — incomplete accounting or mismatched workloads; see completeness.reasons per run',
    requestCounts: { native: native.requests, optchat: optchat.requests, note: 'informational only; request counts alone are not savings' },
    totals,
  };
}

const sessionCandidates = (dir: string): string[] => {
  const manifest = readManifest(dir);
  const named = (manifest.runs ?? []).map(run => run.sessionFile)
    .filter((file): file is string => typeof file === 'string' && isAbsolute(file) && existsSync(file));
  if (named.length) return named;
  return readdirSync(dir).filter(f => f.endsWith('.jsonl') && statSync(join(dir, f)).isFile()).map(f => join(dir, f));
};

interface ManifestRun { name?: string; sessionFile?: string; usageFile?: string; compositionFile?: string }
interface Manifest { config?: { mode?: string; workload?: string }; runs?: ManifestRun[] }

function readManifest(dir: string): Manifest {
  const manifestPath = join(dir, 'manifest.json');
  if (!existsSync(manifestPath)) return {};
  let parsed: unknown;
  try { parsed = JSON.parse(readFileSync(manifestPath, 'utf8')); } catch { return {}; }
  if (!record(parsed)) return {};
  const manifest: Manifest = {};
  if (record(parsed.config)) {
    manifest.config = {
      mode: typeof parsed.config.mode === 'string' ? parsed.config.mode : undefined,
      workload: typeof parsed.config.workload === 'string' ? parsed.config.workload : undefined,
    };
  }
  if (Array.isArray(parsed.runs)) {
    manifest.runs = parsed.runs.filter(record).map(run => ({
      name: typeof run.name === 'string' ? run.name : undefined,
      sessionFile: typeof run.sessionFile === 'string' ? run.sessionFile : undefined,
      usageFile: typeof run.usageFile === 'string' ? run.usageFile : undefined,
      compositionFile: typeof run.compositionFile === 'string' ? run.compositionFile : undefined,
    }));
  }
  return manifest;
}

async function main(argv: string[]) {
  const paths: string[] = [];
  let usage: string | undefined, composition: string | undefined, out: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--usage') usage = argv[++i];
    else if (arg === '--composition') composition = argv[++i];
    else if (arg === '--json') out = argv[++i];
    else if (arg.startsWith('--')) throw new Error(`Unknown flag ${arg}`);
    else paths.push(arg);
  }
  if (!paths.length || paths.some(p => !existsSync(p))) {
    console.error('Usage: bun scripts/bench-report.ts <session.jsonl | runDir>... [--usage usage.jsonl] [--composition request-composition.jsonl] [--json out.json]');
    process.exit(2);
  }
  const reports: RunReport[] = [];
  for (const path of paths) {
    const target = resolve(path);
    if (statSync(target).isDirectory()) {
      const manifest = readManifest(target);
      const mode = manifest.config?.mode === 'native' || manifest.config?.mode === 'optchat' ? manifest.config.mode : 'unknown';
      const workload = manifest.config?.workload ?? 'unknown';
      for (const file of sessionCandidates(target)) {
        const base = basename(file);
        const run = manifest.runs?.find(candidate => candidate.sessionFile === file || candidate.name === base.replace(/\.jsonl$/, ''));
        const usageFile = run?.usageFile ?? usage ?? join(target, 'usage.jsonl');
        const compositionFile = run?.compositionFile ?? composition ?? join(target, 'request-composition.jsonl');
        reports.push(buildRunReport({
          label: `${basename(target)}/${base}`, mode, workload,
          session: parseSession(file),
          background: parseUsageLog(usageFile),
          composition: parseCompositionLog(compositionFile),
        }));
      }
    } else {
      reports.push(buildRunReport({
        label: basename(target), mode: 'unknown', workload: 'unknown',
        session: parseSession(target),
        background: parseUsageLog(usage),
        composition: parseCompositionLog(composition),
      }));
    }
  }
  const comparisons: RunComparison[] = [];
  for (const native of reports.filter(r => r.mode === 'native'))
    for (const optchat of reports.filter(r => r.mode === 'optchat'))
      comparisons.push({ native: native.label, optchat: optchat.label, ...compareRuns(native, optchat) });
  const report = { generatedAt: new Date().toISOString(), runs: reports, comparisons };
  const text = JSON.stringify(report, null, 2);
  if (out) writeFileSync(resolve(out), text + '\n');
  for (const run of reports) {
    const s = run.session;
    console.log(`${run.label} [${run.mode}] ${run.evidence}`);
    if (!s) { console.log('  no session parsed'); continue; }
    console.log(`  main: ${fmt(s.main.calls)} calls · in ${fmt(s.main.input)} · out ${fmt(s.main.output)} · read ${fmt(s.main.cacheRead)} · write ${fmt(s.main.cacheWrite)} · ${fmtCost(s.main.costUsd)} · unknown ${fmt(s.main.unknown)}`);
    for (const [purpose, bucket] of Object.entries(s.modelUsage))
      console.log(`  ${purpose}: ${fmt(bucket.calls)} calls · in ${fmt(bucket.input)} · out ${fmt(bucket.output)} · ${fmtCost(bucket.costUsd)} · unknown ${fmt(bucket.unknown)}`);
    const wire = run.nativeCompactionUsage;
    console.log(`  compaction: ${fmt(s.compaction.events)} native call(s)${wire && wire.requests ? ` · wire-captured ${fmt(wire.requests)} · in ${fmt(wire.input)} out ${fmt(wire.output)} · catalog-priced $${wire.costUsd.toFixed(4)} (estimate, not billed actuals)` : ' · usage NOT captured'}`);
    console.log(`  background: ${run.background.recorded ? `${fmt(run.background.attempts)} attempts, pending ${fmt(run.background.pending)}, failed ${fmt(run.background.failed)}` : 'NOT RECORDED'}`);
    console.log(`  composition: ${run.composition.recorded ? `${fmt(run.composition.requests)} requests, ${fmt(run.composition.bytesTotal)} bytes, ~${fmt(run.composition.tokensEstimate)} tokens (byte/4), leaks ${run.composition.leaks}` : 'NOT RECORDED'}`);
    console.log(`  complete: ${run.completeness.complete ? 'yes' : `NO — ${run.completeness.reasons.join('; ')}`}`);
    console.log(`  savings claim: ${run.savingsClaim}`);
  }
  for (const pair of comparisons) console.log(`comparison: ${JSON.stringify(pair)}`);
  if (out) console.log(`\nJSON report: ${resolve(out)}`);
}

if (import.meta.main) await main(process.argv.slice(2)).catch(error => { console.error(error); process.exit(1); });
