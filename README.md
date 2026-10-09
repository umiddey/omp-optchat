# omp-optchat

[Victor Taelin's OptChat](https://gist.github.com/VictorTaelin/91837951a5ce5b38f341ec1ba1df6449) for
[oh-my-pi (OMP)](https://github.com/can1357/oh-my-pi): one chat that never ends. Every message is logged, a cheap
model compresses the log into a tree of one-line summaries, and each turn the model sees a bounded view of the
whole history instead of a growing (and compacted) session. It can `zoom` into any line down to the original
message.

Built so the prompt cache keeps working: in real Opus runs, every request after the first turn read 97–99% of
its input from Anthropic's cache.

## Install

```sh
omp plugin install github:umiddey/omp-optchat
```

Update: `omp plugin upgrade omp-optchat`. Remove: `omp plugin uninstall omp-optchat`.

Requires OMP 18.8.3 or newer and an Anthropic login (`/login`) for the summarizer model.
Tested with OMP 18.8.3. Needs an Anthropic login (`/login`) for the summarizer model.
## Use

```sh
omp --optchat main
```

- `main` is the memory profile; any name works (`--optchat work`, `--optchat personal`). Memories are separate per
  profile and live in `~/.omp/optchat/<profile>/` (override the root with `OMP_OPTCHAT_HOME`).
- Without the flag OMP behaves exactly as before. `OMP_OPTCHAT=<profile>` in the environment works too.
- One OMP window per profile at a time: a second window on the same profile is refused. Other OMP windows without
  the flag, or on another profile, are unaffected.
- The model gets two tools: `zoom(id, n)` opens a summary line, `zoom(id, 1)` returns the original message,
  `date(id)` returns when it was sent.
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
`OMP_OPTCHAT_DUMP_DIR=<dir>`, then `bun scripts/cache-check.ts <dir> <session.jsonl>`.

## Credits

Core ported from [pi-optchat](https://github.com/jonaslsaa/pi-optchat) by Jonas Silva (MIT); see
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md). Recipe by Victor Taelin.
