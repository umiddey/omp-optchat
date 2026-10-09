# omp-optchat

[Victor Taelin's OptChat](https://gist.github.com/VictorTaelin/91837951a5ce5b38f341ec1ba1df6449) for
[oh-my-pi (OMP)](https://github.com/can1357/oh-my-pi): one chat that never ends. Every message is logged, a cheap
model compresses the log into a tree of one-line summaries, and each turn the model sees a bounded view of the
whole history instead of a growing (and compacted) session. It can `zoom` into any line down to the original
message.

Built so the prompt cache keeps working. Measured on real runs, every request after the first one:
Anthropic Opus 97–99% of input read from cache, Codex `gpt-6.1-sol` 98.6%, GLM `glm-5.3-flash` 99% (after GLM
stored the first request).

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

Summarizer model (default `anthropic/claude-haiku-5-5`, medium effort): edit
`~/.omp/optchat/<profile>/config.json`:

```json
{ "compactor": { "provider": "anthropic", "model": "claude-haiku-5-5", "thinking": "medium" } }
```

## What it changes in OMP (only when the flag is set)

- The model sees `[tools][system][memory view][current turn]`; OMP's own history stays on disk but is not sent.
- OMP's auto-compaction is turned off for that session.
- Per-turn memory recall (`<memories>`) and the date/cwd reminder are moved after the view, so they never
  invalidate the cached view.
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

## Credits

Core ported from [pi-optchat](https://github.com/jonaslsaa/pi-optchat) by Jonas Silva (MIT); see
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md). Recipe by Victor Taelin.

## License

MIT, see [LICENSE](LICENSE).
