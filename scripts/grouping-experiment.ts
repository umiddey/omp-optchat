import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { streamSimple, type Api, type AssistantMessage, type Message } from '@oh-my-pi/pi-ai';
import { ThinkingLevel, type AgentMessage } from '@oh-my-pi/pi-agent-core';
import { ModelRegistry, Settings, discoverAuthStorage } from '@oh-my-pi/pi-coding-agent';
import { Memory, NODE } from '../src/memory.ts';
import type { Entry } from '../src/memory.ts';
import { createCompressor, createOrderTask, reasoningFor, type ModelChoice } from '../src/compactor.ts';
import { logMessage } from '../src/transcript.ts';
import { checkRetrieval, groupTranscript, oversizedUnits, unitEntry,
  type GroupUnit, type RetrievalCheck } from '../src/experiment-grouping.ts';
import { record } from '../src/cache.ts';
import { openMeasurement, readUsageLog } from '../src/measurement.ts';

/** Isolated grouped-tool-exchange experiment (EXPERIMENTAL — no production grouping, no flag, no cutover): the same
 * recorded fixture transcript is replayed into two real Memory profiles with the real compressor and real order
 * task (model registry actual APIs, temp profile homes) — once with the shipped message-level logging and once with
 * each assistant message grouped with its own tool results. The experiment then asserts, per mode: exact source
 * retrieval through zoom (full source ID map, originals preserved verbatim), retained standing orders in the real
 * orders ledger, and live model answers to factual questions asked from the rendered compressed view — so exact
 * source preservation is never equated with memory quality. Calls and usage of every compactor/order invocation are
 * counted per mode via the compressor's onUsage; QA calls are counted separately. Units over the 512-byte node
 * budget force real summarization. */

const ROOT = resolve(import.meta.dir, '..');
const SETTLE_TIMEOUT_MS = 10 * 60_000;
const THINKING_LEVELS = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];

interface FixtureFact { id: string; answer: string; question: string }
interface Fixture {
  description: string;
  messages: AgentMessage[];
  expectedOrders: { text: string; kind: string; from: number; expectTokens: string[] }[];
  facts: FixtureFact[];
  orderQuestion: { question: string; expect: string };
}

function loadFixture(path: string): Fixture {
  const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'));
  if (!record(parsed) || !Array.isArray(parsed.messages)) throw new Error(`Invalid fixture: ${path}`);
  // Fixture is a repo-owned file written against the AgentMessage shapes; the read-model cast keeps the replay typed.
  const messages = parsed.messages as Fixture['messages'];
  const facts = Array.isArray(parsed.facts) ? parsed.facts as FixtureFact[] : [];
  const expectedOrders = Array.isArray(parsed.expectedOrders) ? parsed.expectedOrders as Fixture['expectedOrders'] : [];
  const orderQuestion = record(parsed.orderQuestion) ? parsed.orderQuestion as Fixture['orderQuestion'] : { question: '', expect: '' };
  return { description: typeof parsed.description === 'string' ? parsed.description : '', messages, expectedOrders, facts, orderQuestion };
}

async function openRegistry(): Promise<{ registry: ModelRegistry; close: () => void }> {
  const settings = await Settings.init({ cwd: ROOT });
  const authStorage = await discoverAuthStorage(undefined, { settings });
  const registry = new ModelRegistry(authStorage);
  await registry.hydrateCredentialScopedModelCaches();
  return { registry, close: () => authStorage.close() };
}

interface UsageCount { calls: number; input: number; output: number; cacheRead: number; cacheWrite: number; errors: number; incomplete: number }
const emptyCount = (): UsageCount => ({ calls: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, errors: 0, incomplete: 0 });

function countUsage(count: UsageCount, message: AssistantMessage) {
  count.calls++;
  const usage: Record<string, unknown> = record(message.usage) ? message.usage : {};
  const num = (value: unknown) => (typeof value === 'number' && Number.isFinite(value) ? value : 0);
  count.input += num(usage.input); count.output += num(usage.output);
  count.cacheRead += num(usage.cacheRead); count.cacheWrite += num(usage.cacheWrite);
  if (message.stopReason === 'error' || message.stopReason === 'aborted') count.errors++;
}

