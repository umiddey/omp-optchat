import type { AgentMessage } from '@oh-my-pi/pi-agent-core';
import { CAP, type Kind } from './memory.ts';
import { textContent } from './transcript.ts';

/** Experimental grouped-tool-exchange units (not production OptChat): one recorded transcript replayed into a real
 * Memory twice — once message-per-entry (the shipped logging) and once with each assistant message grouped with the
 * tool results of its own tool calls. Grouping never crosses a user or shown-custom boundary, never merges two
 * assistants, never attaches a result to a call that is not its own, and never orphans a result whose call is absent.
 * The log stays authoritative: a group renders one entry whose text carries every original line verbatim, so zoom
 * retrieval of the exact originals stays assertable in both modes. */

export type UnitKind = 'user' | 'custom' | 'assistant' | 'orphan-result' | 'other';
export interface GroupUnit {
  kind: UnitKind;
  /** Fixture source ids in transcript order; grouped units hold the assistant plus each result it owns. */
  sourceIds: string[];
  messages: AgentMessage[];
  /** True when any tool result in the unit reports isError. */
  error: boolean;
  /** True when a parallel assistant (multiple toolCall blocks) contributed the unit's results. */
  parallel: boolean;
}
export interface SourceRef { id: string; index: number }

/** Split a recorded transcript into replay units. user/custom messages are boundaries; an assistant opens a group
 * that collects every following toolResult until the next boundary; a result with no open group stands alone. */
export function groupTranscript(messages: readonly AgentMessage[]): GroupUnit[] {
  const units: GroupUnit[] = [];
  let open: GroupUnit | undefined;
  messages.forEach((message, index) => {
    const source: SourceRef = { id: `s${index}`, index };
    if (message.role === 'user') {
      open = undefined;
      units.push({ kind: 'user', sourceIds: [source.id], messages: [message], error: false, parallel: false });
    } else if (message.role === 'custom') {
      open = undefined;
      units.push({ kind: 'custom', sourceIds: [source.id], messages: [message], error: false, parallel: false });
    } else if (message.role === 'assistant') {
      open = undefined;
      open = { kind: 'assistant', sourceIds: [source.id], messages: [message],
        error: false, parallel: message.content.filter(block => block.type === 'toolCall').length > 1 };
      units.push(open);
    } else if (message.role === 'toolResult') {
      // A result joins the open group only while its own call is the group's latest unanswered one.
      let joined = false;
      if (open) {
        const head = open.messages[0];
        const answered = open.messages.slice(1).flatMap(m => m.role === 'toolResult' ? [m.toolCallId] : []);
        joined = head.role === 'assistant'
          && head.content.some(block => block.type === 'toolCall' && block.id === message.toolCallId)
          && !answered.includes(message.toolCallId);
      }
      if (joined) {
        open!.sourceIds.push(source.id);
        open!.messages.push(message);
        if (message.isError === true) open!.error = true;
      } else {
        open = undefined;
        units.push({ kind: 'orphan-result', sourceIds: [source.id], messages: [message],
          error: message.isError === true, parallel: false });
      }
    } else {
      open = undefined;
      units.push({ kind: 'other', sourceIds: [source.id], messages: [message], error: false, parallel: false });
    }
  });
  return units;
}

/** One Memory entry per unit: the exact line formats transcript.ts logs, joined so every original stays verbatim.
 * Returns null for messages the shipped logging skips (hidden custom). */
export function unitEntry(unit: GroupUnit): { kind: Kind; text: string } | null {
  const [first] = unit.messages;
  if (unit.kind === 'user') {
    if (first.role !== 'user') return null;
    return { kind: 'user', text: textContent(first.content) };
  }
  if (unit.kind === 'custom') {
    if (first.role !== 'custom' || first.display !== true) return null;
    if (!['async-result', 'irc:incoming'].includes(String(first.customType))) return null;
    return { kind: 'work', text: `[${first.customType}] ${textContent(first.content)}` };
  }
  if (unit.kind === 'orphan-result' || unit.kind === 'other') {
    // Non-transcript roles (developer, bashExecution, …) are skipped by the shipped logging too.
    if (unit.kind === 'other' || first.role !== 'toolResult') return null;
    const name = String(first.toolName), body = textContent(first.content, name !== 'zoom');
    const text = body.length > CAP ? `${body.slice(0, CAP)}\n[${body.length - CAP} characters omitted]` : body;
    return { kind: 'echo', text: `${name}: ${text}` };
  }
  // A grouped unit is always built around an assistant message.
  if (first.role !== 'assistant') return null;
  const lines: string[] = [];
  for (const block of first.content) {
    if (block.type === 'text' && block.text.trim()) lines.push(block.text);
    if (block.type === 'toolCall') lines.push(`${block.name} ${JSON.stringify(block.arguments)}`);
  }
  if (first.stopReason === 'error' || first.stopReason === 'aborted')
    lines.push(`Agent ${first.stopReason}: ${first.errorMessage ?? 'No further details'}`);
  for (const result of unit.messages.slice(1)) {
    if (result.role !== 'toolResult') continue;
    const name = String(result.toolName), body = textContent(result.content, name !== 'zoom');
    const text = body.length > CAP ? `${body.slice(0, CAP)}\n[${body.length - CAP} characters omitted]` : body;
    lines.push(`${name}: ${text}`);
  }
  return lines.length ? { kind: 'talk', text: lines.join('\n') } : null;
}

