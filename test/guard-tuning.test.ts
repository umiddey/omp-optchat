import { describe, expect, test } from 'bun:test';
import { missingTokens } from '../src/orders.ts';
import { EXTRACT_ORDERS, MIGRATE_LEDGER, CONSOLIDATE_ORDERS } from '../src/prompts.ts';

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
 expect(missingTokens('Raise PR', 'Raise MRs.')).toEqual(['PR', 'invented MRs']);
});

describe('dictation capitals are not names', () => {
  test('a mid-sentence stoplist word is not a must-keep name', () => {
    expect(missingTokens('ship it, Okay then', 'ship it then')).toEqual([]);
  });
  test('a one-letter capital is not a must-keep name', () => {
    expect(missingTokens('tell them I agree', 'tell them agree')).toEqual([]);
  });
});

describe('context-corroborated names', () => {
 test('an ordinary dictation capital without corroboration is not a name', () => {
  expect(missingTokens('behind some Place', 'behind a location')).toEqual([]);
 });
 test('capitalized names corroborated by context remain guarded', () => {
  for (const name of ['Gateforge', 'Tailscale', 'Sol', 'Rappov'])
   expect(missingTokens(`send to ${name}`, 'send there', `Ask ${name} for help`)).toEqual([name]);
 });
 test('CamelCase names remain guarded without corroboration', () => {
  expect(missingTokens('ask AutomataDore', 'ask someone')).toEqual(['AutomataDore']);
 });
});
test('acronym plurals normalize in either direction, not to another acronym', () => {
 expect(missingTokens('watch CPUs', 'watch CPU')).toEqual([]);
 expect(missingTokens('watch CPUs', 'watch GPUs')).toEqual(['CPUs', 'invented GPUs']);
});
test('opening punctuation and line starts make ordinary capitals sentence-initial', () => {
 for (const source of ['(chosen: Skip it by default)', 'chosen: "Skip it by default"', 'chosen:\nSkip it by default'])
  expect(missingTokens(source, 'chosen: omit it by default', 'Skip was mentioned')).toEqual([]);
});
test('all negations share one hard-token group without permitting loss of negation', () => {
 const negations = ['not', "don't", 'no', 'never', 'none', 'nobody', 'nothing', 'neither', 'nor', 'without', 'cannot'];
 for (const old of negations) {
  for (const next of negations) expect(missingTokens(`${old} push`, `${next} push`)).toEqual([]);
  expect(missingTokens(`${old} push`, 'push').length).toBeGreaterThan(0);
 }
});
