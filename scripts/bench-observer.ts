import { appendFileSync, mkdirSync, writeFileSync, unlinkSync, promises as fs } from 'node:fs';
import type { FileHandle } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ExtensionAPI, ExtensionContext } from '@oh-my-pi/pi-coding-agent';
import { lookup } from '@oh-my-pi/pi-coding-agent/config/registry';
import { record } from '../src/cache.ts';
import { requestComposition } from '../src/measurement.ts';

/** Passive native-mode observer for matched benchmark runs. Native runs load only this extension (discovery off and
 * no OptChat flag/env, so a globally installed OptChat cannot activate); it records the request composition of every
 * native wire request in the shared measurement contract's row format via the pure `requestComposition` classifier
 * (no `view` argument: native payloads carry no chat view) and dumps each payload, without ever returning a
 * replacement, so measurement never changes the comparator. OptChat-mode composition is written by the runtime
 * instrumentation inside src/index.ts; this observer stays silent there (gated on OMP_OPTCHAT_BENCH_DUMP, which only
 * native benchmark runs set). Any <chat> text leaking into a native request is flagged in optchat-leak.jsonl — a
 * matched-mode integrity failure the report surfaces as incomplete. */
export default function benchObserve(pi: ExtensionAPI) {
  let sequence = 0;
  let dumps = 0;
  if (process.env.OMP_OPTCHAT_BENCH_COMPACTION_TOKENS) {
    const threshold = Number(process.env.OMP_OPTCHAT_BENCH_COMPACTION_TOKENS);
    if (!Number.isSafeInteger(threshold) || threshold <= 0) throw Error('Invalid benchmark compaction threshold');
    pi.on('session_start', () => {
      const setting = lookup('compaction.thresholdTokens');
      if (!setting) throw Error('OMP compaction.thresholdTokens is unavailable');
      setting.override(pi.pi.settings, threshold);
    });
  }
  // Bun's compiled request-debug logger may lose a FileHandle before explicitly closing it.
  // Retain handles when used, not by replacing fs.open (compiled imports bind that function early).
  // Benchmark-only: provider options and payloads stay untouched. Needed in BOTH modes whenever PI_REQ_DEBUG is on
  // (OptChat + --wire-debug crashed with "FileHandle closed during garbage collection" when this was native-only).
  if (process.env.PI_REQ_DEBUG === '1') {
    const handles = new Set<FileHandle>();
    let restore = () => {};
    pi.on('session_start', async () => {
      const path = join(tmpdir(), `optchat-handle-probe-${process.pid}-${crypto.randomUUID()}`);
      const sample = await fs.open(path, 'w', 0o600);
      const prototype = Object.getPrototypeOf(sample) as FileHandle;
      await sample.close(); unlinkSync(path);
      const write = prototype.write, writeFile = prototype.writeFile, close = prototype.close;
      prototype.write = function (this: FileHandle, ...args: unknown[]) {
        handles.add(this); return Reflect.apply(write, this, args);
      } as FileHandle['write'];
      prototype.writeFile = function (this: FileHandle, ...args: unknown[]) {
        handles.add(this); return Reflect.apply(writeFile, this, args);
      } as FileHandle['writeFile'];
      prototype.close = async function (this: FileHandle) {
        try { await close.call(this); } finally { handles.delete(this); }
      };
      restore = () => { prototype.write = write; prototype.writeFile = writeFile; prototype.close = close; };
    });
    pi.on('session_shutdown', async () => {
      try { await Promise.all([...handles].map(handle => handle.close())); } finally { restore(); }
    });
  }
  pi.on('before_provider_request', (event, ctx: ExtensionContext) => {
    if (!record(event.payload)) return undefined;
    const payload = event.payload;
    const dump = process.env.OMP_OPTCHAT_BENCH_DUMP;
    if (!dump) return undefined;
    const measure = process.env.OMP_OPTCHAT_MEASURE_DIR;
    if (measure) {
      mkdirSync(measure, { recursive: true, mode: 0o700 });
      const { blocks, totalBytes } = requestComposition(payload);
      let leak = false;
      for (const section of Array.isArray(payload.messages) ? payload.messages : []) {
        if (!record(section) || !Array.isArray(section.content)) continue;
        for (const block of section.content) {
          if (record(block) && block.type === 'text' && typeof block.text === 'string' && block.text.includes('<chat>')) leak = true;
        }
      }
      const row = {
        schema: 1, type: 'request', id: crypto.randomUUID(), timestamp: new Date().toISOString(),
        purpose: 'main', provider: ctx.model?.provider, model: ctx.model?.id, blocks, totalBytes,
        tokenEstimateMethod: 'utf8-bytes/4', leak,
      };
      appendFileSync(join(measure, 'request-composition.jsonl'), JSON.stringify(row) + '\n');
      if (leak) appendFileSync(join(measure, 'optchat-leak.jsonl'), JSON.stringify({ timestamp: row.timestamp, seq: ++sequence }) + '\n');
    }
    mkdirSync(dump, { recursive: true, mode: 0o700 });
    writeFileSync(join(dump, `${String(++dumps).padStart(6, '0')}-native-${ctx.agent.kind}.json`), JSON.stringify(payload, null, 2), { mode: 0o600 });
    // Passive by contract: never a replacement payload.
    return undefined;
  });
}