interface ModeResult {
  mode: 'message-level' | 'grouped';
  directory: string;
  entries: number;
  unitCount: number;
  oversizedUnitCount: number;
  nodes: number;
  viewBytes: number;
  viewText: string;
  retrieval: RetrievalCheck[];
  retrievalPassed: boolean;
  ordersRendered: string;
  ordersFailed: { expect: string; missingTokens: string[] }[];
  qa: { id: string; question: string; expected: string; answer: string; pass: boolean; error?: string }[];
  qaPassed: boolean;
  qaIncomplete: boolean;
  background: UsageCount;
  qaUsage: UsageCount;
  settled: boolean;
}

/** Ledger semantics check per fixture order: the restated render must carry the order's kind marker and source
 * message id (`<from> [kind`), plus EVERY expected token (case-insensitive). Bare single-word probes can pass an
 * opposite or partial restatement; missing tokens are reported explicitly. */
function orderChecks(rendered: string, orders: Fixture['expectedOrders']) {
  const lower = rendered.toLowerCase();
  return orders.map(order => {
    const anchor = `${order.from} [${order.kind}`;
    const missingTokens = [anchor, ...order.expectTokens.map(token => token.toLowerCase())]
      .filter(needle => !lower.includes(needle));
    return { expect: `${order.kind} from ${order.from}: ${order.text}`, missingTokens, pass: missingTokens.length === 0 };
  });
}

