# OptChat progress

## Done

Milestone 1 committed as `5374d19`: Bun/TypeScript package, OMP 18.8.3 development
pins, MIT notice for pi-optchat 6804bec30c564e0a9500d54ddb7d9a3ba6869e53,
ported log/tree/view/store/compactor/prompts, paged zoom, logging/capping,
Anthropic cache placement and I1–I7 regression tests. First green checkpoint:
47 passing tests, zero failures; TypeScript exit 0.

Milestone 2 complete: opt-in main-agent lifecycle integration, profile lock,
runtime-only compaction override, essential/default-inactive zoom/date,
allowlisted notice preservation, memory relocation, frozen run views,
side-turn projection and abort-on-context-failure. OMP image resizing uses the
verified `@oh-my-pi/pi-coding-agent/utils/image-resize` subpath. Added seed,
cache-check and reproducible RPC smoke scripts. No extension installation,
configuration edits under ~/.omp, reference edits or remote push.

## Usage / repeatable verification

- `OMP_OPTCHAT_HOME=/tmp/optchat-smoke bun scripts/seed-notes.ts smoke 200`
  appends short notes with the Memory API without calling a model.
- Activate with `omp -e /home/ukd/projects/omp-optchat/src/index.ts --optchat <profile>`
  or `OMP_OPTCHAT=<profile>`. Home defaults to ~/.omp/optchat; config.json
  defaults to anthropic/claude-haiku-5-5, medium effort.
- Smoke driver launches the default model, checks competing ownership, five
  turns, sequential tool calls, then plain print-mode inactivity:
  `setsid nohup env OMP_OPTCHAT_HOME=/tmp/optchat-smoke bun /home/ukd/projects/omp-optchat/scripts/smoke.ts <dumpDir> > <log> 2>&1 &`
- `bun scripts/cache-check.ts <dumpDir> <sessionJsonl>` reports actual usage,
  common block prefixes and 20-block-lookback mark reuse; returns nonzero on
  unexpected prefix breaks, missing usage rows or cache-share failures.

## Acceptance

Final smoke: default `anthropic/claude-opus-5-5`, fresh 200-note profile, five
completed turns and nine provider requests. Session:
`/home/ukd/.omp/agent/sessions/-projects-omp-optchat/2026-10-09T16-26-05-396Z_01a1217c-6ed4-722b-b7f2-41f0a0e3881b.jsonl`.
Newest session after the smoke is the separate plain-mode check:
`/home/ukd/.omp/agent/sessions/-projects-omp-optchat/2026-10-09T16-26-30-748Z_01a1217c-d1dc-75e4-a762-8a5d755b7146.jsonl`.

| Item | Command | Observed result | PASS/FAIL |
|---|---|---|---|
| Core/invariant tests | `bun test` | exit 0; 55 pass, 0 fail, 7 files; due-order t=0..20000; fake-compressor batch | PASS |
| TypeScript | `bunx tsc --noEmit` | exit 0 | PASS |
| Seed | `OMP_OPTCHAT_HOME=/tmp/optchat-smoke bun scripts/seed-notes.ts smoke 200` | exit 0; 200 notes, 14,690 view bytes, 200 leaf nodes; no model calls | PASS |
| Real five-turn smoke | detached driver command above; dumpDir `/tmp/optchat-evidence-sol-final-20261009` | launch exit 0; driver completed; RPC and plain subprocesses exit 0 | PASS |
| Cache shares / prefixes | `bun scripts/cache-check.ts /tmp/optchat-evidence-sol-final-20261009 <session above>` | exit 0; 9 usage rows; minimum turn >=2 share 0.9785; zero unexpected prefix breaks | PASS |
| Zoom / several tools | same RPC smoke | successful zoom(0,1); turn 3 executed date(0), zoom(1,1), date(1) sequentially; all four results isError=false | PASS |
| Persisted memory / summaries | smoke plus filesystem evidence | 218 log entries; tree/2026-10-09.jsonl has 431 nodes including 213 merged nodes; view.json exists with 200 saved pairs (later growth replayed from log) | PASS |
| Second process refused | `omp -p --no-title -e /home/ukd/projects/omp-optchat/src/index.ts --optchat smoke 'Reply only LOCK_TEST.'` while RPC owns profile | exit 1; Profile already running: OMP PID ...; no provider dump | PASS |
| Inactive plain context | `omp -p --no-title -e .../src/index.ts -e .../test/fixtures/observe.ts 'Reply only PLAIN_OK. Do not use tools.'` without flag/env | exit 0; observed payload has no <chat> | PASS |
| Real static system / marks | payload inspection | all nine system arrays byte-identical; <=4 marks; original ephemeral ttl=1h preserved | PASS |
| Cleanup / no install | evidence capture and removal | /tmp/optchat-smoke removed; ten leaked upstream write-behind test directories removed and tests fixed to use in-memory directory labels; preliminary smoke artifacts removed | PASS |

### Final per-request table (checker output)

| Request | Turn | Blocks | Shared prefix | Reusable mark | Predicted share | Input | Cache read | Cache write | Real share | Prefix event |
|---|---:|---:|---:|---|---:|---:|---:|---:|---:|---|
| 000001-main.json | 1 | 73 | 0 | no | 0.0000 | 4 | 0 | 36891 | 0.0000 | cold |
| 000002-main.json | 2 | 73 | 69 | yes | 0.9865 | 4 | 36467 | 478 | 0.9870 | stable |
| 000003-main.json | 2 | 75 | 73 | yes | 0.9962 | 2 | 36945 | 136 | 0.9963 | stable |
| 000004-main.json | 3 | 74 | 69 | yes | 0.9826 | 4 | 36467 | 639 | 0.9827 | stable |
| 000005-main.json | 3 | 76 | 74 | yes | 0.9963 | 2 | 37106 | 116 | 0.9968 | stable |
| 000006-main.json | 3 | 78 | 76 | yes | 0.9962 | 2 | 37222 | 134 | 0.9964 | stable |
| 000007-main.json | 3 | 80 | 78 | yes | 0.9963 | 2 | 37356 | 114 | 0.9969 | stable |
| 000008-main.json | 4 | 76 | 70 | yes | 0.9793 | 4 | 36579 | 800 | 0.9785 | stable |
| 000009-main.json | 5 | 77 | 72 | yes | 0.9857 | 4 | 36895 | 520 | 0.9860 | stable |

