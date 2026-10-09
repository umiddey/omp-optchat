# OptChat progress

## Done — milestone 1

Ported append-only log/tree/view, due-order sawtooth, persisted view, scheduler,
settle and paged zoom, file store and image references, logging/capping, compactor
ruler/retries/prime-first, static prompts, cache placement and pure turn projection.
Package pins OMP 18.8.3 as development/type dependencies; no installation.
MIT notice records upstream 6804bec30c564e0a9500d54ddb7d9a3ba6869e53.

Evidence: `bun test` exit 0: 47 pass, 0 fail, five files; `bunx tsc --noEmit`
exit 0. Tests include due-order agreement for t=0..20000 and I1–I7 synthetic
payloads, four consecutive runs, multi-tool loop, and a real-budget fake-compressor batch.

## Next / resume point

Wire the verified OMP lifecycle APIs in src/index.ts, register essential inactive
zoom/date tools, implement seed/check scripts and execute the five-turn RPC smoke.
API source: extensions/types.ts (agent.kind, registerFlag, defaultInactive,
loadMode, hooks, abort), shared-events.ts (context has no signal),
context-settings.ts (`compaction.enabled`), session-tools.ts (four notice types),
pi-ai stream.ts (`streamSimple`), model-registry.ts (find/getApiKey).

## Decisions / deviations to document at final acceptance

Upstream lock is an OS-owned socket with a live owner response rather than a PID
file. Preserve its race-safe acquisition, include PID in owner description.
OMP context exposes no AbortSignal; a lifecycle-owned controller is needed.
Images are stored losslessly rather than depending on upstream Pi's unavailable
resizer export. No out-of-scope UI/import/search/subagent systems are included.