async function replayMode(
  mode: 'message-level' | 'grouped', fixture: Fixture, units: GroupUnit[],
  registry: ModelRegistry, choice: () => ModelChoice, home: string,
): Promise<ModeResult> {
  const directory = join(home, mode.replace(/[^a-z]/g, ''));
  if (existsSync(directory)) throw new Error(`${directory} already exists: experiment runs require fresh directories`);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  // Contract instrumentation is the source of truth for replay usage (it records thrown calls and null usage that
  // onUsage never sees); the rows land in <dir>/usage.jsonl and are parsed below.
  const measurement = openMeasurement(directory, () => {});
  const background = emptyCount();
  // A deliberately small view budget (a real Memory.open parameter) forces the same sawtooth merges production
  // needs for orders batches, so the fixture's standing orders go through real extraction AND consolidation.
  const budget = 4096;
  const memory = await Memory.open(directory, createCompressor(registry, choice, () => {}, undefined, measurement.invoke),
    () => {}, budget, undefined, createOrderTask(registry, choice, () => {}, measurement.invoke));
  // Per-message log indexes first: message-level replay can append several entries per message; grouped appends
  // exactly one per unit. Then map units onto the union of their source messages' indexes (the source ID map).
  const byMessage: number[][] = [];
  if (mode === 'message-level') {
    for (const [index, message] of fixture.messages.entries()) {
      const before = memory.root.length;
      logMessage(memory, message);
      byMessage[index] = Array.from({ length: memory.root.length - before }, (_, k) => before + k);
    }
  } else {
    for (const unit of units) {
      const entry = unitEntry(unit);
      if (!entry) continue;
      const appended: Entry = memory.append(entry.kind, entry.text);
      // One entry carries every original of the unit: assign it to each source message id it contains.
      for (const id of unit.sourceIds) byMessage[Number(id.slice(1))] = [appended.i];
    }
  }
  const unitIndexes: number[][] = units.map(unit => unit.sourceIds.flatMap(id => byMessage[Number(id.slice(1))] ?? []));
  // The actual logged entry texts per unit: retrieval must reproduce the mode's own logging byte-for-byte, not an
  // idealized expectation (message-level and grouped entries genuinely differ in shape).
  const logged: string[][] = units.map(unit => unit.sourceIds
    .flatMap(id => byMessage[Number(id.slice(1))] ?? [])
    .map(index => memory.root[index]?.text ?? ''));
  // Force the sawtooth over the small budget with deterministic filler notes (same for both modes), so the fixture
  // orders go through real extraction, real merges, real batches and real consolidation before settle.
  for (let note = 0; note < 40; note++)
    memory.append('note', `Filler note ${note}: benchmark volume for merge forcing; token ${note} is deterministic.`);
  const retrieval = checkRetrieval(units, unitIndexes, memory, logged);
  // Real summarization for every >512-byte unit; bounded so persistent compactor failures end the experiment as
  // incomplete instead of retrying forever.
  let settled = true;
  const settleController = new AbortController();
  const timer = setTimeout(() => settleController.abort(), SETTLE_TIMEOUT_MS);
  try {
    await memory.settle(settleController.signal, 'tree');
  } catch {
    settled = false;
  } finally {
    clearTimeout(timer);
  }
  // Replay usage comes from the contract instrumentation rows (they include thrown calls and null usage that an
  // onUsage callback never observes); unresolved starts and thrown/null rows make the mode's usage incomplete.
  const rows = readUsageLog(join(directory, 'usage.jsonl'));
  for (const row of rows.rows) {
    if (row.type === 'background-start') { background.calls++; continue; }
    background.calls++;
    const usage = record(row.usage) ? row.usage : {};
    const value = (key: string) => (typeof usage[key] === 'number' && Number.isFinite(usage[key]) ? usage[key] as number : 0);
    background.input += value('input'); background.output += value('output');
    background.cacheRead += value('cacheRead'); background.cacheWrite += value('cacheWrite');
    if (row.type === 'background' && row.status !== 'ok') background.errors++;
  }
  background.incomplete = (rows.rows.some(row => row.type === 'background-start')
    || rows.rows.some(row => row.type === 'background' && (row.usage === null || row.status === 'thrown'))) ? 1 : 0;
  const viewText = memory.render();
  const ordersRendered = memory.orders?.render() ?? '';
  const orderResults = orderChecks(ordersRendered, fixture.expectedOrders);
  const ordersPassed = fixture.expectedOrders.length > 0 && orderResults.every(order => order.pass);
  const qa: ModeResult['qa'] = [];
  const qaUsage = emptyCount();
  if (settled) {
    const selected = choice();
    const qaModel = registry.find(selected.provider, selected.model);
    if (!qaModel) throw new Error(`Compactor model unavailable: ${selected.provider}/${selected.model}`);
    const ask = async (question: string) => {
      const context = `${ordersRendered ? `${ordersRendered}\n\n` : ''}${viewText}`;
      const messages: Message[] = [{ role: 'user', content: `${context}\n\n${question}`, timestamp: Date.now() }];
      const reply = await streamSimple(qaModel, { systemPrompt: [viewText], messages }, {
        apiKey: await registry.getApiKey(qaModel), sessionId: 'optchat-grouping-qa',
        reasoning: reasoningFor(qaModel, ThinkingLevel.Low),
      }).result();
      countUsage(qaUsage, reply);
      return reply.content.filter(part => part.type === 'text').map(part => part.text).join('').trim();
    };
    for (const fact of fixture.facts) {
      try {
        const answer = await ask(fact.question);
        qa.push({ id: fact.id, question: fact.question, expected: fact.answer, answer, pass: answer.includes(fact.answer) });
      } catch (error) {
        qaUsage.errors++;
        qa.push({ id: fact.id, question: fact.question, expected: fact.answer, answer: '', pass: false, error: String(error) });
      }
    }
    if (fixture.orderQuestion.question) {
      try {
        const answer = await ask(fixture.orderQuestion.question);
        qa.push({ id: 'standing-order', question: fixture.orderQuestion.question, expected: fixture.orderQuestion.expect,
          answer, pass: answer.includes(fixture.orderQuestion.expect) });
      } catch (error) {
        qa.push({ id: 'standing-order', question: fixture.orderQuestion.question, expected: fixture.orderQuestion.expect,
          answer: '', pass: false, error: String(error) });
      }
    }
  }
  await memory.close();
  return {
    mode, directory, entries: memory.root.length, unitCount: units.length,
    oversizedUnitCount: oversizedUnits(units).length, nodes: memory.tree.size,
    viewBytes: memory.size, viewText, retrieval,
    retrievalPassed: retrieval.length > 0 && retrieval.every(check => check.pass),
    ordersRendered, ordersFailed: orderResults.filter(order => !order.pass), qa,
    qaPassed: settled && qa.length > 0 && qa.every(item => item.pass),
    qaIncomplete: qa.some(item => item.error !== undefined) || qaUsage.errors > 0,
    background, qaUsage, settled,
  };
}