/** Groups whose rendered entry carries a fixture line over the 512-byte node budget, so real compaction must run. */
export function oversizedUnits(units: readonly GroupUnit[]): GroupUnit[] {
  return units.filter(unit => {
    const entry = unitEntry(unit);
    return entry !== null && Buffer.byteLength(`${entry.kind}: ${entry.text}`, 'utf8') > 512;
  });
}

export interface RetrievalCheck { sourceId: string; pass: boolean; detail: string }
export interface RetrievalAccessor { zoom(id: number, n: number): string }

/** The lines the shipped logging writes for one unit, each tagged with the source message it came from — the exact
 * strings retrieval must find, attributable per fixture message. */
function expectedLines(unit: GroupUnit): { sourceId: string; line: string }[] {
  const entry = unitEntry(unit);
  if (!entry) return [];
  if (unit.messages.length === 1) return [{ sourceId: unit.sourceIds[0], line: `${entry.kind}: ${entry.text}` }];
  const lines: { sourceId: string; line: string }[] = [];
  const [assistant] = unit.messages;
  if (assistant.role === 'assistant')
    for (const block of assistant.content) {
      if (block.type === 'text' && block.text.trim()) lines.push({ sourceId: unit.sourceIds[0], line: block.text });
      if (block.type === 'toolCall') lines.push({ sourceId: unit.sourceIds[0], line: `${block.name} ${JSON.stringify(block.arguments)}` });
    }
  unit.messages.slice(1).forEach((result, k) => {
    if (result.role !== 'toolResult') return;
    const name = String(result.toolName), body = textContent(result.content, name !== 'zoom');
    const text = body.length > CAP ? `${body.slice(0, CAP)}\n[${body.length - CAP} characters omitted]` : body;
    lines.push({ sourceId: unit.sourceIds[k + 1], line: `${name}: ${text}` });
  });
  return lines;
}

/** Assert every original line of every unit is retrievable verbatim through the log index each unit landed on, and
 * — when the caller supplies the mode's actual logged texts — that zoom reproduces those entries byte-for-byte.
 * `indexes[i]` lists the log entry ids unit i occupies (one for grouped replay; the shipped logger's entry ids for
 * message-level replay). */
export function checkRetrieval(units: readonly GroupUnit[], indexes: readonly (readonly number[])[],
  memory: RetrievalAccessor, logged?: readonly (readonly string[])[]): RetrievalCheck[] {
  const checks: RetrievalCheck[] = [];
  units.forEach((unit, i) => {
    const ids = indexes[i] ?? [];
    if (!ids.length) { checks.push({ sourceId: unit.sourceIds[0], pass: false, detail: 'no log index' }); return; }
    const rendered = ids.map(id => { try { return memory.zoom(id, 1); } catch (error) { return `ZOOM_ERROR: ${String(error)}`; } }).join('\n');
    for (const text of logged?.[i] ?? []) {
      if (!text) continue;
      const found = rendered.includes(text);
      checks.push({ sourceId: `${unit.sourceIds[0]}#logged`, pass: found,
        detail: found ? 'logged text verbatim' : `logged text missing: ${text.slice(0, 80)}` });
    }
    for (const { sourceId, line } of expectedLines(unit)) {
      const found = rendered.includes(line);
      checks.push({ sourceId, pass: found, detail: found ? 'verbatim'
        : `missing: ${line.slice(0, 80)}` });
    }
  });
  return checks;
}