## Deviations / verified API adaptations

1. DESIGN requests a system-role stop message on context failure. OMP 18.8.3's
   Message union supports user/developer/assistant/toolResult, not system
   (pi-ai/src/types.ts:1303). Use the supported developer-role stop message
   with identical text, after ctx.abort(); never restore historical context.
2. DESIGN's settle(signal) cannot receive a hook-provided signal: OMP context
   event and ExtensionContext expose none (shared-events.ts:192–196;
   extensions/types.ts:485–595). A lifecycle-owned AbortController supplies it,
   aborted on faults, shutdown and run replacement.
3. Ownership uses the port's OS-owned Unix socket, with PID in the live owner
   response, rather than a PID-file/kill-zero lock. This preserves the source's
   race-safe, stale-socket/inode checks and cannot steal a responsive owner.
   It implements DESIGN's PID + liveness requirement via the source mechanism.

No other departures from DESIGN.md. No scope exclusions were silently reduced.
Ambient OMP diagnostics included existing unavailable MCP servers and an
OpenRouter auto-thinking helper 403; the default Anthropic main model completed
all five turns. Those diagnostics were not suppressed or fixed.

## Retained evidence dumps

Only `/tmp/optchat-evidence-sol-final-20261009/` is retained from this work:
- `000001-main.json` through `000009-main.json`: final main payloads.
- `plain/000001-main.json`: untouched inactive-session provider payload.
- `rpc.jsonl`, `rpc.stderr.log`, `driver.log`: smoke protocol and diagnostics.
- `lock-refusal.log`, `plain.log`: subprocess outputs/exit codes.
- `filesystem.json`, `view.json`, `tree/2026-10-09.jsonl`: captured persistence,
  tool result, static-system and mark evidence before deleting smoke data.

## Next / resume point

None for this assignment. Both milestones are complete; stop after committing
this acceptance record. Do not install the extension or push a remote.

