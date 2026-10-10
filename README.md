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

`runLimit` is a positive integer UTF-8 byte limit for the raw run tail (default 256000, about 64k tokens); long runs refresh their memory view at the latest assistant boundary while retaining the original task and intact assistant/tool-result tail.

`memories` (default `false`): whether OMP's per-turn memory recall (`<memories>`, e.g. Mnemopi) is sent in OptChat
sessions. Off, the view and `zoom` are the only memory and each turn start writes about 1k fewer tokens to the cache.
Plain OMP sessions keep their recall either way; OMP still saves facts from OptChat sessions for them.

## Standing orders ledger

OptChat keeps standing goals, rules, constraints, prohibitions, preferences and decisions outside
the summary tree, restated in clear wording. They appear as an `<orders through="N">` block before `<chat>` on every
request. New orders remain in recent view lines until the next view merge batch, when the ledger
is consolidated: orders are restated, duplicates and multi-message orders merge, and newest contradictory instructions replace earlier ones. A code guard checks that no condition, number, path or id is lost.
The static prompt gives orders priority over conflicting summaries, but newer user messages can change or retire them and win. `zoom(id, 1)` gives context.
This is a deliberate extension beyond Taelin's recipe, not a change to existing summary nodes.

No extra config: orders are scanned by the summarizer calls that already run, using `compactor`'s model
and effort, so a user message costs one model call fewer than before. Each summarizer call that covers
unscanned user messages gets a short appended task section and returns an `ORDERS:` JSON line beside its
summary; the summary itself keeps the 512-byte rule. Because the summarizer reads the surrounding view,
speech-to-text slips such as "stale scale" or "gatefoge" are resolved from context. Shown custom-message
tags are ignored, and messages with no standing order are recorded as empty. Existing profiles backfill
missing ids once in the background, batched; their first ledger appears at a subsequent turn start after
completion. Normal turns do not wait for scanning; a view rewrite waits for its consolidation with the
usual working message.

Profiles written before restated orders included `said` migrate once in the background. Clean extractions
are appended as superseding records, never by rewriting history; the rendered ledger changes only at the
next normal view batch. Duplicate orders merge with their source ids, and newer incompatible orders replace
older ones without treating apparent completion as retirement.

Standing means an instruction keeps applying beyond the current task. One-off agent assignments,
action approvals, pushing a particular change, or installing/restarting it are not standing orders.
To understand a short answer that chooses a lasting policy, the summarizer also sees the preceding
assistant reply in the view. It may resolve the user's chosen option as `"user's words" (chosen: option
text)`, but the reply is never itself a source of orders. Each order keeps the user's words (`said`) and a
restated `text`; consolidation restates clearly, fixes typos and names, and keeps user wording rather than
interpreting it, so it adds no explanatory notes beyond resolved-choice annotations and `(replaces msg N)`.

Only the user's words create, change or retire an order. `rule` means how to work with no end;
`goal` means something to achieve, with `until` holding its done-condition in the user's words
or resolved from context. When the agent has evidence a goal is done, it must report that evidence
and ask whether to retire it—not silently expire it. A user saying "that's done", "drop the MR
watch", or "yes retire it" creates a retirement directive; the next batch removes targeted items.
Retired instructions stay in extraction history but are not rendered.

For example:
```text
<orders through="2681">
24 [goal until: PM gate shows 0 missing/0 waived/0 baselined and PM pushed] (2026-10-09): Goal: every endpoint and table proven by a witnessed real UI test, 0 waived, 0 baselined; push PM when green locally
2681 [rule] (2026-10-10): i can be okay with you pushing it with no verify but YOU HAVE TO ensure that we fix them eventually
</orders>
```
If a goal has no user-specified or resolvable done-condition, it renders `[goal]` without
inventing one. The `through` header changes only with ledger publication.

Profile files:
- `orders.jsonl`: append-only, flushed `{i,date,orders:[directives]}`. Directives are
  `{said,text,kind:"rule"|"goal",until?:string}` (`said` is the user's words, `text` the restatement) or
  `{retire:[text or numeric source ids]}`.
  Legacy string entries load as `{text,kind:"rule"}` without rewriting the file. Read it as JSONL,
  or use `jq -c 'select(.orders | length > 0)' ~/.omp/optchat/main/orders.jsonl`.
- `ledger.json`: atomic `{through,items:[{text,kind,until?,from:[ids],date}]}` snapshot, loaded without
  recomputation at restart. `through` is the inclusive last incorporated message id. Read active
  instructions with `jq '.items' ~/.omp/optchat/main/ledger.json`; newest source id labels each item.
  After failed consolidation, optional `raw` stores unconsolidated orders and `retire` stores
  pending user retirement targets beside the old snapshot, so restart preserves the fallback.
  A batch that has started but not landed also writes `pending: N` here, before the merge that
  requested it can save the view, so a crash or a closed window can never lose it: the next start
  re-runs that consolidation before the first request.

Consolidated rendered orders are bounded to 16,000 UTF-8 bytes. Oversized or invalid outputs retry,
never truncate. If consolidation fails three attempts, old instructions plus raw new orders are
rendered losslessly (this fallback can exceed the bound), and consolidation retries at the next batch
(or at the next start, while `pending` stands). Between batches the orders prefix is byte-identical,
preserving the prompt cache. Closing OMP mid-consolidation aborts the model call but leaves `pending`
on disk; the first turn after the restart waits for that consolidation, and only a profile's very
first ledger (background backfill) may appear without a view rewrite.


## What it changes in OMP (only when the flag is set)

- The model sees `[tools][system][orders][memory view][current turn]`; OMP's own history stays on disk but is not sent.
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

Release: bump `version` in `package.json`, commit and push, then `gh release create v<version> --generate-notes`.
Publishing the GitHub release runs `.github/workflows/publish.yml`, which tests and publishes to npm (trusted
publishing, no token).

## Credits

Core ported from [pi-optchat](https://github.com/jonaslsaa/pi-optchat) by Jonas Silva (MIT); see
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md). Recipe by Victor Taelin.

## License

MIT, see [LICENSE](LICENSE).
