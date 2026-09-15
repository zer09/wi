# Wi: P1-A accepted implementation handoff

P1-A durable application-session storage, contract **p1a.0**, is implemented and
accepted on this branch. Local acceptance, final complete-diff review, and exact-head
Ubuntu/macOS/Windows CI passed. The implementation commit is `d429181`; commit
`2fb600a` fixes the macOS Unix-socket fixture path without changing production code.
Runtime baseline: `dd720c0e66eceaaea831ad03e489656f77fc1cec` (R1/NB-02 merged).
See docs/slices/p1a/VERIFICATION.md and verification.json for all 32 dispositions.
Frozen planning NOT RUN headings are not current acceptance evidence.

Read in order:
1. docs/slices/p1a/CONTRACT.md
2. docs/slices/p1a/SCHEMA.md
3. docs/slices/p1a/MATRIX.md
4. docs/slices/p1a/VALIDATION.md
5. docs/slices/p1a/IMPLEMENTOR_PROMPT.md
6. Current source paths in VALIDATION.md and completed R1/S2 verification records.

Preserve the reviewed implementation. Do not begin P1-B or another
architecture-planning exercise. Report
a genuine source/contract conflict before changing scope. Preserve local user work:
no reset, clean, forced checkout, unsolicited stash or overwrite.

## Scope

The shared wi::storage library uses SQLite through minimal SQLx 0.9.0 features,
one canonical database per application session and a session catalog, with
create/rename/receipts, typed history and minimal projections, explicit catalog refresh
and repair, short cursor queries, safe DB ownership, lazy interruption of prior-instance
recorded work, and offline/process evidence. Canonical writes require explicit catalog
refresh; lost-catalog repair is explicit. Receipt retries do not repeat effects.
Handles retain no idle connection; close drains admitted operations before lease release.

P1-A does not integrate ordinary wi run with storage. It records supplied validated
DTOs; P1-B will separately add the awaited runtime seam and explicit new submissions
using preserved provider history. No new CLI/server/GUI is part of this assignment.
Application session IDs/sequences are not provider-session IDs or run-local sequences.
History is not reconstructed from terminal output or by rereading changed skills.

Only the planned new storage modules/export, specified dependency and necessary
lockfile resolution, focused new tests/example and current documentation may change.
Do not change accepted run/provider/auth/context/tool/CLI semantics. Use actual current
DTO getters and serializers; GatewayError::code and run/provider schemas 2/1 stay intact.
ToolFailed remains gateway_error; storage errors have their own static namespace.

No RunLimits, optional budgets, model/tool quotas, whole-run timers, installation
history/session caps, auto-deletion, auto-resume or effect retry. No hosted skills,
API-key billing, extra providers, permission system, shell/resource executors,
search/compaction, arbitrary SQL API, plugin framework or production reorganization.

## Verification and authority

Use temporary synthetic data roots, workspaces, skills and credentials. No real
credential/private-skill access, auth/profile/login/refresh commands, provider requests
or live probes. Normal locked build/dependency fetching is permitted development
traffic. Keep the ledger unchanged: **31/50 used, 19 remaining**.

Keep docs/slices/p1a/VERIFICATION.md and verification.json aligned with actual
P1A-00..P1A-31 evidence, failures/fixes, commands/counts, SQLite/runtime versions,
process/permission gaps and independent review. Local Linux success is not native
Windows/macOS evidence. Windows symlink tests need privilege; ACL protection remains
caller-owned, and same-user TOCTOU is not eliminated. Prior 422 Rust/152 Node results are
historical, not P1-A evidence or a test-count target. Never weaken CI/lints/platform
checks to force acceptance. New direct SQLite dependency is permitted; unrelated
upgrades are not. Compile/run all required old and new gates.

The owner authorized the P1-A commits and pushes recorded in the verification report.
Do not merge, release, deploy, publish or start P1-B/V1 automatically. The final report
distinguishes local tests, exact-head hosted CI, and live provider claims. The planning contract/schema are not implemented acceptance evidence.

## Completed work and enduring direction

Gateway/authentication, M3's retained controller, C1 deletion, S1, S2 and R1/NB-02 are
complete within their recorded scopes. Do not execute their old prompts. Their frozen
NOT RUN headings and historical budgets are evidence of prior phases, not current
assignments. R1 merge is dd720c0; the current docs index links closure and prior reports.
Unrelated audit observations such as older Node classification are not P1-A repairs.

Wi is a Rust harness with a model gateway, not a CLI-only proxy. The final service
serves one owner across devices; the browser only observes/commands. Disconnect is
not cancellation. Sessions persist; restart stops old tasks without automatically
resubmitting model work or rerunning tools. SQLite WAL recovery/catalog repair/in-flight
DB commit cleanup are not agent task resumption. Human-readable database files and
network database servers are not requirements. Actual provider-history restoration,
service authentication, browser protocol, GUI and real coding tools remain later work.
