import type { ExtensionAPI } from '@oh-my-pi/pi-coding-agent';
import { PAGE, type Memory } from './memory.ts';
import { loadImages } from './images.ts';
export const result = (text: string) => ({ content: [{ type: 'text' as const, text }], details: {} });
export function registerMemoryTools(pi: ExtensionAPI, memory: () => Memory) {
  const z = pi.zod;
  pi.registerTool({ name: 'zoom', label: 'Zoom memory', loadMode: 'essential', defaultInactive: true, approval: 'read',
    description: `Open line id+n into the two summaries underneath; n=1 gives the original message and its images. Messages over ${PAGE} characters are paged with offset and limit.`,
    parameters: z.object({ id: z.number().int().min(0), n: z.number().int().min(1).optional(), offset: z.number().int().min(0).optional(), limit: z.number().int().min(1).max(PAGE).optional() }),
    async execute(_id, { id, n = 1, offset, limit }, _signal, _onUpdate, ctx) {
      if (ctx.agent.kind !== 'main') throw new Error('OptChat is not active in child sessions.');
      const m = memory(), text = m.zoom(id, n, offset, limit), page = result(text);
      return n === 1 ? { ...page, content: [...page.content, ...await loadImages(m.store, text)] } : page;
    },
  });
  pi.registerTool({ name: 'date', label: 'Memory date', loadMode: 'essential', defaultInactive: true, approval: 'read', description: 'The date and time of message id.',
    parameters: z.object({ id: z.number().int().min(0) }),
    async execute(_id, { id }, _signal, _onUpdate, ctx) {
      if (ctx.agent.kind !== 'main') throw new Error('OptChat is not active in child sessions.');
      return result(memory().date(id));
    },
  });
}
