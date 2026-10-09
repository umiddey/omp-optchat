import { test } from 'bun:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { z, Settings } from '@oh-my-pi/pi-coding-agent';
import type { ExtensionAPI, ExtensionContext } from '@oh-my-pi/pi-coding-agent';
import optchat from '../src/index.ts';
import { WELCOME } from '../src/config.ts';

type Hook = (event: object, ctx: ExtensionContext) => unknown;
function plainSession(home: string) {
  const hooks = new Map<string, Hook>(), notes: [string, string][] = [];
  const api = {
    zod: z, registerFlag: () => {}, registerTool: () => {}, getFlag: () => undefined,
    pi: { settings: Settings.isolated() }, getActiveTools: () => [], setActiveTools: () => {},
    on: (name: string, handler: unknown) => hooks.set(name, handler as Hook),
  } as unknown as ExtensionAPI;
  const ctx = (mode: string, kind = 'main') => ({ agent: { kind }, cwd: home, mode, ui: { notify: (text: string, type: string) => notes.push([type, text]) } }) as unknown as ExtensionContext;
  optchat(api);
  return { start: (mode: string, kind?: string) => hooks.get('session_start')!({}, ctx(mode, kind)), notes };
}

test('plain OMP shows the install hint once, only in the main TUI session, and never fails on a broken home', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'optchat-welcome-')), saved = { home: process.env.OMP_OPTCHAT_HOME, env: process.env.OMP_OPTCHAT, code: process.env.OMPCODE };
  // Run as a user's own terminal would: OMP marks the shells it spawns (this test may run in one) with OMPCODE=1.
  delete process.env.OMP_OPTCHAT; delete process.env.OMPCODE;
  try {
    process.env.OMP_OPTCHAT_HOME = join(dir, 'home');
    const s = plainSession(dir);
    await s.start('print'); await s.start('tui', 'sub');
    assert.deepEqual(s.notes, [], 'no hint outside the main interactive session');
    await s.start('tui'); await s.start('tui');
    assert.deepEqual(s.notes, [['info', WELCOME]], 'shown exactly once');
    assert.deepEqual(plainSession(dir).notes, []);
    const again = plainSession(dir); await again.start('tui');
    assert.deepEqual(again.notes, [], 'a later OMP start does not repeat it');

    const locked = join(dir, 'locked'); process.env.OMP_OPTCHAT_HOME = join(locked, 'home');
    mkdirSync(locked); chmodSync(locked, 0o500);
    const broken = plainSession(dir); await broken.start('tui');
    assert.deepEqual(broken.notes, []); assert.equal(existsSync(join(locked, 'home')), false);
  } finally {
    if (saved.home === undefined) delete process.env.OMP_OPTCHAT_HOME; else process.env.OMP_OPTCHAT_HOME = saved.home;
    if (saved.env !== undefined) process.env.OMP_OPTCHAT = saved.env;
    if (saved.code !== undefined) process.env.OMPCODE = saved.code;
    if (existsSync(join(dir, 'locked'))) chmodSync(join(dir, 'locked'), 0o700);
    rmSync(dir, { recursive: true, force: true });
  }
});
