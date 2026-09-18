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
| V1-B authenticated HTTP/API and history stream | Planning only,v1b.0;40 rows NOT RUN | [Contract](v1b/CONTRACT.md),[API](v1b/API.md),[security](v1b/SECURITY.md),[matrix](v1b/MATRIX.md),[validation](v1b/VALIDATION.md),[prompt](v1b/IMPLEMENTOR_PROMPT.md) |
| Browser GUI | Not implemented; separate future task | Uses the service API; frontend language remains undecided. |

V1-A sourcefad3855/evidencec828f8a was merged at16d623a with identical tree. Push
35325229157 and PR35325232536 attempt2 passed all six Cargo gates on all three OS.
Earlier watchdog failures are retained, not proven fixed. [Merge closure](https://github.com/zer09/wi/pull/8#issuecomment-5733501460)
records recovery/source/CI scope. Local counts/examples/reviews are attributed to reports.

V1-B is not a delivered server merely because a plan exists. New choices are HTTP
JSON plus SSE, a separate shared owner bearer token, explicit workspace selection,
loopback HTTP with same-host HTTPS proxy deployment and closed browser data views.
No provider OAuth change, native TLS/device-login/GUI/deployment or live acceptance.

The ledger remains31/50 used,19 remaining, not authorization. No task restarts
on Wi startup. No RunLimits, replacement budgets, history-lifetime caps or automatic
retries/deletion are reinstated. Earlier gateway/auth/M3/C1/S1 records remain in the
archive; do not infer they are missing because this directory began with later slices.