## Orchestrator review (2026-10-09)
- Fixed: a run started by a shown custom message (async result, report) faulted the session (turn start matched the log copy, role `user`, not OMP's `custom`) and would have put the view after that message. Regression test in `test/transcript.test.ts`.
- Fixed: `OMP_OPTCHAT` inherited by an `omp` launched from an OMP shell (`OMPCODE=1`) is ignored; the `--optchat` flag still works.
- Re-verified live after the fix: 5-turn smoke, real cacheRead share ≥ 0.9785 on turns ≥ 2, 0 unexpected breaks; long-message smoke exercised the Haiku compactor (lines ≤ 512 B, 0 unbuilt), turn 2/3 shares 0.970 / 0.987.
- Not proven live: batch merge (128 KB → 64 KB) and the 20-block lookback across big turns; covered by unit tests I2/I3 only.
- Installed: `~/.omp/agent/extensions/optchat -> /home/ukd/projects/omp-optchat`. Evidence dumps in /tmp were deleted after review.

## Agent-name zoom (branch `zoom-name`, 2026-10-09)

Complete: append-only/fsynced `agents.jsonl` in each active profile, task/async/IRC name discovery,
recursive end-of-run discovery (including nested senders), restart resolution, newest-first duplicate
selection with dated and exact-path selectors, nearest-name errors and missing-transcript errors.
`zoom` now accepts a string `id`; numeric zoom and image retrieval remain unchanged. Transcript rendering
is read-only, emits `kind|text` lines with escaped newlines, excludes thinking/hidden custom messages,
and bounds each tool result to its first/last ~500 characters. Transcript and memory zoom share the same
25,000-character paging implementation, including offsets, limits, hints and surrogate-pair handling.
Shown async results and incoming peer messages log as `work`; task/async reports retain per-agent
`Full chat: zoom("Name")` trailers inside the log cap. Static prompt/tool descriptions updated once;
README and DESIGN describe the interface without changing I1–I7.

Files: `src/agents.ts`, `src/paging.ts`, `src/index.ts`, `src/memory.ts`, `src/tools.ts`,
`src/transcript.ts`, `src/prompts.ts`, `test/agents.test.ts`, `README.md`, `DESIGN.md`, `PROGRESS.md`.

Red-first evidence:
- `bun test /home/ukd/projects/omp-optchat-zoom/test/agents.test.ts`: exit 1, 0 pass / 8 fail.
  Seven new API tests failed because the agent-index/renderer module did not exist yet; the logging
  test observed `echo,user,user` instead of `echo,work,work`. Tests retain append/restart, duplicates,
  missing/unknown files, rendering, paging, trailers and numeric/string tool assertions.
- `bun test /home/ukd/projects/omp-optchat-zoom/test/agents.test.ts --test-name-pattern 'nested sender'`:
  exit 1, 0 pass / 1 fail; resolved a nonexistent direct-child path instead of the existing nested
  transcript. Corrected path discovery, not the assertion. No tests skipped or assertions weakened.
- The first full implementation check exposed OMP's Zod-like facade lacking `z.iso`/`ZodType`
  (tests exit 1, TypeScript exit 2). Read the installed facade declaration, used its supported
  string/refine surface and corrected union narrowing. Final suite below includes a main lifecycle
  test invoking hooks without launching OMP or calling a provider.

| Item | Command | Observed result | PASS/FAIL |
|---|---|---|---|
| Complete tests, including I1–I7 | `bun test` | exit 0; 67 pass, 0 fail, 8 files | PASS |
| TypeScript | `bunx tsc --noEmit` | exit 0; no diagnostics | PASS |
| Existing transcript, read-only | `bun /home/ukd/projects/omp-optchat-zoom/scripts/.zoom-probe.ts` (throwaway script, removed) | exit 0; 252,440 rendered characters, 11 pages; printed the complete first 25,000-character page with next offset 25,000; displayed first 20 output lines | PASS |
| Verified OMP API | `npm pack @oh-my-pi/pi-coding-agent@18.8.3 --pack-destination /tmp`, extract/read source | exit 0; session-manager.ts:3093–3094 returns the session file; IRC details.from and task progress/results metadata inspected | PASS |
| Cleanup / boundaries | remove temporary probe and packed source | throwaway probe, `/tmp/omp-src-sol` and downloaded archive removed; test fixture directories removed in finally blocks; no live OMP session, installation, remote push or edits outside worktree | PASS |

Real transcript used:
`/home/ukd/.omp/agent/sessions/-Work-gateforge/2026-10-06T05-15-55-164Z_01a10fa3-cb9c-7201-b91a-acfe1257b3f2/Gf015Wp1.jsonl`.
Probe called exported `renderTranscript(file)` and shared `pageText`, printed page one, and counted
pages by following the returned next offsets to the rendered text's end. Its first twenty output
lines showed the brief, tool calls, capped tool echoes and a shown async completion as `work`.
No transcript or other file under `~/.omp` was written.

Stop point: commit the green unit on `zoom-name`, report, stop. No merge, install, push or live probe.

### Review fixes after `452b840`

- Never append predicted paths: names reported before a transcript appears remain unindexed until
  discovery. Unknown-name resolution lazily scans the current session (via the live session-file getter
  in the extension, or the last session supplied to the standalone index), so a delayed nested
  transcript is accessible before `agent_end`.
- Deduplicate name/path keys before opening or reading transcript headers, including message indexing.
  Repeated scans still discover new directory entries but do not reopen known transcript files.
- Updated existing fixtures to create real transcripts before indexing; the missing-file test now
  removes an actually indexed file. Assertions were preserved. Added delayed-file/lazy-discovery
  regressions and an openSync spy that proves known files are not reopened while a new header is read once.

Red-first:
- `bun test /home/ukd/projects/omp-optchat-zoom/test/agents.test.ts --test-name-pattern 'reported name waits|unknown names discover|second scan opens'`:
  exit 1, 0 pass / 3 fail. Observed a persisted nonexistent path and an unknown-name error before discovery.
  The initial default-export fs spy did not intercept named imports; corrected it to spy on the module namespace.
- `bun test /home/ukd/projects/omp-optchat-zoom/test/agents.test.ts --test-name-pattern 'second scan opens'`:
  exit 1, 0 pass / 1 fail; the corrected spy observed one open of the known Alpha header, violating the expected zero.
  Both red checks preceded the index implementation fixes; no assertions were weakened.

| Item | Command | Observed result | PASS/FAIL |
|---|---|---|---|
| Complete suite, including I1–I7 and review regressions | `bun test` | exit 0; 70 pass, 0 fail, 8 files | PASS |
| TypeScript | `bunx tsc --noEmit` | exit 0; no diagnostics | PASS |
| Delayed nested transcript / lazy unknown discovery | same complete suite | new tests green; one real nested record, no nonexistent direct path | PASS |
| Repeated scan header I/O | same complete suite | known Alpha header: 0 opens; new Beta header: 1 open | PASS |

No live runs, merge, installation, push or temporary files in this review unit. Commit and stop.

## Live verification round (2026-10-09, orchestrator)

| Item | Observed | Result |
|---|---|---|
| OptChat main on Codex `gpt-6.1-sol`, 5 turns with tools + zoom | answers correct; 98.6% from cache after the first call, 0 misses | PASS |
| OptChat main on GLM `glm-5.3-flash`, same script | answers correct; one miss on request 2 although bytes matched to 17.6k chars into the view (GLM had not stored request 1), then 99% | PASS (provider-side) |
| Opus main, two background subagents (glm, luna), results start runs | before fix: first request of a result-started run re-sent the previous turn (live owner session: 45k tokens rewritten). OMP emits `message_end` fire-and-forget, so `context` ran before `runFirst` was set. Fix: the run opens after the previous run's last message (`lastEnd`). Red/green: `test/run-start.test.ts`. After fix: request opens `[view][async-result]`, main ≥96% on every call after the first | PASS |
| `zoom("GlmCount")` from the main agent | returned the subagent transcript; model named its first bash command | PASS |
| Restart with `--resume` across a plugin upgrade | first request full miss: static prompt and zoom tool text changed with the upgrade (expected once per upgrade) | expected |

## Long-run rollover — run-limit-sol (2026-10-10)

Implemented `config.json` `runLimit` (positive safe integer UTF-8 bytes, default 256000 for old profiles),
deterministic raw content counting, latest-assistant cuts, pre-cut logging catch-up, summary settle/render,
and preservation of the original task, latest assistant/thinking, tool results and later injections.
Views/cuts stay fixed between rollovers. Existing logging conventions, run anchors and cache marks remain.
The fire-and-forget catch-up claims messages before image I/O and deduplicates later message_end delivery.
README and DESIGN explain configuration, deliberate recipe deviation and cache-prefix argument.

Red-first command: `bun test test/run-limit.test.ts`, exit 1: 1 pass, 3 fail.
Rollover test retained earlier assistant/result messages instead of the latest assistant tail;
between-cut test received 4 messages instead of 2; config test found no runLimit property.
The unchanged-under-limit test passed on the baseline. The rollover test also asserts byte-identical
latest assistant, intact result/injection tail, old content in the view, original task retained,
and duplicate-delivery stability. Added UTF-8/thinking/tool-argument/custom counting and no-advance tests.

| Acceptance | Evidence | Result |
|---|---|---|
| Full tests | `bun test`: exit 0, 78 pass, 0 fail, 11 files, 27 expect assertions (plus existing node:assert assertions) | PASS |
| Types | `bunx tsc --noEmit`: exit 0 | PASS |
| Rollover / intact tail / task | red-first test failed on retained old messages; final suite checks exact tail and assistant JSON equality | PASS |
| Fixed between-cut prefix | red-first expected 2, received 4; final suite checks same opening and append-only tail | PASS |
| Under limit unchanged | identical `projectContext` output on baseline and final suite | PASS |
| Config | red-first missing property; final suite checks old/default, explicit 6000 and six invalid values | PASS |
| Single live copy | first provider dump has exactly one `_zoom` tool and one `You are OptChat` system block | PASS |
| Live rollover | 11 provider requests, 10 sequential bash calls; cuts at requests 4, 6, 8, 10 | PASS |
| Final answer | memory.ts 20,824 bytes, largest; all ten counts match independent `wc -c` exit 0 | PASS |
| Cached shared prefixes | tools/system byte-identical at every cut; shared marked old-view blocks at cuts 6/8/10: 2/3/5 | PASS |
| Live cache shares | minimum at cut 4: 88.09%; report after first call 91.3%, zero misses <80% | PASS |

Live launch: detached `setsid nohup bun /home/ukd/projects/omp-optchat-runlimit-sol/live-runlimit-sol.ts`
(launch exit 0). Driver used temp cwd `/tmp/runlimit-sol/cwd`, fresh profile `/tmp/runlimit-sol/home/proof`,
`runLimit:6000`, and dumps `/tmp/runlimit-sol/dumps`; ran
`omp --mode rpc --no-ui --no-title --no-extensions -e /home/ukd/projects/omp-optchat-runlimit-sol/src/index.ts --optchat proof`
with OMPCODE/OMP_OPTCHAT cleared and default anthropic/claude-opus-5-5.
One prompt requested ten sequential wc calls with 25 short diagnostic padding lines per call to trigger
rollover without long-line truncation. prompt_result: completed, agentInvoked=true, sessionSettled=true.
Initial experiment used one long padding line, which bash truncated to 768 bytes and produced only one cut;
the revised experiment changes diagnostic shape, not implementation or assertions.

Session measured (removed during requested cleanup):
`/home/ukd/.omp/agent/sessions/-tmp-runlimit-sol-cwd/2026-10-10T07-25-13-574Z_01a124b3-9de6-7698-aae7-9dcf9ae674b9.jsonl`.

| Request | Payload messages | View bytes | Input | cacheRead | cacheWrite | Read share | Event |
|---:|---:|---:|---:|---:|---:|---:|---|
| 1 | 1 | 15 | 4 | 32360 | 658 | 97.995% | tools/system already warm |
| 2 | 3 | 15 | 2 | 33018 | 2776 | 92.239% | append |
| 3 | 5 | 15 | 2 | 35794 | 2707 | 92.964% | append |
| 4 | 3 | 2259 | 2 | 32360 | 4373 | 88.090% | cut, empty old view had no whole marked blocks |
| 5 | 5 | 2259 | 2 | 36733 | 2906 | 92.664% | append |
| 6 | 3 | 3581 | 2 | 33201 | 4128 | 88.937% | cut, 2 marked old-view blocks shared |
| 7 | 5 | 3581 | 2 | 37329 | 2835 | 92.937% | append |
| 8 | 3 | 4745 | 2 | 33712 | 4150 | 89.034% | cut, 3 marked old-view blocks shared |
| 9 | 5 | 4745 | 2 | 37862 | 2794 | 93.123% | append |
| 10 | 3 | 6156 | 2 | 34478 | 4040 | 89.507% | cut, 5 marked old-view blocks shared |
| 11 | 5 | 6156 | 2 | 38518 | 2808 | 93.201% | final answer |

Before each cut request roles are `[user, assistant, user(tool_result), assistant, user(tool_result)]`;
after each cut they are `[user(new view + original task), latest assistant, user(tool_result)]`.
No merge batch occurred. The first empty view cannot share any whole view block; fallback system cache
still reads tools/system. Later cuts share old whole-view marks and read those tokens as usage confirms.

Required cache report command (exit 0):
`bun /home/ukd/projects/omp-optchat/scripts/cache-report.ts <session above>`

```text
✓ main                         anthropic/claude-opus-5-5
    11 calls · overall 91.8% from cache · after the first call 91.3% · misses below 80.0%: 0 (unexplained 0)
```

Final verified wc counts: index.ts 7589; integration.ts 2475; config.ts 2082; memory.ts 20824;
transcript.ts 4537; cache.ts 3637; agents.ts 10463; tools.ts 2419; store.ts 7088; compactor.ts 5545.
The model claimed fourteen calls in its final prose, but actual session records contain exactly ten
assistant toolCall blocks and ten toolResult messages; all ten numeric answers are correct.
Temporary driver, temp directories/logs and both isolated live sessions are removed; HANDOFF-runlimit.md
is intentionally untracked as requested. No install, push, merge, publish or other-worktree access.

### Cut-anchor review correction

Orchestrator requested replacing the numeric cut with a message anchor. The cut now stores the selected
assistant message and resolves its role + timestamp via `findLastIndex` on every context call.
If the cut is missing (or not after the opening), the same request falls back to `at + 1`, clears the
obsolete anchor and runs normal limit selection without faulting. Insertion before a retained cut no
longer includes the newly inserted message in its raw tail. DESIGN.md documents the history-rewrite rule.

Red-first: `bun test test/run-limit.test.ts`, exit 1: 6 pass, 2 fail. Insert-before-cut test unexpectedly
received the inserted custom message in the projected tail; missing-cut test received only the last
result instead of the fallback old assistant/result/tail. Both now pass unchanged. A third test verifies
that missing-cut fallback can choose a fresh latest assistant on that same context call.

Verification: `bun test`, exit 0, 81 pass, 0 fail, 11 files, 35 expect assertions plus existing node assertions.
`bunx tsc --noEmit`, exit 0. No live rerun requested for this anchor-only correction.

## Recipe conformance — recipe-conformance (2026-10-10)

Spec: Victor Taelin's complete recipe (gist 91837951a5ce5b38f341ec1ba1df6449).
Audit before editing and phase evidence are recorded in untracked `HANDOFF-recipe.md`.

Restored §5 verbatim in the static turn and compactor texts (Unii→OptChat,
unii→talk; permitted device paragraph omission). Existing reply kinds and nodes
are unchanged. New profiles default to Haiku xhigh; explicit old config efforts
remain intact. §4 fitting output stops without a false too-long retry; contexts
stop at the first unbuilt line. Failed nodes retry on the next message as well
as the deliberate availability timer. Non-tool long text, including async/IRC
work reports, splits losslessly into consecutive 30,000-character messages;
tool outputs remain capped, and existing unsplit records retain paged zoom.

Documented owner-approved exceptions in DESIGN: compactor omits OMP's prompt/tools
because turn and compaction models differ; damaged/missing view recovery; turn
availability fallback/timer. Preserved existing rollover, memories, TTL/marks,
plain OMP children/transcripts/socket integration.

Red evidence: targeted recipe suite exit 1 (7 pass, 5 fail); next-message retry
exit 1 (100 vs 200 attempts); async work losslessness exit 1 (clipped interior).
Final restoration verification: `bun test && bunx tsc --noEmit`, exit 0,
88 pass / 0 fail, 13 files, 35 expect calls; TypeScript clean.

### Copied real-memory measurements

Read-only snapshot: 3,492 messages / 6,978 nodes; main checkout prompt baseline
matched starting `src/prompts.ts`. Replayed real Haiku via one `streamSimple`
protocol, real task/retry/cache/effort helpers, three samples/variant.
Context A uses reconstructed real `Memory.compactionView`; historical request
payloads/views/readiness are unavailable. Context B retains earlier context but
shows only the two child lines inside the merged range. No tree rebuild/migration.

Commands: `bun .recipe-eval.ts` exit 0 (108 compactions, 322.31 s);
`env RECIPE_SUPPLEMENT=1 bun .recipe-eval.ts` exit 0 (27 more, 210.92 s).
135 compactions / 335 underlying calls, no provider-error retries.
The temporary harness is archived in `/tmp/optchat-recipe-results.md`, alongside
every source/output and per-request token/latency/cost record. It uses six worker
jobs and does not reproduce production warm-prefix gating; costs are
model/catalog-reported estimates, not an invoice.

| Full goal retained | OLD medium | Restored medium | Restored xhigh |
|---|---:|---:|---:|
| A: 16+16 | 0/3 | 0/3 | 0/3 |
| A: 0+32 | 0/3 | 0/3 | 0/3 |
| A: chained 0+64 | 0/3 | 0/3 | 0/3 |
| B: 16+16 | 0/3 | 0/3 | 0/3 |
| B: 0+32 | 0/3 | 0/3 | 0/3 |
| B: chained 0+64 | 0/3 | 0/3 | 0/3 |
| Ten A lost-order targets (3 samples each) | 10/30 | 11/30 | 16/30 |

Full goal requires every endpoint/table, witnessed real UI, 0 waived, 0 baselined.
Snapshot 16+16 already omits endpoint/table and baselined, although leaf24
preserves the goal. Strict-child contexts cannot recover absent input details.
The ten targets include 16+16 as its narrower dropped-zero-baselined check.
Retention uses reviewed clause-specific predicates (not topic similarity);
initial permissive lexical flags remain in raw evidence, alongside corrected
flags. No samples were excluded or rerun.

| All contexts, 45 compactions/variant | OLD | Restored medium | Restored xhigh |
|---|---:|---:|---:|
| Mean input tokens, including cache | 29,156 | 33,661 | 9,346 |
| Mean output tokens, including thinking | 1,137 | 1,590 | 9,586 |
| Mean latency seconds | 6.19 | 8.17 | 38.93 |
| Mean calls/compaction | 3.09 | 3.33 | 1.02 |
| Final outputs above 512 bytes | 8 | 9 | 0 |
| Total estimated USD | 0.058967 | 0.070125 | 0.221836 |
| USD/compaction | 0.001310 | 0.001558 | 0.004930 |

Conclusion: prompt-only gain was small (10→11/30); added effort improved sampled
order retention (11→16/30) but did not preserve the full goal. Xhigh averaged
3.76× OLD cost and 6.29× latency, while sharply reducing size retries.
Three samples on selected failure cases do not establish a general guarantee.
Recipe restoration affects new nodes only; existing losses remain recoverable
only by zooming to original messages, not by a prohibited migration.

## Orders ledger — orders-ledger (2026-10-10)

Implemented the deliberate standing-orders extension in `src/orders.ts`, with task prompts and
compactor-model transport, Memory batch/turn lifecycle wiring, and a separate text block before
the chat view. Extraction is background, append-only and flushed, including empty results;
shown-custom user entries are excluded. Atomic ledger snapshots load without recomputation.
Only view merge batches (plus the first background backfill) change the prefix. Consolidation
failures retain old plus raw orders durably and retry next batch; oversized model output is
rejected rather than truncated. README and DESIGN describe files, cache partition and semantics.

### Acceptance

Commands run from `/home/ukd/projects/omp-optchat-ledger`.

| Check | PASS/FAIL | Evidence |
|---|---|---|
| Final complete suite | PASS | `bun test && bun run typecheck`, exit 0; 98 pass, 0 fail, 14 files, 63 expect calls |
| TypeScript | PASS | `bun run typecheck` invokes `tsc --noEmit`, exit 0 |
| Existing cut/rollover and cache I1–I7 | PASS | Included in full 98-test suite; no skipped tests or weakened assertions |
| Exact recipe compactor and explicit turn extension | PASS | Exact whole-string assertions retained; turn equality now includes the exact static paragraph |
| Red-first suite | PASS (module-load red only) | Before orders implementation, `bun test test/orders.test.ts`, exit 1: missing src/orders.ts; 0 pass, 1 fail, 1 error |
| Independent assertion-level red per scenario | FAIL (not exercised) | The initial six tests shared that module-load failure, so their assertions did not run independently |

| Initial ledger test | Red evidence | Final |
|---|---|---|
| Every user record including [], custom skip | Shared missing-module failure before implementation | PASS |
| Only batch consolidation, persisted load without recompute | Shared missing-module failure before implementation | PASS |
| Render position, stable opening between batches | Shared missing-module failure before implementation | PASS |
| Failed consolidation raw fallback | Shared missing-module failure before implementation | PASS |
| 16000 UTF-8 byte bound | Shared missing-module failure before implementation | PASS |
| Missing-id backfill once | Shared missing-module failure before implementation | PASS |

Four later tests cover nonempty-ledger cache marks, background backfill plus fallback restart,
actual Memory view-batch integration, and extraction failure/concurrency/one-record persistence.
They passed in the final suite; no preimplementation red is claimed for them.
Initial full run was 93 pass/1 fail because the old turn-prompt recipe-equality test did not include
the deliberate extension. Its exact assertion was updated, not removed or weakened.
Dependencies were linked from the existing checkout; no install, push, merge or publish.

### Copied real-memory backfill

`bun scripts/ledger-eval.ts` (temporary script removed after measurement), exit 0.
Used only copied profile and copied credentials; no writes to the owner's held profile.
Model: default `anthropic/claude-haiku-5-5`, xhigh.

| Measurement | PASS/FAIL | Result |
|---|---|---|
| Snapshot/skip accounting | PASS | 3785 entries, 188 user entries, 92 custom-tagged skipped, 96 genuine user extraction records |
| Order extraction and consolidation | PASS | 86 extracted strings, 23 consolidated items, 97 calls (96 extraction + 1 consolidation) |
| Rendered ledger bound | PASS | 5819 UTF-8 bytes, below 16000 |
| Message 24 PM goal | PASS | Full every-endpoint/table, witnessed real UI, 0 waived, 0 baselined retained at newest duplicate source 3522; push-PM-when-green clause retained at 24 |
| Conditional no-verify push | PASS | Real source id 2681; permission and eventual-fix condition both present |
| “Exclude and delete” | FAIL (absent) | Real id 3234 says `eclude and delete, yeah.`; extraction [], consistent with excluding single-action approvals |
| Cost/wall time | PASS | Model-reported $0.045765575; backfill+consolidation 192.253 seconds (command 194.22 seconds) |

Full rendered block and every extraction record remain in `/tmp/optchat-ledger-results.md`.
Five false-positive candidates: 406 “after this you may do what you wer esuggesting me to”;
637 “use sol”; 891 “use a GLM agent to implement the OIA agent, internet and attachment thing”;
2849 “if it is good then you can push it into main and yes, install it and restart”;
3634 the “You can do number one, but before…” approval/reporting task.
These look like one-off assignments/approvals, not standing orders. Model consolidation also
inserted editorial parentheticals and normalized some wording: near-verbatim is not a claim
of exact transcription. No id-specific whitelist or special case was used.


### Orchestrator review corrections A/B/C

Corrections to `bd88928`:
- A: live and historical extraction now snapshot the preceding assistant reply, joining consecutive
  `talk` chunks and retaining the final <=4000 valid UTF-8 bytes. Context only resolves references;
  a short approval may choose a lasting policy, but assistant text cannot itself supply orders.
- B: extraction explicitly separates beyond-current-task instructions from one-off agent assignments,
  action/deployment approvals and operations.
- C: consolidation keeps user wording without interpretation, spelling corrections or explanatory
  notes. Only `(replaces msg N)` and extracted `(chosen: ...)` annotations are allowed.

README/DESIGN describe the new context and semantic prompt contracts.

| Acceptance | PASS/FAIL | Precise evidence |
|---|---|---|
| Assertion-level red A live context | PASS | Before source changes, expected resolved choice, received []; `orders.test.ts:107` |
| Assertion-level red A backfill tail | PASS | Before source changes, expected context string, received undefined; `orders.test.ts:115` |
| Assertion-level red B prompt contract | PASS | Before source changes, beyond-current-task policy assertion failed; `orders.test.ts:125` |
| Assertion-level red C prompt contract | PASS | Before source changes, no-interpretation assertion failed; `orders.test.ts:132` |
| Red command | PASS | `bun test test/orders.test.ts --test-name-pattern '^(A \|B \|C )'`, exit 1; 0 pass/4 assertion failures, artifact://433 |
| Full suite and tsc | PASS | `bun test && bun run typecheck`, exit 0; 102 pass/0 fail, 14 files, 85 expect calls; tsc --noEmit exit 0 |
| Fresh real replay | PASS | New live-profile/credential copies; `bun scripts/ledger-eval.ts`, exit 0; no manual retry/output selection |
| 3234 resolved decision | PASS | `eclude and delete (chosen: exclude them from the gate and delete the dead code)`; reply 3230 concerns 388 dead PM endpoints |
| Full PM goal | PASS | At 24: every endpoint/table, witnessed real UI, 0 waived, 0 baselined; push PM when green locally |
| 2681 conditional push | PASS | Both no-verify permission and `YOU HAVE TO ensure that we fix them eventually` retained in two items with source 2681 |
| Original five one-off examples | PASS | 406/637/891/3634 now []; 2849 retains ongoing communications requirement, drops deployment approval |
| No forbidden editorial notes | PASS | Rendered output contains no as-written/possibly-exception/unclear-confirm/typed-correction notes |
| Remaining one-offs | FAIL (four candidates remain) | Exhaustive contextual review identifies the four below; semantic filtering is not perfect |

Fresh snapshot: 3820 entries; 191 user entries, 94 custom-tagged excluded, 97 extraction
records and 63 extracted strings. First ledger: 56 items; full rendered block 5745 UTF-8 bytes.
Model-reported cost $0.057333510; backfill+consolidation 194.600 seconds; command process 196.00
seconds. Calls: 99 = 97 successful extractions + 1 invalid-JSON extraction retried by the
implemented retry policy + 1 consolidation. That failed call is included in cost.

Every remaining item judged one-off:
1. 24: `watch CP MR !103 until it is merged.` — supervision of one merge request.
2. 932: `yeah i approve that (chosen: Committing only if no claims owned by the selected tests are missing.)`
3. 932: `yeah i approve that (chosen: Stopping and waiting if any run fails for a new reason.)`
4. 932: `yeah i approve that (chosen: with no forced clicks and no retries.)`

The three 932 items approve the particular oc-fullchain/oc-7 plan in reply 931; a wider policy
is not explicit. These are human judgements, not proven intent. 126's `medium` IS a lasting
choice: reply 125 asks which enduring Sol configuration to write for subsequently started agents.
Stream A's roadmap and OIA requirements are ongoing-stream/product goals, not classified as
single-action approvals. B/C tests verify prompt contracts; replay supplies semantic evidence.

Latest full block, extraction records and acceptance table supersede the earlier scratch report
at `/tmp/optchat-ledger-results.md`. Temporary script, profile and credential copies are removed
before committing. No id-specific exclusions, push, merge, publish or install.


### Addition D: user-owned expiry and typed orders

Only the user's words create, change or retire an order. Extraction now returns
`{text,kind:"rule"|"goal",until?:string}` or `{retire:[text or numeric source ids]}` directives.
Legacy string extraction records and old untyped ledger items load as rules, without rewriting
history or recomputing the ledger. Rules describe continuing working policy; goals hold
user-worded/resolved done-conditions. Missing conditions remain unspecified, never invented.

Render is `<orders through="N">` followed by typed rule/goal labels, source dates and wording.
The static turn paragraph says newer user words in the view can change/retire orders and win;
on apparent completion the agent reports evidence and asks the user whether to retire the goal.
Recorded retirements remove targeted items at the next batch; assistant status/model judgement
do not. Pending retirements keep their own source ids, so a newer user can reintroduce an order
in the same batch. Fallback retirement events persist atomically beside raw orders.

Consolidation validates retention of existing orders/new goals and valid authority sources.
An empty or retirement-only extraction cannot become a new standing-order source.
Replacement uses the owner's generic rule: explicit user change/replacement, or instructions
that cannot both be followed. Overlap/broader goals are not replacements; ambiguous tension
keeps both verbatim, without interpretation. No topic/id-specific replacement exceptions.

| Acceptance | PASS/FAIL | Evidence |
|---|---|---|
| D kind/until and header red | PASS | artifact://443: fields stripped before implementation; green typed persistence/render/through assertions |
| Legacy strings red | PASS | artifact://443: received strings rather than rule objects; green and history bytes unchanged |
| Retirement parsing/batch red | PASS | artifact://445: constructor assertion failed on retire record; green removes target only at batch, preserves history |
| No model/assistant expiry red | PASS | artifact://443: goal disappeared; green conservative retention/fallback |
| Later user reintroduces retired order red | PASS | artifact://455: rendered empty; green source-ordered retirement |
| Eligibility before kind red | PASS | artifact://451: missing contract; green prevents calling an immediate task a standing goal |
| Replacement authority reds | PASS | artifact://459 then generic owner contract artifact://466; green |
| Empty-source authority red | PASS | artifact://470: empty message credited as source; green rejects model source invention |
| Complete final tests/tsc | PASS | `bun test && bun run typecheck`, exit 0; 112 pass, 0 fail, 14 files, 113 expect calls; tsc --noEmit exit 0 |
| Fresh final real replay | PASS | `bun scripts/ledger-eval.ts`, exit 0; new live-profile and credential copies; 3925 entries, 195 user entries, 95 shown-custom exclusions, 100 extraction records |
| PM full goal and push condition | PASS | At 24: every endpoint/table, witnessed real UI, 0 waived, 0 baselined; push PM when green locally |
| 2681 condition | PASS | Full permission plus eventual-fix condition, one goal; until “the 1858 entries are fixed” resolves “them” from reply 2680 |
| 3234 choice | PASS | Rule `"eclude and delete" (chosen: exclude them from the gate and delete the dead code)` |
| Compatible orders/real user replacement | PASS | PM goal and exclude/delete coexist; 850 prohibition replaces prior MR-opening goal but leaves attachments/internet goals |
| Typed item count/bound/header | PASS | 49 standing objects, 0 retirement directives, 46 items (35 rules/11 goals), 6611 rendered UTF-8 bytes, through 3924 |
| Final cost/wall | PASS | Model-reported $0.052520775; 101 calls (100 extraction + 1 consolidation); 167.781s model work, 172.67s process |
| Every remaining one-off | PASS for this sample | Reviewed every extracted object and ledger item: none judged one-off; 406/637/891/932/3634 [], 2849 deployment approval excluded |

Five of eleven goals have explicit/resolved conditions; six do not. The final copied history has
no retirement directive, so retirement behavior is evidenced by deterministic tests, not a
claim of a real-profile retirement. The MR watch is intentionally a goal under D, superseding
the earlier one-off judgement. Product capabilities/ongoing stream goals are not counted as
implementation-task approvals. Near-verbatim remains a model contract, not exact transcription
or a universal semantic guarantee.

All typed replays are reported (no discarded failures):

| Trial | Orders/items/bytes | PM / 2681 / 3234 | Calls | USD | Seconds |
|---|---|---|---:|---:|---:|
| D1 initial typing | 51 / 46 / 6836 | PASS / PASS / FAIL (extraction []) | 101 | 0.060363825 | 184.326 |
| D2 eligibility clarification | 51 / 46 / 6641 | PASS / PASS / PASS | 101 | 0.060395160 | 201.851 |
| D3 user-change clarification | 45 / 40 / 6293 | PASS / PASS / FAIL (model replaced it with 3344) | 101 | 0.057961150 | 209.064 |
| D4 generic explicit-change/mutual-impossibility authority | 49 / 46 / 6611 | PASS / PASS / PASS | 101 | 0.052520775 | 167.781 |

D1 leaked local execution-plan approvals at 932; D2 removed those but retained a contradictory
old MR-opening feature; D3 fixed that but inferred a broader goal replaced exclude/delete.
The owner confirmed both must stay and supplied the generic rule used in D4. Each prompt
correction followed a demonstrated discrepancy and an assertion-level red, not unchanged
retries or favorable-output selection. An initially proposed topic-specific assertion was
superseded by the owner's generic direction before topic-specific replacement logic landed.

Typed replay totals: $0.231240910, 404 calls, 763.022s. Whole-assignment measured totals including
original ledger and A–C: $0.334339995, 600 calls, 1149.875s. Costs are model-reported estimates.
Full final rendered block with kinds/until, all extraction records, detailed PASS/FAIL and all
trial accounting: `/tmp/optchat-ledger-results.md`. Temporary evaluation script/profile/agent.db
are removed before final commit; no live profile/main checkout edits or install/push/merge/publish.


## Durable ledger recovery — ledger-durable (2026-10-10)

Bug (live, owner profile): a view merge batch queued consolidation; closing OMP aborted the
model call and saved nothing — no `pending` marker existed — and the next start only consolidated
on a later merge (or never, in short sessions), so merged view lines lost their orders and the
orders block changed at an arbitrary turn. Fix: `batch(P)` synchronously and atomically writes
`pending: P` into `ledger.json` (keeping `through`/`items`/`raw`/`retire`) before the merge that
requested it can save `view.json`; `Orders` attaches before `Memory`'s constructor replay with
backfill inside the constructor, so startup merges checkpoint too and wait for their extraction
records; a saved `pending > through` replays as blocking work awaited by the first turn's settle;
`close()` aborts the call but never drops the marker; failure after three retries renders raw
orders for `(through, pending]` and keeps `pending` for the next attempt; a restart with no
pending work and an existing ledger consolidates nothing (orders block byte-identical); the very
first ledger (backfill with no ledger) stays background. README, DESIGN and this file document it.

Red-first (`bun test test/orders.test.ts` at 47daf20): 25 pass / 4 fail — 'batch checkpoints
pending…', 'close during a batch…', 'two consecutive turns…', 'consolidation failing after
retries…' all failed on `pending` absent from ledger.json (Expected 0/1, Received undefined).
The 'restart with no pending work' test passes at 47daf20 by design: it guards behavior that
already held (loaded ledger ⇒ no start consolidation).

| Acceptance | PASS/FAIL | Evidence |
|---|---|---|
| Checkpoint before view save | PASS | new test: FileStore.saveView spy read `pending: 2` from ledger.json at the merge's view write; Orders-level sync checkpoint asserts `pending` before `batch()` resolves |
| Close mid-batch keeps pending; restart blocks first settle | PASS | new test: checkpoint survives `close()`; reopened `settle()` unresolved while consolidation runs, then `through` advances and the retired order is gone |
| Byte-identical openings after the replay | PASS | new test: two consecutive `settle()` cycles render identical orders blocks and identical projected first blocks |
| Restart with no pending work | PASS | new test (green at 47daf20 by design): restored ledger renders byte-identically, consolidation task must not run |
| Failed consolidation keeps pending, renders raw | PASS | new test: 3 attempts, raw fallback rendered, `pending` kept; restart retries exactly 3 attempts and keeps `pending` |
| Full suite | PASS | `bun test` exit 0: 117 pass, 0 fail, 14 files (112 baseline + 5) |
| TypeScript | PASS | `bunx tsc --noEmit` exit 0 |

Live proof (worktree code, isolated temp profile, three passes; commands: seed
`OMP_OPTCHAT_HOME=/tmp/glm-durable/home bun scripts/seed-notes.ts p 1700` → view 126,390 B,
then per run `cd /tmp/glm-durable/cwd && OMP_OPTCHAT_DUMP_DIR=/tmp/glm-durable/dumps/runN omp -p
--no-title --no-extensions -e /home/ukd/projects/omp-optchat-durable/src/index.ts --optchat p "<prompt>"`):
run1 "Standing rule from now on: always end every answer with BANANA. Reply OK."; run2 "Reply OK.";
run3 "The BANANA rule is done, drop it. Reply OK."; runs 4–7 "Use bash once: sed -n 1,60p
/home/ukd/projects/omp-optchat/src/memory.ts. Then reply with its first word only."; run 8 (extra,
opening-stability) "Reply OK.". Every run rc=0 in all passes. Ledger after every run (pass 3):

