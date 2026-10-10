import { isView } from './memory.ts';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { atomicWrite } from './store.ts';
export function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
export function splitView(text: string) {
  const pieces: string[] = [];
  let offset = 0;
  for (let count = 0, at = text.indexOf('\n'); at >= 0; at = text.indexOf('\n', at + 1))
    if (++count % 4 === 0) { pieces.push(text.slice(offset, at + 1)); offset = at + 1; }
  pieces.push(text.slice(offset));
  return pieces;
}
interface ViewMark { viewBytes: number; sha256: string; blockIndex: number }
export interface CacheState { file?: string; previous?: ViewMark }
const processState: CacheState = {};
export function cachePayload(payload: unknown, state: CacheState = processState): unknown {
  if (!record(payload) || !Array.isArray(payload.messages)) return payload;
  const messages: unknown[] = payload.messages;
  for (const owner of messages) {
    if (!record(owner) || owner.role !== 'user' || !Array.isArray(owner.content)) continue;
    const content: unknown[] = owner.content;
    const at = content.findIndex(b => record(b) && b.type === 'text' && typeof b.text === 'string' && isView(b.text));
    const view = content[at];
    if (!record(view) || typeof view.text !== 'string') continue;
    const all: Record<string, unknown>[] = [payload];
    for (const section of [payload.tools, payload.system, messages]) {
      if (!Array.isArray(section)) continue;
      for (const item of section) if (record(item)) {
        all.push(item);
        if (Array.isArray(item.content)) for (const block of item.content) if (record(block)) all.push(block);
      }
    }
    const control = all.find(b => record(b.cache_control))?.cache_control;
    for (const block of all) delete block.cache_control;
    const pieces = splitView(view.text);
    const blocks: Record<string, unknown>[] = pieces.map(text => ({ type: 'text', text }));
    content.splice(at, 1, ...blocks);
    const reminder = content.findIndex(b => record(b) && b.type === 'text' && typeof b.text === 'string' && b.text.startsWith('<system-reminder>\nToday:'));
    if (reminder >= 0) {
      const [block] = content.splice(reminder, 1);
      content.splice(content.indexOf(blocks[blocks.length - 1]) + 1, 0, block);
    }
    if (!control) return payload;
    // Fallback entry: tools + system remain readable when a tiny view or batch rewrite has no reusable mark.
    const system = Array.isArray(payload.system) ? payload.system.findLast(record) : undefined;
    if (system) system.cache_control = control;
    const lastWhole = blocks.length - 2;
    // Anchor the exact entry written by the previous request, regardless of how many lines were appended.
    // Missing/corrupt state or a rewritten prefix retains Anthropic's 20-block lookback fallback.
    if (!state.previous && state.file) {
      try {
        const saved: unknown = JSON.parse(readFileSync(state.file, 'utf8'));
        if (record(saved) && Number.isSafeInteger(saved.viewBytes) && (saved.viewBytes as number) > 0
          && Number.isSafeInteger(saved.blockIndex) && (saved.blockIndex as number) >= 0
          && typeof saved.sha256 === 'string' && /^[a-f0-9]{64}$/.test(saved.sha256))
          state.previous = saved as unknown as ViewMark;
      } catch { /* Cache hints are disposable; never prevent a provider request. */ }
    }
    const bytes = Buffer.from(view.text);
    const old = state.previous;
    let oldPrefixBytes = 0;
    if (old && old.blockIndex < lastWhole)
      for (let i = 0; i <= old.blockIndex; i++) oldPrefixBytes += Buffer.byteLength(pieces[i]);
    const previous = old && old.blockIndex < lastWhole && old.viewBytes === oldPrefixBytes
      && createHash('sha256').update(bytes.subarray(0, old.viewBytes)).digest('hex') === old.sha256
      ? old.blockIndex : lastWhole - 20;
    for (const index of system ? [lastWhole, previous] : [lastWhole, previous, lastWhole - 40]) {
      const block = blocks[index];
      if (block) block.cache_control = control;
    }
    const viewBytes = bytes.length - Buffer.byteLength(pieces[pieces.length - 1]);
    state.previous = lastWhole >= 0
      ? { viewBytes, sha256: createHash('sha256').update(bytes.subarray(0, viewBytes)).digest('hex'), blockIndex: lastWhole }
      : undefined;
    if (state.file) {
      try { atomicWrite(state.file, JSON.stringify(state.previous ?? null)); }
      catch { /* A failed hint write sacrifices reuse, not the chat. */ }
    }
    // Thinking signatures and empty text cannot carry Anthropic cache marks.
    for (let j = messages.length - 1; j >= 0; j--) {
      const message = messages[j];
      if (!record(message)) continue;
      if (typeof message.content === 'string') message.content = [{ type: 'text', text: message.content }];
      if (!Array.isArray(message.content)) continue;
      for (let i = message.content.length - 1; i >= 0; i--) {
        const block: unknown = message.content[i];
        if (!record(block) || block.type === 'thinking' || block.type === 'redacted_thinking' || (block.type === 'text' && (typeof block.text !== 'string' || !block.text.trim()))) continue;
        block.cache_control = control;
        return payload;
      }
    }
    return payload;
  }
  return payload;
}
