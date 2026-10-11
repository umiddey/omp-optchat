import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { Usage } from '@oh-my-pi/pi-ai';
import { calculateCost } from '@oh-my-pi/pi-catalog/models';
import { ModelRegistry, Settings, discoverAuthStorage } from '@oh-my-pi/pi-coding-agent';
import { buildRunReport, compareRuns, parseCompositionLog, parseSession, parseUsageLog,
  sessionExchanges, type RunComparison, type RunReport, type SessionExchange } from './bench-report.ts';
import { record } from '../src/cache.ts';

/** Matched native-OMP vs OptChat benchmark. Both modes run the identical matched workload (same turns, main model,
 * fresh identical empty cwd, fresh per-run OptChat home, identical tool environment) as isolated one-shot RPC
 * sessions; the only delta is the OptChat extension and its compactor. Correctness is actual: per-turn sentinels,
 * factual recall of planted facts, the standing-order obligation (ORCHID in every reply) and a real filesystem
 * artifact both modes must produce identically. Usage: foreground from the session JSONL (purpose-classified
 * model_usage included, active branch only), background from usage.jsonl drained while the process is still running
 * (closing first would abort in-flight calls; pending rows then expose the aborted lifecycle). Native compaction
 * usage — not journaled by OMP — is captured for real via OMP's OTEL export (telemetry.otlpExportEnabled defaults
 * on): a local OTLP/http-json receiver collects the compaction spans' gen_ai.usage counters, so compaction tokens
 * are actual; their USD price stays unreported by the spans and is named as the remaining gap. Smoke runs are
 * labeled "NOT long-context evidence". The optchat-only zoom probe runs as a fully isolated, noncomparative side
 * session (own session dir and measure dir) and never enters the matched totals. */

const ROOT = resolve(import.meta.dir, '..');

interface Check { kind: 'sentinel' | 'recall' | 'order' | 'artifact'; pattern?: string; expect: string }
interface TurnSpec { id: string; prompt: string; checks: Check[] }
interface Workload { name: 'smoke' | 'long'; turns: TurnSpec[]; artifact?: { file: string; content: string; turn: string; expect: string } }

const orderCheck: Check = { kind: 'order', pattern: 'ORCHID', expect: 'standing order: every reply includes ORCHID' };

function smokeWorkload(): Workload {
  const turns: TurnSpec[] = [
    {
      id: 't1',
      prompt: 'Benchmark turn 1 of 4. Two things to remember for later: the bench codeword is FALCON-7, and a standing order: every reply you write from now on must include the word ORCHID somewhere. For this turn reply with the word READY (plus the standing-order word).',
      checks: [{ kind: 'sentinel', pattern: 'READY', expect: 'READY' }, orderCheck],
    },
    {
      id: 't2',
      prompt: 'Benchmark turn 2 of 4. What is the bench codeword I asked you to remember? Reply with the codeword itself (plus the standing-order word), nothing else.',
      checks: [{ kind: 'recall', pattern: 'FALCON-7', expect: 'codeword FALCON-7 recalled' }, orderCheck],
    },
    {
      id: 't3',
      prompt: 'Benchmark turn 3 of 4. Compute 17*23, then create a file named artifact.txt in the current directory whose entire content is exactly the result (that number and nothing else). Reply WROTE_OK (plus the standing-order word).',
      checks: [{ kind: 'sentinel', pattern: 'WROTE_OK', expect: 'WROTE_OK' },
        { kind: 'artifact', expect: 'artifact.txt content == 391' }, orderCheck],
    },
    {
      id: 't4',
      prompt: 'Benchmark turn 4 of 4. Reply BENCH_DONE, and state the bench codeword one more time (plus the standing-order word).',
      checks: [{ kind: 'sentinel', pattern: 'BENCH_DONE', expect: 'BENCH_DONE' },
        { kind: 'recall', pattern: 'FALCON-7', expect: 'codeword FALCON-7 recalled' }, orderCheck],
    },
  ];
  return { name: 'smoke', turns, artifact: { file: 'artifact.txt', content: '391', turn: 't3', expect: 'artifact.txt content == 391' } };
}

/** Long workload: turn k plants FACT_k=FK<k> inside multi-kilobyte padding; every RECALL_EVERY turns the model is
 * asked for an older fact, so rollover/compaction fidelity is checked, not just echo. Final turn recalls the codeword. */
