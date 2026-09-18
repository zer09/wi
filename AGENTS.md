# Wi: V1-A service-owned execution handoff

Current status: **v1a.0 is complete and accepted** at implementation head
`fad3855db70ff4151a5c27ec3f64d04fa9097cbb`. Exact-head push run **35320097103** and
pull-request run **35320100396** passed all six Cargo steps on Ubuntu/macOS/Windows.
Accepted foundation: `50f4dffe5d912615014edc46cf1bf1e1b68e6857`.
During acceptance preparation, PR #8 was observed **open and draft, not merged**.
The recorded runs prove only the implementation revision above. Current PR-head merge
checks are external GitHub merge-readiness evidence, separate from this fixed
implementation evidence.
Do not resume the V1-A or P1-B2 implementation prompts. P1-B2 plus B2-E01 is merged in PR #7.

Read in order:
1. docs/slices/v1a/CONTRACT.md
2. docs/slices/v1a/API.md
3. docs/slices/v1a/MATRIX.md
4. docs/slices/v1a/VALIDATION.md
5. docs/slices/v1a/IMPLEMENTOR_PROMPT.md
6. docs/slices/v1a/VERIFICATION.md and verification.json
7. The actual mapped source and prior P1-A/B1/B2 evidence.

Review and preserve the fixed implementation, not a replacement architecture. Inspect
HEAD/ancestry and all staged, unstaged and untracked work. Preserve owner changes; no
reset, clean, forced checkout, unsolicited stash or historical report rewrite. Report
an actual contract conflict with exact producer/consumer evidence before widening scope.

## Accepted foundation

Wi is a Rust harness backend with a provider gateway. OpenAI-Codex subscription auth,
managed profiles, C1 full RunLimits deletion, S1 global/project context, S2 main skill
loading, R1/NB-02, P1-A SQLite store, B1 actual capture and B2 explicit stored-context
replay are complete. Session DB2/catalog1/stored envelope1/runtime2/provider1 remain.

B2 final head e25279ad867d900487c4b41215fb957972493408 passed push35227116004 attempt3
and PR35227120456 attempt1 on all three OS. Its merge tree is unchanged. The new joined
host-like caller tests closed B2-E01 but did not implement a service owner. Existing
Windows watchdog failures on attempts1/2 remain reliability observations, not proven
production defects or fixed flakes. Reports retain earlier failures and unrun live cases.

P1-B2 uses one loop, receipt-first acceptance, fixed-head native/effective replay,
actual opened-account binding, real tool results and awaited storage. Empty application
conversation means empty prior replay; fresh provider connection does not mean fresh
conversation. Incomplete/unbound histories stay readable but are not silently repaired
or assigned today's account. No account/model/transport fallback or automatic resumption.

## Implemented V1-A boundary

The accepted implementation adds a shared in-process run host owning execution independently of
clients/tickets. Dispatch, committed acceptance and actual completion are distinct. The
implementation adds only the specified private receipt notifier and preserves existing
public execution APIs and failure/certainty semantics. Cancellation is explicit; owner
shutdown cancels/drains before closing storage. Client/ticket Drop never cancels; owner
Drop initiates shutdown.
No browser/HTTP/authentication service, normal CLI session interface, GUI, second loop,
provider/tool change, schema migration, dependency change or network deployment.
V1-B network/client protocol remains later work, not incidental implementation.

Use actual host -> B2 -> SQLite -> loopback provider -> real tools in the required
joined tests. Do not substitute separate adapter and fake-host tests. No RunLimits,
optional budgets, task deadlines, lifetime session/history caps, retention deletion,
automatic task restart, retry/failover, hosted skills/API billing or speculative framework.

## Verification and authorization

V1A-00..28 are complete with PASS_LOCAL evidence. V1A-29 is PASS with no blockers;
`accepted=true` and hosted CI is PASS for the implementation head above.
`docs/slices/v1a/VERIFICATION.md` and `verification.json` record exact run/job evidence,
local gates, independent complete-diff reviews, historical pre-commit fingerprints,
failures and limits. Source/CI/local/live remain distinct evidence. Preserve historical
reports and plan-time statuses; do not weaken jobs, lints or tests.

Use synthetic roots/skills/credentials and scripted/loopback providers only. No real
profile/private-skill reads, auth commands or live provider requests. Ledger remains
**31/50 used,19 remaining**. Build caches are allowed, provider probes are not.
The authorized implementation commit and push are complete. Further staging, commits,
pushes, PR state changes, merge/release/deployment, V1-B and live verification require
separate authorization. An old prompt is not fresh permission.