| After run | ledger.json | Note |
|---|---|---|
| 1 | `{"through":1699,"items":[]}` | first ledger from background backfill (0 eligible seeds) |
| 2–5 | `{"through":1699,"items":[]}` | no pending work, no start consolidation, block unchanged |
| 6 | `{"through":1699,"items":[],"pending":1716}` | batch checkpoint written synchronously; close aborted the model call; marker survived |
| 7 | `{"through":1716,"items":[]}` | first settle waited for the replay; `through` advanced past 1704; `pending` cleared |
| 8 | `{"through":1716,"items":[]}` | unchanged |

Passes 1 and 2 matched exactly (`pending`:1716 / `pending`:1717 → `through` 1716 / 1717).
orders.jsonl held exactly `i=1700 [{"text":"always end every answer with BANANA","kind":"rule"}]`
and `i=1704 [{"retire":["BANANA rule"]}]` — the orchestrator's evidence. Consolidated items are
empty, so BANANA is absent from every opening and `<orders>` renders nothing.

Openings (provider payloads via OMP_OPTCHAT_DUMP_DIR, pass 3): run 6 request 1 view head block
238 chars / 431 request blocks (pre-batch, 1717 raw lines); run 7 request 1 after the blocking
replay: head block 722 chars / 107 blocks (merged view) — no BANANA anywhere; run 7 request 2 and
run 8 request 1 first blocks byte-identical to run 7 request 1 (722 chars, `==` true). The view
rewrite and any orders change travel together; between rewrites the opening is byte-stable.