function longWorkload(turnCount: number, padBytes: number, codeword = 'FALCON-7'): Workload {
  const RECALL_EVERY = 6;
  const fact = (k: number) => `FK${String(k).padStart(3, '0')}`;
  const turns: TurnSpec[] = [{
    id: 't1',
    prompt: `Benchmark turn 1. Remember for later: the bench codeword is ${codeword}, and a standing order: every reply must include the word ORCHID somewhere. Reply READY (plus the standing-order word).`,
    checks: [{ kind: 'sentinel', pattern: 'READY', expect: 'READY' }, orderCheck],
  }];
  for (let k = 2; k < turnCount; k++) {
    const padding = Array.from({ length: Math.ceil(padBytes / 200) },
      (_, line) => `PAD_${k}_${line}: benchmark filler for long-context volume; deterministic, no semantic load.`.padEnd(200, '.')).join('\n');
    const recall = k - RECALL_EVERY >= 2
      ? ` Also: at turn ${k - RECALL_EVERY} I gave you FACT_${k - RECALL_EVERY}; append its exact value in the form FACT_OK=<value>.`
      : '';
    const checks: Check[] = [{ kind: 'sentinel', pattern: `ACK${k}`, expect: `ACK${k}` }, orderCheck];
    if (k - RECALL_EVERY >= 2) checks.push({ kind: 'recall', pattern: fact(k - RECALL_EVERY), expect: `FACT_${k - RECALL_EVERY}=${fact(k - RECALL_EVERY)} recalled` });
    turns.push({
      id: `t${k}`,
      prompt: `Benchmark turn ${k}. In this padding I plant FACT_${k} with exact value ${fact(k)}; remember it if asked later.\n${padding}\nReply only ACK${k} (plus the standing-order word).${recall}`,
      checks,
    });
  }
  turns.push({
    id: `t${turnCount}`,
    prompt: `Benchmark final turn. Reply BENCH_DONE and state the bench codeword (plus the standing-order word).`,
    checks: [{ kind: 'sentinel', pattern: 'BENCH_DONE', expect: 'BENCH_DONE' },
      { kind: 'recall', pattern: codeword, expect: `codeword ${codeword} recalled` }, orderCheck],
  });
  return { name: 'long', turns };
}

interface Args {
  mode: 'native' | 'optchat' | 'both'; model?: string; compactor: { provider: string; model: string; thinking: string };
  repetitions: number; out: string; workload: 'smoke' | 'long'; turns: number; runLimit?: number;
  backgroundWaitMs: number; promptTimeoutMs: number; omp: string; wireDebug: boolean; compactionThreshold?: number;
}

function parseArgs(argv: string[]): Args {
  const args: Args = {
    mode: 'both', compactor: { provider: 'anthropic', model: 'claude-haiku-5-5', thinking: 'xhigh' },
    repetitions: 1, out: join('/tmp', `optchat-bench-${new Date().toISOString().replace(/[:.]/g, '-')}`),
    workload: 'smoke', turns: 36, backgroundWaitMs: 120_000, promptTimeoutMs: 300_000, omp: 'omp', wireDebug: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const value = () => { const v = argv[++i]; if (v === undefined) throw new Error(`${argv[i - 1]} needs a value`); return v; };
    if (argv[i] === '--mode') { const m = value(); if (m !== 'native' && m !== 'optchat' && m !== 'both') throw new Error('--mode native|optchat|both'); args.mode = m; }
    else if (argv[i] === '--model') args.model = value();
    else if (argv[i] === '--compactor') { const [provider, model] = value().split('/'); if (!provider || !model) throw new Error('--compactor provider/model'); args.compactor.provider = provider; args.compactor.model = model; }
    else if (argv[i] === '--thinking') args.compactor.thinking = value();
    else if (argv[i] === '--repetitions') args.repetitions = Number(value());
    else if (argv[i] === '--out') args.out = resolve(value());
    else if (argv[i] === '--workload') { const w = value(); if (w !== 'smoke' && w !== 'long') throw new Error('--workload smoke|long'); args.workload = w; }
    else if (argv[i] === '--turns') args.turns = Number(value());
    else if (argv[i] === '--run-limit') args.runLimit = Number(value());
    else if (argv[i] === '--background-wait') args.backgroundWaitMs = Number(value());
    else if (argv[i] === '--prompt-timeout') args.promptTimeoutMs = Number(value());
    else if (argv[i] === '--omp') args.omp = value();
    else if (argv[i] === '--wire-debug') args.wireDebug = true;
    else if (argv[i] === '--compaction-threshold') { const n = Number(value()); if (!Number.isSafeInteger(n) || n <= 0) throw new Error('--compaction-threshold needs a positive integer token count'); args.compactionThreshold = n; }
    else throw new Error(`Unknown flag ${argv[i]}`);
  }
  if (!Number.isSafeInteger(args.repetitions) || args.repetitions < 1) throw new Error('--repetitions must be >= 1');
  if (args.workload === 'long' && (!Number.isSafeInteger(args.turns) || args.turns < 8)) throw new Error('--turns must be >= 8 for the long workload');
  return args;
}

