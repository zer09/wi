# Fresh implementor assignment — P1-B1

Implement **p1b1.0** against accepted merge
`34b4cfd0d3ecf286869a239997267dbd75c28c0b`. This is a fixed implementation contract,
not a request to design another architecture. Read AGENTS.md and this directory's
CONTRACT.md, MATRIX.md and VALIDATION.md in full before edits. Then read the actual
current source they identify and P1-A's accepted schema/verification records.

The September 13 uploaded checkpoint predates P1-A. P1-A is now implemented and merged;
do not reimplement it or treat its original NOT RUN headings as current status.
P1-A review/merge closure is on PR #5. Its accepted source is 0839af9, one-line evidence
correction 95353ef, merge 34b4cfd. Preserve original failures and factual limitations.

## Work to execute

Add `wi::execution::run_persisted` for actual execution recording through the real
controller, ToolRegistry and SessionHandle. Implement receipt-first duplicate handling,
shared pure preflight, actual accepted runtime UUID, awaited event/result persistence,
and the minimal store-lifecycle execution hold/closing notification.

Refactor private observation/admission as needed; keep ONE orchestration loop, the old
run/Tool/registry public APIs and serialized event/error contracts. Keep legacy non-Send
synchronous observers usable; prove the persistent instantiation is Send. Preserve
current gateway/auth transport behavior and per-run result scopes.

Tool output must come from the actual serializer after existing error/output handling
and cache insertion, before truthful finish delivery and provider continuation. Do not
infer is_error from JSON or fabricate a trace after execution. ToolFailed still maps to
gateway_error. The stored input is the actual supplied prepared snapshot, not a reread
of mutable skill files. Validate against the actual admitted registry definitions.

A critical storage failure stops further work, preserves its operation identity and
certainty/cleanup receipt, and never masquerades as rollback or provider failure alone.
Store close must not release root ownership while the persistent execution or admitted
SQL can still publish. Client history reads are independent; dropping a reader is not
cancellation. Directly aborting the backend-owned execution future is different and
uses the documented conservative ownership behavior.

## Explicit scope boundaries

P1-B1 is capture of an explicitly supplied prepared input. It does NOT reconstruct
previous conversation history into model input, integrate a new persistent CLI command,
or build the V1 service. B2 remains a separate required contract for restored-conversation
new submissions and provider/account compatibility. Do not flatten stored messages into
one user prompt or reuse old provider sockets/response IDs as a shortcut.

No schema/version change, new dependency, alternative storage, queue/pool/cache framework,
config knobs, RunLimits, optional budgets, task deadlines, history/session caps, automatic
resumption, retries/failover, hosted skills, API-key billing, permissions, shell/resource
executors, approvals, steering, compaction, server or GUI. Existing source organization
and accepted protections remain. A pressure test does not authorize changing provider
consumer timeouts or inventing lossless buffering.

## Implementation and evidence

1. Inspect HEAD/ancestry and tracked/untracked work. Preserve owner changes; no reset,
   clean, forced checkout, stash or broad reformat. Observe baseline gates.
2. Implement in the sequence from VALIDATION.md. Add focused real-path regressions;
   compile and check the private observer/lifetime changes before deeper integration.
3. Complete all **P1B1-00..P1B1-29** using actual SQLite, actual controller/registry,
   scripted providers, current WS/SSE loopback fixtures and isolated child processes.
4. Run the complete required gates and all five offline examples. Measure the explicitly
   requested finite costs; do not claim a throughput improvement without a comparison.
5. Obtain fresh independent complete-diff review, including untracked files. Fix confirmed
   in-scope findings and rerun. Report a true contract contradiction with exact producer,
   consumer and assertion evidence instead of silently changing the specification.
6. Create VERIFICATION.md and verification.json in this directory. Every matrix row
   needs actual evidence, test names/commands, observer, failures/fixes and remaining gaps.
   Preserve distinction between source review, observed tests, CI and live behavior.

Use isolated synthetic HOME/config/data/workspace/skill roots. No real credentials,
private skill text, auth/profile/login/refresh commands or provider requests. No live
probe or automatic live phase. Ledger stays **31/50 used, 19 remaining**.

The owner is authorizing local scoped implementation and offline verification through
this assignment. Leave implementation uncommitted for review. No commit, push, merge,
release, deployment or later-slice work without separate owner authorization. After an
authorized push, verify both workflows and every configured OS job on the exact head;
local Linux results alone are not cross-platform evidence.

Return a handoff with exact HEAD/worktree, source changes, 30-row status, actual commands
and counts, persistence/effect/failure observations, review outcomes, timing measurements,
compatibility and limitations. Do not stop after planning or return a claim that all of
P1-B/V1 is done when this capture increment is complete.
