# P1-B2 fresh local implementor prompt

Contract **p1b2.0**. Baseline `6fe0a538edf6bae39c9f933db8394b7d8483e2be`.
This is an implementation/offline-verification assignment, not an architecture prompt.
Read CONTRACT.md, SCHEMA.md, MATRIX.md and VALIDATION.md in this directory before editing.

## Entry prompt

```text
Implement Wi P1-B2, contract p1b2.0, from this planning branch.

Read AGENTS.md and:
- docs/slices/p1b2/CONTRACT.md
- docs/slices/p1b2/SCHEMA.md
- docs/slices/p1b2/MATRIX.md
- docs/slices/p1b2/VALIDATION.md
- docs/slices/p1b2/IMPLEMENTOR_PROMPT.md

Accepted baseline: 6fe0a538edf6bae39c9f933db8394b7d8483e2be.
P1-A and P1-B1 are accepted and merged. Inspect actual HEAD/ancestry and all tracked,
untracked and staged work. Preserve my changes; do not reset, clean, force-checkout,
stash unsolicited work or execute earlier milestone prompts.

The design, supported replay policy, migration and matrix are fixed. Acknowledge scope,
then implement, verify, obtain independent complete-diff review and report. Do not
return another architecture plan or stop after planning.

Add explicit stored-conversation submissions through execution::run_in_session and
shared replay preparation. Use the actual saved prepared prompts, authoritative native/
effective responses and real correlated tool results. Use the existing shared engine,
registry, awaited recorder and store execution hold; no second agent loop.

Implement the specified session-v2 migration and two canonical provenance facts.
Preserve all old data/receipts. New acceptance selects a fixed committed history head
atomically; duplicates return their original receipt without current dependency checks.
Capture identity from credentials ALREADY used to open the provider; compare before
sending any history. Never reread credentials to guess the binding or search other
accounts automatically.

Fresh WebSocket replay starts with full native context and NO old previous_response_id.
Later requests use only that new connection's actual continuation state. SSE preserves
full effective/native replay. Check combined history plus NEW input before acceptance;
do not misapply new-input capacities to whole historical context.

Follow closed-exchanges-v1 exactly. Complete stored exchanges/results may inform a NEW
explicit task, including after interruption. Partial/uncertain/unbound histories remain
readable but are refused for native replay; do not fill gaps, strip opaque content,
truncate tails, invent tool errors or auto-resume work. Definitely-unsubmitted exclusions
need the actual evidence specified by the contract, not merely missing events.

Complete P1B2-00 through P1B2-35. Use real SQLite/DTO/controller/registry paths, independent
v1 migration fixtures, process faults, both loopback transports, identity/duplicate races,
S2 source-deletion cases and the actual public offline example. Validate against a fixed
history head; no current projection or future record may supply missing older evidence.

Run all existing and new gates and obtain fresh independent complete-diff review. Do
not weaken CI, platform checks, schema constraints, error mappings or negative tests.
Do not count reruns, subprocess helpers, examples or source definitions as extra tests.
Preserve first failures and distinguish source inspection, local execution, CI and live.

Create:
- docs/slices/p1b2/VERIFICATION.md
- docs/slices/p1b2/verification.json

No new dependencies, runtime quotas/deadlines/RunLimits, automatic deletion, retries,
failover, hosted skills/API billing, tools/providers, permission framework, storage
engine, server, GUI, normal CLI session interface or unrelated reorganization.
The only storage error addition is the specified stale_history; preserve old codes.

Use synthetic temporary roots/skills/credentials and loopback/scripted providers only.
No real credentials or private skills, auth commands or real provider requests.
Ledger remains 31/50 used,19 remaining; balance is not authorization.

Report a genuine source/contract contradiction with exact producer/consumer evidence
before changing scope. Do not change production behavior to satisfy a mistaken reading.
Leave implementation uncommitted for owner review. No commit, push, merge, release,
deployment, live test or later milestone without separate authorization.
```

## Required closing handoff

Return the tested revision plus any uncommitted diff, actual worktree state, all36 row
dispositions, command outcomes/counts, migration and replay proof, account/transport
boundaries, first failures/fixes, independent reviewers' actual work and remaining
limitations. Identify which cases are unsupported rather than calling every old session
replayable. Preserve no-auto-resume and nonpersistent legacy CLI status explicitly.

An owner's later authorized push requires exact-head Ubuntu/macOS/Windows push and PR
workflow jobs/steps before merge. Local Linux success does not establish hosted native
coverage; prior B1 CI is not B2 CI. Do not merge or begin V1 as part of this assignment.
