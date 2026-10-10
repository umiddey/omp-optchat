import { test } from 'bun:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { COMPACT, OPTCHAT_PROMPT } from '../src/prompts.ts';
import { loadConfig } from '../src/config.ts';
import { Memory } from '../src/memory.ts';

test('compactor equals recipe §5; turn adds only the deliberate standing-orders extension', () => {
  const recipe = readFileSync(new URL('./fixtures/recipe-prompt.txt', import.meta.url), 'utf8').trimEnd();
  assert.equal(COMPACT, recipe);
  assert.equal(OPTCHAT_PROMPT, recipe + `\n\n<orders> holds the user's standing orders in their own words. They stay in force until the user changes them and override any summary that says otherwise. Use zoom(id, 1) for context.`);
});
test('new profiles default to xhigh and existing explicit effort is unchanged', () => {
  const dir = mkdtempSync(join(tmpdir(), 'optchat-recipe-config-'));
  try {
    assert.equal(loadConfig(dir).compactor.thinking, 'xhigh');
    writeFileSync(join(dir, 'config.json'), JSON.stringify({ compactor: { provider: 'anthropic', model: 'claude-haiku-5-5', thinking: 'medium' } }));
    assert.equal(loadConfig(dir).compactor.thinking, 'medium');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
test('non-tool long texts split losslessly into consecutive messages, without splitting surrogate pairs', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'optchat-recipe-split-'));
  const memory = new Memory(dir, async () => 'summary', () => {});
  const text = 'a'.repeat(29999) + '😀' + 'z'.repeat(31000);
  try {
    memory.append('user', text, '2026-10-10T00:00:00Z');
    assert.equal(memory.root.length, 3);
    assert.equal(memory.root.map(e => e.text).join(''), text);
    assert.ok(memory.root.every(e => e.text.length <= 30000 && e.kind === 'user' && e.date === '2026-10-10T00:00:00Z'));
    assert.ok(!memory.root.some(e => /[\ud800-\udbff]$/.test(e.text) || /^[\udc00-\udfff]/.test(e.text)));
    assert.equal(memory.zoom(0, 1).includes('a'.repeat(100)), true);
  } finally { await memory.close(); rmSync(dir, { recursive: true, force: true }); }
});
