import type { ExtensionAPI } from '@oh-my-pi/pi-coding-agent';
import { PAGE, type Memory } from './memory.ts';
import { loadImages } from './images.ts';
import type { AgentIndex } from './agents.ts';
export const result = (text: string) => ({ content: [{ type: 'text' as const, text }], details: {} });
export function registerMemoryTools(pi: ExtensionAPI, memory: () => Memory, agents: () => AgentIndex) {
  const z = pi.zod;
  pi.registerTool({ name: 'zoom', label: 'Zoom memory', loadMode: 'essential', defaultInactive: true, approval: 'read',
    description: `Open numeric line id+n into the two summaries underneath; n=1 gives the original message and its images. zoom("Name") (id as a string) opens a subagent's whole chat as kind|text lines, with tool results showing their first and last ~500 characters. Duplicate names choose the newest transcript and list other matches with dates: use zoom("Name@<ISO date>") or zoom("Name@<absolute transcript path>") to select one. Messages and transcripts over ${PAGE} characters are paged with offset and limit; use the next offset shown. Transcript offsets count only kind|text body characters, not match metadata.`,
    parameters: z.object({ id: z.union([z.number().int().min(0), z.string().min(1)]), n: z.number().int().min(1).optional(), offset: z.number().int().min(0).optional(), limit: z.number().int().min(1).max(PAGE).optional() }),
    async execute(_id, { id, n = 1, offset, limit }, _signal, _onUpdate, ctx) {
      if (ctx.agent.kind !== 'main') throw new Error('OptChat is not active in child sessions.');
      const m = memory();
      if (typeof id === 'string') {
        if (n !== 1) throw new Error('Agent transcripts use offset/limit paging, not n.');
        return result(agents().zoom(id, offset, limit));
      }
      const text = m.zoom(id, n, offset, limit), page = result(text);
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
