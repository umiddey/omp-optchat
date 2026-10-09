import { test, setSystemTime } from 'bun:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Memory, type Compression } from '../src/memory.ts';
test('a day file that another process created first is caught, and an ordinary midnight rollover is not', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'optchat-test-')), compress = async () => 'summary';
  setSystemTime(new Date(2026, 0, 1, 23, 59));
  const opened: Memory[] = [];
  try {
    const lone = new Memory(dir, compress, () => {}); opened.push(lone);
    lone.append('user', 'before midnight');
    setSystemTime(new Date(2026, 0, 2, 0, 1).getTime());
    lone.append('user', 'after midnight');
    const a = new Memory(dir, compress, () => {}), b = new Memory(dir, compress, () => {}); opened.push(a, b);
    setSystemTime(new Date(2026, 0, 3, 0, 1).getTime());
    b.append('user', 'b on the third');
    assert.throws(() => a.append('user', 'a on the third'), /Another process wrote .*2026-01-03\.jsonl/);
    b.append('user', 'b again');
  } finally { setSystemTime(); await Promise.all(opened.map(m => m.close())); }
  const reopened = new Memory(dir, compress, () => {});
  try { assert.deepEqual(reopened.root.map(e => e.text), ['before midnight', 'after midnight', 'b on the third', 'b again']); }
  finally { await reopened.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('a second writer whose first write starts a new day file is refused when the other wrote an older day file', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'optchat-test-')), compress = async () => 'summary';
  setSystemTime(new Date(2026, 0, 1, 12));
  const opened: Memory[] = [];
  try {
    const a = new Memory(dir, compress, () => {}), b = new Memory(dir, compress, () => {}); opened.push(a, b);
    a.append('user', 'a on the first');
    setSystemTime(new Date(2026, 0, 2, 12).getTime());
    assert.throws(() => b.append('user', 'b on the second'), /Another process wrote .*2026-01-02\.jsonl.*nothing was written/);
    assert.equal(b.root.length, 0);
  } finally { setSystemTime(); await Promise.all(opened.map(m => m.close())); }
  const reopened = new Memory(dir, compress, () => {});
  try { assert.deepEqual(reopened.root.map(e => e.text), ['a on the first']); }
  finally { await reopened.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('a summary sees the built lines after one still being built, such as an echo\'s own tool call', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'optchat-gaps-'));
  const calls: { input: Compression; release: () => void }[] = [];
  const memory = new Memory(dir, input => new Promise(resolve => calls.push({ input, release: () => resolve('s'.repeat(300)) })), () => {});
  try {
    memory.append('talk', `reply ${'.'.repeat(600)}`);
    memory.append('tool', 'read src/memory.ts');
    memory.append('echo', `contents ${'.'.repeat(600)}`);
    await new Promise(resolve => setTimeout(resolve, 20));
    const echo = calls.find(c => c.input.part.i === 2)!.input.context;
    assert.match(echo, /^0\+1\|\(not summarized yet: zoom it\)$/m);
    assert.match(echo, /^1\+1\|tool: read src\/memory\.ts$/m);
  } finally { calls.forEach(c => c.release()); await memory.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('a log whose day files sort against the order of the entries still opens, and a broken one does not', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'optchat-order-')), compress = async () => 'summary';
  const home = process.env.TZ;
  setSystemTime(Date.parse('2026-10-05T17:00:00Z'));
  const opened: Memory[] = [];
  try {
    process.env.TZ = 'Asia/Tokyo';
    let memory = new Memory(dir, compress, () => {}); opened.push(memory);
    memory.append('user', 'a'); memory.append('user', 'b'); await memory.close();
    process.env.TZ = 'America/Sao_Paulo';
    memory = new Memory(dir, compress, () => {}); opened.push(memory);
    memory.append('user', 'c'); await memory.close();
    assert.deepEqual(readdirSync(join(dir, 'main')).sort(), ['2026-10-05.jsonl', '2026-10-06.jsonl']);
    memory = new Memory(dir, compress, () => {}); opened.push(memory);
    assert.deepEqual(memory.root.map(e => e.text), ['a', 'b', 'c']);
    await memory.close();
  } finally {
    setSystemTime();
    if (home === undefined) delete process.env.TZ; else process.env.TZ = home;
    await Promise.all(opened.map(m => m.close()));
  }
  const entry = (i: number) => JSON.stringify({ i, kind: 'user', text: `m${i}`, date: new Date().toISOString() }) + '\n';
  try {
    writeFileSync(join(dir, 'main', '2026-10-05.jsonl'), entry(2) + entry(2));
    assert.throws(() => new Memory(dir, compress, () => {}), /noncontiguous/);
    writeFileSync(join(dir, 'main', '2026-10-05.jsonl'), entry(2));
    writeFileSync(join(dir, 'main', '2026-10-06.jsonl'), entry(0) + entry(3));
    assert.throws(() => new Memory(dir, compress, () => {}), /noncontiguous/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