interface RpcFrame extends Record<string, unknown> { type?: string; id?: unknown }

/** One OMP RPC driver, mirroring scripts/smoke.ts: NDJSON frames, waiter map, bounded timeouts. */
class RpcSession {
  private readonly waiters = new Map<string, { resolve: (frame: RpcFrame) => void; reject: (error: Error) => void }>();
  private pending = ''; private stopped = false;
  private readonly reader: Promise<void>;
  constructor(private readonly proc: Bun.Subprocess<'pipe', 'pipe', Bun.BunFile>, private readonly log: string) {
    this.reader = (async () => {
      try {
        for await (const data of proc.stdout) {
          const text = Buffer.from(data).toString();
          appendFileSync(this.log, text);
          this.pending += text;
          for (let at = this.pending.indexOf('\n'); at >= 0; at = this.pending.indexOf('\n')) {
            const line = this.pending.slice(0, at);
            this.pending = this.pending.slice(at + 1);
            if (!line) continue;
            let frame: unknown;
            try { frame = JSON.parse(line); } catch { continue; }
            if (!record(frame)) continue;
            if (frame.type === 'extension_error') console.error(JSON.stringify(frame));
            const key = frame.type === 'ready' ? 'ready' : frame.type === 'prompt_result' ? String(frame.id) : undefined;
            if (key && this.waiters.has(key)) { this.waiters.get(key)!.resolve(frame); this.waiters.delete(key); }
            if (frame.type === 'response' && frame.success === false && typeof frame.id === 'string' && this.waiters.has(frame.id)) {
              this.waiters.get(frame.id)!.reject(new Error(JSON.stringify(frame)));
              this.waiters.delete(frame.id);
            }
          }
        }
      } finally {
        this.stopped = true;
        for (const waiter of this.waiters.values()) waiter.reject(new Error('RPC exited before completion'));
      }
    })();
  }
  next(key: string, timeout: number): Promise<RpcFrame> {
    if (this.stopped) return Promise.reject(new Error('RPC already exited'));
    const { promise, resolve: resolveFrame, reject } = Promise.withResolvers<RpcFrame>();
    const timer = setTimeout(() => { this.waiters.delete(key); reject(new Error(`Timeout waiting for ${key} after ${timeout}ms`)); }, timeout);
    this.waiters.set(key, {
      resolve: frame => { clearTimeout(timer); resolveFrame(frame); },
      reject: error => { clearTimeout(timer); reject(error); },
    });
    return promise;
  }
  async prompt(id: string, message: string, timeout: number) {
    const result = this.next(id, timeout);
    this.proc.stdin.write(JSON.stringify({ id, type: 'prompt', message }) + '\n');
    this.proc.stdin.flush();
    const frame = await result;
    if (frame.status === 'error' || frame.error) throw new Error(JSON.stringify(frame));
  }
  close() { try { this.proc.stdin.end(); } catch { /* already closed */ } }
}

const HANDOFF_TEMPLATE_MARKER = '[What should happen next]';
const SERIALIZED_USER_END = '[user:end]';
const COMPACTION_STOP = 'compaction';
export interface WireUsage { requests: number; input: number; output: number; cacheRead: number; cacheWrite: number; costUsd: number; unpriced: number; noResponse: number }

/** Wire-level capture over pi-ai's request-debug hook (PI_REQ_DEBUG=1 wraps EVERY streamSimple fetch, including
 * native compaction side streams the session journal never records). Native runs only — OptChat background is
 * already instrumented by the measurement module. Each rr-session-N.json request dump is sanitized immediately
 * after parse (its headers carry credentials and are never persisted or published); responses are raw SSE in
 * rr-session-N.res.log, and Anthropic usage comes from message_start + message_delta counters.
 * Classification (validated against real proof artifacts /tmp/optchat-native-compaction-proof):
 * - native/remote compaction: the request body carries the top-level `compaction` directive (seen on every remote
 *   attempt, including ones the provider answers with stop_reason `refusal` and zero usage), or the RESPONSE
 *   stop_reason is `compaction`;
 * - handoff compaction: the request's last user message carries the handoff summary template placeholder
 *   `[What should happen next]` (compaction.ts renders the full conversation into that template);
 * - memory-extractor side calls (no tools, `[user:end]` serialization): journaled by the session as model_usage
 *   (`memory`) — counted separately and EXCLUDED from spend, so token costs are never double counted;
 * - everything else is a main/other wire request, counted only for the wire/session cross-check. */
