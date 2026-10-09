/** The most characters one zoom page returns, below the tool-output cap. */
export const PAGE = 25_000;

/** Character offsets and hints shared by original-message and agent-transcript zoom. */
export function pageText(text: string, label: string, offset?: number, limit?: number): string {
  const page = Math.min(limit ?? PAGE, PAGE);
  if (!Number.isSafeInteger(page) || page < 1) throw new Error('limit must be a positive integer.');
  if (offset === undefined && text.length <= page) return text;
  if (offset !== undefined && (!Number.isSafeInteger(offset) || offset < 0 || offset >= Math.max(1, text.length)))
    throw new Error(`${label} has ${text.length} characters; offset must be 0 to ${Math.max(0, text.length - 1)}.`);
  // A requested low-surrogate offset starts at the pair's high surrogate.
  const from = /[\udc00-\udfff]/.test(text[offset ?? 0] ?? '') ? (offset ?? 0) - 1 : offset ?? 0;
  let to = Math.min(text.length, from + page);
  // A one-unit page takes the whole pair so the next offset always advances.
  if (to < text.length && /[\ud800-\udbff]/.test(text[to - 1])) to += to - 1 === from ? 1 : -1;
  const hint = text.length <= PAGE ? `\n[note: this message is only ${text.length.toLocaleString('en-US')} characters and fits in one zoom; offset/limit are for messages over ${PAGE.toLocaleString('en-US')}]` : '';
  return `${text.slice(from, to)}\n[showing characters ${from}-${to} of ${text.length}${to < text.length ? `; next page: offset ${to}` : ''}]${hint}`;
}
