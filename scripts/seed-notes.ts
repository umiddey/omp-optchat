import { Memory } from '../src/memory.ts';
import { loadConfig, profilePath } from '../src/config.ts';
import { lockProfile } from '../src/profiles.ts';
const [profile, countText = '200'] = process.argv.slice(2);
const count = Number(countText);
if (!profile || !Number.isSafeInteger(count) || count < 0) throw new Error('Usage: bun scripts/seed-notes.ts <profile> [N=200]');
const dir = profilePath(profile); loadConfig(dir);
const release = await lockProfile(dir, `seed-notes PID ${process.pid}`);
const memory = await Memory.open(dir, async () => { throw new Error('Seed mode: model compaction is intentionally unavailable.'); }, () => {});
try {
  for (let i = 0; i < count; i++) memory.append('note', `Seed note ${i}: keep decisions exact; use zoom for original evidence.`);
  await memory.settle();
  console.log(JSON.stringify({ directory: dir, appended: count, messages: memory.root.length, viewBytes: memory.size, nodes: memory.tree.size }));
} finally { await memory.close(); await release(); }
