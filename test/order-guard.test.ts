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

test('a mid-sentence capital is a must-keep name when the context also uses it; a near spelling counts as kept', () => {
 expect(missingTokens('Ask PM Gateforge to merge.', 'Ask PM to merge.', 'The Gateforge release is ready')).toEqual(['Gateforge']);
 expect(missingTokens('Ask PM Gateforge to merge.', 'Ask PM to merge.')).toEqual([]);
 expect(missingTokens('Push to Gatefoge now.', 'Push to Gateforge now.')).toEqual([]);
});

test('a name the restatement brings in from nowhere is reported as invented', () => {
 expect(missingTokens('Ask the OIA agent.', 'Ask the OI agent.')).toEqual(['OIA', 'invented OI']);
 expect(missingTokens('Send it to Rappov', 'Send it to Gateforge', 'user: Send it to Rappov\nassistant: The Gateforge repo is ready')).toEqual([]);
});

test('an all-caps acronym of two or more letters is must-keep, case-insensitively', () => {
 expect(missingTokens('Watch CP MR !103', 'watch the gate')).toEqual(['CP', 'MR', '!103']);
 expect(missingTokens('Watch CP', 'watch cp')).toEqual([]);
});

test('plain lowercase words are not must-keep, so a paraphrase of scope passes', () => {
 expect(missingTokens('PM gate waived', 'PM gate')).toEqual([]);
 expect(missingTokens('Stay in scope.', 'Stay in range.')).toEqual([]);
 expect(missingTokens('gatefoge must never push', 'Gateforge must never push')).toEqual([]);
});

test('the first word of a sentence is not a name', () => {
 expect(missingTokens('Stream B runs. Push.', 'Lane B runs. Push.')).toEqual([]);
});