class ReqDebugCapture {
  private readonly usage: Required<WireUsage> = { requests: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, costUsd: 0, unpriced: 0, noResponse: 0 };
  totalRequests = 0;
  journaledWireRequests = 0;
  constructor(private readonly cwd: string, private readonly registry: import('@oh-my-pi/pi-coding-agent').ModelRegistry | undefined) {}
  /** Sanitize every rr-session dump in the run cwd first (a later pricing/parse failure must never leave credential
   * headers on disk; an unparseable dump is deleted outright), then extract compaction usage. */
  harvest(): Required<WireUsage> {
    const dumps: { requestPath: string; dump: Record<string, unknown> }[] = [];
    for (const name of readdirSync(this.cwd).filter(f => /^rr-session-\d+\.json$/.test(f)).sort()) {
      const requestPath = join(this.cwd, name);
      let parsed: unknown;
      try { parsed = JSON.parse(readFileSync(requestPath, 'utf8')); } catch { parsed = undefined; }
      if (!record(parsed)) { rmSync(requestPath, { force: true }); continue; }
      if (parsed.headers !== undefined) {
        const { headers: _headers, ...sanitized } = parsed;
        writeFileSync(requestPath, JSON.stringify(sanitized, null, 2) + '\n');
      }
      dumps.push({ requestPath, dump: parsed });
    }
    for (const { requestPath, dump } of dumps) {
      this.totalRequests++;
      const bodyText = typeof dump.bodyText === 'string' ? dump.bodyText
        : typeof dump.body === 'string' ? dump.body : undefined;
      const responseLog = requestPath.replace(/\.json$/, '.res.log');
      const response = responseLog && existsSync(responseLog) ? readFileSync(responseLog, 'utf8') : undefined;
      // request-debug stores a JSON body as an object (seen in real dumps), other bodies as text.
      let body: Record<string, unknown> | undefined = record(dump.body) ? dump.body : undefined;
      if (!body && bodyText !== undefined) {
        try {
          const parsedBody: unknown = JSON.parse(bodyText);
          if (record(parsedBody)) body = parsedBody;
        } catch { body = undefined; }
      }
      const kind = this.classify(body, response);
      if (kind === 'main') continue;
      if (kind === 'journaled') { this.journaledWireRequests++; continue; }
      // Never skip a compaction request silently: no response means usage is unavailable, unparseable usage means
      // cost unknown. Both keep the run incomplete.
      if (!response) { this.usage.noResponse++; continue; }
      const usage = parseAnthropicSseUsage(response);
      if (!usage) { this.usage.unpriced++; continue; }
      this.usage.requests++;
      this.usage.input += usage.input; this.usage.output += usage.output;
      this.usage.cacheRead += usage.cacheRead; this.usage.cacheWrite += usage.cacheWrite;
      const modelId = body && typeof body.model === 'string' ? body.model : undefined;
      const slash = modelId ? modelId.indexOf('/') : -1;
      // Anthropic wire bodies carry the bare model id; the endpoint names the provider.
      const provider = slash > 0 ? modelId!.slice(0, slash)
        : typeof dump.url === 'string' && dump.url.startsWith('https://api.anthropic.com/') ? 'anthropic' : undefined;
      const model = this.registry && modelId && provider
        ? this.registry.find(provider, slash > 0 ? modelId.slice(slash + 1) : modelId)
        : undefined;
      if (!model) { this.usage.unpriced++; continue; }
      // calculateCost reads these token counters and fills usage.cost in place (it must exist), returning it.
      // Catalog-priced estimate from the model price table; never a billed-actual dollars claim.
      const priced = {
        input: usage.input, output: usage.output, cacheRead: usage.cacheRead, cacheWrite: usage.cacheWrite,
        totalTokens: usage.input + usage.output + usage.cacheRead + usage.cacheWrite,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      } as unknown as import('@oh-my-pi/pi-ai').Usage;
      const cost = calculateCost(model, priced);
      this.usage.costUsd += typeof cost.total === 'number' ? cost.total : 0;
    }
    return { ...this.usage };
  }

  /** Wire-level call class from the sanitized request body and the raw SSE response. */
  private classify(body: Record<string, unknown> | undefined, response: string | undefined): 'compaction' | 'journaled' | 'main' {
    if (body && body.compaction !== undefined) return 'compaction';
    if (response && /"stop_reason":"compaction"/.test(response)) return 'compaction';
    const lastUser = body && Array.isArray(body.messages)
      ? body.messages.filter(record).filter(message => message.role === 'user').at(-1)
      : undefined;
    const content = lastUser && record(lastUser) ? lastUser.content : undefined;
    const text = typeof content === 'string' ? content
      : Array.isArray(content) ? content.filter(record).map(block => block.type === 'text' && typeof block.text === 'string' ? block.text : '').join('\n') : '';
    if (text.includes(HANDOFF_TEMPLATE_MARKER)) return 'compaction';
    const tools = body && Array.isArray(body.tools) ? body.tools : [];
    if (tools.length === 0 && text.includes(SERIALIZED_USER_END)) return 'journaled';
    return 'main';
  }
}

