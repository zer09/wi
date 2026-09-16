# Wi: P1-B1 accepted implementation

P1-B1, contract **p1b1.0**, is implemented. The accepted runtime source is
`b1e46f3eb33a66c2682b3038066a9d20dadf17da`; evidence-only head
`ba83a5f7f7216b0a2f296553ab7e80d7334556a4` passed push workflow 35081585604
and pull-request workflow 35081591576 on Ubuntu, macOS and Windows.
This status correction is documentation only. A later documentation head still
requires its own exact-head checks before merge. PR #6 is the merge-state record.

No new implementation assignment is created by this file. Preserve completed work.
Read the actual current user instruction before making further changes. The original
P1-B1 contract, matrix, validation notes and implementor prompt are frozen phase
records; their PLAN ONLY/NOT RUN headings and old imperatives are not instructions
to repeat completed work. Actual acceptance is recorded in:

- docs/slices/p1b1/VERIFICATION.md
- docs/slices/p1b1/verification.json

The reports attribute 601 Rust passes, two subprocess helpers ignored as standalone
tests, 152 Node self-tests, five offline examples and independent review to local
execution. Hosted CI runs the six Cargo gates, not Node or example mains. Those
counts are not targets for future work. Preserve the earlier failures and repairs.
The planner inspected source and CI, not a fresh local Rust/Node test run.

## Implemented boundary

`wi::execution::run_persisted` captures an explicitly supplied prepared input using
one shared run engine, actual supplied run identity, receipt-first acceptance,
awaited runtime observations, exact serialized tool-result recording and final
RunResult persistence. Duplicate accepted operations never launch work.

The private execution hold retains store ownership across active execution without
holding SQLite/session/maintenance locks across model/tool waits. Store close signals
local cancellation and drains ownership. Dropping the owning execution future is not
a browser disconnect; unfinished ownership follows the documented quarantine policy.
A successful database commit is not proof of successful model execution or guaranteed
upstream termination. Final execution and recording/delivery outcomes remain separate.

P1-A is merged at `34b4cfd0d3ecf286869a239997267dbd75c28c0b`. Its per-session
SQLite/canonical-history/catalog design, schema version 1, explicit catalog refresh
and repair, private-root lease and no-auto-resume behavior remain in force.

## Required later work, not an automatic assignment

B2 must add explicit new submissions using stored conversation history and validated
provider/account-compatible native replay. B1 does not restore old conversation
context. Ordinary `wi run` remains the existing nonpersistent diagnostic path.
Service-owned active-run management, service authentication, browser transport and
GUI are V1 or separately approved work. Do not implement them incidentally.

## Compatibility and enduring requirements

- Keep public legacy run/Tool/registry behavior and runtime/provider schemas 2/1.
- Keep application-session identity separate from provider-session identity.
- ToolFailed remains gateway_error; do not infer is_error from error-shaped JSON.
- Full-batch authority validation precedes tool intent and execution.
- Preserve exact actual tool output, cache/reuse scope, uncertainty and receipt identities.
- Preserve S1/S2 context/skill checks, R1/NB-02 fixes and accepted authentication.
- No RunLimits, replacement budgets, execution quotas, task deadlines, history/session
  lifetime caps, auto-deletion, automatic task restart or external-effect replay.
- No hosted skills/API-key billing fallback, new providers/tools, permission framework,
  alternate database, task scheduler or unrelated reorganization without a new contract.

Wi is a Rust service-oriented harness with a provider gateway, not a CLI-only proxy.
The final service owns work for one owner across devices. Browser disconnect does not
cancel tasks. Application sessions persist; restart stops tasks without automatically
requesting a model, running a tool or draining a work queue. Storage/WAL recovery is
not execution resumption. Embedded storage only; database-file readability is irrelevant.

## Verification and authority

Use synthetic temporary roots, skills, credentials and scripted/loopback providers.
No real credential/private-skill reads, authentication commands or live provider calls
without separate owner permission. Ledger remains **31/50 used, 19 remaining**;
remaining balance is not authorization. Normal build traffic is not model usage.

Preserve user changes and historical evidence. Do not reset, clean, force-checkout,
stash unsolicited work, disable CI jobs or relax warning-denied checks. A new head
requires exact-head CI before an authorized merge. Commits, pushes, merges, release,
deployment and subsequent milestones require the applicable current owner instruction.
