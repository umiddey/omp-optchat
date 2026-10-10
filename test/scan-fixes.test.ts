import { describe, expect, test } from 'bun:test';
import { orderMap } from '../src/orders.ts';
import { compaction } from '../src/prompts.ts';

describe('a scan reply that names an id it was not asked for', () => {
  test('keeps the asked-for orders and ignores the extra id', () => {
    const found = orderMap({ '1700': [{ retire: ['BANANA'] }], '1704': [{ said: 'x', text: 'y', kind: 'rule' }] }, [1700]);
    expect([...found.keys()]).toEqual([1700]);
    expect(found.get(1700)).toEqual([{ retire: ['BANANA'] }]);
  });
});

describe('the scan task keeps order words out of the summary line', () => {
  const part = { l: 1, i: 851 };
  test('the line instruction is byte-identical with and without a scan', () => {
    const plain = compaction({ source: 'S', part });
    expect(compaction({ source: 'S', part, scan: [1700] }).startsWith(plain)).toBe(true);
  });
  test('the scan section forbids order words in the line', () => {
    const scanned = compaction({ source: 'S', part, scan: [1700] });
    expect(scanned).toContain('do not use the words standing, one-off, retire, rule or goal in it');
    expect(scanned.indexOf('do not use the words')).toBeLessThan(scanned.indexOf('ORDERS:'));
  });
});
