import type { AgentMessage } from '@oh-my-pi/pi-agent-core';
import { CAP, cap, type Memory } from './memory.ts';
import { imageRef, isImage } from './images.ts';
import { z } from '@oh-my-pi/pi-coding-agent';

const detailsSchema = z.object({ progress: z.array(z.unknown()).optional(), results: z.array(z.unknown()).optional(), jobs: z.array(z.unknown()).optional(), from: z.string().optional() });
const agentSchema = z.object({ id: z.string().optional(), jobId: z.string().optional(), type: z.string().optional() });
/** Names advertised by OMP; never interpret tool output or arbitrary custom text as a path. */
export function agentNames(message: AgentMessage): string[] {
  if (!(message.role === 'toolResult' && message.toolName === 'task') &&
      !(message.role === 'custom' && message.display && ['async-result', 'irc:incoming'].includes(message.customType))) return [];
  const parsed = detailsSchema.safeParse(message.details);
  if (!parsed.success) return [];
  const details = parsed.data, names: string[] = [];
  if (message.role === 'custom' && message.customType === 'irc:incoming' && details.from) names.push(details.from);
  for (const item of [...details.progress ?? [], ...details.results ?? [], ...details.jobs ?? []]) {
    const agent = agentSchema.safeParse(item);
    if (!agent.success || (agent.data.type && agent.data.type !== 'task')) continue;
    const name = agent.data.id ?? agent.data.jobId;
    if (name) names.push(name);
  }
  return [...new Set(names.filter(name => /^[\w.-]+$/.test(name)))];
}
const reportText = (text: string, names: string[], toolOutput = true) => {
  const trailer = names.map(name => `Full chat: zoom(${JSON.stringify(name)})`).join('\n');
  if (!toolOutput) return trailer ? text + '\n' + trailer : text;
  return trailer ? cap(text, CAP - trailer.length - 1) + '\n' + trailer : cap(text);
};
export function textContent(content: unknown, images = true): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.map((part: unknown) => {
    if (typeof part !== 'object' || part === null) return '';
    if ('type' in part && part.type === 'text' && 'text' in part && typeof part.text === 'string') return part.text;
    if (images && isImage(part)) return imageRef(part);
    return '';
  }).filter(Boolean).join('\n');
}
export function asUser(message: AgentMessage): AgentMessage {
  if (message.role !== 'custom' || !message.display) return message;
  const { content, customType, timestamp } = message;
  const tag = `[${customType}] `;
  if (typeof content === 'string') return { role: 'user', content: tag + content, timestamp };
  const [first, ...rest] = content;
  if (first?.type === 'text') return { role: 'user', content: [{ ...first, text: tag + first.text }, ...rest], timestamp };
  return { role: 'user', content: [{ type: 'text', text: tag.trimEnd() }, ...content], timestamp };
}
export function logMessage(memory: Memory, original: AgentMessage) {
  const message = asUser(original);
  const date = new Date(message.timestamp).toISOString();
  if (original.role === 'custom' && original.display && ['async-result', 'irc:incoming'].includes(original.customType)) {
    memory.append('work', reportText(`[${original.customType}] ${textContent(original.content)}`, original.customType === 'async-result' ? agentNames(original) : [], false), date);
    return;
  }
  if (message.role === 'user') memory.append('user', textContent(message.content), date);
  else if (message.role === 'assistant') {
    for (const block of message.content) {
      if (block.type === 'text' && block.text.trim()) memory.append('talk', block.text, date);
      if (block.type === 'toolCall') memory.append('tool', `${block.name} ${JSON.stringify(block.arguments)}`, date);
    }
    if (message.stopReason === 'error' || message.stopReason === 'aborted')
      memory.append('echo', `Agent ${message.stopReason}: ${message.errorMessage ?? 'No further details'}`, date);
  } else if (message.role === 'toolResult')
    // A zoom's page already names the images it returns.
    memory.append('echo', reportText(`${message.toolName}: ${textContent(message.content, message.toolName !== 'zoom')}`, agentNames(original)), date);
}
export function boundedMessage(message: AgentMessage): AgentMessage {
  if (message.role !== 'toolResult') return message;
  const text = message.content.filter(c => c.type === 'text').map(c => c.text).join('\n');
  if (text.length <= CAP) return message;
  return { ...message, content: [{ type: 'text', text: cap(text) }, ...message.content.filter(c => c.type === 'image')] };
}
