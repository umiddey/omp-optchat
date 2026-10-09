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
