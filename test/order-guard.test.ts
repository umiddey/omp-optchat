import { test, expect } from 'bun:test';
import { missingTokens } from '../src/orders.ts';

test('numbers, including 0 and ids, must match exactly at word boundaries', () => {
 expect(missingTokens('Keep 663 tests green.', 'Keep 661 tests green.')).toEqual(['663']);
 expect(missingTokens('0 waived', 'there are 10 waived')).toEqual(['0']);
 expect(missingTokens('MR !103 watch', 'watch the MR')).toEqual(['!103']);
});

test('paths and code tokens must appear exactly', () => {
 expect(missingTokens('see docs/gate.md.', 'see the gate doc')).toEqual(['docs/gate.md']);
 expect(missingTokens('see docs/gate.md.', 'see docs/gate.md')).toEqual([]);
});

test('a slash-separated count pattern checks each piece, not the whole compound', () => {
 expect(missingTokens('missing/0 waived/0', '0 missing and 0 waived')).toEqual([]);
});

test('condition words are exact: every is not satisfied by each', () => {
 expect(missingTokens('Every endpoint', 'Each endpoint')).toEqual(['Every']);
});

test('names of five or more letters tolerate typos within edit distance 2', () => {
 expect(missingTokens('gatefoge must never push', 'Gateforge must never push')).toEqual([]);
 expect(missingTokens('PM gate waived', 'PM gate')).toEqual(['waived']);
});
