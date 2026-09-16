# Wi: P1-B2 implementation assignment

Current task: P1-B2, contract **p1b2.0**.
Accepted baseline: `6fe0a538edf6bae39c9f933db8394b7d8483e2be`.
The branch is a planning handoff until the local implementation is performed.
All 36 acceptance rows begin NOT RUN.

Read in order:
1. docs/slices/p1b2/CONTRACT.md
2. docs/slices/p1b2/SCHEMA.md
3. docs/slices/p1b2/MATRIX.md
4. docs/slices/p1b2/VALIDATION.md
5. docs/slices/p1b2/IMPLEMENTOR_PROMPT.md
6. The mapped current source and prior P1-A/P1-B1 verification reports.

Execute the fixed implementation and offline verification. Do not return another
architecture proposal or execute completed milestone prompts. Preserve user changes,
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
It does not restore prior history. B2 is the new capability, not a B1 repair.

## Required boundary

Add `run_in_session` and shared read-only replay preparation, using canonical history
at a fixed head, actual recorded results and native/effective response items. Keep
one shared engine and B1 recording/failure semantics. No transcript flattening,
historical skill rereads, repeated tool effects or speculative old-parent request.

The contract authorizes session schema 2 with a tested lazy v1 migration, selection
and provider-binding facts, and additive default-unsupported provider replay methods.
Catalog schema remains 1; preserve old history and receipts. Runtime/provider schemas
remain 2/1. Keep existing public run/Tool interfaces and legacy CLI behavior.

Only closed exchanges and complete actual results are replayable. Incomplete,
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

Execute all 36 rows and required gates/examples. Obtain fresh independent complete-
diff review. Record exact revision/worktree, first failures, test outcomes, schema
migration, identity/native replay, platform limits and remaining unsupported cases in:
- docs/slices/p1b2/VERIFICATION.md
- docs/slices/p1b2/verification.json

Source counts, reruns, examples and child helpers are not additional unique tests.
Do not weaken CI, lints or security assertions. A later authorized push requires its
own exact-head workflow evidence. Leave implementation uncommitted for owner review.
Commit, push, merge, release, deployment, live tests and later work require separate
owner authorization. Old checkpoints and frozen prompts are historical references.
