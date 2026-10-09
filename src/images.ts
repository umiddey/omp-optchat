import { createHash } from 'node:crypto';
import type { ImageContent } from '@oh-my-pi/pi-ai';
import { resizeImage } from '@oh-my-pi/pi-coding-agent/utils/image-resize';
import { isMime, type Store } from './store.ts';

const IMAGE_LIMITS = { maxWidth: 2048, maxHeight: 2048, maxBytes: 2 * 1024 * 1024, jpegQuality: 85, minDimension: 1 };
const hash = (image: ImageContent) => createHash('sha256').update(image.data).digest('hex').slice(0, 16);
/** Stable content-addressed reference to the original image bytes. */
export const imageRef = (image: ImageContent) => `[image ${hash(image)}]`;
const REF = /\[image ([0-9a-f]{16})\]/g;

export const isImage = (part: unknown): part is ImageContent => typeof part === 'object' && part !== null
  && 'type' in part && part.type === 'image' && 'data' in part && typeof part.data === 'string' && 'mimeType' in part && typeof part.mimeType === 'string';

/** Keeps each image once, using OMP's resizer with the upstream image limits. */
export async function saveImages(store: Store, content: unknown) {
  if (!Array.isArray(content)) return;
  for (const image of content.filter(isImage)) {
    const name = hash(image);
    if (await store.image(name)) continue;
    const kept = await resizeImage(image, IMAGE_LIMITS);
    if (isMime(kept.mimeType)) await store.putImage(name, kept.mimeType, kept.buffer);
  }
}

/** The kept images a text refers to, in order, each once; ones never kept are skipped. */
export async function loadImages(store: Store, text: string): Promise<ImageContent[]> {
  const names = [...new Set(Array.from(text.matchAll(REF), match => match[1]))];
  return (await Promise.all(names.map(name => store.image(name))))
    .flatMap(kept => kept ? [{ type: 'image' as const, data: Buffer.from(kept.data).toString('base64'), mimeType: kept.mimeType }] : []);
}
