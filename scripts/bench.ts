import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
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
export interface WireUsage { requests: number; input: number; output: number; cacheRead: number; cacheWrite: number; costUsd: number; unpriced: number }

/** Wire-level capture over pi-ai's request-debug hook (PI_REQ_DEBUG=1 wraps EVERY streamSimple fetch, including
 * native compaction side streams the session journal never records). Native runs only — OptChat background is
 * already instrumented by the measurement module. Each rr-session-N.json request dump is sanitized immediately
 * after parse (its headers carry credentials and are never persisted or published); responses are raw SSE in
 * rr-session-N.res.log, and Anthropic usage comes from message_start + message_delta counters.
 * Classification (validated against real proof artifacts /tmp/optchat-native-compaction-proof):
 * - native/remote compaction: the RESPONSE stop_reason is `compaction` (AnthropicCompaction side stream);
 * - handoff compaction: the request's last user message carries the handoff summary template placeholder
 *   `[What should happen next]` (compaction.ts renders the full conversation into that template);
 * - memory-extractor side calls (no tools, `[user:end]` serialization): journaled by the session as model_usage
 *   (`memory`) — counted separately and EXCLUDED from spend, so token costs are never double counted;
 * - everything else is a main/other wire request, counted only for the wire/session cross-check. */
class ReqDebugCapture {
  private readonly usage: Required<WireUsage> = { requests: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, costUsd: 0, unpriced: 0 };
  totalRequests = 0;
  journaledWireRequests = 0;
  constructor(private readonly cwd: string, private readonly registry: import('@oh-my-pi/pi-coding-agent').ModelRegistry | undefined) {}
  /** Parse every rr-session dump in the run cwd, sanitize request headers in place, extract compaction usage. */
  harvest(): Required<WireUsage> {
    for (const name of readdirSync(this.cwd).filter(f => /^rr-session-\d+\.json$/.test(f)).sort()) {
      const requestPath = join(this.cwd, name);
      let dump: Record<string, unknown>;
      try {
        const parsed: unknown = JSON.parse(readFileSync(requestPath, 'utf8'));
        if (!record(parsed)) continue;
        dump = parsed;
      } catch { continue; }
      // Sanitize first: strip credential-bearing headers from the dump on disk, keep method/url/body.
      if (dump.headers !== undefined) {
        const { headers: _headers, ...sanitized } = dump;
        writeFileSync(requestPath, JSON.stringify(sanitized, null, 2) + '\n');
      }
      this.totalRequests++;
      const bodyText = typeof dump.bodyText === 'string' ? dump.bodyText
        : typeof dump.body === 'string' ? dump.body : undefined;
      const responseLog = requestPath.replace(/\.json$/, '.res.log');
      const response = responseLog && existsSync(responseLog) ? readFileSync(responseLog, 'utf8') : undefined;
      let body: Record<string, unknown> | undefined;
      if (bodyText !== undefined) {
        try {
          const parsedBody: unknown = JSON.parse(bodyText);
          if (record(parsedBody)) body = parsedBody;
        } catch { body = undefined; }
      }
      const kind = this.classify(body, response);
      if (kind === 'main') continue;
      if (kind === 'journaled') { this.journaledWireRequests++; continue; }
      if (!response) continue;
      const usage = parseAnthropicSseUsage(response);
      if (!usage) continue;
      this.usage.requests++;
      this.usage.input += usage.input; this.usage.output += usage.output;
      this.usage.cacheRead += usage.cacheRead; this.usage.cacheWrite += usage.cacheWrite;
      const modelId = body && typeof body.model === 'string' ? body.model : undefined;
      const slash = modelId ? modelId.indexOf('/') : -1;
      const model = this.registry && modelId && slash > 0
        ? this.registry.find(modelId.slice(0, slash), modelId.slice(slash + 1))
        : undefined;
      if (!model) { this.usage.unpriced++; continue; }
      // calculateCost reads exactly these token counters and writes usage.cost — the priced surface of Usage.
      // Catalog-priced estimate from the model price table; never a billed-actual dollars claim.
      const priced = { input: usage.input, output: usage.output, cacheRead: usage.cacheRead, cacheWrite: usage.cacheWrite } as unknown as import('@oh-my-pi/pi-ai').Usage;
      calculateCost(model, priced);
      this.usage.costUsd += record(priced.cost) && typeof priced.cost.total === 'number' ? priced.cost.total : 0;
    }
    return { ...this.usage };
  }

  /** Wire-level call class from the sanitized request body and the raw SSE response. */
  private classify(body: Record<string, unknown> | undefined, response: string | undefined): 'compaction' | 'journaled' | 'main' {
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
