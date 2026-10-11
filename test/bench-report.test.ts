import { afterAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { activeBranch, aggregateSpend, buildRunReport, compareRuns, parseCompositionLog, parseSession,
  parseUsageLog, sessionExchanges } from '../scripts/bench-report.ts';
import { record } from '../src/cache.ts';

const fixture = (name: string) => join(import.meta.dir, 'fixtures', name);

const usageRow = (over: Record<string, unknown>) => JSON.stringify({ schema: 1, ...over });

describe('parseSession (spend: every billable entry counts once)', () => {
  test('native fixture: purpose-classified totals, unknowns and compaction events', () => {
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
    expect(autoThinking!.calls).toBe(1);
    expect(autoThinking!.input).toBe(300);
    expect(autoThinking!.costUsd).toBeCloseTo(0.0004, 6);
    const memory = parsed.modelUsage['memory'];
    expect(memory!.calls).toBe(1);
    expect(memory!.unknown).toBe(1);
    expect(parsed.compaction.events).toBe(1);
    expect(parsed.compaction.tokensBefore).toEqual([190000]);
    expect(parsed.totals.calls).toBe(parsed.main.calls + 2);
    expect(parsed.requests).toBe(7);
    expect(parsed.damaged).toBe(0);
    expect(parsed.branchy).toBe(false);
  });

  test('rewind fork: abandoned-branch calls were PAID and stay in spend; active chain only for correctness', () => {
    const parsed = parseSession(fixture('bench-session-fork.jsonl'));
    // f2 (both branches' shared parent), f3 (abandoned sibling), f4 (active leaf): all three were billed.
    expect(parsed.main.calls).toBe(3);
    expect(parsed.main.input).toBe(100 + 200 + 300);
    expect(parsed.main.costUsd).toBeCloseTo(0.01 + 0.02 + 0.03, 6);
    expect(parsed.branchy).toBe(true);
    // Correctness ordering still walks the active chain: user, shared assistant, active leaf.
    const exchanges = sessionExchanges(fixture('bench-session-fork.jsonl'));
    expect(exchanges.map(e => e.role)).toEqual(['user', 'assistant', 'assistant']);
    expect(exchanges.at(-1)!.text).toBe('active leaf answer');
  });

  test('damaged lines are counted, never silently skipped', () => {
    const dir = mkdtempSync(join(tmpdir(), 'bench-damaged-'));
    try {
      const file = join(dir, 'session.jsonl');
      writeFileSync(file, [
        '{"type":"session","id":"s","timestamp":"t","cwd":"/tmp/x"}',
        '{"type":"message","id":"m1","parentId":null,"timestamp":"t","message":{"role":"user","content":"hi","timestamp":1}}',
        'NOT JSON AT ALL',
        '{"type":"message","id":"m2","parentId":"m1","timestamp":"t","message":{"role":"assistant","api":"anthropic-messages","provider":"p","model":"m","content":[{"type":"text","text":"yo"}],"usage":{"input":5,"output":1,"cacheRead":0,"cacheWrite":0,"cost":{"total":0.001}},"stopReason":"stop","timestamp":2}}',
      ].join('\n') + '\n');
      const parsed = parseSession(file);
      expect(parsed.damaged).toBe(1);
      expect(parsed.main.calls).toBe(1);
      expect(parsed.main.input).toBe(5);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('activeBranch prefers the deepest chain, tie-breaks on latest timestamp', () => {
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
        usageRow({ type: 'background', id: 'u2', timestamp: 't', purpose: 'summary', provider: 'anthropic', model: 'haiku', attempt: 2, durationMs: 40, status: 'error', usage: null, error: 'provider 500' }),
        usageRow({ type: 'background-start', id: 'u3', timestamp: 't', purpose: 'consolidate', provider: 'anthropic', model: 'haiku', attempt: 1, retry: true }),
        usageRow({ type: 'background', id: 'u4', timestamp: 't', purpose: 'backfill', provider: 'anthropic', model: 'haiku', attempt: 1, durationMs: 5, status: 'ok', usage: { input: 10, output: 1, cacheRead: 0, cacheWrite: 0, cost: { total: 0.0001 } } }),
        'GARBAGE LINE',
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
      expect(log.purposes['backfill']!.callsWithUsage).toBe(1);
      expect(log.pending).toBe(1);
      expect(log.failed).toBe(1);
      expect(log.durationMs).toBe(945);
      expect(log.damaged).toBe(1);
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
  test('blocks partition totals; purposes split foreground and background; leaks and damaged counted', () => {
    const dir = mkdtempSync(join(tmpdir(), 'bench-comp-'));
    try {
      const file = join(dir, 'request-composition.jsonl');
      const block = (bytes: number) => ({ bytes, estimatedTokens: Math.floor(bytes / 4) });
      writeFileSync(file, [
        JSON.stringify({ schema: 1, type: 'request', id: 'r1', timestamp: 't', purpose: 'main', provider: 'anthropic', model: 'opus', blocks: { tools: block(400), system: block(3000), orders: block(50), view: block(12000), memories: block(0), history: block(600), other: block(40) }, totalBytes: 16090, tokenEstimateMethod: 'utf8-bytes/4' }),
        JSON.stringify({ schema: 1, type: 'request', id: 'r2', timestamp: 't', purpose: 'summary', provider: 'anthropic', model: 'haiku', blocks: { tools: block(0), system: block(500), orders: block(0), view: block(9000), memories: block(0), history: block(300), other: block(30) }, totalBytes: 9830, tokenEstimateMethod: 'utf8-bytes/4' }),
        '{"broken": true}',
      ].join('\n') + '\n');
      const leakFile = join(dir, 'optchat-leak.jsonl');
      writeFileSync(leakFile, '{"timestamp":"t","seq":1}\n');
      const log = parseCompositionLog(file, leakFile);
      expect(log.recorded).toBe(true);
      expect(log.requests).toBe(2);
      expect(log.damaged).toBe(1);
      expect(log.classes.tools).toBe(400);
      expect(log.classes.view).toBe(21000);
      expect(log.bytesTotal).toBe(16090 + 9830);
      expect(log.purposes['main']!.requests).toBe(1);
      expect(log.purposes['summary']!.bytesTotal).toBe(9830);
      expect(log.leaks).toBe(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

const session = (file: string) => parseSession(fixture(file));

describe('completeness and comparison', () => {
  test('native run with compaction events and no wire capture is never complete', () => {
    const report = buildRunReport({
      label: 'native', mode: 'native', workload: 'smoke',
      session: session('bench-session-native.jsonl'),
      background: parseUsageLog(undefined),
      composition: parseCompositionLog(undefined),
    });
    expect(report.completeness.complete).toBe(false);
    expect(report.completeness.reasons.some(r => r.includes('no wire-captured usage'))).toBe(true);
    expect(report.savingsClaim).toContain('none — incomplete');
    expect(report.evidence).toContain('NOT long-context evidence');
  });

  test('fully known wire compaction usage is complete; pricing stays an informational note', () => {
    const withCompaction = session('bench-session-optchat.jsonl');
    withCompaction.compaction = { ...withCompaction.compaction, events: 1, tokensBefore: [190000] };
    const report = buildRunReport({
      label: 'native', mode: 'native', workload: 'smoke',
      session: withCompaction,
      background: parseUsageLog(undefined),
      composition: { ...parseCompositionLog(undefined), recorded: true, requests: 2 },
      nativeCompactionUsage: { requests: 1, input: 190_000, output: 800, cacheRead: 0, cacheWrite: 0, costUsd: 0.31, unpriced: 0 },
      correctnessPassed: true,
    });
    expect(report.completeness.complete).toBe(true);
    expect(report.completeness.reasons).toEqual([]);
    expect(report.pricingNote).toContain('catalog-priced estimate');
    expect(report.pricingNote).toContain('not billed actuals');
  });

  test('wire capture below compaction events is incomplete', () => {
    const report = buildRunReport({
      label: 'native', mode: 'native', workload: 'long',
      session: session('bench-session-native.jsonl'),
      background: parseUsageLog(undefined),
      composition: parseCompositionLog(undefined),
      nativeCompactionUsage: { requests: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, costUsd: 0, unpriced: 0 },
    });
    expect(report.completeness.complete).toBe(false);
    expect(report.completeness.reasons.some(r => r.includes('no wire-captured usage'))).toBe(true);
    expect(report.evidence).toContain('NOT compaction-tested');
  });

  test('damaged telemetry in any sink forces incomplete', () => {
    const damagedSession = buildRunReport({
      label: 'n', mode: 'native', workload: 'smoke',
      session: { ...session('bench-session-optchat.jsonl'), damaged: 2 },
      background: parseUsageLog(undefined),
      composition: { ...parseCompositionLog(undefined), recorded: true, damaged: 1 },
      backgroundSettled: true,
    });
    expect(damagedSession.completeness.complete).toBe(false);
    expect(damagedSession.completeness.reasons.some(r => r.includes('unparseable session line'))).toBe(true);
    expect(damagedSession.completeness.reasons.some(r => r.includes('unparseable composition line'))).toBe(true);
  });

  test('optchat run without a usage log is incomplete', () => {
    const report = buildRunReport({
      label: 'optchat', mode: 'optchat', workload: 'smoke',
      session: session('bench-session-optchat.jsonl'),
      background: parseUsageLog(undefined),
      composition: parseCompositionLog(undefined),
    });
    expect(report.completeness.complete).toBe(false);
    expect(report.completeness.reasons.some(r => r.includes('usage.jsonl absent'))).toBe(true);
  });
});

describe('compareRuns over aggregated spend', () => {
  const dir = mkdtempSync(join(tmpdir(), 'bench-aggregate-'));
  const usageFile = join(dir, 'usage.jsonl');
  const compositionFile = join(dir, 'request-composition.jsonl');
  writeFileSync(usageFile, [
    // OptChat background is expensive enough to flip the totals even though its foreground is cheaper.
    usageRow({ type: 'background-start', id: 'b1', timestamp: 't', purpose: 'summary', provider: 'anthropic', model: 'haiku', attempt: 1 }),
    usageRow({ type: 'background', id: 'b1', timestamp: 't', purpose: 'summary', provider: 'anthropic', model: 'haiku', attempt: 1, durationMs: 800, status: 'ok', usage: { input: 200_000, output: 500, cacheRead: 0, cacheWrite: 0, cost: { total: 0.5 } } }),
  ].join('\n') + '\n');
  writeFileSync(compositionFile, JSON.stringify({ schema: 1, type: 'request', id: 'c1', timestamp: 't', purpose: 'main', provider: 'anthropic', model: 'opus', blocks: { tools: { bytes: 1, estimatedTokens: 0 }, system: { bytes: 1, estimatedTokens: 0 }, orders: { bytes: 0, estimatedTokens: 0 }, view: { bytes: 0, estimatedTokens: 0 }, memories: { bytes: 0, estimatedTokens: 0 }, history: { bytes: 1, estimatedTokens: 0 }, other: { bytes: 0, estimatedTokens: 0 } }, totalBytes: 3, tokenEstimateMethod: 'utf8-bytes/4' }) + '\n');

  const identity = { model: 'anthropic/claude-opus-5-5', compactor: 'anthropic/claude-haiku-5-5', thinking: 'xhigh', workload: 'smoke', turns: 4 };
  const native = buildRunReport({
    label: 'native', mode: 'native', workload: 'smoke', identity,
    session: session('bench-session-optchat.jsonl'),
    background: parseUsageLog(undefined),
    composition: parseCompositionLog(compositionFile),
    nativeCompactionUsage: { requests: 1, input: 1000, output: 100, cacheRead: 0, cacheWrite: 0, costUsd: 0.002, unpriced: 0 },
    correctnessPassed: true,
  });
  const optchat = buildRunReport({
    label: 'optchat', mode: 'optchat', workload: 'smoke', identity,
    session: session('bench-session-optchat.jsonl'),
    background: parseUsageLog(usageFile),
    composition: parseCompositionLog(compositionFile),
    correctnessPassed: true,
  });

  test('totals aggregate foreground + background + compaction on each side', () => {
    const nativeSpend = aggregateSpend(native);
    expect(nativeSpend.total.costUsd).toBeCloseTo(native.session!.totals.costUsd + 0.002, 6);
    expect(nativeSpend.background.calls).toBe(0);
    const optchatSpend = aggregateSpend(optchat);
    expect(optchatSpend.background.calls).toBe(1);
    expect(optchatSpend.total.costUsd).toBeCloseTo(optchat.session!.totals.costUsd + 0.5, 6);
  });

  test('comparison uses total spend: cheaper foreground with expensive background loses', () => {
    const comparison = compareRuns(native, optchat);
    expect(comparison.eligible).toBe(true);
    const nativeTotal = aggregateSpend(native).total.costUsd;
    const optchatTotal = aggregateSpend(optchat).total.costUsd;
    expect(optchatTotal).toBeGreaterThan(nativeTotal);
    expect(comparison.totals.costDeltaUsd).toBeCloseTo(optchatTotal - nativeTotal, 6);
    expect(comparison.verdict).toContain('total spend');
    expect(comparison.verdict).toContain('catalog-priced estimates, not billed actuals');
  });

  test('correctness FAIL refuses comparison even with complete accounting', () => {
    const failed = buildRunReport({
      label: 'optchat-fail', mode: 'optchat', workload: 'smoke', identity,
      session: session('bench-session-optchat.jsonl'),
      background: parseUsageLog(usageFile),
      composition: parseCompositionLog(compositionFile),
      correctnessPassed: false,
    });
    const comparison = compareRuns(native, failed);
    expect(comparison.eligible).toBe(false);
    expect(comparison.verdict).toContain('correctness failure');
  });

  test('identity mismatch refuses comparison', () => {
    const otherModel = buildRunReport({
      label: 'optchat-other', mode: 'optchat', workload: 'smoke',
      identity: { ...identity, model: 'anthropic/claude-opus-4-1' },
      session: session('bench-session-optchat.jsonl'),
      background: parseUsageLog(usageFile),
      composition: parseCompositionLog(compositionFile),
      correctnessPassed: true,
    });
    const comparison = compareRuns(native, otherModel);
    expect(comparison.eligible).toBe(false);
    expect(comparison.verdict).toContain('identity mismatch');
  });

  afterAll(() => { rmSync(dir, { recursive: true, force: true }); });
});
