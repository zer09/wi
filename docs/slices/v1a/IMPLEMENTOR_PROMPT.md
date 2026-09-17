# Fresh local implementor entry — V1-A

Contract **v1a.0**, accepted baseline `50f4dffe5d912615014edc46cf1bf1e1b68e6857`.
This is implementation plus offline verification, not another architecture assignment.

```text
Implement Wi V1-A, contract v1a.0, from this planning branch.

Read AGENTS.md and:
- docs/slices/v1a/CONTRACT.md
- docs/slices/v1a/API.md
- docs/slices/v1a/MATRIX.md
- docs/slices/v1a/VALIDATION.md
- docs/slices/v1a/IMPLEMENTOR_PROMPT.md

Accepted baseline: 50f4dffe5d912615014edc46cf1bf1e1b68e6857.
P1-B2 and B2-E01 are accepted and merged in PR #7. Inspect actual HEAD/ancestry,
staged/unstaged/untracked work and preserve owner changes. No reset, clean, forced
checkout or unsolicited stash. Do not execute completed milestone prompts.

The APIs, ownership, receipt point, shutdown semantics and matrix are fixed.
Implement, test, obtain fresh independent complete-diff review and report.
Do not return another architecture plan or silently expand the scope.

Add wi::service RunHost, weak RunClient, passive RunTicket and ShutdownTicket.
Use the existing B2 execution path and real storage, not a second loop. Dispatch
is not durable acceptance. Add only the specified private infallible notifier
AFTER actual unwarned acceptance, preserving all duplicate/failure branches.

The host owns tracked execution. Dropping submission/acceptance/completion/history
waiters, tickets or client handles must not cancel it. Explicit cancel addresses
application session and run together and means signal requested, not durable stop.
Orderly owner shutdown closes dispatch, cancels/drains jobs while storage is open,
then closes storage. Dropped shutdown waiters do not stop that coordinator.
Preserve actual execution/recording outcomes and existing quarantine after worker loss.

Use existing TaskTracker/watch/Handle facilities with a race-safe admission gate.
No unbounded output/command queue, lifetime result cache, new dependency or runtime
policy. No public abort handle, arbitrary callback framework or task deadline.

Complete V1A-00 through V1A-29. Use actual public host dispatch, real SQLite,
actual tools and OpenAI WS/SSE loopbacks in JOINED acceptance tests. Existing
adapter component tests plus a host scripted test cannot substitute for the
whole producer-to-consumer path. Cover empty first history and explicit later
same-session replay, commit gates, duplicates, waiter loss, cancellation, owner
Drop, isolated worker/process loss, shutdown races and no work on reopen.

Create:
- docs/slices/v1a/VERIFICATION.md
- docs/slices/v1a/verification.json

Run all old/new gates and examples, finite measurements, and independent complete-
diff review including untracked files. Preserve first failures and every CI attempt.
Existing Windows watchdog observations were not proven fixed by later passing runs;
diagnose actual new failures rather than suppress checks or rerun until green.
Source definitions, examples, ignored children and repeated runs are not extra tests.

This is the in-process service ownership component only. No HTTP/browser protocol,
client authentication, GUI, normal CLI persistence, new schema, provider/auth/tool
behavior, account fallback, history repair/compaction, new tools or V1-B implementation.
Do not restore RunLimits, optional budgets, quotas, task deadlines or auto-resume.

Synthetic roots/skills/credentials and loopbacks only. No real credentials/private
skills, auth commands, live provider tests or hosted billing. Ledger remains
31/50 used, 19 remaining. Passing offline tests grants no live permission.

Report a genuine specification conflict with exact source and consumer evidence
before changing scope. Leave work uncommitted for owner review. No commit, push,
merge, release, deployment or subsequent milestone without separate authorization.
```

Return exact tested revision/worktree, actual APIs/diff, all30 row dispositions,
commands/counts, joined-path proofs, observed failures/fixes, reviewer work, finite
measurements and remaining limitations. Do not call the local host a network service.
Later authorized push requires exact-head Ubuntu/macOS/Windows push and PR checks;
previous P1-B2 CI is not V1-A CI. No merge is part of this implementor assignment.