/** Anthropic SSE usage: message_start carries input/cache counters, the final message_delta carries output_tokens.
 * Native (AnthropicCompaction) responses instead report per-iteration counters in `usage.iterations` with zeroed
 * top-level fields — the real billed tokens are the iteration entries, summed. */
export function parseAnthropicSseUsage(text: string): { input: number; output: number; cacheRead: number; cacheWrite: number } | undefined {
  const num = (value: unknown) => (typeof value === 'number' && Number.isFinite(value) ? value : 0);
  let input = 0, output = 0, cacheRead = 0, cacheWrite = 0, seen = false;
  let iterations: readonly unknown[] | undefined;
  for (const line of text.split('\n')) {
    if (!line.startsWith('data:')) continue;
    const payload = line.slice(5).trim();
    if (!payload || payload === '[DONE]') continue;
    let event: unknown;
    try { event = JSON.parse(payload); } catch { continue; }
    if (!record(event) || event.type !== 'message_start' && event.type !== 'message_delta') continue;
    const message = record(event.message) ? event.message : undefined;
    const usage = record(event.usage) ? event.usage : record(message?.usage) ? message.usage : undefined;
    if (!usage) continue;
    seen = true;
    if (Array.isArray(usage.iterations)) iterations = usage.iterations;
    input += num(usage.input_tokens);
    output = Math.max(output, num(usage.output_tokens));
    cacheRead += num(usage.cache_read_input_tokens);
    cacheWrite += num(usage.cache_creation_input_tokens);
  }
  if (!seen) return undefined;
  if (iterations) {
    input = 0; output = 0; cacheRead = 0; cacheWrite = 0;
    for (const iteration of iterations) {
      if (!record(iteration)) continue;
      input += num(iteration.input_tokens);
      output += num(iteration.output_tokens);
      cacheRead += num(iteration.cache_read_input_tokens);
      cacheWrite += num(iteration.cache_creation_input_tokens);
    }
  }
  return { input, output, cacheRead, cacheWrite };
}
/** Bounded wait for background accounting while the RPC process is STILL RUNNING: poll the usage log until its size
 * is stable, so post-turn compactor/order calls (and their retries) finish before stdin closes. Closing first would
 * abort in-flight calls; if the wait still times out, unmatched start rows surface the aborted lifecycle as pending. */
async function waitForBackground(usageFile: string, deadlineMs: number, stableMs: number) {
  const started = Date.now();
  let lastSize = -1, lastChange = Date.now();
  while (Date.now() - started < deadlineMs) {
    const size = existsSync(usageFile) ? statSync(usageFile).size : 0;
    if (size !== lastSize) { lastSize = size; lastChange = Date.now(); }
    else if (Date.now() - lastChange >= stableMs) return { settled: true, waitedMs: Date.now() - started, bytes: size };
    const { promise, resolve: wake } = Promise.withResolvers<void>();
    setTimeout(wake, 500);
    await promise;
  }
  return { settled: false, waitedMs: Date.now() - started, bytes: lastSize < 0 ? 0 : lastSize };
}

/** The final assistant reply of the turn whose user prompt starts with `promptPrefix`: scan forward from the prompt
 * to the next user boundary and take the last non-empty assistant text inside that span. */
function replyForTurn(exchanges: SessionExchange[], promptPrefix: string): string | undefined {
  const at = exchanges.findIndex(exchange => exchange.role === 'user' && exchange.text.startsWith(promptPrefix));
  if (at < 0) return undefined;
  let reply: string | undefined;
  for (let i = at + 1; i < exchanges.length && exchanges[i].role !== 'user'; i++)
    if (exchanges[i].role === 'assistant' && exchanges[i].text.trim()) reply = exchanges[i].text;
  return reply;
}

interface CorrectnessCheck { turn: string; kind: string; expect: string; pass: boolean; reply?: string }

function evaluateCorrectness(turns: TurnSpec[], sessionFile: string): CorrectnessCheck[] {
  const exchanges = sessionExchanges(sessionFile);
  return turns.flatMap(turn => {
    const reply = replyForTurn(exchanges, turn.prompt.slice(0, 48));
    return turn.checks.filter(check => check.kind !== 'artifact').map(check => ({
      turn: turn.id, kind: check.kind, expect: check.expect,
      pass: reply !== undefined && check.pattern !== undefined && new RegExp(check.pattern).test(reply),
      reply: reply?.slice(0, 200),
    }));
  });
}

