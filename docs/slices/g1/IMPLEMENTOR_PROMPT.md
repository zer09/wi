# Fresh local implementor assignment — G1

Implement **g1.0**, the minimal browser conversation client. Accepted baseline:
**76bb32fd04fd4737c0efcceaabc7d10387453147** (V1-B/Windows-withdrawal PR #9 merge).
The planning commit and branch are recorded on the G1 PR. This document is the
assignment, not an old verification result. Every G1-00 through G1-31 row is NOT RUN
until you observe it.

## Read before editing

1. AGENTS.md and docs/PLATFORM_SUPPORT.md.
2. docs/slices/v1b/PLATFORM_FOLLOWUP.md and platform-followup.json.
3. docs/slices/g1/CONTRACT.md.
4. docs/slices/g1/CLIENT_PROTOCOL.md.
5. docs/slices/g1/MATRIX.md.
6. docs/slices/g1/VALIDATION.md and this prompt.
7. Current V1-B API/security and actual mapped source, including DTOs/router,
   RunHost/B2, platform inventory and joined provider fixtures.

Inspect actual HEAD/ancestry and every staged, unstaged and untracked file. Preserve
owner work. No reset, clean, forced checkout, unsolicited stash or execution of old
M3/C1/S1/S2/R1/P1/V1 prompts. Do not treat historical NOT RUN/platform requirements or
old report fingerprints as the current native-support policy.

## First complete the independent platform audit

G1-00 and G1-01 precede browser edits. Independently inspect the entire PR #9 follow-up
from f0adbddc31cc1f967ccb2df68c3481b2c7ff5b53 through6805640444e98cd00ef06dcbad1e966b4d4d8a65.
Run `cargo test --test platform_support`, manually audit all native Windows branches,
process launchers, signals, reparse handling, suffix/path accommodations and current
usage/security docs. Verify both Linux/macOS CI jobs and all six Cargo gates remain.
Check that Unix/shared safety assertions were not lost. Do not rely only on the
lexical scanner or planner signoff.

Native Windows is withdrawn. Its old V1B-03/V1B-33 gaps stay historical and are not
PASS. Portable APIs, Windows browser compatibility, WSL Linux, negative path tests,
synthetic environment poisoning and transitive Cargo target metadata are different
things. Do not remove them merely by keyword. Do not port managed auth to macOS or
reintroduce Windows to satisfy an old report. Minimal residual platform/doc cleanup
is allowed only as the narrowly evidenced G1-01 preflight repair; separate that diff
and evidence before proceeding. Report an unrelated runtime/contract blocker rather
than silently expanding the assignment.

## Implement the fixed browser slice

Use framework-free TypeScript modules, HTML and CSS. The backend remains Rust. Use
exact dev dependencies typescript5.9.3 and @playwright/test1.58.2, Node24.x for tooling,
strict TypeScript and reproducibly committed compiled modules. No UI runtime package,
new Rust dependency, bundler or Node server. Cargo must build the embedded assets
without Node; the nonmutating verifier compares complete output sets and bytes.

Add only fixed embedded GET/HEAD static resources after existing Host/Origin checks.
All `/v1` operations stay authenticated. No arbitrary directory/static fallback,
source maps, config injection, auth cookie, public metadata endpoint or auth bypass.
Serve CSP/no-store/nosniff/no-referrer headers as specified.

Use the actual V1-B DTOs, including flat ErrorView, flattened catalog fields and
exact decimal strings. Runtime-validate before the pure reducer. Fetch only same
origin with the separate owner bearer token in page memory; never persist/log it.
No provider OAuth or credentials in browser state. Disconnect/401 clears local data;
cleanup/navigation/stream loss never cancels host-owned work.

Deliver settings-driven creation/list/open/rename, canonical history, explicit task
submission and actual durable receipt, text/refusal/reasoning/tool views, lifecycle,
explicit cancel, and manual observation reconnect. Preserve task/title/result bytes.
Keep pending draft/unknown acceptance separate from canonical saved conversation.
Retries are explicit same-command actions; never an automatic POST or provider retry.

Apply fixed-head pages and SSE afterH with one session-qualified applied cursor.
Decode streaming UTF-8 and SSE framing, not network chunks as events. Advance after
successful application only; verify IDs, duplicates/gaps and epochs. Authoritative
snapshots replace provisional text; run.result never duplicates the answer; actual
tool is_error is authoritative. Render untrusted content only as safe text, not HTML.
Never reconstruct native model replay, hide an incomplete tail or restart old work.

Implement the keyboard/responsive/accessibility requirements without a UI framework,
Markdown engine, IDE, terminal, file tool, new server feature or redesign.

## Verification and delivery

Complete every G1-00..G1-31 assertion with actual named evidence. Joined tests MUST use
real browser actions/assets -> real HTTP/auth/preparation -> RunHost/B2 -> real SQLite
-> actual OpenAI loopback -> real tools -> HTTP/SSE -> DOM. Existing component tests
or route.fulfill mocks are not substitutes. Private cfg(test) child fixtures are
allowed; production fake-provider configuration is not. Reap all children.

Run all existing six Cargo gates, platform inventory, verify.py, Node CLI self-tests,
eight offline examples and the specified HTTP release/loaded samples. Run npmci,
typecheck, nonmutating asset verification, unit tests and actual Playwright Chromium
cases. Add the Ubuntu browser CI job without changing the retained native gates.
Obtain three fresh independent complete-diff reviews including untracked/generated
files and the platform preflight. Preserve each failure, fix and rerun; distinguish
native Rust, Node, browser, hosted, source-inspection and live evidence.

Create:
- docs/slices/g1/VERIFICATION.md
- docs/slices/g1/verification.json

Record actual baseline/final revisions, worktree, platform-audit findings, every row,
commands/test names/counts, reviewers, generated assets, finite measurements, current
docs and limits. Do not fabricate reviews/CI or inflate unique tests with reruns,
ignored helper executions or source-definition counts. Historical reports stay intact.

No RunLimits, replacement budgets, task deadlines, lifetime history caps, deletion,
automatic resumption, retries/failover, hosted skills/billing, new providers/executors,
storage schemas, core/auth policy, arbitrary filesystem API, native TLS/device login,
ordinary CLI persistence, deployment or later milestone.

Use only synthetic temporary roots/skills/owner and provider credentials plus
scripted/loopback providers. No real credential/private-skill reads, auth commands,
provider generations or live smoke. Ledger31/50used19remaining remains unchanged.
Normal package/browser installation is development traffic, not live authorization.

The planner has supplied the design and concrete matrix. Implement it rather than
planning it again. Raise a genuine contradiction with exact producer/consumer evidence
before changing policy. Leave implementation uncommitted for owner review. No commit,
push, merge, publication, release, deployment or later work without separate permission.
