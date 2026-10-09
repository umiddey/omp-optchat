import { record } from './cache.ts';
export interface Block { bytes: string; marked: boolean; view: boolean; whole: boolean }
function clean(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(clean);
  if (!record(value)) return value;
  return Object.fromEntries(Object.entries(value).filter(([key]) => key !== 'cache_control').map(([key, item]) => [key, clean(item)]));
}
export function sequence(payload: unknown): Block[] {
  if (!record(payload)) throw new Error('Invalid payload');
  const blocks: Block[] = [];
  let inView = false;
  const add = (value: unknown, role?: unknown) => {
    if (record(value) && value.type === 'text' && typeof value.text === 'string' && value.text.startsWith('<chat>\n')) inView = true;
    const view = inView;
    const whole = view && record(value) && typeof value.text === 'string' && value.text.endsWith('\n') && !value.text.endsWith('\n</chat>');
    blocks.push({ bytes: JSON.stringify({ role, block: clean(value) }), marked: record(value) && !!value.cache_control, view, whole });
    if (inView && record(value) && typeof value.text === 'string' && value.text.endsWith('</chat>')) inView = false;
  };
  for (const section of [payload.tools, payload.system]) if (Array.isArray(section)) for (const block of section) add(block);
  if (Array.isArray(payload.messages)) for (const message of payload.messages) if (record(message)) {
    if (Array.isArray(message.content)) for (const block of message.content) add(block, message.role);
    else add({ type: 'text', text: message.content }, message.role);
  }
  return blocks;
}
export function compare(previous: Block[], current: Block[]) {
  let prefix = 0;
  while (prefix < Math.min(previous.length, current.length) && previous[prefix].bytes === current[prefix].bytes) prefix++;
  const reusable = previous.flatMap((b, i) => b.marked && i < prefix ? [i] : []).filter(old => current.some((b, i) => b.marked && i >= old && i - old <= 20));
  const cached = reusable.length ? Math.max(...reusable) + 1 : 0;
  const bytes = current.reduce((sum, b) => sum + Buffer.byteLength(b.bytes), 0);
  const share = bytes ? current.slice(0, cached).reduce((sum, b) => sum + Buffer.byteLength(b.bytes), 0) / bytes : 0;
  return { prefix, reusable: reusable.length > 0, share };
}
