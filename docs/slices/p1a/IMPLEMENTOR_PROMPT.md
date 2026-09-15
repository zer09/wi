# Fresh local implementor: Wi P1-A

Implement **P1-A, contract p1a.0**, in the existing Wi Rust repository.

Read in order:
1. AGENTS.md
2. docs/slices/p1a/CONTRACT.md
3. docs/slices/p1a/SCHEMA.md
4. docs/slices/p1a/MATRIX.md
5. docs/slices/p1a/VALIDATION.md
6. The current source paths linked by VALIDATION.md and the completed R1/S2 reports.

Runtime baseline: `dd720c0e66eceaaea831ad03e489656f77fc1cec`.
The branch may contain the documentation-only planning commit after that baseline.
Inspect actual HEAD/ancestry, full worktree and untracked paths. Preserve all user
changes; do not reset, clean, stash, force-checkout or rewrite history.

The architecture, dependency, schema and acceptance matrix are specified. Give a
brief scope acknowledgment, then implement and verify. Do not return a replacement
architecture plan or stop after planning. Private helper names and normal coding
details remain yours to implement. A genuine conflict requires exact source evidence
and a targeted question, not a silent behavior change or scope expansion.

## Deliver

A shared wi::storage library using SQLx =0.9.0 with only runtime-tokio and
sqlite-bundled, plus necessary locked dependencies. Verify Rust >=1.94 and the actual
linked SQLite >=3.51.3; no dynamic old engine or extra database driver fallback.

Implement:
- one canonical SQLite file per application session and a session catalog;
- explicit-root, generated-path storage with one OS-backed owner lease;
- operation-scoped async database ownership, commit/rollback/close, safe waiter drop;
- create/rename, original task/prepared-context recording, immutable ordered history,
  minimal transactional run/tool projections and durable receipts;
- catalog-independent session mutation, explicit refresh, validated reconstruction;
- short cursor reads, missing/corrupt/future-version preservation and lazy old-instance
  interruption with zero model/tool execution;
- actual existing DTO/string/provenance round-trips and a synthetic storage example.

This is **P1-A storage only**. Normal wi run is NOT made persistent here. Do not edit
run/provider/auth/tools/context/CLI behavior to connect it. P1-B will require a new
awaited runtime seam, accepted run-ID handling and real provider-history restoration.
Do not claim that replaying stored events to the model is already implemented.

## Required preservation

Do not restore RunLimits, optional budgets, request/tool quotas, whole-task deadlines,
installation session limits, history-lifetime ceilings, auto-deletion or copied
TypeScript operational caps. Query pagination is not a cap on stored work.

Do not add hosted skills/uploads, API-key billing, another provider, callbacks that
execute tools during recovery, approvals, queues, shell/file executors, storage
plugins/ORMs, GUI/server, history compaction, branching, import/export, search or an
unrequested encryption/keyring system. No production provider restructuring.

GatewayError::code is unchanged: ToolFailed remains gateway_error; Protocol remains
protocol_error; AuthExpired remains auth_expired. New StorageError is separate.
Existing RunRequest stays provider_id/options/prompt. Outer runtime schema stays 2;
nested provider schema stays 1. Storage has its own application-session ID/sequence.
Use the real registry output and bool in tests; do not infer errors from enum spelling,
make an Ok error-shaped value, or serialize a finish notification as if it held output.

## Verification and review

Complete every **P1A-00 through P1A-31** row with observed evidence. Test real temporary
SQLite and fresh processes. Baseline 422 Rust / 152 Node is historical, not a target
to fake. Separate source definitions, unique executions, ignored fixtures, filtered
focused runs, reruns, platform coverage and zero doctests.

Run all specified Cargo, Python, Node and example gates. Preserve existing assertions
and warning-denied/OS CI. A finite performance fixture is an observation, not a product
quota or an unsupported comparison with another engine. Preserve first failures.

Obtain fresh independent complete-diff review, including new/untracked files, schema,
transaction/idempotency ordering, file/operation lifetime, creation/reconstruction and
source-to-storage payload fidelity. Record actual reviewer work. Fix confirmed
in-scope findings and rerun. Unrelated findings remain a separate disclosed backlog.

Create:
- docs/slices/p1a/VERIFICATION.md
- docs/slices/p1a/verification.json

Update current docs and task routing to accurately describe observed storage-only
behavior, while preserving historical contracts/reports. All new acceptance starts
NOT RUN. No local source-inspection or draft DDL check is falsely called executed Rust
or physical power-loss evidence. Exact-head hosted CI remains pending until a later
owner-authorized push and actual workflow review.

## Authorization

Use synthetic storage/workspace/skill/credential roots and loopback fixtures only.
No real private-skill access, credential read/write, auth/profile/login/refresh command,
model generation, hosted probe or provider entitlement request. Build dependency
fetches are permitted development traffic, not live acceptance.

Ledger: **31/50 used, 19 remaining**, unchanged. Remaining balance is not permission.
The host Pi author's own inference is not Wi provider-test evidence.

Leave implementation changes UNCOMMITTED for owner review. No commit, push, merge,
release, deployment, publication or next milestone without separate authorization.
Return exact tested HEAD/worktree, changed files, row evidence, commands/results,
engine versions, performance observations, reviewer findings and remaining limits.
