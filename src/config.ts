import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { Effort } from '@oh-my-pi/pi-ai';
import type { ModelChoice } from './compactor.ts';
import { atomicWrite } from './store.ts';
import { record } from './cache.ts';
/** `memories`: whether OMP's per-turn memory recall (`<memories>`, e.g. Mnemopi) reaches the model in OptChat sessions.
 * Off by default: the view and zoom are the memory, and recall changes every turn, so it is rewritten at every turn start.
 * `compactorFallbacks`: summarizer providers tried in order when the primary is quota-blocked or down; `[]` disables failover. */
export const defaults: { compactor: ModelChoice; compactorFallbacks: ModelChoice[]; runLimit: number; memories: boolean } = {
  compactor: { provider: 'anthropic', model: 'claude-haiku-5-5', thinking: Effort.Medium },
  // Efforts must be ones each provider supports (OMP rejects unsupported ones): GLM takes low/high/max, hence high.
  compactorFallbacks: [
    { provider: 'zai', model: 'glm-5.3-flash', thinking: Effort.High },
    { provider: 'google-antigravity', model: 'gemini-3.8-flash', thinking: Effort.Medium },
    { provider: 'cursor', model: 'claude-haiku-5-5', thinking: Effort.Medium },
  ],
  runLimit: 256000, memories: false,
};
const home = () => resolve(process.env.OMP_OPTCHAT_HOME ?? join(homedir(), '.omp', 'optchat'));
export function profilePath(name: string) {
  if (!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(name)) throw new Error('Profile names: 1–64 lowercase letters, digits, hyphens, or underscores.');
  return join(home(), name);
}
export const WELCOME = 'OptChat is installed but off. Start it with `omp --optchat main`, or add `export OMP_OPTCHAT=main` to your shell profile to make it the default.';
/** True exactly once per OptChat home: the first call leaves a marker, so the install hint never repeats. */
export function firstRun() {
  const marker = join(home(), '.welcomed');
  if (existsSync(marker)) return false;
  atomicWrite(marker, new Date().toISOString() + '\n');
  return true;
}
/** OMP's supported effort strings; the whitelist the primary compactor and every fallback entry validate against. */
const EFFORTS = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];
export function loadConfig(dir: string): typeof defaults {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = join(dir, 'config.json');
  if (!existsSync(file)) atomicWrite(file, JSON.stringify(defaults, null, 2) + '\n');
  const value: unknown = JSON.parse(readFileSync(file, 'utf8'));
  const choice = record(value) ? value.compactor : undefined;
  if (!record(choice) || typeof choice.provider !== 'string' || typeof choice.model !== 'string'
    || !EFFORTS.includes(String(choice.thinking))) throw new Error(`Invalid compactor configuration: ${file}`);
  const runLimit = record(value) && value.runLimit !== undefined ? value.runLimit : defaults.runLimit;
  if (typeof runLimit !== 'number' || !Number.isSafeInteger(runLimit) || runLimit <= 0)
    throw new Error(`Invalid runLimit configuration (expected positive integer UTF-8 bytes): ${file}`);
  const memories = record(value) && value.memories !== undefined ? value.memories : defaults.memories;
  if (typeof memories !== 'boolean') throw new Error(`Invalid memories configuration (expected true or false): ${file}`);
  // Absent field inherits the default chain; an explicit [] yields no fallbacks (failover off).
  const raw = record(value) && value.compactorFallbacks !== undefined ? value.compactorFallbacks : defaults.compactorFallbacks;
  if (!Array.isArray(raw)) throw new Error(`Invalid compactorFallbacks configuration (expected an array of {provider, model, thinking} entries): ${file}`);
  const compactorFallbacks = raw.map(entry => {
    if (!record(entry) || typeof entry.provider !== 'string' || typeof entry.model !== 'string'
      || !EFFORTS.includes(String(entry.thinking))) throw new Error(`Invalid compactorFallbacks configuration (expected an array of {provider, model, thinking} entries): ${file}`);
    return { provider: entry.provider, model: entry.model, thinking: entry.thinking as ModelChoice['thinking'] };
  });
  // The enums were validated against OMP's supported effort strings above.
  return { compactor: { provider: choice.provider, model: choice.model, thinking: choice.thinking as ModelChoice['thinking'] }, compactorFallbacks, runLimit, memories };
}
