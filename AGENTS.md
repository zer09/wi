# Wi: current V1-B implementation handoff

Active contract: **v1b.0**, documentation-only planning. Accepted runtime baseline:
`16d623a3317abc7796ec203e4fe15d580791a769` (V1-A merged, PR #8).
All V1B-00 through V1B-39 are NOT RUN. No network-service implementation or new
acceptance result is included in the planning commit.

Read docs/slices/v1b/CONTRACT.md, API.md, SECURITY.md, MATRIX.md, VALIDATION.md
and IMPLEMENTOR_PROMPT.md before editing. The [slice index](docs/slices/README.md)
separates the active task from completed milestones. Follow the fixed assignment,
not a new architecture exercise. Check actual HEAD/ancestry and all worktree files;
preserve owner changes, including staged/untracked work. No reset, clean, forced
checkout, unsolicited stash or historical evidence rewrite.

## Accepted baseline

P1-B2/B2-E01 merged in PR #7 at50f4dff. V1-A implements RunHost, weak clients,
passive tickets, actual post-commit acceptance, explicit addressed cancellation
and run drain before storage close. Source fad3855db70ff4151a5c27ec3f64d04fa9097cbb,
evidence c828f8a0e1164aea4731ba8784c3c0e838e962b4, merge16d623a. Exact-head push
35325229157 and PR35325232536, both attempt2, passed six Cargo steps on Ubuntu,
macOS and Windows. The merge tree equals that head. First-attempt watchdog failures
remain reliability observations, not proven fixed; local750 Rust/6 helpers/152Node
and examples/reviews remain attributed evidence, not new test-count targets.

Gateway/managed auth, M3/C1, S1/S2, R1/NB-02, P1-A storage, B1 capture and B2 replay
remain completed. Do not revive old prompts, budgets, hosted skills or unfinished-
work replay. Empty application session has no old model context. A fresh provider
connection may restore compatible history from the selected existing conversation.
Incomplete/unbound history stays readable without automatic repair or account adoption.

## Current scope

Implement a headless authenticated HTTP service over the shared library, not a GUI,
second agent loop, subprocess wrapper, task queue or replacement storage engine.
HTTP JSON commands and canonical-history SSE use the existing host/B2/store. Return
actual acceptance receipts, isolate observers, preserve raw-command duplicate identity
and current provider/account protections. Keep native/binding/credential internals
out of browser views; page/cursor data comes from committed storage, not live queues.

The first service uses a separately provisioned shared owner bearer token, explicit
workspace allowlist, loopback listener and documented same-host HTTPS proxy for
remote devices. This is a new service-client boundary, not provider OAuth/billing.
No insecure public HTTP, cookie/device login, native TLS or deployment is included.
Only the specified Axum direct dependency and necessary transitive additions are allowed.
Core APIs/database schemas and existing CLI commands remain compatible.

Actual HTTP -> RunHost -> B2 -> SQLite -> OpenAI loopback -> real tools is mandatory
acceptance evidence. Separate component tests do not satisfy the joined rows.
Shutdown may close network waiters, never abort core runs or owned SQL; observe the
existing host outcome and quarantine. No task resumes on service restart.

## Verification and authorization

Implement, test, independently review complete diff and report under the fixed40-row
matrix. Create docs/slices/v1b/VERIFICATION.md and verification.json from actual
observations. Do not label source review as execution, reruns as unique tests, old
CI as new-head CI, or loopback as live/provider approval. Preserve failed attempts.

Synthetic roots/skills/owner and provider secrets, loopbacks and scripted providers
only. No real credentials/private skills, auth commands or provider requests.
Ledger31/50 used,19 remaining; balance is not permission. Build-cache/dependency
traffic is development work. Implementation Git writes, merge, release/deployment
and later milestones require separate owner authorization.

No RunLimits/optional replacement budget/global call quotas/task deadlines, lifetime
session/history cap, deletion/retention policy, auto-resume, retry/failover, hosted
skills/API billing, new executors/providers/schema/store, permissions framework,
GUI, native TLS, per-device administration or unrelated reorganization. Report any
genuine contract/source conflict with exact producer/consumer evidence before widening scope.
