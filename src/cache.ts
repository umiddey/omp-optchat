import { isView } from './memory.ts';
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
export function cachePayload(payload: unknown): unknown {
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
    // Fallback entry: tools + system never change in a session, so a turn whose view marks find nothing (a new
    // profile's tiny view, a batch merge, a turn that adds more than 160 lines) still reads them from the cache.
    const system = Array.isArray(payload.system) ? payload.system.findLast(record) : undefined;
    if (system) system.cache_control = control;
    // The view's last whole block and the one 20 back: Anthropic looks back 20 blocks from a mark, so together
    // they find the last turn's entry after a turn adds up to 40 blocks (160 lines).
    for (const back of system ? [0, 20] : [0, 20, 40]) {
      const block = blocks[blocks.length - 2 - back];
      if (block) block.cache_control = control;
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
