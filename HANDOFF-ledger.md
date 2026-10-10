# Review corrections A/B/C — complete

Four assertion-level reds before implementation: `bun test test/orders.test.ts --test-name-pattern '^(A |B |C )'`, exit 1, 0 pass/4 failures (artifact://433): A live [] instead of resolved choice; A backfill undefined context; B beyond-current-task instruction absent; C no-interpretation instruction absent.

Corrected extraction snapshots preceding assistant reply for live/backfill, joins consecutive talk chunks, keeps final <=4000 valid UTF-8 bytes. Prompts exclude task-scoped operations/assignments/deployments, resolve approved lasting policy choices from context, and forbid interpretation/comments except replacement and extracted chosen-option annotations. README/DESIGN/PROGRESS updated.

`bun test && bun run typecheck`: exit 0, 102 pass/0 fail, 14 files, 85 expect calls, tsc --noEmit exit 0.

Fresh copied-profile evaluation: 3820 entries, 191 user entries, 94 custom prefixes excluded, 97 extraction records, 63 strings, 56 ledger items, 5745 rendered UTF-8 bytes. 99 Haiku xhigh calls (97 successful extractions + 1 invalid-JSON extraction retried by policy + 1 consolidation), model-reported $0.057333510, 194.600 seconds (process 196.00). 3234 retained with chosen exclude-from-gate/delete-dead-code option; full PM goal and push-green condition retained at 24; both 2681 clauses retained as two items. Initial evaluator single-item 2681 predicate said false; reviewed result corrected transparently because both source-2681 clauses visibly remain. Original five one-off examples excluded; 2849 keeps only its ongoing communications requirement.

Every residual one-off candidate: 24 watch CP MR !103; three 932 chosen clauses (commit only with no missing selected-test claims; stop/wait on new failure; no forced clicks/retries), approving the specific reply-931 plan. Context confirms 126 medium is a durable Sol configuration choice, not one-off. Consolidation has no forbidden editorial notes. Full block, all extraction records and PASS/FAIL table: /tmp/optchat-ledger-results.md; repo summary PROGRESS.md.

Cleanup complete: temporary evaluation script removed; `rm -rf /tmp/optchat-ledger-eval && test ! -e /tmp/optchat-ledger-eval && test -f /tmp/optchat-ledger-results.md`, exit 0. Copied agent.db/profile removed. No install/push/merge/publish. Commit on orders-ledger is next and final action.
