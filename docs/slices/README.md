# Current Wi slice register

Updated2026-09-19. Accepted baseline `16d623a3317abc7796ec203e4fe15d580791a769`.
This register adds current state without rewriting frozen contracts, reports or the
[documentation archive](../README.md). Old NOT RUN headings belong to their plan date.

| Slice | Status | Evidence/contract |
|---|---|---|
| S2 local model-selected SKILL.md loading | Accepted/merged PR #3 | [Evidence](s2/VERIFICATION.md) |
| R1 and NB-02 inherited repairs | Accepted/merged PR #4 | [Evidence](r1/VERIFICATION.md) |
| P1-A SQLite session storage | Accepted/merged PR #5 | [Evidence](p1a/VERIFICATION.md) |
| P1-B1 actual runtime capture | Accepted/merged PR #6 | [Evidence](p1b1/VERIFICATION.md) |
| P1-B2 stored replay and B2-E01 joined closure | Accepted/merged PR #7,50f4dff | [Evidence](p1b2/VERIFICATION.md) |
| V1-A service-owned execution | Accepted/merged PR #8,16d623a | [Evidence](v1a/VERIFICATION.md) |
| V1-B authenticated HTTP/API and history stream | LOCAL_VERIFIED, v1b.0; accepted=false; tested `6e28cc3`; 38 PASS/2 PARTIAL | [Evidence](v1b/VERIFICATION.md), [JSON](v1b/verification.json), [API/CLI](v1b/API.md), [security](v1b/SECURITY.md); frozen [contract](v1b/CONTRACT.md), [matrix](v1b/MATRIX.md), [validation](v1b/VALIDATION.md), [prompt](v1b/IMPLEMENTOR_PROMPT.md) |
| Browser GUI | Not implemented; separate future task | Uses the service API; frontend language remains undecided. |

V1-A sourcefad3855/evidencec828f8a was merged at16d623a with identical tree. Push
35325229157 and PR35325232536 attempt2 passed all six Cargo gates on all three OS.
Earlier watchdog failures are retained, not proven fixed. [Merge closure](https://github.com/zer09/wi/pull/8#issuecomment-5733501460)
records recovery/source/CI scope. Local counts/examples/reviews are attributed to reports.

V1-B implements `wi::http_api::serve` and `wi serve --config` at tested revision
`6e28cc339f25a95b78170e7c4171de48f122d07a`. Local gates, increment/final/remediation
reviews and exact-head push/PR CI passed. The report retains two intentionally deferred
Windows subcases, so accepted remains false.
HTTP JSON plus committed-history SSE uses a separate shared owner bearer token,
explicit workspaces, literal-loopback HTTP, same-host HTTPS proxy requirements and
closed browser views. No provider OAuth change, native TLS/device-login/GUI,
deployment or live acceptance is claimed.

The ledger remains31/50 used,19 remaining, not authorization. No task restarts
on Wi startup. No RunLimits, replacement budgets, history-lifetime caps or automatic
retries/deletion are reinstated. Earlier gateway/auth/M3/C1/S1 records remain in the
archive; do not infer they are missing because this directory began with later slices.