async function main() {
  const argv = process.argv.slice(2);
  let fixturePath = join(ROOT, 'test', 'fixtures', 'grouping-transcript.json');
  let home = join('/tmp', `optchat-grouping-${new Date().toISOString().replace(/[:.]/g, '-')}`);
  let compactor = 'anthropic/claude-haiku-5-5';
  let thinking = 'xhigh';
  let out: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const value = () => { const v = argv[++i]; if (v === undefined) throw new Error(`${argv[i - 1]} needs a value`); return v; };
    if (argv[i] === '--fixture') fixturePath = resolve(value());
    else if (argv[i] === '--home') home = resolve(value());
    else if (argv[i] === '--compactor') compactor = value();
    else if (argv[i] === '--thinking') thinking = value();
    else if (argv[i] === '--out') out = resolve(value());
    else throw new Error(`Unknown flag ${argv[i]}`);
  }
  const [provider, model] = compactor.split('/');
  if (!provider || !model) throw new Error('--compactor provider/model');
  if (!THINKING_LEVELS.includes(thinking)) throw new Error(`--thinking must be one of ${THINKING_LEVELS.join('|')}`);
  // Validated against OMP's supported effort strings immediately above (same cast loadConfig performs).
  const choice = (): ModelChoice => ({ provider, model, thinking: thinking as ModelChoice['thinking'] });
  if (existsSync(home)) throw new Error(`--home ${home} already exists: experiment runs require a fresh directory`);
  const fixture = loadFixture(fixturePath);
  const units = groupTranscript(fixture.messages);
  const oversized = oversizedUnits(units);
  console.log(`Fixture: ${fixture.messages.length} messages → ${units.length} units (${oversized.length} over the ${NODE}-byte node budget; real summarization will run for them)`);
  for (const unit of units)
    console.log(`  ${unit.sourceIds.join('+')} [${unit.kind}${unit.parallel ? ', parallel' : ''}${unit.error ? ', error' : ''}]`);
  const { registry, close } = await openRegistry();
  const results: ModeResult[] = [];
  try {
    for (const mode of ['message-level', 'grouped'] as const) {
      console.log(`[${mode}] replaying into ${home}…`);
      const result = await replayMode(mode, fixture, units, registry, choice, home);
      results.push(result);
      console.log(`[${mode}] entries ${result.entries}; nodes ${result.nodes}; view ${result.viewBytes}B; settled ${result.settled}`);
      console.log(`[${mode}] retrieval ${result.retrievalPassed ? 'PASS' : 'FAIL'}; orders ${result.ordersFailed.length === 0 ? 'PASS' : 'FAIL'}; live QA ${result.qaPassed ? 'PASS' : 'FAIL'} (${result.qa.filter(q => q.pass).length}/${result.qa.length}); compactor calls ${result.background.calls}`);
      for (const item of result.qa)
        console.log(`[${mode}] QA ${item.id}: ${item.pass ? 'pass' : `FAIL — expected ${item.expected}, got: ${item.answer.slice(0, 120)}${item.error ? ` (${item.error})` : ''}`}`);
    }
  } finally {
    close();
  }
  const [messageLevel, grouped] = results;
  const comparison = messageLevel && grouped ? {
    compactorCallDelta: grouped.background.calls - messageLevel.background.calls,
    viewBytesDelta: grouped.viewBytes - messageLevel.viewBytes,
    nodesDelta: grouped.nodes - messageLevel.nodes,
    exactSourceRetrievalBoth: messageLevel.retrievalPassed && grouped.retrievalPassed,
    ordersRetainedBoth: messageLevel.ordersFailed.length === 0 && grouped.ordersFailed.length === 0,
    liveQAMessageLevel: `${messageLevel.qa.filter(q => q.pass).length}/${messageLevel.qa.length}`,
    liveQAGrouped: `${grouped.qa.filter(q => q.pass).length}/${grouped.qa.length}`,
    note: 'Exact source preservation (zoom retrieval) is reported separately from live compressed-view QA; they are not the same measurement.',
  } : undefined;
  const report = {
    generatedAt: new Date().toISOString(), fixture: fixturePath, description: fixture.description,
    experimentalOnly: true,
    counts: { messages: fixture.messages.length, units: units.length, oversizedUnits: oversized.length },
    results: results.map(result => ({ ...result, viewText: `${result.viewText.slice(0, 4000)}…`, usageIncomplete: result.background.incomplete > 0 || result.qaIncomplete })),
    comparison,
  };
  const outPath = out ?? join(home, 'grouping-report.json');
  mkdirSync(resolve(outPath, '..'), { recursive: true, mode: 0o700 });
  writeFileSync(outPath, JSON.stringify(report, null, 2) + '\n');
  console.log(`\nReport: ${outPath}`);
}

if (import.meta.main) await main().catch(error => { console.error(error); process.exit(1); });
