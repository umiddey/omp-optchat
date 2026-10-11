import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { AgentMessage } from '@oh-my-pi/pi-agent-core';
import { checkRetrieval, groupTranscript, oversizedUnits, unitEntry,
  type GroupUnit, type RetrievalAccessor } from '../src/experiment-grouping.ts';
import { record } from '../src/cache.ts';

const fixturePath = join(import.meta.dir, 'fixtures', 'grouping-transcript.json');
const fixture: { messages: AgentMessage[] } = JSON.parse(readFileSync(fixturePath, 'utf8'));
const messages = fixture.messages;

const user = (text: string, timestamp = 1000): AgentMessage => ({ role: 'user', content: text, timestamp });
const call = (id: string, name: string, args: Record<string, unknown> = {}) => ({ type: 'toolCall' as const, id, name, arguments: args });
const callMessage = (calls: ReturnType<typeof call>[], text = '', stopReason = 'toolUse'): AgentMessage => ({
  role: 'assistant', api: 'anthropic-messages', provider: 'anthropic', model: 'fixture-model',
  content: [...(text ? [{ type: 'text' as const, text }] : []), ...calls],
  usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, cost: { total: 0 } },
  stopReason, timestamp: 2000,
} as AgentMessage);
const result = (toolCallId: string, toolName: string, text: string, isError = false): AgentMessage => ({
  role: 'toolResult', toolCallId, toolName, content: [{ type: 'text' as const, text }], isError, timestamp: 3000,
});
const accessor = (entries: { kind: string; text: string }[]): RetrievalAccessor => {
  const lines = entries.map((entry, i) => `${i}+0|${entry.kind}: ${entry.text}`);
  return { zoom: id => lines[id] ?? (() => { throw new Error(`no entry ${id}`); })() };
};

describe('groupTranscript', () => {
  test('fixture units: kinds, order, parallel, error, orphans and boundaries', () => {
    const units = groupTranscript(messages);
    // s0 orphan result | s1 user | s2 assistant | s3 user | s4 parallel assistant + s5 read + s6 bash-error |
    // s7 custom | s8 user | s9 assistant | s10 user | s11 zoom + s12 result | s13 assistant | s14 call-d |
    // s15 user | s16 orphan result
    expect(units.map(u => u.kind)).toEqual([
      'orphan-result', 'user', 'assistant', 'user', 'assistant', 'custom', 'user', 'assistant',
      'user', 'assistant', 'assistant', 'assistant', 'user', 'orphan-result',
    ]);
    const parallel = units.find(u => u.parallel);
    expect(parallel).toBeDefined();
    expect(parallel!.sourceIds).toEqual(['s4', 's5', 's6']);
    expect(parallel!.error).toBe(true);
    // The custom notice and the steering user each closed the open group: no multi-message unit spans a boundary.
    for (const unit of units) {
      if (unit.messages.length > 1)
        expect(unit.messages.some(m => m.role === 'user' || m.role === 'custom')).toBe(false);
    }
    expect(units[0].sourceIds).toEqual(['s0']);
    expect(units.at(-1)!.sourceIds).toEqual(['s16']);
    // call-d's result is orphaned by the intervening user turn, never joined across the boundary.
    expect(units.some(u => u.sourceIds.includes('s14') && u.sourceIds.includes('s16'))).toBe(false);
  });

  test('adversarial transcript: result never joins a closed or foreign group', () => {
    const transcript: AgentMessage[] = [
      result('x1', 'bash', 'orphan at start'),
      callMessage([call('a1', 'read')]),
      user('steering turns off the tool'),
      result('a1', 'read', 'late result after user'),
      callMessage([call('b1', 'bash')]),
      callMessage([call('b2', 'zoom')]),
      result('b2', 'zoom', 'only the latest call is open'),
    ];
    const units = groupTranscript(transcript);
    expect(units.map(u => u.kind)).toEqual([
      'orphan-result', 'assistant', 'user', 'orphan-result', 'assistant', 'assistant',
    ]);
    const zoomGroup = units.find(u => u.sourceIds.includes('s5'))!;
    expect(zoomGroup.sourceIds).toEqual(['s5', 's6']);
  });

  test('pure-talk assistant closes as its own unit with no results', () => {
    const units = groupTranscript([user('hi'), callMessage([], 'just text', 'stop')]);
    expect(units).toHaveLength(2);
    expect(units[1].messages).toHaveLength(1);
    expect(units[1].parallel).toBe(false);
  });
});

