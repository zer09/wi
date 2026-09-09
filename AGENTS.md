# Wi: active task routing

## M3 bounded run controller — 2026-09-09

The M3 planning PR is documentation only. When the user starts M3 implementation,
follow `docs/WI_RUN_CONTROLLER.md` (contract m3.1), `docs/WI_RUN_MATRIX.md`, and
`docs/WI_RUN_IMPLEMENTOR_PROMPT.md`. The implementor executes this fixed plan;
no second architecture-planning pass or automatic live phase is needed.

M3 permits only its specified source/test/doc changes and offline verification.
No real credential reads, profile checks, login, renewal, provider generations,
commits, pushes or publication are authorized by that task. Pi's authoring
conversation is separate. The completed gateway/auth baseline is
`2d9008b125c8a67dbc6977fe07fd65442cac7f9a`; its current ledger is 27/40 used,
13 remaining, with zero allocated to M3. Existing managed authentication is
complete within its recorded scope and must not be redesigned.

The gateway-repair handoff below and old START_HERE/LOCAL_AGENT_PROMPT documents
are historical task instructions. Their Pi-only auth assumptions, repair scope,
10-request live permission, and report targets do not apply to M3. Use the new
M3 verification files; preserve old reports and ledgers. New explicit user
instructions and higher-priority environment rules still take precedence.

---

## Historical gateway-repair instructions (inactive for M3)

# Local agent instructions — Harness Gateway

## Task and priority

Repair and verify the inherited Rust gateway; do not build a new product. Read
`START_HERE.md`, `docs/LOCAL_AGENT_HANDOFF.md`, and
`docs/REVIEW_CHECKLIST.md` before executing project code.

The user originally expected an implementation plan, but accepted the source
already produced and now wants a local agent to check it, correct defects, and
run bounded live tests. Do not assume earlier assistant claims prove correctness.
Current explicit user directions and the local environment's higher-priority
safety rules take precedence over these project notes.

## Scope

- Native Rust library + CLI; compiled-in provider plugins via traits.
- OpenAI-Codex subscription transport only; read-only existing OAuth credentials.
- Persistent WebSocket session, explicit SSE, typed item/events, continuation.
- One deterministic `add_numbers` tool outside the provider adapter.
- Prefer surgical fixes and regression tests; justified small refactors are fine.
- No GUI, web server, other providers, database, shell executor, dynamic plugin
  loader, native steering, tool search, skills, PTC, or async tool execution now.
- Do not invoke Pi/Codex as an implementation substitute for the gateway. Pi is
  the authoring/review agent; comparing its public source is allowed.

## Credentials and network

Inspect source and dependency/build configuration before real credentials are
read. Real credentials are only to be loaded in process by the reviewed gateway
(or a reviewed local metadata-only checker). Never display their contents through
shell tools, file readers, debug output, exception messages, reports, or fixtures.
Do not dump environment variables, raw headers, native provider streams, or Pi
session logs into the conversation. Do not compute or report token fingerprints.

Use the explicitly selected source. This handoff selects Pi OAuth by default;
Codex OAuth remains supported but requires user selection. Do not search broadly
for credentials, try other accounts, use environment API keys, create keys, or
fall back to API billing. The originating client owns refresh. Do not rewrite,
chmod, copy, rotate, or change storage settings of existing auth files. Report
missing/expired/keyring-only credentials as blockers. Do not disable TLS checks,
spoof another client's identity to evade restrictions, or bypass provider policy.

Cargo/toolchain downloads are development network activity, not provider smoke
tests. Inspect dependency scripts and use normal trusted tooling. Do not install
system software, run as administrator, or execute unexplained install scripts
without appropriate permission. Normal synthetic tests must not require auth or
contact OpenAI. Live tests are local, explicitly gated, and excluded from CI.

## Live limit

After offline/security gates pass, up to 10 total provider-generation submissions
from the gateway under test are allowed for the synthetic text, continuation, and
add_numbers cases in the handoff. Count attempts including ambiguous writes. No
automatic retries, fallback, reconnect replay, or advanced-feature probes. A
failure stops the affected sequence; fix offline first. Report blockers and the
remaining budget. The cap does not include the user's Pi authoring conversation.

## Work preservation and evidence

Inspect `git status` if this is a checkout. Do not reset, clean, delete user work,
auto-commit, push, or publish. Work inside the extracted project. Keep and report
Cargo.lock after dependency resolution; correct formatting and CI deliberately.
Do not weaken validation or delete failing tests simply to obtain green output.

Record a short initial plan, then work; do not repeatedly ask to reconfirm the
already agreed scope. Ask only for genuinely missing choices/permissions that
cannot safely be resolved, such as increasing live usage or changing auth mode.
A blocked live test does not prevent useful offline repair and reporting.

Create `docs/LOCAL_VERIFICATION.md` and `docs/local-verification.json` using the
templates. Preserve `docs/VERIFICATION.md` as historical evidence. Distinguish
source review, compilation, mocked tests, live tests, and account capability
checks. Every PASS needs observed evidence. Unknown remains unknown.