/** The artifact check runs against the filesystem of the run's own cwd: both modes must create the identical file. */
function artifactCheck(workload: Workload, cwd: string): CorrectnessCheck[] {
  if (!workload.artifact) return [];
  const file = join(cwd, workload.artifact.file);
  let actual: string | undefined;
  try { actual = readFileSync(file, 'utf8').trim(); } catch { actual = undefined; }
  return [{
    turn: workload.artifact.turn, kind: 'artifact', expect: workload.artifact.expect,
    pass: actual === workload.artifact.content, reply: actual === undefined ? 'file missing' : `content: ${actual.slice(0, 100)}`,
  }];
}

interface ChildEnv extends Record<string, string> {}

function childEnv(args: Args, mode: 'native' | 'optchat', home: string, measure: string, dump: string): ChildEnv {
  const env: ChildEnv = {};
  for (const [key, value] of Object.entries(process.env)) if (typeof value === 'string') env[key] = value;
  // Matched isolation: strip every OptChat/measure lifecycle variable the parent shell may carry, then set exactly
  // this run's values; a globally installed OptChat must never activate the native comparator.
  for (const key of ['OMP_OPTCHAT', 'OMPCODE', 'OPTCHAT_OBSERVER_DIR', 'OMP_OPTCHAT_MEASURE_DIR',
    'OMP_OPTCHAT_BENCH_DUMP', 'OMP_OPTCHAT_SETTLE_BUDGET_MS', 'OMP_OPTCHAT_BENCH_COMPACTION_TOKENS', 'PI_REQ_DEBUG',
    'OTEL_EXPORTER_OTLP_ENDPOINT', 'OTEL_EXPORTER_OTLP_PROTOCOL', 'OTEL_EXPORTER_OTLP_TRACES_ENDPOINT']) delete env[key];
  env.OMP_OPTCHAT_HOME = home;
  env.OMP_OPTCHAT_MEASURE_DIR = measure;
  if (mode === 'optchat') env.OMP_OPTCHAT = 'bench';
  else env.OMP_OPTCHAT_BENCH_DUMP = dump;
  // Wire-level capture of every provider fetch: always for native (compaction side streams are not journaled),
  // and for OptChat with --wire-debug (session/wire cross-check). The observer keeps the debug FileHandles alive.
  if (mode === 'native' || args.wireDebug) env.PI_REQ_DEBUG = '1';
  // Same native compaction threshold on both sides (read by bench-observer.ts) so the workload is matched.
  if (args.compactionThreshold !== undefined) env.OMP_OPTCHAT_BENCH_COMPACTION_TOKENS = String(args.compactionThreshold);
  return env;
}

function launch(args: Args, mode: 'native' | 'optchat', cwd: string, sessions: string, env: ChildEnv, log: string) {
  const extIndex = join(ROOT, 'src', 'index.ts');
  const observer = join(ROOT, 'scripts', 'bench-observer.ts');
  const argv = [args.omp, '--mode', 'rpc', '--no-ui', '--no-title', '--no-extensions', '--session-dir', sessions, '-e', observer];
  // Only explicit -e files load (--no-extensions): native runs load the passive observer alone; optchat runs
  // additionally load this worktree's extension.
  if (mode === 'optchat') argv.push('-e', extIndex, '--optchat', 'bench');
  if (args.model) argv.push('--model', args.model);
  return Bun.spawn(argv, { cwd, env, stdin: 'pipe', stdout: 'pipe', stderr: Bun.file(log) });
}

