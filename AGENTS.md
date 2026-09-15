# Wi: P1-B1 implementation assignment

Current task: **P1-B1, contract p1b1.0**, actual runtime-to-storage capture.
Accepted baseline: `34b4cfd0d3ecf286869a239997267dbd75c28c0b` (P1-A merged in PR #5).
Planning documents are not implementation evidence; all 30 new rows start NOT RUN.

Read in order:
1. docs/slices/p1b1/CONTRACT.md
2. docs/slices/p1b1/MATRIX.md
3. docs/slices/p1b1/VALIDATION.md
4. docs/slices/p1b1/IMPLEMENTOR_PROMPT.md
5. docs/slices/p1a/SCHEMA.md and its VERIFICATION.md/verification.json
6. The current source paths in VALIDATION.md and applicable existing regressions.

The design and matrix are fixed. Execute the scoped implementation and offline
verification; do not return another architecture plan or repeat P1-A. A source-linked
contract contradiction must be reported before changing behavior or widening scope.
Preserve user work, including untracked changes. No reset, clean, forced checkout,
unsolicited stash or historical report rewrite.

## Current implementation and this increment

P1-A is implemented and merged. Its accepted source is 0839af9; the owner evidence head
was 7e487e4. Planner correction 95353ef changed one stale platform limitation. Push run
34935741002 and PR run 34935743731 passed all six Cargo gates on Ubuntu/macOS/Windows
at that correction head; merge34b4cfd has the same file tree. Local 536 Rust passes,
one ignored child helper, 152 Node tests and four examples are attributed prior evidence,
not B1 test targets. The source reviewer did not rerun them or certify a defect-free repo.

B1 adds a small wi::execution composition over the existing run engine and storage.
It commits the accepted supplied input/real run UUID before provider work, awaits actual
runtime observations, captures actual serialized tool results before continuation and
records the returned RunResult. Duplicate old operations never launch work. Use ONE
shared loop and keep the public legacy run/Tool/registry interfaces compatible.

A narrow crate-private execution hold/closing notification extends the existing storage
lifecycle so explicit close cannot release the root during active execution. No provider
or tool is executed inside storage. Do not hold SQLite/session/maintenance locks across
model/tool waits. Do not add a second task manager or background write queue.

B1 executes only the explicitly supplied prepared input. It does not restore prior
conversation context. B2 remains required for new explicit submissions against retained
history and provider/account-bound native replay. Normal CLI persistence, service client
auth, browser transport, active-run ownership manager and GUI remain later work. This
split is an implementation-scope boundary, not a cancellation of those requirements.

## Preserve these semantics

- RunRequest fields and existing run/provider schemas 2/1 remain unchanged.
- Application-session IDs/sequences are distinct from provider sessions/source sequences.
- ToolFailed remains gateway_error; AuthExpired and Protocol mappings remain unchanged.
- Full batch validation precedes tool intent/execution. No partial call can execute.
- Actual result serialization/error flag/output-size handling is shared; no inferred
  is_error, fabricated tool output, cache rollback after execution or duplicate effect.
- Cancellation is cooperative; a completed actual result differs from pending work.
- SQL queue acceptance is not commit. Ambiguous writes retain their operation identity.
- Final execution outcome and final persistence/delivery outcome remain distinct.
- P1-A schema and explicit catalog refresh/repair remain; no new schema/version planned.
- Preserve S1/S2 catalog/loader/source checks and R1/NB-02 rendering/validation fixes.
- Preserve auth ownership, account/session binding, provider uncertainty and transports.

No RunLimits, optional replacement budgets, task deadlines, history/session quotas,
auto-deletion, task resumption, retry/failover, hosted skills/API billing, new provider,
permissions, shell/resource executors, approvals, steering, compaction, search, alternate
DB, new dependencies, unused framework or production-provider reorganization.

## Verification and authorization

Use synthetic temporary roots/skills/credentials and loopback/scripted providers only.
No real profile/credential/private-skill reads, auth commands or live provider requests.
Ledger remains **31/50 used, 19 remaining**; balance is not authorization.

Run old gates plus new real SQL/controller/registry/process/loopback tests and the new
persisted_run_offline example. Record actual performance costs without a fastest/SLA
claim. Legacy callbacks need not be Send, while the new composition future must be Send.
A slow-storage test must not weaken provider queue/consumer/terminal safeguards.

Create docs/slices/p1b1/VERIFICATION.md and verification.json after actual work. Map every
P1B1-00..P1B1-29 row to executed or honestly unrun evidence. Keep first failures, ignored
helpers, platform exclusions and observer attribution. Obtain fresh independent complete-
diff review and remediate actual in-scope findings. Source counts are not test executions;
zero doctests is not additional coverage.

Local source changes/offline verification are the current assignment. No implementation
commit/push/merge, release, deployment or B2/V1 work without separate owner approval.
Exact-head push/PR Ubuntu/macOS/Windows CI is a later merge gate after authorized push.

## Enduring product requirements

Wi is a Rust harness with a provider gateway, not a CLI-only proxy. The final service
owns work for one owner across devices. Browser disconnect is not cancellation; clients
observe committed history and send explicit commands. Sessions persist. Restart stops
old tasks without automatically requesting a model, executing a tool or draining a task
queue. Database WAL recovery/creation reconciliation does not authorize agent execution.
Only embedded storage is allowed; human-readable database files are not a requirement.

Historical gateway/auth/M3/C1/S1/S2/R1/P1-A prompts are phase records, not fresh orders.
September13 checkpoint resources predate P1-A; current accepted source and new owner
instructions take precedence. Frozen NOT RUN headings preserve original planning status;
subsequent reports/CI establish scoped completion. Remaining unrelated audit notes are
not incidental cleanup assignments.
