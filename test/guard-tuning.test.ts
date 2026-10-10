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
  test('dropping either negation fails the hard-token guard', () => {
    expect(missingTokens('do not push', 'push')).toEqual(['not']);
    expect(missingTokens('no waivers', 'waivers')).toEqual(['no']);
    expect(missingTokens("don't push", 'push')).toEqual(['not']);
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
test('shouted profanity and emphasis are filler, but NEVER remains a condition', () => {
 expect(missingTokens('NEVER FUCKING EVER stop working; WHAT IS THE POINT', 'Never stop working.')).toEqual([]);
 expect(missingTokens('NEVER FUCKING EVER stop working', 'Stop working.')).toEqual(['NEVER']);
});
test('all in a dictation filler is not a quantifier; actual all remains guarded', () => {
 expect(missingTokens('keep it efficient and all that', 'Keep it efficient.')).toEqual([]);
 expect(missingTokens('fix all the endpoints', 'Fix the endpoints.')).toEqual(['all']);
});
test('an acronym plural keeps its name without allowing a different acronym', () => {
 expect(missingTokens('Raise PR', 'Raise PRs.')).toEqual([]);
 expect(missingTokens('Raise PR', 'Raise MRs.')).toEqual(['PR']);
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