async function runOnce(args: Args, workload: Workload, mode: 'native' | 'optchat', rep: number, outDir: string) {
  const name = `${mode}-rep${rep}`;
  const runDir = join(outDir, name);
  const cwd = join(runDir, 'cwd');
  const home = join(runDir, 'home');
  const measure = join(runDir, 'measure');
  const dump = join(runDir, 'payloads');
  const sessions = join(runDir, 'sessions');
  for (const dir of [runDir, cwd, home, measure, dump, sessions]) mkdirSync(dir, { recursive: true, mode: 0o700 });
  const usageFile = join(measure, 'usage.jsonl');
  const compositionFile = join(measure, 'request-composition.jsonl');
  const profile = join(home, 'bench');
  mkdirSync(profile, { recursive: true, mode: 0o700 });
  // The profile config is fixed before launch so the extension loads exactly the benchmark compactor.
  writeFileSync(join(profile, 'config.json'), JSON.stringify({
    compactor: args.compactor, ...(args.runLimit !== undefined ? { runLimit: args.runLimit } : {}),
  }, null, 2) + '\n');

  const startedAt = new Date().toISOString();
  const proc = launch(args, mode, cwd, sessions, childEnv(args, mode, home, measure, dump), join(runDir, 'rpc.stderr.log'));
  const rpcLog = join(runDir, 'rpc.jsonl');
  const rpc = new RpcSession(proc, rpcLog);
  const promptTimeout = args.promptTimeoutMs;
  let turnIndex = 0;
  let background = { settled: true, waitedMs: 0, bytes: 0 };
  try {
    await rpc.next('ready', promptTimeout);
    for (const turn of workload.turns) {
      turnIndex++;
      await rpc.prompt(turn.id, turn.prompt, promptTimeout);
    }
    // Drain background accounting while the process is alive: closing stdin first would abort in-flight
    // compactor/order calls. Unresolved starts after this wait surface as pending rows.
    background = await waitForBackground(usageFile, mode === 'optchat' ? args.backgroundWaitMs : 20_000, 15_000);
  } catch (error) {
    console.error(`[${name}] run failed at turn ${turnIndex}: ${String(error)}`);
  } finally {
    rpc.close();
  }
  const exit = await proc.exited;
  // Wire capture harvests AFTER exit and always runs (even after a failed run): it strips the credential headers
  // from every rr-session dump, then extracts compaction usage priced through the catalog (estimate, not billed).
  let wireUsage: Required<WireUsage> | undefined;
  let wireRequests: number | undefined;
  if (mode === 'native' || args.wireDebug) {
    const settings = await Settings.init({ cwd });
    const authStorage = await discoverAuthStorage(undefined, { settings });
    try {
      const capture = new ReqDebugCapture(cwd, new ModelRegistry(authStorage));
      const harvested = capture.harvest();
      wireRequests = capture.totalRequests;
      if (mode === 'native') wireUsage = harvested;
    } finally {
      authStorage.close();
    }
  }

  const sessionFiles = readdirSync(sessions).filter(f => f.endsWith('.jsonl')).map(f => join(sessions, f))
    .filter(f => statSync(f).isFile()).sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);
  const sessionFile = sessionFiles[0];
  const correctness = sessionFile ? [...evaluateCorrectness(workload.turns, sessionFile), ...artifactCheck(workload, cwd)] : [];

  // Noncomparative optchat-only probe: fully isolated side session (own session dir + measure dir + payloads), so
  // the extra zoom work never enters the matched usage comparison.
  let probe: { sessionFile?: string; correctness: CorrectnessCheck[] } | undefined;
  if (mode === 'optchat') {
    const probeSessions = join(runDir, 'probe', 'sessions');
    const probeMeasure = join(runDir, 'probe', 'measure');
    const probeDump = join(runDir, 'probe', 'payloads');
    for (const dir of [probeSessions, probeMeasure, probeDump]) mkdirSync(dir, { recursive: true, mode: 0o700 });
    // No wire capture for the probe: it runs after the harvest, so its credential-bearing dumps would stay on disk.
    const probeEnv = childEnv(args, mode, home, probeMeasure, probeDump);
    delete probeEnv.PI_REQ_DEBUG;
    const probeProc = launch(args, mode, cwd, probeSessions, probeEnv, join(runDir, 'probe', 'rpc.stderr.log'));
    const probeRpc = new RpcSession(probeProc, join(runDir, 'probe', 'rpc.jsonl'));
    try {
      await probeRpc.next('ready', promptTimeout);
      await probeRpc.prompt('probe-zoom', 'Benchmark probe (memory tools). Call zoom with id 0 and n 1, then reply only PROBE_ZOOM_OK plus the standing-order word.', promptTimeout);
      await waitForBackground(join(probeMeasure, 'usage.jsonl'), args.backgroundWaitMs, 15_000);
    } catch (error) {
      console.error(`[${name}] probe failed: ${String(error)}`);
    } finally {
      probeRpc.close();
      await probeProc.exited;
    }
    const probeFiles = existsSync(probeSessions)
      ? readdirSync(probeSessions).filter(f => f.endsWith('.jsonl')).map(f => join(probeSessions, f)).sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)
      : [];
    const probeSessionFile = probeFiles[0];
    probe = {
      sessionFile: probeSessionFile,
      correctness: probeSessionFile
        ? evaluateCorrectness([{ id: 'probe-zoom', prompt: 'Benchmark probe (memory tools). Call zoom with id 0 and n 1, then reply only PROBE_ZOOM_OK plus the standing-order word.',
          checks: [{ kind: 'sentinel', pattern: 'PROBE_ZOOM_OK', expect: 'PROBE_ZOOM_OK' }, orderCheck] }], probeSessionFile)
        : [],
    };
  }

  return {
    name, mode, rep, startedAt, finishedAt: new Date().toISOString(), cwd, sessionFile, usageFile, compositionFile,
    leakFile: join(measure, 'optchat-leak.jsonl'),
    payloadsDir: dump, dumpDir: dump, home, wireDir: cwd,
    wireCompactionUsage: wireUsage, wireRequests,
    rpcExit: exit, turnsSent: turnIndex,
    correctness, probe,
    background,
    correctnessPassed: turnIndex === workload.turns.length && correctness.length > 0 && correctness.every(c => c.pass),
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const workload = args.workload === 'smoke' ? smokeWorkload()
    : longWorkload(args.turns, Math.max(2000, Math.floor((args.runLimit ?? 256_000) * 1.4 / args.turns)));
  const outDir = args.out;
  if (existsSync(outDir)) throw new Error(`--out ${outDir} already exists: benchmark runs require a fresh directory`);
  mkdirSync(outDir, { recursive: true, mode: 0o700 });
  const modes = args.mode === 'both' ? ['native', 'optchat'] as const : [args.mode] as const;
  const manifest: Record<string, unknown> = {
    config: { ...args, root: ROOT, evidence: args.workload === 'smoke' ? 'smoke — NOT long-context evidence' : 'long-context benchmark' },
    startedAt: new Date().toISOString(), runs: [],
  };
  const runs: Record<string, unknown>[] = [];
  const reports: RunReport[] = [];
  for (let rep = 1; rep <= args.repetitions; rep++) {
    for (const mode of modes) {
      console.log(`[${mode} rep${rep}] running ${workload.name} workload (${workload.turns.length} turns)…`);
      const run = await runOnce(args, workload, mode, rep, outDir);
      runs.push(run);
      console.log(`[${run.name}] rpc exit ${run.rpcExit}; ${run.turnsSent} turns; session ${run.sessionFile ?? 'MISSING'}`);
      if (run.wireCompactionUsage) console.log(`[${run.name}] wire compaction requests ${run.wireCompactionUsage.requests} (in ${run.wireCompactionUsage.input}, out ${run.wireCompactionUsage.output}, catalog cost $${run.wireCompactionUsage.costUsd.toFixed(4)}, unpriced ${run.wireCompactionUsage.unpriced})`);
      const parsedSession = run.sessionFile ? parseSession(run.sessionFile) : undefined;
      const composition = parseCompositionLog(existsSync(run.compositionFile) ? run.compositionFile : undefined,
        existsSync(run.leakFile) ? run.leakFile : undefined);
      const report = buildRunReport({
        label: run.name, mode, workload: workload.name,
        session: parsedSession,
        background: parseUsageLog(existsSync(run.usageFile) ? run.usageFile : undefined),
        composition,
        backgroundSettled: run.background.settled,
        nativeCompactionUsage: run.wireCompactionUsage,
        nativeWireRequests: run.wireRequests,
        correctnessPassed: run.correctnessPassed,
        identity: {
          model: args.model, compactor: `${args.compactor.provider}/${args.compactor.model}`, thinking: args.compactor.thinking,
          workload: workload.name, turns: workload.turns.length, runLimit: args.runLimit,
        },
        // Native: a compaction call was wire-captured. OptChat: earlier runs reached the model only as summary view.
        rolloverObserved: mode === 'native'
          ? (run.wireCompactionUsage?.requests ?? 0) > 0
          : (composition.classes.view ?? 0) > 0,
      });
      reports.push(report);
      console.log(`[${run.name}] correctness ${run.correctnessPassed ? 'PASS' : 'FAIL'} (${run.correctness.filter(c => c.pass).length}/${run.correctness.length} checks)`);
      if (run.probe) console.log(`[${run.name}] probe (noncomparative): ${run.probe.correctness.filter(c => c.pass).length}/${run.probe.correctness.length}`);
      console.log(`[${run.name}] ${report.evidence}; complete: ${report.completeness.complete ? 'yes' : `NO — ${report.completeness.reasons.join('; ')}`}`);
    }
  }
  manifest.runs = runs;
  manifest.finishedAt = new Date().toISOString();
  writeFileSync(join(outDir, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
  const comparisons: RunComparison[] = [];
  for (let rep = 1; rep <= args.repetitions; rep++) {
    const native = reports.find(r => r.mode === 'native' && r.label.endsWith(`rep${rep}`));
    const optchat = reports.find(r => r.mode === 'optchat' && r.label.endsWith(`rep${rep}`));
    if (native && optchat) comparisons.push({ native: native.label, optchat: optchat.label, ...compareRuns(native, optchat) });
  }
  writeFileSync(join(outDir, 'report.json'), JSON.stringify({ generatedAt: new Date().toISOString(), config: manifest.config, runs: reports, comparisons }, null, 2) + '\n');
  console.log(`\nBenchmark out: ${outDir}\n  manifest.json  report.json  (per-run: rpc.jsonl, sessions/, measure/, payloads/, home/, otlp/)`);
  console.log(`Workload: ${workload.name} — ${workload.name === 'smoke' ? 'NOT long-context evidence' : 'long-context benchmark'}`);
  for (const pair of comparisons) console.log(`comparison: ${JSON.stringify(pair)}`);
}

if (import.meta.main) await main().catch(error => { console.error(error); process.exit(1); });