Per-call usage (pass 3 session jsonls, in/cacheRead/cacheWrite/output): run1 4/91291/0/9;
run2 4/91320/0/70; run3 4/91363/0/31; run4 4/91432/0/172 + 2/91432/1664/3; run5 4/91375/401/113 +
2/91776/1605/3; run6 4/91375/706/186 + 2/92081/1678/3; run7 4/35323/46962/190 + 2/82285/1682/3
(the one legitimate batch rewrite: merged view written, ≥70% still read from cache); run8
4/81933/655/4. Sessions under `/home/ukd/.omp/agent/sessions/-tmp-glm-durable-cwd/` (removed with
the temp dirs at cleanup). Commit: on `ledger-durable`; no install/push/merge/publish; the owner's
live profile was never touched.

## Restated orders — orders-restate (red tests e6e0f16, implementation d676dc5)

CONSOLIDATE now restates orders in clear wording, merges an order spread over messages into one item
and fixes typos and names, keeping every condition. Code guard (`missingTokens` in `src/orders.ts`)
checks every previous and newly extracted order: a covering item of the same kind must share a source
id and keep its must-keep tokens (numbers, paths, URLs, ids, code-ish tokens, condition words, all-caps acronyms, and capitalised names not starting a sentence; names of 5+ letters within edit distance 2; plain lowercase words not must-keep). Gaps retry with the missing tokens listed (attempts 0 and 1); the
last attempt substitutes the verbatim text for only the failing orders, with one warning. Hard error
only when an active previous order is omitted. Text retire targets match content words only (3+ letters or all-caps acronyms, minus the/and/for/with/that/this/rule/order/goal), so a phrase retires only the items carrying all its content words; a phrase with none retires nothing. A retired order stays retired after restating (needed by the BANANA regression tests). EXTRACT unchanged.
`HANDOFF-ledger.md` removed. Tests: 131 pass, 0 fail, 15 files; `bunx tsc --noEmit` exit 0.
Two existing tests were updated, not weakened: `test/recipe.test.ts` pins the new `OPTCHAT_PROMPT`
tail, and the byte-bound fixture in `test/orders.test.ts` now keeps the condition word "Never push" so
it exercises the byte limit rather than the guard.
