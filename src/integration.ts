import type { AgentMessage } from '@oh-my-pi/pi-agent-core';
import { OPTCHAT_PROMPT } from './prompts.ts';
import { cachePayload } from './cache.ts';
export const NOTICES = new Set(['tool-roster-notice', 'eval-prelude-notice', 'session-agent-notice', 'xdev-mount-notice']);
export const enabled = (active: boolean, kind: string) => active && kind === 'main';
export function preparePrompt(systemPrompt: string[], active = true, kind = 'main') {
  if (!enabled(active, kind)) return { systemPrompt, memories: '' };
  const memories = systemPrompt.filter(s => s.startsWith('<memories>')).join('\n\n');
  const stable = systemPrompt.filter(s => !s.startsWith('<memories>'));
  const at = stable.findIndex(s => s.startsWith('<project-context>'));
  stable.splice(at < 0 ? stable.length : at, 0, OPTCHAT_PROMPT);
  return { systemPrompt: stable, memories };
}
export function turnStart(messages: AgentMessage[], first?: AgentMessage) {
  const at = first ? messages.findLastIndex(m => m.role === first.role && m.timestamp === first.timestamp)
    : messages.findLastIndex(m => m.role === 'user');
  if (at < 0) throw new Error('OptChat has no turn start; refusing historical context.');
  return at;
}
/** The view (and moved recall) always opens the current turn, so its bytes sit right after the stable notices on
 * every request of the run. A run started by a shown custom message (async result, report) gets its own view message. */
export function projectContext(messages: AgentMessage[], at: number, view: string, memories: string, active = true, kind = 'main', cut = at + 1, orders = '') {
  if (!enabled(active, kind)) return messages;
  const notices = messages.slice(0, at).filter(m => m.role === 'custom' && NOTICES.has(m.customType));
  const first = messages[at], rest = messages.slice(Math.max(at + 1, cut));
  if (!first) throw new Error('OptChat has no current message.');
  const head = [...(orders ? [{ type: 'text' as const, text: orders }] : []), { type: 'text' as const, text: view }, ...(memories ? [{ type: 'text' as const, text: memories }] : [])];
  if (first.role === 'user')
    return [...notices, { ...first, content: [...head, ...(typeof first.content === 'string' ? [{ type: 'text' as const, text: first.content }] : first.content)] }, ...rest];
  if (cut > at + 1 && first.role === 'custom') {
    const content = typeof first.content === 'string' ? [{ type: 'text' as const, text: first.content }] : first.content;
    return [...notices, { role: 'user' as const, content: [...head, ...content], timestamp: first.timestamp }, ...rest];
  }
  return [...notices, { role: 'user' as const, content: head, timestamp: first.timestamp }, first, ...rest];
}
/** Count raw content, not model tokens or transport metadata. UTF-8 makes this deterministic across models. */
export function rawBytes(messages: AgentMessage[], from: number): number {
  let bytes = 0;
  for (let i = from; i < messages.length; i++) {
    const message = messages[i];
    if (!('content' in message)) { bytes += Buffer.byteLength(JSON.stringify(message), 'utf8'); continue; }
    if (typeof message.content === 'string') { bytes += Buffer.byteLength(message.content, 'utf8'); continue; }
    for (const block of message.content) {
      if (block.type === 'text') bytes += Buffer.byteLength(block.text, 'utf8');
      else if (block.type === 'toolCall') bytes += Buffer.byteLength(block.name + JSON.stringify(block.arguments), 'utf8');
      else if (block.type === 'thinking') bytes += Buffer.byteLength(block.thinking, 'utf8');
      else bytes += Buffer.byteLength(JSON.stringify(block), 'utf8');
    }
  }
  return bytes;
}
export function providerPayload(payload: unknown, active: boolean, kind: string, api: string | undefined) {
  return enabled(active, kind) && api === 'anthropic-messages' ? cachePayload(payload) : payload;
}
