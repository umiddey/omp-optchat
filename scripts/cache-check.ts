import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { record } from '../src/cache.ts';
import { compare, sequence, type Block } from '../src/cache-analysis.ts';
const [dir, session] = process.argv.slice(2);
if (!dir) throw new Error('Usage: bun scripts/cache-check.ts <dumpDir> [sessionJsonl]');
const files = readdirSync(dir).filter(name => /^\d+-main\.json$/.test(name)).sort();
const usages: { input: number; cacheRead: number; cacheWrite: number }[] = [];
if (session) for (const line of readFileSync(session, 'utf8').split('\n').filter(Boolean)) {
  const entry: unknown = JSON.parse(line);
  if (!record(entry) || entry.type !== 'message' || !record(entry.message) || entry.message.role !== 'assistant' || !record(entry.message.usage)) continue;
  const u = entry.message.usage;
  if (typeof u.input === 'number' && typeof u.cacheRead === 'number' && typeof u.cacheWrite === 'number') usages.push({ input: u.input, cacheRead: u.cacheRead, cacheWrite: u.cacheWrite });
}
let previous: Block[] = [], previousView = '', turn = 0, breaks = 0, failedShares = 0;
console.log('| Request | Turn | Blocks | Shared prefix | Reusable mark | Predicted share | Input | Cache read | Cache write | Real share | Prefix event |');
console.log('|---|---:|---:|---:|---|---:|---:|---:|---:|---:|---|');
for (const [i, file] of files.entries()) {
  const payload: unknown = JSON.parse(readFileSync(join(dir, file), 'utf8'));
  const blocks = sequence(payload);
  const view = blocks.filter(b => b.view).map(b => b.bytes).join('\n');
  const newTurn = !previous.length || previousView !== view;
  if (newTurn) turn++;
  const result = compare(previous, blocks);
  const lastWhole = previous.findLastIndex(b => b.whole);
  const oldViewBytes = previous.filter(b => b.view).reduce((s, b) => s + Buffer.byteLength(b.bytes), 0);
  const newViewBytes = blocks.filter(b => b.view).reduce((s, b) => s + Buffer.byteLength(b.bytes), 0);
  const batch = newTurn && oldViewBytes > 128000 && newViewBytes <= oldViewBytes * 0.6;
  const broken = previous.length > 0 && (newTurn ? result.prefix <= lastWhole : result.prefix < previous.length);
  if (broken && !batch) breaks++;
  const usage = usages[i], total = usage ? usage.input + usage.cacheRead + usage.cacheWrite : 0;
  const share = total && usage ? usage.cacheRead / total : undefined;
  if (turn >= 2 && !batch && (share === undefined || share < 0.85)) failedShares++;
  console.log(`| ${file} | ${turn} | ${blocks.length} | ${result.prefix} | ${result.reusable ? 'yes' : 'no'} | ${result.share.toFixed(4)} | ${usage?.input ?? '—'} | ${usage?.cacheRead ?? '—'} | ${usage?.cacheWrite ?? '—'} | ${share?.toFixed(4) ?? '—'} | ${batch ? 'batch' : broken ? 'UNEXPECTED BREAK' : i ? 'stable' : 'cold'} |`);
  previous = blocks; previousView = view;
}
console.log(`\nRequests: ${files.length}; turns: ${turn}; unexpected prefix breaks: ${breaks}; real-share failures (turn >=2, excluding post-batch): ${failedShares}; usage rows: ${usages.length}.`);
if (breaks || (session && (usages.length !== files.length || failedShares))) process.exitCode = 1;
