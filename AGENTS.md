# Wi: P1-B2 source and verification boundary

Current contract: **p1b2.0**.
Accepted P1-B1 baseline: `6fe0a538edf6bae39c9f933db8394b7d8483e2be`.
P1-B2 is implemented in local committed source at `80f3872`, with local validation.
B2 push and exact-head hosted CI remain pending. Frozen planning documents retain
NOT RUN statuses; the local reports identify the exact tested source revision and do
not claim hosted acceptance.

Read in order:
1. docs/slices/p1b2/CONTRACT.md
2. docs/slices/p1b2/SCHEMA.md
3. docs/slices/p1b2/MATRIX.md
4. docs/slices/p1b2/VALIDATION.md
5. docs/slices/p1b2/IMPLEMENTOR_PROMPT.md
6. The mapped current source and prior P1-A/P1-B1 verification reports.

Follow the current scoped assignment. Preserve the implemented contract; do not
execute completed milestone prompts or broaden remediation. Preserve user changes,
including untracked and staged work. No reset, clean, force checkout, unsolicited
stash, or historical report rewrite. Report a genuine source/contract conflict with
its exact producer/consumer evidence before changing behavior or widening scope.

## Baseline

P1-A is merged in PR #5 at `34b4cfd`. P1-B1 is merged in PR #6 at `6fe0a53`.
Its source revision is `b1e46f3`, evidence revision `ba83a5f`, and documentation-only
closure `2948b8c`. Push workflow 35088046786 and PR workflow 35088051822 passed all
six Cargo gates on Ubuntu, macOS and Windows at the reviewed head. The merge tree
matches that head. Local 601 Rust passes, two child helpers, 152 Node self-tests and
five examples are attributed earlier observations, not B2 results or count targets.

B1 already records actual supplied-input execution with the shared loop, awaited
observations/results, receipt-first concurrency and storage lifecycle ownership.
It does not restore prior history. B2 now supplies that capability through the same engine.

## Implemented boundary

`run_in_session` and shared read-only `prepare_session_replay` use canonical history
at a fixed head, actual recorded results and native/effective response items. Keep
one shared engine and B1 recording/failure semantics. No transcript flattening,
historical skill rereads, repeated tool effects or speculative old-parent request.

Session schema 2 has tested lazy schema-1 migration, canonical `run.history.selected`
and `run.provider.bound` facts, and additive default-unsupported provider replay methods.
Catalog schema remains 1; preserve old history and receipts. Stored envelopes remain 1;
runtime/provider schemas remain 2/1. Keep public run/Tool interfaces and legacy CLI behavior.
Legacy schema-1 history stays readable but lacks native replay provenance. Migration
never supplies missing selection or account binding.

Only closed exchanges and complete actual results are replayable. Nonempty normal
terminal runs can use committed `RunFinished` without a final `RunResult` when canonical
exchanges validate its outcome and summary. Empty-run exclusion still requires an
actual zero-attempt/admission result. Authorized complete ProcessRestart cases remain
usable only for a new explicit task; missing evidence is not repaired. Incomplete,
uncertain and legacy unbound history remains readable but is not silently repaired
or assigned the current account. Identity comes from the credentials already used by
the provider opening, not an extra read or alias guess. No account search/failover.
The first new WebSocket request sends full native history without an old parent ID;
subsequent requests use that connection's new response ID. SSE retains native history.

## Compatibility and exclusions

Preserve ToolFailed -> gateway_error, actual is_error, original result/request/call
identities, whole-batch preflight, sticky recording failures, cleanup certainty,
final execution versus delivery, S1/S2 source checks, R1/NB-02 and accepted auth.

No new dependency, storage engine, RunLimits or replacement budget, task quota or
deadline, history/session lifetime ceiling, auto-deletion, automatic task restart,
retry/failover, hosted skills or billing path, provider, tool, permission framework,
compaction, import/export, normal CLI session commands, server, GUI or unrelated
reorganization. V1 remains separate. The service will own work across browser
connections; a reader disconnect is not an owning-future cancellation.

## Verification and authorization

Use synthetic temporary roots, skills, credentials, scripted providers and loopback
transports. No real profile/private-skill access, authentication commands or live
provider requests. Ledger remains **31/50 used, 19 remaining**.

The local 36-row implementation evidence is recorded in:
- docs/slices/p1b2/VERIFICATION.md
- docs/slices/p1b2/verification.json

Do not rewrite frozen contracts or historical reports. Evidence updates require their
own assignment and must identify exact source revisions/worktrees, first failures,
checks, platform limits and unsupported cases. Follow the current assignment's gate
and review scope rather than rerunning completed milestones automatically.

Source counts, reruns, examples and child helpers are not additional unique tests.
Do not weaken CI, lints or security assertions. A later authorized push requires its
own exact-head workflow evidence. Leave remediation uncommitted for owner review.
Commit, push, merge, release, deployment, live tests and later work require separate
owner authorization. Old checkpoints and frozen prompts are historical references.