describe('unitEntry', () => {
  test('renders each unit kind with the shipped logging line formats', () => {
    const units = groupTranscript(messages);
    expect(unitEntry(units[0])).toEqual({ kind: 'echo', text: 'read: RESUME_TAIL=orphaned result recovered before this transcript window; no matching call exists in it.' });
    expect(unitEntry(units[1])).toEqual({ kind: 'user', text: expect.stringContaining('ORCHID') });
    const grouped = unitEntry(units[4])!;
    expect(grouped.kind).toBe('talk');
    expect(grouped.text).toContain('ROLLOUT_STAGE=CANARY-42');
    expect(grouped.text).toContain('"path":"deploy-notes.txt"');
    expect(grouped.text).toContain('SIMULATED_FAILURE');
  });

  test('oversized units exceed the 512-byte node budget so real compaction must run', () => {
    const units = groupTranscript(messages);
    const oversized = oversizedUnits(units);
    expect(oversized.length).toBeGreaterThanOrEqual(2);
    expect(oversized.some(u => u.sourceIds.includes('s5'))).toBe(true);
    expect(oversized.some(u => u.sourceIds.includes('s12'))).toBe(true);
  });
});

describe('checkRetrieval', () => {
  const singleUnit = (unit: GroupUnit, message: AgentMessage): GroupUnit => ({
    kind: message.role === 'user' ? 'user' : message.role === 'custom' ? 'custom'
      : message.role === 'toolResult' ? 'orphan-result'
      : message.role === 'assistant' ? 'assistant' : 'other',
    sourceIds: [message.role], messages: [message],
    error: message.role === 'toolResult' && message.isError === true, parallel: false,
  });
  const entriesOfGrouped = (units: GroupUnit[]) => units.map(unit => unitEntry(unit)).filter(entry => entry !== null);
  const entriesOfMessageLevel = (units: GroupUnit[]) => units.flatMap(unit => unit.messages
    .map(message => unitEntry(singleUnit(unit, message))).filter(entry => entry !== null));

  test('grouped replay: every original line is retrievable verbatim', () => {
    const units = groupTranscript(messages);
    const entries = entriesOfGrouped(units);
    const checks = checkRetrieval(units, entries.map((_, i) => [i]), accessor(entries));
    expect(checks.length).toBeGreaterThan(0);
    expect(checks.every(check => check.pass)).toBe(true);
  });

  test('message-level replay: every original line is retrievable verbatim', () => {
    const units = groupTranscript(messages);
    const entries = entriesOfMessageLevel(units);
    // Each fixture message lands on its own entry, in unit order.
    const indexes: number[][] = [];
    let next = 0;
    for (const unit of units) {
      const count = unit.messages.filter(message => {
        const single = unitEntry(singleUnit(unit, message));
        return single !== null;
      }).length;
      indexes.push(Array.from({ length: count }, (_, k) => next++));
    }
    const checks = checkRetrieval(units, indexes, accessor(entries));
    expect(checks.length).toBeGreaterThan(0);
    expect(checks.every(check => check.pass)).toBe(true);
  });

  test('missing or wrong entries fail retrieval with details', () => {
    const units = groupTranscript(messages.slice(0, 3));
    const entries = entriesOfGrouped(units);
    const checks = checkRetrieval(units, [entries.map((_, i) => [i])[0]], accessor(entries));
    expect(checks.some(check => !check.pass && check.detail === 'no log index')).toBe(true);
    const broken = accessor(entries.slice(0, 1));
    const failing = checkRetrieval(units, units.map((_, i) => [i]), broken);
    expect(failing.some(check => !check.pass)).toBe(true);
  });
});

describe('fixture expectations', () => {
  test('fixture declares facts, orders and an order question for the live checks', () => {
    const parsed: unknown = JSON.parse(readFileSync(fixturePath, 'utf8'));
    expect(record(parsed)).toBe(true);
    expect(record(parsed) && Array.isArray(parsed.facts) && parsed.facts.length >= 3).toBe(true);
    expect(record(parsed) && Array.isArray(parsed.expectedOrders) && parsed.expectedOrders.length >= 1).toBe(true);
    expect(record(parsed) && record(parsed.orderQuestion) && typeof parsed.orderQuestion.expect === 'string').toBe(true);
  });
});
