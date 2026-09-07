# Local verification report — replace with actual date

Copy this file to `docs/LOCAL_VERIFICATION.md`. It is a template, not evidence.
Use PASS / FAIL / BLOCKED / NOT RUN / NOT APPLICABLE. Delete unused example text.

## Verdict

- Milestone: gateway communication + ordinary tool round trip.
- Overall status: NOT RUN.
- Rust build: NOT RUN.
- Offline tests: NOT RUN.
- WebSocket live verification: NOT RUN.
- SSE live verification: NOT RUN.
- Provider/account access scope: unknown until tested.
- No advanced-feature support is claimed.

## Environment and baseline

Date/time; OS/architecture; rustc/cargo/Pi versions; exact tested model identifier;
auth source label (Pi or explicitly selected Codex); source baseline; local git
revision if any; initial dirty worktree status. Do not include account IDs,
credentials, token fingerprints, private absolute paths, or native response dumps.

## Findings and repairs

| ID | Severity | File / symbol | Observed evidence | Root cause and fix | Regression | Status |
|---|---|---|---|---|---|---|
| — | — | — | No findings recorded yet | — | — | NOT RUN |

Distinguish confirmed defects from unresolved review questions. Explain any public
API, protocol, dependency, validation, or documentation changes.

## Local checks

| Command | Exit code | Result | Executed / ignored / filtered | Evidence / blocker |
|---|---|---|---|---|
| cargo fmt --all -- --check | — | NOT RUN | — | — |
| cargo check --all-targets | — | NOT RUN | — | — |
| cargo test --all-targets | — | NOT RUN | — | — |
| cargo clippy --all-targets -- -D warnings | — | NOT RUN | — | — |
| cargo build --all-targets | — | NOT RUN | — | — |
| cargo test --doc | — | NOT RUN | — | — |

Record first failures and final reruns separately. Static test-definition counts
are not executed counts. Note OS-specific tests not exercised and whether Cargo.lock
was generated. Do not imply GitHub CI ran unless it actually ran.

## Security review before live requests

Credential-source selection, read-only behavior, output redaction, TLS/redirect
rules, synthetic-only tests, no billing fallback, scope of executable tools,
request/queue bounds, cancellation uncertainty. State residual limitations.

## Live evidence — no raw logs

| Case | Model | Transport | Submissions | Result | Observed assertions / blocker |
|---|---|---|---|---|---|
| W1 text | — | WebSocket | 0 | NOT RUN | — |
| W2 continuation | — | WebSocket | 0 | NOT RUN | — |
| W3 tool round trip | — | WebSocket | 0 | NOT RUN | — |
| S1 text | — | SSE | 0 | NOT RUN | — |
| S2 continuation | — | SSE | 0 | NOT RUN | — |
| S3 tool round trip | — | SSE | 0 | NOT RUN | — |

Total gateway provider submissions: 0 / 10. Count failed/uncertain submissions.
Record no secret material. Use non-reversible local aliases for identities where
needed, rather than including upstream response/account IDs. Known synthetic
prompt text, add_numbers input, and result 42 are safe to summarize.

For each pass, state how it was verified. Show that the gateway's actual transport
and executor path were used. Record missing deltas or reasoning fields as not
observed, not automatically verified. Confirm no hidden fallback/retry occurred.

## Changes and repeatable commands

Paths changed; behavioral changes; exact commands for the user's shell; generated
Cargo.lock status; tests added; docs reconciled; no commit/push/publish performed.

## Remaining risks and next decision

Separate code defects from provider entitlement/protocol/network restrictions.
Clearly list blocked or unrun tests. Do not begin advanced features automatically.
Summarize whether this small milestone is ready, partially verified, or blocked.
