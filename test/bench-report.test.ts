import { describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { activeBranch, buildRunReport, compareRuns, parseCompositionLog, parseSession,
  parseUsageLog, sessionExchanges } from '../scripts/bench-report.ts';
import { record } from '../src/cache.ts';

const fixture = (name: string) => join(import.meta.dir, 'fixtures', name);

const usageRow = (over: Record<string, unknown>) => JSON.stringify({ schema: 1, ...over });

describe('parseSession', () => {
  test('native fixture: purpose-classified totals, unknowns and compaction events, active branch only', () => {
    const parsed = parseSession(fixture('bench-session-native.jsonl'));
    // Main calls: e2, e4, e6, e8 count; e10 aborted does not (unknown).
    expect(parsed.main.calls).toBe(5);
    expect(parsed.main.callsWithUsage).toBe(4);
    expect(parsed.main.unknown).toBe(1);
    expect(parsed.main.input).toBe(120 + 400 + 800 + 1500);
    expect(parsed.main.cacheRead).toBe(0 + 390 + 790 + 1400);
    expect(parsed.main.cacheWrite).toBe(4000 + 20 + 15 + 110);
    expect(parsed.main.costUsd).toBeCloseTo(0.0123 + 0.0044 + 0.0022 + 0.0031, 6);
    // model_usage purposes are comparator costs and stay separate from main.
    const autoThinking = parsed.modelUsage['auto-thinking'];
    expect(autoThinking).toBeDefined();
    expect(autoThinking.calls).toBe(1);
    expect(autoThinking.input).toBe(300);
    expect(autoThinking.costUsd).toBeCloseTo(0.0004, 6);
    const memory = parsed.modelUsage['memory'];
    expect(memory!.calls).toBe(1);
    expect(memory!.unknown).toBe(1);
    // Native compaction: counted as events, usage explicitly unknown by contract.
    expect(parsed.compaction.events).toBe(1);
    expect(parsed.compaction.tokensBefore).toEqual([190000]);
    expect(parsed.compaction.usageKnown).toBe(false);
    expect(parsed.totals.calls).toBe(parsed.main.calls + 2);
    expect(parsed.requests).toBe(7);
  });

  test('branched fixture: abandoned branch never double counts', () => {
    const parsed = parseSession(fixture('bench-session-fork.jsonl'));
    expect(parsed.branchResolution).toBe('branch');
    // Active branch f1→f2→f4 counts exactly one assistant reply; f3 (earlier timestamp sibling) is abandoned.
    expect(parsed.main.calls).toBe(2);
    expect(parsed.main.input).toBe(100 + 300);
    expect(parsed.main.costUsd).toBeCloseTo(0.04, 6);
  });

  test('sessionExchanges walks the active branch in order', () => {
    const exchanges = sessionExchanges(fixture('bench-session-fork.jsonl'));
    expect(exchanges.map(e => e.role)).toEqual(['user', 'assistant', 'assistant']);
    expect(exchanges.at(-1)!.text).toBe('active leaf answer');
  });

  test('activeBranch prefers the deepest chain, tie-breaks on timestamp', () => {
    const entries = [
      { type: 'message', id: 'a', parentId: null, timestamp: '2026-01-01T00:00:00Z', message: { role: 'user' } },
      { type: 'message', id: 'b', parentId: 'a', timestamp: '2026-01-02T00:00:00Z', message: { role: 'assistant' } },
      { type: 'message', id: 'c', parentId: 'b', timestamp: '2026-01-03T00:00:00Z', message: { role: 'user' } },
    ];
    const { branch, resolution } = activeBranch(entries);
    expect(resolution).toBe('branch');
    expect(branch.map(entry => entry.id)).toEqual(['a', 'b', 'c']);
  });
});

describe('parseUsageLog (contract v2 rows)', () => {
  test('pairs join by id; null usage and orphan starts are pending, failures counted', () => {
    const dir = mkdtempSync(join(tmpdir(), 'bench-usage-'));
    try {
      const file = join(dir, 'usage.jsonl');
      writeFileSync(file, [
        usageRow({ type: 'background-start', id: 'u1', timestamp: 't', purpose: 'summary', provider: 'anthropic', model: 'haiku', attempt: 1 }),
        usageRow({ type: 'background', id: 'u1', timestamp: 't', purpose: 'summary', provider: 'anthropic', model: 'haiku', attempt: 1, durationMs: 900, status: 'ok', usage: { input: 5000, output: 100, cacheRead: 4000, cacheWrite: 900, cost: { total: 0.01 } } }),
        usageRow({ type: 'background-start', id: 'u2', timestamp: 't', purpose: 'summary', provider: 'anthropic', model: 'haiku', attempt: 2 }),
        // v2: all-zero counters on a failure file as usage:null — unknown, never free.
        usageRow({ type: 'background', id: 'u2', timestamp: 't', purpose: 'summary', provider: 'anthropic', model: 'haiku', attempt: 2, durationMs: 40, status: 'error', usage: null, error: 'provider 500' }),
        usageRow({ type: 'background-start', id: 'u3', timestamp: 't', purpose: 'consolidate', provider: 'anthropic', model: 'haiku', attempt: 1, retry: true }),
        usageRow({ type: 'background', id: 'u4', timestamp: 't', purpose: 'backfill', provider: 'anthropic', model: 'haiku', attempt: 1, durationMs: 5, status: 'ok', usage: { input: 10, output: 1, cacheRead: 0, cacheWrite: 0, cost: { total: 0.0001 } } }),
      ].join('\n') + '\n');
      const log = parseUsageLog(file);
      expect(log.recorded).toBe(true);
      expect(log.attempts).toBe(4);
      const summary = log.purposes['summary']!;
      expect(summary.attempts).toBe(2);
      expect(summary.callsWithUsage).toBe(1);
      expect(summary.unknown).toBe(1);
      expect(summary.failed).toBe(1);
      expect(summary.input).toBe(5000);
      expect(summary.costUsd).toBeCloseTo(0.01, 6);
      // Orphan terminal (u4 has no start) counts as a completed attempt; orphan start u3 stays pending.
      expect(log.purposes['backfill']!.callsWithUsage).toBe(1);
      expect(log.pending).toBe(1);
      expect(log.failed).toBe(1);
      expect(log.durationMs).toBe(945);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('absent file is recorded:false, never an empty complete run', () => {
    const log = parseUsageLog(join(tmpdir(), 'bench-missing-usage.jsonl'));
    expect(log.recorded).toBe(false);
    expect(log.attempts).toBe(0);
  });
});

describe('parseCompositionLog (contract v2 rows)', () => {
  test('blocks partition totals; purposes split foreground and background; leaks counted', () => {
    const dir = mkdtempSync(join(tmpdir(), 'bench-comp-'));
    try {
      const file = join(dir, 'request-composition.jsonl');
      const block = (bytes: number) => ({ bytes, estimatedTokens: Math.floor(bytes / 4) });
      writeFileSync(file, [
        JSON.stringify({ schema: 1, type: 'request', id: 'r1', timestamp: 't', purpose: 'main', provider: 'anthropic', model: 'opus', blocks: { tools: block(400), system: block(3000), orders: block(50), view: block(12000), memories: block(0), history: block(600), other: block(40) }, totalBytes: 16090, tokenEstimateMethod: 'utf8-bytes/4' }),
        JSON.stringify({ schema: 1, type: 'request', id: 'r2', timestamp: 't', purpose: 'summary', provider: 'anthropic', model: 'haiku', blocks: { tools: block(0), system: block(500), orders: block(0), view: block(9000), memories: block(0), history: block(300), other: block(30) }, totalBytes: 9830, tokenEstimateMethod: 'utf8-bytes/4' }),
      ].join('\n') + '\n');
      const leakFile = join(dir, 'optchat-leak.jsonl');
      writeFileSync(leakFile, '{"timestamp":"t","seq":1}\n');
      const log = parseCompositionLog(file, leakFile);
      expect(log.recorded).toBe(true);
      expect(log.requests).toBe(2);
      expect(log.classes.tools).toBe(400);
      expect(log.classes.view).toBe(21000);
      expect(log.bytesTotal).toBe(16090 + 9830);
      expect(log.tokensEstimate).toBe(Math.floor(400 / 4) + Math.floor(3000 / 4) + Math.floor(50 / 4) + Math.floor(12000 / 4) + Math.floor(600 / 4) + Math.floor(40 / 4)
        + Math.floor(500 / 4) + Math.floor(9000 / 4) + Math.floor(300 / 4) + Math.floor(30 / 4));
      expect(log.purposes['main']!.requests).toBe(1);
      expect(log.purposes['summary']!.bytesTotal).toBe(9830);
      expect(log.leaks).toBe(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('completeness and comparison', () => {
  const session = (file: string) => parseSession(fixture(file));

  test('native run with compaction events is never complete', () => {
    const report = buildRunReport({
      label: 'native', mode: 'native', workload: 'smoke',
      session: session('bench-session-native.jsonl'),
      background: parseUsageLog(undefined),
      composition: parseCompositionLog(undefined),
    });
    expect(report.completeness.complete).toBe(false);
    expect(report.completeness.reasons.some(r => r.includes('native compaction call'))).toBe(true);
    expect(report.savingsClaim).toContain('none — incomplete');
    expect(report.evidence).toContain('NOT long-context evidence');
  });

  test('optchat run without a usage log is incomplete; complete runs compare on cost', () => {
    const missingBackground = buildRunReport({
      label: 'optchat', mode: 'optchat', workload: 'smoke',
      session: session('bench-session-optchat.jsonl'),
      background: parseUsageLog(undefined),
      composition: parseCompositionLog(undefined),
    });
    expect(missingBackground.completeness.complete).toBe(false);
    expect(missingBackground.completeness.reasons.some(r => r.includes('usage.jsonl absent'))).toBe(true);

    const dir = mkdtempSync(join(tmpdir(), 'bench-complete-'));
    try {
      const usageFile = join(dir, 'usage.jsonl');
      writeFileSync(usageFile, [
        usageRow({ type: 'background-start', id: 's1', timestamp: 't', purpose: 'summary', provider: 'anthropic', model: 'haiku', attempt: 1 }),
        usageRow({ type: 'background', id: 's1', timestamp: 't', purpose: 'summary', provider: 'anthropic', model: 'haiku', attempt: 1, durationMs: 700, status: 'ok', usage: { input: 9000, output: 120, cacheRead: 8000, cacheWrite: 1000, cost: { total: 0.02 } } }),
      ].join('\n') + '\n');
      const compositionFile = join(dir, 'request-composition.jsonl');
      writeFileSync(compositionFile, JSON.stringify({ schema: 1, type: 'request', id: 'c1', timestamp: 't', purpose: 'main', provider: 'anthropic', model: 'opus', blocks: { tools: { bytes: 1, estimatedTokens: 0 }, system: { bytes: 1, estimatedTokens: 0 }, orders: { bytes: 0, estimatedTokens: 0 }, view: { bytes: 0, estimatedTokens: 0 }, memories: { bytes: 0, estimatedTokens: 0 }, history: { bytes: 1, estimatedTokens: 0 }, other: { bytes: 0, estimatedTokens: 0 } }, totalBytes: 3, tokenEstimateMethod: 'utf8-bytes/4' }) + '\n');
      const optchat = buildRunReport({
        label: 'optchat', mode: 'optchat', workload: 'smoke',
        session: session('bench-session-optchat.jsonl'),
        background: parseUsageLog(usageFile),
        composition: parseCompositionLog(compositionFile),
      });
      // The optchat fixture session itself is complete (no compaction, no unknowns), but its model_usage
      // cache-warm row has usage, so the whole run is complete here.
      expect(optchat.completeness.complete).toBe(true);
      const native = buildRunReport({
        label: 'native', mode: 'native', workload: 'smoke',
        session: session('bench-session-optchat.jsonl'),
        background: parseUsageLog(usageFile),
        composition: parseCompositionLog(compositionFile),
      });
      const comparison = compareRuns(native, optchat);
      expect(comparison.eligible).toBe(true);
      expect(comparison.verdict).toContain('cost comparison, not a request-count comparison');
      expect(comparison.requestCounts.note).toContain('not savings');
      expect(comparison.totals.costDeltaUsd).toBeCloseTo(optchat.session!.totals.costUsd - native.session!.totals.costUsd, 6);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('workload mismatch blocks the comparison', () => {
    const a = buildRunReport({ label: 'a', mode: 'native', workload: 'long', session: session('bench-session-optchat.jsonl'), background: parseUsageLog(undefined), composition: parseCompositionLog(undefined) });
    const b = buildRunReport({ label: 'b', mode: 'optchat', workload: 'smoke', session: session('bench-session-optchat.jsonl'), background: parseUsageLog(undefined), composition: parseCompositionLog(undefined) });
    expect(compareRuns(a, b).eligible).toBe(false);
    expect(record(a)).toBe(true);
  });
});
