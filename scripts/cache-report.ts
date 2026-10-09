// Prompt-cache report for one OMP session: the main agent and every subagent, any provider.
// Reads the usage OMP records per model call (input / cacheRead / cacheWrite), so it shows what the provider billed.
// Usage: bun scripts/cache-report.ts [session.jsonl | session dir | cwd]   (default: newest session of the cwd)
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { homedir } from 'node:os';

const LOW = 0.8;
interface Call { model: string; input: number; read: number; write: number; at: number; events: string[] }
interface Usage { input?: number; cacheRead?: number; cacheWrite?: number }
interface Assistant { role?: string; provider?: string; model?: string; usage?: Usage; timestamp?: number }

function sessionFile(arg: string | undefined): string {
  const target = resolve(arg ?? process.cwd());
  if (target.endsWith('.jsonl') && existsSync(target)) return target;
  if (existsSync(`${target}.jsonl`)) return `${target}.jsonl`;
  const slug = '-' + target.replace(/^\//, '').replace(/[/.]/g, '-');
  const dir = join(homedir(), '.omp/agent/sessions', slug);
  if (!existsSync(dir)) throw new Error(`No OMP sessions for ${target} (looked in ${dir})`);
  const newest = readdirSync(dir).filter(f => f.endsWith('.jsonl')).map(f => join(dir, f))
    .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)[0];
  if (!newest) throw new Error(`No session files in ${dir}`);
  return newest;
}
function calls(file: string): Call[] {
  const out: Call[] = [];
  // OMP session events between two model calls that legitimately change the cached prefix.
  let events = new Set<string>();
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    if (!line) continue;
    let entry: { type?: string; message?: Assistant; timestamp?: string };
    try { entry = JSON.parse(line); } catch { continue; }
    const m = entry.message;
    if (entry.type !== 'message' || m?.role !== 'assistant' || !m.usage) {
      if (entry.type === 'compaction' || entry.type === 'thinking_level_change' || entry.type === 'branch_summary') events.add(entry.type);
      continue;
    }
    const input = m.usage.input ?? 0, read = m.usage.cacheRead ?? 0, write = m.usage.cacheWrite ?? 0;
    if (input + read + write === 0) continue; // aborted before the provider answered
    out.push({ model: `${m.provider}/${m.model}`, input, read, write, at: m.timestamp ?? Date.parse(entry.timestamp ?? ''), events: [...events] });
    events = new Set();
  }
  return out;
}

const share = (c: Pick<Call, 'input' | 'read' | 'write'>) => c.read / Math.max(1, c.input + c.read + c.write);
const pct = (x: number) => `${(100 * x).toFixed(1)}%`;

function report(name: string, list: Call[]) {
  if (!list.length) return;
  const models = [...new Set(list.map(c => c.model))];
  const total = list.reduce((s, c) => ({ input: s.input + c.input, read: s.read + c.read, write: s.write + c.write }), { input: 0, read: 0, write: 0 });
  const warm = list.slice(1).reduce((s, c) => ({ input: s.input + c.input, read: s.read + c.read, write: s.write + c.write }), { input: 0, read: 0, write: 0 });
  // A miss is explained by a model switch, an OMP event that rewrites the prefix (compaction, thinking-level change,
  // branch), or a pause longer than the shortest cache lifetime (5 min). Anything else is a real leak.
  const misses = list.flatMap((c, i) => {
    if (i === 0 || share(c) >= LOW) return [];
    const gap = (c.at - list[i - 1].at) / 1000;
    const why = c.model !== list[i - 1].model ? 'model switch' : c.events.length ? c.events.join(', ') : gap > 300 ? `pause ${Math.round(gap / 60)} min` : 'UNEXPLAINED';
    return [`    call ${i + 1}: ${pct(share(c))} read (${c.read} read / ${c.write} written / ${c.input} uncached) — ${why}`];
  });
  const unexplained = misses.filter(m => m.endsWith('UNEXPLAINED')).length;
  console.log(`${unexplained ? '✗' : '✓'} ${name.padEnd(28)} ${models.join(', ')}`);
  console.log(`    ${list.length} calls · overall ${pct(share(total))} from cache · after the first call ${pct(share(warm))} · misses below ${pct(LOW)}: ${misses.length} (unexplained ${unexplained})`);
  for (const line of misses) console.log(line);
}

const main = sessionFile(process.argv[2]);
console.log(`Session ${main}\n`);
report('main', calls(main));
const children = main.replace(/\.jsonl$/, '');
if (existsSync(children) && statSync(children).isDirectory())
  for (const file of readdirSync(children).filter(f => f.endsWith('.jsonl')).sort()) report(basename(file, '.jsonl'), calls(join(children, file)));
