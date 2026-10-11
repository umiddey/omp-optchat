# omp-optchat

[Victor Taelin's OptChat](https://gist.github.com/VictorTaelin/91837951a5ce5b38f341ec1ba1df6449) for
[oh-my-pi (OMP)](https://github.com/can1357/oh-my-pi): one chat that never ends. Every message is logged, a cheap
model compresses the log into a tree of one-line summaries, and each turn the model sees a bounded view of the
whole history instead of a growing (and compacted) session. It can `zoom` into any line down to the original
message.

Built so the prompt cache keeps working. Measured on real runs, every request after the first one:
Anthropic Opus 97–99% of input read from cache, Codex `gpt-6.1-sol` 98.6%, GLM `glm-5.3-flash` 99% (after GLM
stored the first request).

Anthropic view marks remember the previous whole-view prefix across restarts in the profile's disposable
`cache.json`, so large appends still reuse it. Missing/corrupt hints fall back safely; batch rewrites still
write a new prefix. OptChat also stabilizes MCP server-instruction order between starts.

## Install

```sh
omp plugin install omp-optchat
```

Or straight from GitHub: `omp plugin install github:umiddey/omp-optchat`.

Update: `omp plugin upgrade omp-optchat`. Remove: `omp plugin uninstall omp-optchat`.

Tested with OMP 18.8.3. Needs an Anthropic login (`/login`) for the summarizer model.

## Use

Installing changes nothing until you turn it on. Start OMP with:

```sh
omp --optchat main
```

The first plain `omp` after installing shows this once, as an on-screen hint (it never reaches the model).

Make it the default, so a plain `omp` always uses the memory: add this to `~/.bashrc` or `~/.zshrc`:

```sh
export OMP_OPTCHAT=main
```

Or keep plain `omp` as it is and add a short command for the memory one: `alias omo='omp --optchat main'`.

- `main` is the memory profile; any name works (`--optchat work`, `--optchat personal`). Memories are separate per
  profile and live in `~/.omp/optchat/<profile>/` (override the root with `OMP_OPTCHAT_HOME`).
- Without the flag or `OMP_OPTCHAT`, OMP behaves exactly as before. Subagents and shells OMP itself starts never
  take the profile.
- One OMP window per profile at a time: a second window on the same profile is refused. Other OMP windows without
  the flag, or on another profile, are unaffected.
- The model gets two tools: `zoom(id, n)` opens a summary line, `zoom(id, 1)` returns the original message,
  `zoom("Name")` opens a subagent's whole transcript, and `date(id)` returns when a memory message was sent.
  Pass a name as the zoom tool's `id` parameter, e.g. `{"id":"Name"}`. Long messages and transcripts page at
  25,000 characters with `offset`/`limit`; follow the next offset in the response.
  Duplicate names default to the newest transcript and list other matches with dates: select one with
  `zoom("Name@<ISO date>")`, or `zoom("Name@<absolute transcript path>")` for an exact match.
  Transcript pages are `kind|text` lines (newlines escaped), with tool results bounded to their first/last
  ~500 characters. Match metadata does not count toward transcript offsets.
- The profile's append-only, flushed `agents.jsonl` keeps names, absolute transcript paths, owning session
  files and creation dates across OMP restarts. Task results, async reports and peer messages index agents;
  the end of each main run also discovers nested transcripts. Names whose files have not appeared yet
  wait for discovery; an unknown-name zoom scans the current session too, without waiting for run end.
  Discovery reads headers only for new paths. The OMP transcript files remain read-only
  and in their original location; missing files produce an error, not a substitute transcript.
  Shown async reports and peer messages log as `work`; task/async reports include `Full chat: zoom("Name")`.
- Before a turn starts, the previous turn's messages are summarized; that usually takes a few seconds and shows as
  "Waiting for OptChat summaries…".

Summarizer model (default `anthropic/claude-haiku-5-5`, xhigh effort for new profiles): edit
`~/.omp/optchat/<profile>/config.json`:

```json
{ "compactor": { "provider": "anthropic", "model": "claude-haiku-5-5", "thinking": "xhigh" }, "runLimit": 256000, "memories": false }
```

Existing profile configs keep their explicit effort. New prompts affect only newly built nodes; existing tree nodes are never rebuilt.

`runLimit` is a positive integer UTF-8 byte limit for the raw run tail (default 256000, about 64k tokens); long runs refresh their memory view at the latest assistant boundary while retaining the current task (the newest message you typed into the run, else its first message) and intact assistant/tool-result tail.

`memories` (default `false`): whether OMP's per-turn memory recall (`<memories>`, e.g. Mnemopi) is sent in OptChat
sessions. Off, the view and `zoom` are the only memory and each turn start writes about 1k fewer tokens to the cache.
Plain OMP sessions keep their recall either way; OMP still saves facts from OptChat sessions for them.

## Cutover from ledger to normal history

This version no longer maintains a standing-orders ledger. OptChat does not extract, backfill, migrate, or
consolidate orders, and it does not inject orders into the conversation: user instructions live only in normal
history and in the summaries that preserve them, so `zoom(id, 1)` still opens the original message that contains
them. Existing profiles are not migrated: if an old `ledger.json` or `orders.jsonl` is present in the profile
folder, OptChat ignores it and leaves it untouched — nothing is read, merged, or deleted. Because the turn
prompt changes and the ledger is removed, the first view rewrite after upgrading triggers one cache
transition; later turns resume the usual cache pattern.


## What it changes in OMP (only when the flag is set)

- The model sees `[tools][system][memory view][current turn]`; OMP's own history stays on disk but is not sent.
- OMP's auto-compaction is turned off for that session.
- Per-turn memory recall (`<memories>`) is dropped (or, with `"memories": true`, moved after the view), and the
  date/cwd reminder is moved after the view, so neither invalidates the cached view.
- Anthropic cache marks are placed on the view (copying OMP's TTL, e.g. 1 h on subscriptions).
- Subagents (`task`) and advisors run unchanged.

## Not included

Importing old chats, OptChat's own background agents, and sharing one profile across several windows.

## Development

```sh
bun install
bun test
bunx tsc --noEmit
```

Design and cache contract: [DESIGN.md](DESIGN.md). Cache check on real traffic: run OMP with
`OMP_OPTCHAT_DUMP_DIR=<dir>`, then `bun scripts/cache-check.ts <dir> <session.jsonl>`. Cache share per agent for
any OMP session (main plus every subagent, misses with their likely cause):
`bun scripts/cache-report.ts [session.jsonl | cwd]`.

### Usage measurements

OptChat records background model calls in the profile's `usage.jsonl`: each summary attempt (including
length retries), orders backfill, migration and consolidation has a start and a terminal row linked by id.
Terminal rows include model, purpose, duration, status and provider-reported input/output/cache tokens.
The recorded `usage.cost` is pi-ai's catalog-priced USD estimate, not an invoice or subscription-quota measurement.
Thrown requests and failed responses without reported usage have `usage: null`, not a fabricated zero.
An unmatched start means accounting is still pending; these logs do not reconstruct costs from older sessions.

`request-composition.jsonl` records each foreground and background request's tools, system prompt, orders,
view, memories, history and other serialized UTF-8 bytes. Their sum equals the serialized payload size.
Per-block token estimates use **bytes / 4**, not provider tokenization; provider-reported token counters remain
in the usage records and OMP session journal. History includes message envelopes; other includes residual JSON structure
and provider parameters. Measurements do not enter the model prompt or alter the request.

Set `OMP_OPTCHAT_MEASURE_DIR=<directory>` to put both files outside the profile. Files are append-only,
contain metadata/counts rather than prompt bodies, and may include truncated provider error messages.
Logging failures warn without disabling chat; missing, damaged or unfinished accounting must be reported
as incomplete rather than treated as free usage.

### Matched benchmarks and grouping experiment

```sh
# Same four-turn task, models and isolated baseline in native OMP and OptChat.
bun scripts/bench.ts --mode both --model anthropic/claude-haiku-5-5 \
  --compactor anthropic/claude-haiku-5-5 --thinking medium --out /tmp/optchat-bench-new

# Read foreground, background and request-composition accounting.
bun scripts/bench-report.ts /tmp/optchat-bench-new --json /tmp/optchat-bench-report.json

# Experimental replay only; never changes the production profile or tree format.
bun scripts/grouping-experiment.ts --home /tmp/optchat-grouping-new \
  --compactor anthropic/claude-haiku-5-5 --thinking medium
```

Use fresh output paths. Matched runs check factual recall, reply compliance (ORCHID in every reply) and a filesystem
artifact; an OptChat-only zoom probe runs separately and is excluded from comparative totals.
`--repetitions N` repeats independent runs; `--workload long --turns N` adds long-context pressure, and
`--compaction-threshold TOKENS` forces native OMP compaction at the same threshold in both modes.
`--wire-debug` also wire-captures OptChat runs for a session/wire request cross-check.
Smoke results are not evidence of long-context savings. A comparison needs matched configuration,
passing correctness checks and complete foreground/background accounting, including retries.
Unknown or unfinished calls cannot be treated as free. Native OMP compaction usage is not recorded in its
session journal; benchmark-only wire capture handles supported response formats and reports gaps explicitly.
Transient wire dumps (`rr-session-N.json` in the run's cwd) carry authentication headers; the runner strips
them after every run, including failed ones. A killed runner can leave them behind: benchmark directories are
private, so delete them before sharing. Do not run benchmarks on a private/live profile.

The grouping experiment compares message-level logging with assistant-tool-call/result units, preserving
source-id mapping and user/steering boundaries. It reports exact logged-source retrieval and live questions
answered from the compressed context separately. Fewer calls are not a success if recall degrades. Grouping is
not enabled in production.

Release: bump `version` in `package.json`, commit and push, then `gh release create v<version> --generate-notes`.
Publishing the GitHub release runs `.github/workflows/publish.yml`, which tests and publishes to npm (trusted
publishing, no token).

## Credits

Core ported from [pi-optchat](https://github.com/jonaslsaa/pi-optchat) by Jonas Silva (MIT); see
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md). Recipe by Victor Taelin.

## License

MIT, see [LICENSE](LICENSE).
