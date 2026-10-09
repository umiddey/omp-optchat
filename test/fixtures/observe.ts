import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ExtensionAPI } from '@oh-my-pi/pi-coding-agent';
/** Smoke-only observer: records provider input without returning a replacement. */
export default function observe(pi: ExtensionAPI) {
  let sequence = 0;
  pi.on('before_provider_request', (event, ctx) => {
    const dir = process.env.OPTCHAT_OBSERVER_DIR;
    if (!dir) return;
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, `${String(++sequence).padStart(6, '0')}-${ctx.agent.kind}.json`), JSON.stringify(event.payload, null, 2));
  });
}
