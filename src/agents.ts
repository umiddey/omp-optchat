import { closeSync, existsSync, mkdirSync, openSync, readFileSync, readSync, readdirSync } from 'node:fs';
import { basename, isAbsolute, join, resolve } from 'node:path';
import { z } from '@oh-my-pi/pi-coding-agent';
import type { AgentMessage } from '@oh-my-pi/pi-agent-core';
import { appendJson } from './store.ts';
import { agentNames, textContent } from './transcript.ts';
import { pageText } from './paging.ts';

const dateSchema = z.string().regex(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/).refine(date => Number.isFinite(Date.parse(date)));
const recordSchema = z.object({ name: z.string().min(1), path: z.string().refine(isAbsolute), sessionFile: z.string().refine(isAbsolute), date: dateSchema });
export type AgentRecord = z.infer<typeof recordSchema>;
const entrySchema = z.object({ type: z.string(), timestamp: z.string().optional(), message: z.unknown().optional(), customType: z.string().optional(), content: z.unknown().optional(), display: z.boolean().optional() });
const messageSchema = z.object({ role: z.string(), content: z.unknown(), toolName: z.string().optional(), customType: z.string().optional(), display: z.boolean().optional() });
const blockSchema = z.object({ type: z.string(), name: z.string().optional(), arguments: z.unknown().optional(), mimeType: z.string().optional() });

const sessionDirectory = (file: string) => resolve(file.replace(/\.jsonl$/, ''));
const oneLine = (text: string) => text.replace(/\r/g, '\\r').replace(/\n/g, '\\n');
/** Expose images as labels, never inline base64; thinking and hidden custom messages remain private. */
function transcriptText(content: unknown): string {
  if (!Array.isArray(content)) return textContent(content, false);
  return content.map(part => {
    const block = blockSchema.safeParse(part);
    return block.success && block.data.type === 'image' ? `[image: ${block.data.mimeType ?? 'unknown'}]` : textContent([part], false);
  }).filter(Boolean).join(' ');
}
function echo(text: string): string {
  if (text.length <= 1000) return text;
  let head = 500, tail = text.length - 500;
  if (/[\ud800-\udbff]/.test(text[head - 1])) head--;
  if (/[\udc00-\udfff]/.test(text[tail])) tail++;
  return `${text.slice(0, head)}\n[${tail - head} characters omitted]\n${text.slice(tail)}`;
}
/** Read-only rendering of OMP session entries, including persisted custom_message envelopes. */
export function renderTranscript(file: string): string {
  let source: string;
  try { source = readFileSync(file, 'utf8'); }
  catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') throw new Error(`Transcript ${file} no longer exists.`);
    throw error;
  }
  const lines: string[] = [], entries = source.split('\n');
  const push = (kind: string, text: string) => { if (text.trim()) lines.push(`${kind}|${oneLine(text)}`); };
  for (const [index, line] of entries.entries()) {
    if (!line.trim()) continue;
    let raw: unknown;
    try { raw = JSON.parse(line); }
    catch {
      // A running subagent may be in the middle of its final append. Earlier damaged records are errors.
      if (index === entries.length - 1 && !source.endsWith('\n')) break;
      throw new Error(`Invalid transcript JSON at ${file}:${index + 1}.`);
    }
    const parsed = entrySchema.safeParse(raw);
    if (!parsed.success) throw new Error(`Invalid transcript entry at ${file}:${index + 1}.`);
    const entry = parsed.data;
    if (entry.type !== 'message' && entry.type !== 'custom_message') continue;
    const message = messageSchema.parse(entry.type === 'custom_message' ? { ...entry, role: 'custom' } : entry.message);
    if (message.role === 'user' || message.role === 'developer') push(message.role, transcriptText(message.content));
    else if (message.role === 'assistant' && Array.isArray(message.content)) {
      for (const part of message.content) {
        const block = blockSchema.safeParse(part); if (!block.success) continue;
        if (block.data.type === 'text') push('talk', textContent([part], false));
        else if (block.data.type === 'toolCall') push('tool', `${block.data.name} ${JSON.stringify(block.data.arguments)}`);
      }
    } else if (message.role === 'toolResult') push('echo', `${message.toolName}: ${echo(transcriptText(message.content))}`);
    else if (message.role === 'custom' && message.display) push(['irc:incoming', 'async-result'].includes(message.customType ?? '') ? 'work' : 'user', `[${message.customType}] ${transcriptText(message.content)}`);
  }
  return lines.join('\n');
}

