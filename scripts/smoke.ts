import { appendFileSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { record } from '../src/cache.ts';
const root = '/home/ukd/projects/omp-optchat';
const dir = process.argv[2];
if (!dir || process.env.OMP_OPTCHAT_HOME !== '/tmp/optchat-smoke') throw new Error('Usage: OMP_OPTCHAT_HOME=/tmp/optchat-smoke bun scripts/smoke.ts <dumpDir>');
mkdirSync(dir, { recursive: true });
const env = { ...process.env, OMP_OPTCHAT_DUMP_DIR: dir };
const rpc = Bun.spawn(['omp', '--mode', 'rpc', '--no-ui', '--no-title', '-e', join(root, 'src/index.ts'), '--optchat', 'smoke'], { cwd: root, env, stdin: 'pipe', stdout: 'pipe', stderr: Bun.file(join(dir, 'rpc.stderr.log')) });
let pending = '', stopped = false;
const waiters = new Map<string, { resolve: (frame: Record<string, unknown>) => void; reject: (error: Error) => void }>();
const reader = (async () => {
  for await (const data of rpc.stdout) {
    const text = Buffer.from(data).toString(); appendFileSync(join(dir, 'rpc.jsonl'), text); pending += text;
    for (let at = pending.indexOf('\n'); at >= 0; at = pending.indexOf('\n')) {
      const line = pending.slice(0, at); pending = pending.slice(at + 1);
      if (!line) continue;
      let frame: unknown; try { frame = JSON.parse(line); } catch { continue; }
      if (!record(frame)) continue;
      if (frame.type === 'extension_error') console.error(JSON.stringify(frame));
      const key = frame.type === 'ready' ? 'ready' : frame.type === 'prompt_result' ? String(frame.id) : undefined;
      if (key && waiters.has(key)) { waiters.get(key)!.resolve(frame); waiters.delete(key); }
      if (frame.type === 'response' && frame.success === false && typeof frame.id === 'string' && waiters.has(frame.id)) { waiters.get(frame.id)!.reject(new Error(JSON.stringify(frame))); waiters.delete(frame.id); }
    }
  }
  stopped = true;
  for (const waiter of waiters.values()) waiter.reject(new Error('RPC exited before completion'));
})();
function next(key: string, timeout = 240000) {
  if (stopped) throw new Error('RPC already exited');
  return new Promise<Record<string, unknown>>((resolve, reject) => {
    const timer = setTimeout(() => { waiters.delete(key); reject(new Error(`Timeout waiting for ${key}`)); }, timeout);
    waiters.set(key, { resolve: frame => { clearTimeout(timer); resolve(frame); }, reject: error => { clearTimeout(timer); reject(error); } });
  });
}
async function prompt(id: string, message: string) {
  const result = next(id); rpc.stdin.write(JSON.stringify({ id, type: 'prompt', message }) + '\n'); rpc.stdin.flush();
  const frame = await result; console.log(JSON.stringify({ id, result: frame }));
  if (frame.status === 'error' || frame.error) throw new Error(JSON.stringify(frame));
}
try {
  await next('ready');
  // The RPC owner stays alive while the competing process attempts the same profile.
  const refused = Bun.spawn(['omp', '-p', '--no-title', '-e', join(root, 'src/index.ts'), '--optchat', 'smoke', 'Reply only LOCK_TEST.'], { cwd: root, env: { ...env, OMP_OPTCHAT_DUMP_DIR: join(dir, 'refused') }, stdout: 'pipe', stderr: 'pipe' });
  const out = await new Response(refused.stdout).text(), err = await new Response(refused.stderr).text(), exit = await refused.exited;
  writeFileSync(join(dir, 'lock-refusal.log'), JSON.stringify({ exit, out, err }, null, 2));
  if (!(out + err).includes('Profile already running')) throw new Error('Competing profile process was not refused');
  console.log(`Lock refusal: exit ${exit}`);
  await prompt('turn-1', 'Smoke test: reply only READY. Do not use tools.');
  await prompt('turn-2', 'Call zoom with id 0 and n 1, then reply only ZOOM_OK. Do not call any other tool.');
  await prompt('turn-3', 'Call these three tools in order, one after another: date id 0; zoom id 1 n 1; date id 1. Then reply only THREE_TOOLS_OK. No other tools.');
  await prompt('turn-4', 'Reply only FOUR. Do not use any tools.');
  await prompt('turn-5', 'Reply only FIVE. Do not use any tools.');
  rpc.stdin.end(); await reader;
  const rpcExit = await rpc.exited; if (rpcExit !== 0) throw new Error(`RPC exit ${rpcExit}`);
  const plainDir = join(dir, 'plain');
  const plain = Bun.spawn(['omp', '-p', '--no-title', '-e', join(root, 'src/index.ts'), '-e', join(root, 'test/fixtures/observe.ts'), 'Reply only PLAIN_OK. Do not use tools.'], { cwd: root, env: { ...process.env, OMP_OPTCHAT: '', OMP_OPTCHAT_DUMP_DIR: '', OPTCHAT_OBSERVER_DIR: plainDir }, stdout: 'pipe', stderr: 'pipe' });
  const plainOut = await new Response(plain.stdout).text(), plainErr = await new Response(plain.stderr).text(), plainExit = await plain.exited;
  writeFileSync(join(dir, 'plain.log'), JSON.stringify({ exit: plainExit, out: plainOut, err: plainErr }, null, 2));
  if (plainExit !== 0) throw new Error(`Plain OMP exit ${plainExit}`);
  for (const file of readdirSync(plainDir)) if (readFileSync(join(plainDir, file), 'utf8').includes('<chat>')) throw new Error('Inactive extension injected chat');
  console.log('Plain context: no <chat>; smoke complete.');
} finally { if (!stopped) { rpc.stdin.end(); rpc.kill(); await rpc.exited; } }
