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
export function projectContext(messages: AgentMessage[], at: number, view: string, memories: string, active = true, kind = 'main') {
  if (!enabled(active, kind)) return messages;
  const notices = messages.slice(0, at).filter(m => m.role === 'custom' && NOTICES.has(m.customType));
  let injected = false;
  const current = messages.slice(at).map(message => {
    if (message.role !== 'user' || injected) return message;
    injected = true;
    return { ...message, content: [{ type: 'text' as const, text: view }, ...(memories ? [{ type: 'text' as const, text: memories }] : []),
      ...(typeof message.content === 'string' ? [{ type: 'text' as const, text: message.content }] : message.content)] };
  });
  if (!injected) throw new Error('OptChat has no current user message.');
  return [...notices, ...current];
}
export function providerPayload(payload: unknown, active: boolean, kind: string, api: string | undefined) {
  return enabled(active, kind) && api === 'anthropic-messages' ? cachePayload(payload) : payload;
}