/** Child creation date from the session header, not mtime (which changes as the agent works). */
function transcriptDate(file: string, fallback: string): string {
  if (!existsSync(file)) return fallback;
  const fd = openSync(file, 'r'), buffer = Buffer.alloc(8192);
  try {
    const header = buffer.toString('utf8', 0, readSync(fd, buffer, 0, buffer.length, 0));
    for (const line of header.split('\n')) {
      let raw: unknown; try { raw = JSON.parse(line); } catch { continue; }
      const entry = entrySchema.safeParse(raw);
      if (entry.success && entry.data.type === 'session' && dateSchema.safeParse(entry.data.timestamp).success) return entry.data.timestamp!;
    }
    return fallback;
  } finally { closeSync(fd); }
}
function distance(a: string, b: string): number {
  let previous = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const current = [i];
    for (let j = 1; j <= b.length; j++) current[j] = Math.min(current[j - 1] + 1, previous[j] + 1, previous[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    previous = current;
  }
  return previous[b.length];
}
/** Walk only the current session's child tree; do not follow symlinks into unrelated sessions. */
function* transcriptFiles(directory: string): Generator<string> {
  if (!existsSync(directory)) return;
  for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const file = join(directory, entry.name);
    if (entry.isDirectory()) yield* transcriptFiles(file);
    else if (entry.isFile() && entry.name.endsWith('.jsonl')) yield file;
  }
}
export class AgentIndex {
  private readonly file: string;
  private readonly records: AgentRecord[] = [];
  private readonly paths = new Set<string>();
  constructor(directory: string, private readonly warn: (text: string) => void = console.error) {
    this.file = join(directory, 'agents.jsonl');
    if (!existsSync(this.file)) return;
    for (const [i, line] of readFileSync(this.file, 'utf8').split('\n').entries()) {
      if (!line.trim()) continue;
      try { this.remember(recordSchema.parse(JSON.parse(line))); }
      catch { warn(`Skipped damaged agent index record at ${this.file}:${i + 1}`); }
    }
  }
  private remember(record: AgentRecord) {
    const key = `${record.name}\0${record.path}`;
    if (this.paths.has(key)) return false;
    this.paths.add(key); this.records.push(record); return true;
  }
  private append(name: string, path: string, sessionFile: string, date: string) {
    const record = recordSchema.parse({ name, path: resolve(path), sessionFile: resolve(sessionFile), date });
    if (this.paths.has(`${record.name}\0${record.path}`)) return;
    mkdirSync(resolve(this.file, '..'), { recursive: true, mode: 0o700 });
    appendJson(this.file, record); // append + fsync; never replace or truncate the index
    this.remember(record);
  }
  recordMessage(message: AgentMessage, sessionFile: string | undefined) {
    if (!sessionFile) return;
    for (const name of agentNames(message)) {
      const root = sessionDirectory(sessionFile), direct = join(root, `${name}.jsonl`);
      const matches = existsSync(direct) ? [direct] : [...transcriptFiles(root)].filter(file => basename(file, '.jsonl') === name);
      for (const path of matches.length ? matches : [direct])
        this.append(name, path, sessionFile, transcriptDate(path, new Date(message.timestamp).toISOString()));
    }
  }
  scan(sessionFile: string | undefined) {
    if (!sessionFile) return;
    const root = sessionDirectory(sessionFile);
    for (const file of transcriptFiles(root))
      this.append(basename(file, '.jsonl'), file, sessionFile, transcriptDate(file, new Date().toISOString()));
  }
  resolve(selector: string): { match: AgentRecord; others: AgentRecord[] } {
    const at = selector.indexOf('@'), name = at < 0 ? selector : selector.slice(0, at), choice = at < 0 ? undefined : selector.slice(at + 1);
    const matches = this.records.filter(record => record.name === name).sort((a, b) => b.date.localeCompare(a.date) || b.path.localeCompare(a.path));
    if (!matches.length) {
      const closest = [...new Set(this.records.map(record => record.name))].sort((a, b) => distance(name.toLowerCase(), a.toLowerCase()) - distance(name.toLowerCase(), b.toLowerCase()) || a.localeCompare(b)).slice(0, 5);
      throw new Error(`Unknown agent ${JSON.stringify(name)}. Closest names: ${closest.join(', ') || '(index is empty)'}.`);
    }
    const selected = choice === undefined ? matches : matches.filter(record => record.date === choice || record.path === choice);
    if (!selected.length) throw new Error(`No transcript for ${JSON.stringify(selector)}. Matches: ${matches.map(record => `${name}@${record.date}`).join(', ')}.`);
    return { match: selected[0], others: matches.filter(record => record !== selected[0]) };
  }
  zoom(selector: string, offset?: number, limit?: number): string {
    const { match, others } = this.resolve(selector);
    const page = pageText(renderTranscript(match.path), `Transcript ${match.name}`, offset, limit);
    if (!others.length) return page;
    // Metadata is outside the paged body: offsets always refer to kind|text transcript characters.
    const options = others.map(record => `- ${record.name} (${record.date}): zoom(${JSON.stringify(`${record.name}@${record.date}`)}); exact file: zoom(${JSON.stringify(`${record.name}@${record.path}`)})`).join('\n');
    return `${page}\n[Selected ${match.name} (${match.date}); ${match.path}. Other matches:\n${options}\n]`;
  }
}
