# omp-optchat — design and cache contract

OptChat (Victor Taelin's recipe) as an OMP 18.8.3 extension. One chat that never ends: every message is
logged, compressed into a binary tree of ≤512-byte lines, and each turn the model sees
`[tools][system][orders][view][current turn]` instead of the OMP session history.

Sources (read-only references):
- Recipe: https://gist.github.com/VictorTaelin/91837951a5ce5b38f341ec1ba1df6449 (the spec; section numbers below refer to it).
- Port source: https://github.com/jonaslsaa/pi-optchat @ `6804bec30c564e0a9500d54ddb7d9a3ba6869e53` (MIT, Jonas Silva). Pi extension
  implementing the recipe. Port its core; keep its LICENSE notice in `THIRD_PARTY_NOTICES.md`.
- OMP 18.8.3 source: `npm pack @oh-my-pi/{pi-coding-agent,pi-ai,pi-agent-core}@18.8.3` (same version as `omp --version`);
  file:line references below are into those packages' `src/`.
- OMP docs: `omp://extensions.md`, `omp://extension-loading.md`, `omp://hooks.md`.

## Scope

In: log, tree, view (due-order sawtooth), compactor (ruler, too-long retry, ≤8 parallel, queues), view.json
persistence, `zoom`/`date` tools, OMP turn integration, Anthropic cache marks, tests, cache verification.
Out (not now): profile picker UI, imports, OptChat's own subagents/spawn/tell, connected windows, inspector,
browser export, usage ledger, "previous exchange", memory search. OMP's own `task` subagents keep working and
their results are logged like any tool result.

## Activation

- Opt-in only. Active when the main session is started with `--optchat <profile>` (registerFlag, string) or env
  `OMP_OPTCHAT=<profile>`. Otherwise every handler returns `undefined` and the tools stay inactive: a plain
  OMP session must be byte-identical to today's.
- Never active in subagents / advisors: check `ctx.agent.kind === "main"` (see `omp://extensions.md`, "Handler
  context"). Child sessions rebind the same factory.
- Data dir: `${OMP_OPTCHAT_HOME ?? ~/.omp/optchat}/<profile>/` (log, tree, view.json, config.json, lock).
- One process per profile (recipe §1 "one process owns a chat"): lock with PID + liveness check (port
  pi-optchat `profiles.ts` lock logic, simplified). A second OMP on a held profile: TUI → notify error and
  refuse input (`input` handler returns handled); print/rpc → throw. No silent fallback to plain OMP.
- `config.json`: `{ "compactor": { "provider": "anthropic", "model": "claude-haiku-5-5", "thinking": "xhigh" }, "runLimit": 256000 }`
  defaults; editable by hand. Missing `runLimit` uses 256000; invalid/nonpositive/noninteger values fail clearly.
  Existing profile configs retain their explicit effort; only new profiles default to xhigh.

### Recipe conformance and deliberate operational deviations

The compaction prompt follows recipe §5 verbatim, renaming Unii→OptChat and unii→talk
(the persisted reply kind). The device-tools paragraph is omitted because this extension exposes no device tools.
The turn prompt adds a static standing-orders paragraph; compaction tasks, the ruler, and too-long retry text follow §4 verbatim.
New nodes use the restored prompt; persisted nodes are never rebuilt or migrated.

Compactors deliberately send their own system prompt, without OMP's system instructions or tools.
Turns run on Opus/Codex and compactions on Haiku: prompt caches are per model, so the recipe's
turn/compaction cache sharing cannot occur here. Sending OMP's roughly 30k-token prompt and tools
to Haiku would only add input. The compactor's OptChat text is still the verbatim §5 prompt.

Normal starts load the persisted view and do not rebuild it. Missing, corrupt, or unreadable
view.json triggers a recovery path that reconstructs coverage from the authoritative log and
built nodes; this deliberately sacrifices cache continuity only after loss/damage.

If all pending compactions fail, a turn may proceed with the recipe-defined
`(not summarized yet: zoom it)` placeholders rather than block the chat indefinitely.
Failed nodes are retried at the next message (§4), and additionally after a 10-second
availability timer even without a new message. Compaction views, unlike turn views,
stop at the first unbuilt line and never contain placeholders.

Non-tool text longer than 30,000 UTF-16 characters is logged losslessly as consecutive
messages of the same kind and date, without splitting surrogate pairs. The recipe does not
specify a chunk size; we use the tool-output character budget. Tool output is still clipped
head/tail, not split. Existing long messages remain readable through paged zoom.

Our reading of “view passes 128,000 bytes” is the sum of node text sizes (flat
UTF-8 summary content), excluding `id+n|` labels, separators, and the `<chat>` envelope.
The same accounting applies to the 64 KB low bound and 16–32 KB compaction view.
The recipe's node records store `size`, but its prose is ambiguous about framing.
We deliberately keep existing accounting: framing is a few percent and changing it
would rewrite an existing profile's view and invalidate its cache continuity.

### Deliberate extension: standing orders outside the tree

The recipe's time-shaped merges squeeze two 512-byte lines into one. In the owner's measured
case, message 24's full PM goal shortened at 16+16 and disappeared at 0+32. A replay of
135 compactions retained only 16/30 lost orders, and 0/18 full PM goals, even with the exact
recipe prompt and Haiku xhigh. Prompt tuning cannot provide durable standing-order storage.

`src/orders.ts` therefore owns an independent append-only extraction log and atomic ledger.
Every genuine user log entry (excluding any `[customType] ` shown-message prefix) gets one
background model extraction, including an empty-array record. The profile compactor model/effort
is reused; failures retry with the compactor's ten-second availability policy. Duplicate ids
are never appended. Backfill extracts missing historical ids on session start without blocking
a normal turn, then creates the first ledger once; saved ledgers are never recomputed on restart.

Only a chat view merge batch publishes subsequent ledger changes. Its inclusive message point
selects extraction records after `ledger.through`; the turn waits for extraction and consolidation
at that boundary, like summary completion. New view and ledger are captured together for the
run. Later contradictions revoke/replace older wording; duplicates merge with source ids.
The rendered consolidated block must be <=16000 UTF-8 bytes; validation rejects, not truncates,
oversized output. Three failed attempts retain old ledger plus raw new orders; `ledger.json`'s
optional `raw` field durably preserves this fallback without advancing `through`. Next batch
tries again. A lossless failure fallback may exceed the normal consolidated bound.

The `<orders>` text block precedes the separate `<chat>` block in the same opening user message.
Cache splitting still starts at `<chat>` and uses the identical four-line partition; no ledger
line shifts a view cache mark. The static turn paragraph contains no dates. Tools/system retain
their own fallback mark. Between view rewrites the orders bytes are identical; the first backfill
publication permits one cache rewrite. The ledger never modifies tree nodes or rebuilds the view.


## Turn integration (OMP hooks)

| Hook | Behavior when active |
|---|---|
| `session_start` | open memory + lock; activate tools `zoom`,`date`; runtime-override OMP auto-compaction off (setting `compaction.enabled`, `pi-coding-agent/src/session/context-settings.ts`; `lookup(id).override(pi.pi.settings,false)`, never persisted); status line. |
| `session_before_compact` | `{ cancel: true }` (backstop). |
| `before_agent_start` | Return `systemPrompt` = `event.systemPrompt` with (a) every element starting with `<memories>` removed; it is stashed for this run only when the profile config sets `"memories": true` (default `false`: recall is dropped, since it changes every turn and would be rewritten at every turn start), (b) the OptChat static prompt inserted as its own element immediately before the first element starting with `<project-context>` (or appended if none). Static = byte-identical every call: no dates, ids, counts. |
| `message_end` | Buffer the message in `run` (pi-optchat `index.ts` 326-362 pattern). Messages are logged after the initial view is frozen; mid-run rollover may incorporate them into the next frozen view. |
| `context` | See below. |
| `before_provider_request` | Anthropic payloads only (`ctx.model?.api === "anthropic-messages"`): cache marks (below). Other APIs: return payload unchanged. |
| `agent_start` / `agent_end` | run boundaries (view = undefined at start; flush log at end). |

`context` handler (main + active):
1. First call of a run: `await memory.settle(signal)` (show `ctx.ui.setWorkingMessage` while waiting, like
   pi-optchat 369-382), `view = memory.render()`, then flush `run` into the log.
2. Turn start = the message in `event.messages` matching `run[0]` (role + timestamp; search from the end). If
   `run` is empty (auto-continuation), use the last user-role message. Never send anything before turn start
   except the allowlisted OMP notices below.
3. Return `[ ...notices, ...event.messages.slice(turnStart) ]` with the first user message of that slice
   rewritten to content `[ {text: view}, {text: stashedMemories}?, ...originalContent ]`.
4. Notices kept from before turn start (stable persisted bytes; they deliver tool/xd:// roster deltas once):
   custom messages whose `customType` equals the values of `TOOL_ROSTER_NOTICE_MESSAGE_TYPE`,
   `EVAL_PRELUDE_NOTICE_MESSAGE_TYPE`, `SESSION_AGENT_NOTICE_MESSAGE_TYPE`, `XDEV_MOUNT_NOTICE_MESSAGE_TYPE`
   (used in `pi-coding-agent/src/session/session-tools.ts` ~1515-1718; grep the constant values).
5. Not in a run (side turns, `/btw`, handoff call `transformContext` too): never send full history. Build from
   `memory.render()` (no settle wait) + messages after the last run's turn start.
6. Any failure: `ctx.abort()` and return a single system message "OptChat context unavailable. Stop." —
   never fall back to the full OMP history (pi-optchat 385-391).

### Long-run rollover: deliberate recipe deviation

The recipe assumes short turns and has no mid-run rule. OMP orchestration can remain in one run for hours,
so disabling native compaction requires an additional raw-tail bound. During `context`, count UTF-8 bytes
of content after the opening message (or from the last cut): text, thinking, tool names + JSON arguments,
tool results, custom content, and other content blocks. Transport/usage metadata is not counted.
When this exceeds `runLimit`, select the latest assistant in `event.messages`, not the possibly incomplete
fire-and-forget `message_end` buffer. Advance only if it is after the current cut. Catch up and flush
messages before the cut without duplicate logging, wait with the same summaries working message and
`settle(signal)` as run start, then render a new view. Send notices, one user opening containing the new
view + moved memories + the original first message content, and the latest assistant plus all following
tool results/injections unchanged. An individual assistant/tool batch can exceed the bound until a newer
assistant exists: never split tool-use/result pairs or discard the last assistant's thinking.
Store the cut message, not its array index. Resolve its role + timestamp with `findLastIndex` on every
context call, so inserted history cannot move the boundary. If rewritten history no longer contains the
cut, fall back to the run opening's next message and run the normal limit check on that same request;
missing cuts never fault the session and may immediately select a fresh latest-assistant boundary.

Between cuts the view and cut are fixed: requests only extend the same prefix. Across cuts the view appends
lines unless a 128 KB merge batch fires. Existing view marks therefore retain tools + system + old whole
view blocks in the shared cache prefix; the new tail is written. A merge has the same accepted cache cost
as at turn start. No cache-mark changes are required. I1 applies between cuts; I2/I3 apply across cuts as
well as across runs. Main-agent and opt-in guards remain unchanged.

Logging (recipe §1, pi-optchat `transcript.ts` `logMessage`/`boundedMessage`): user → `user`; assistant text →
reply kind; tool calls → `tool` (`name JSON`); tool results → `echo`, head+tail capped to 30,000 chars; displayed
custom messages → `user` text prefixed `[customType] `, except `async-result` and `irc:incoming` → `work`;
task/async reports end with `Full chat: zoom("Name")` per agent (preserved inside capped task
tool output; async/IRC work text is never clipped and instead uses lossless message chunks).
Hidden custom messages and thinking → not logged.

Agent transcript navigation (recipe §6): `zoom("Name")` accepts a string `id`, renders the OMP transcript
as `kind|text` lines (newlines escaped; tool results head+tail ~500 characters), and shares original-message
offset/limit paging at 25,000 characters, including Unicode surrogate boundaries. Numeric zoom is unchanged.
The profile's `agents.jsonl` is append-only and fsynced, recording name, absolute transcript path, session
file and creation date. Names in task results, shown async deliveries and peer messages are resolved under
`ctx.sessionManager.getSessionFile()` without `.jsonl`; `agent_end` recursively discovers all child transcripts.
Only existing transcript paths are indexed. A name reported before its file exists waits for discovery;
unknown-name resolution also scans the current session's child tree so zoom works before `agent_end`.
Discovery checks the in-memory name/path key before opening a header; known files are never reread by scans.
Names survive profile restarts; duplicates select the newest creation date and list other matches with
`Name@<ISO date>` selectors (or `Name@<absolute transcript path>` for exact selection, including tied dates).
Unknown names list nearby names; removed transcripts give a clear error. Match metadata is outside paged offsets.
Only active main sessions write the index; transcript files themselves are never modified.

## Cache contract (the reason this exists)

Measured baseline (this machine, plain OMP, one session): cacheRead/(cacheRead+cacheWrite+input) ≈ 0.95.

Facts from OMP 18.8.3 source:
- `pi-ai/src/providers/anthropic.ts` `applyHeadCaching` (4083) marks the last tool + the last system block before
  the first volatile block (`<memories>`, `<project-context>`); `applyPromptCaching` (3901) adds ≤2 message marks.
  Max 4 marks. `onPayload` (2280) runs after both, so `before_provider_request` sees and may replace them.
- Mark TTL: OAuth sessions get `{type:"ephemeral", ttl:"1h"}` (`getCacheControl`, 545). Never hardcode a TTL:
  reuse the `cache_control` object OMP already put in the payload. If the payload has none, add no marks.
- `<memories>` (Mnemopi recall) is rebuilt per turn inside the system prompt (`hindsight/content.ts` 34,
  `mnemopi/state.ts` 1005). Left there, it changes every turn and re-bills the whole view → it MUST move after
  the view (before_agent_start + context steps above).
- `session/date-cwd-reminder.ts`: OMP prepends `<system-reminder>\nToday: …` as a text block to the FIRST user
  message of every request (the view message). Its bytes change daily / per cwd → in the Anthropic payload,
  move that block to directly after the view blocks.
- `extensions/runner.ts` 2022-2030: messages a `context` hook changes are marked per-call; OMP's own message
  marks avoid them. Irrelevant once we own all marks, but explains why OMP's default marks would miss the view.

Mark placement in `before_provider_request` (port pi-optchat `src/cache.ts`, change TTL handling):
1. Find the view text block (starts with `<chat>\n`); split it into 4-line blocks counted from its start
   (`splitView`), byte-identical concatenation.
2. Remove every existing `cache_control` (tools, system, messages). Place marks on the last system block (fallback
   entry: tools + system are stable for the session, so a turn whose view marks find nothing still reads them),
   the view's last whole block and the block 20 before it (when it exists), plus one on the last cacheable block of
   the request (skip thinking/redacted_thinking/empty text) — total ≤ 4. Without a system block the third view mark
   (40 back) is used instead. Found live 2026-10-09: with view marks only, a new profile's first turns (view < 4
   lines, no view mark) re-wrote the whole ~30k-token prefix every turn.
3. Move the date/cwd reminder block after the view blocks (inside the same user message).
4. Optional debug: when `OMP_OPTCHAT_DUMP_DIR` is set, write each final payload as
   `<dir>/<seq>-<agentKind>.json` (main only unless dumping children for the subagent check).

Invariants (tests must enforce):
- I1 Within a run, request k+1's block sequence (tools → system → messages, `cache_control` stripped) starts with
  request k's full sequence except OMP-appended per-call tail blocks.
- I2 Across runs without a batch merge, run N+1's first request shares with run N's requests every block up to
  and including the old view's last whole block, and one of run N's marks lies in that shared prefix within 20
  blocks before a mark of run N+1.
- I3 A batch merge (view > 128,000 bytes → ≤ 64,000) is the only event allowed to break I2; at most once per batch.
- I4 System prompt bytes identical across all runs of one session/cwd (OptChat block static; `<memories>` gone).
- I5 ≤ 4 marks; every mark copies OMP's original `cache_control` (same `ttl`).
- I6 Inactive (no flag) → payload, context and system prompt untouched (deep-equal to input).
- I7 Child/advisor sessions → untouched.

## Verification (acceptance)

- `bun test` green: ported core tests (memory/tree/view due order incl. "matches push for t=0..20000" if
  pi-optchat has it; compactor size/retry; store; paged zoom) + new tests for I1-I7 using synthetic Anthropic
  payloads and a fake compressor.
- `scripts/cache-check.ts <dumpDir> [sessionJsonl]`: per request, longest common block prefix with the previous
  request, whether a previous mark is reusable (Anthropic 20-block lookback), predicted cached share; and, when
  given the OMP session jsonl, the real `usage` per assistant message (`input`, `cacheRead`, `cacheWrite`).
- Real smoke in OMP 18.8.3 (`omp --mode rpc` or several `omp -p` runs on one profile, temp
  `OMP_OPTCHAT_HOME`, extension loaded with `-e /home/ukd/projects/omp-optchat/src/index.ts`, default model):
  profile seeded with ~200 short `note` messages (<512 B, no model calls) so the view spans ~50 blocks; ≥5 turns
  incl. one with ≥3 tool calls and one that calls `zoom`. Pass: real cacheRead share ≥ 0.85 on every request of
  turns ≥2 except the turn after a batch merge; checker reports 0 unexpected breaks; summaries built; view.json
  persisted; second process on the same profile refused; a plain `omp -p` without the flag shows no `<chat>`.
