import { describe, expect, test } from 'bun:test';
import { missingTokens } from '../src/orders.ts';

describe('must-keep condition words and negation', () => {
  test('not is satisfied by n\'t', () => {
    expect(missingTokens('do not run it', "don't run it")).toEqual([]);
  });
  test('not is satisfied by never and no', () => {
    expect(missingTokens('do not run it', 'never run it')).toEqual([]);
    expect(missingTokens('do not run it', 'no running')).toEqual([]);
  });
  test('no is satisfied by zero, 0, none and without', () => {
    expect(missingTokens('no CLI', 'zero CLI')).toEqual([]);
    expect(missingTokens('no CLI', 'there is 0 CLI')).toEqual([]);
    expect(missingTokens('no CLI', 'none of the CLI')).toEqual([]);
    expect(missingTokens('no CLI', 'without any CLI')).toEqual([]);
  });
  test('any is not a must-keep word', () => {
    expect(missingTokens('there are any problems', 'there are problems')).toEqual([]);
  });
  test('a condition word still must be kept', () => {
    expect(missingTokens('every repo gets it', 'some repos get it')).toEqual(['every']);
  });
});

describe('shouted words are not acronyms', () => {
  test('YOU HAVE TO is not must-keep', () => {
    expect(missingTokens('YOU HAVE TO fix them', 'fix them')).toEqual([]);
  });
  test('a shouted condition word is still checked as a condition word', () => {
    expect(missingTokens('NEVER push it', 'push it')).toEqual(['NEVER']);
  });
});

describe('dictation capitals are not names', () => {
  test('a mid-sentence stoplist word is not a must-keep name', () => {
    expect(missingTokens('ship it, Okay then', 'ship it then')).toEqual([]);
  });
  test('a one-letter capital is not a must-keep name', () => {
    expect(missingTokens('tell them I agree', 'tell them agree')).toEqual([]);
  });
});

describe('resolved names', () => {
  test('a missing name is allowed when the restatement has a capitalised context word for it', () => {
    expect(missingTokens('send to Rappov now', 'send to Gateforge now', 'we talk about Gateforge')).toEqual([]);
  });
  test('a restatement word not in the context does not resolve a name', () => {
    expect(missingTokens('send to Rappov now', 'send to Gateforge now', 'nothing here')).toEqual(['Rappov']);
  });
  test('at most one resolved name per missing name', () => {
    expect(missingTokens('send to Rappov and Brendon', 'send to Gateforge now', 'Gateforge and Brendon')).toEqual(['Brendon']);
  });
});
