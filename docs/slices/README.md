# Current Wi slice register

Updated **September 20, 2026**. Accepted runtime foundation:
`16d623a3317abc7796ec203e4fe15d580791a769` (V1-A merge).
This register separates current scope from [archived documentation](../README.md).
Old NOT RUN headings and platform reports belong to their original phase.
Current native platform authority: [Linux/macOS policy](../PLATFORM_SUPPORT.md).

| Slice | Status | Evidence/contract |
|---|---|---|
| S2 local model-selected SKILL.md loading | Accepted/merged PR #3 | [Evidence](s2/VERIFICATION.md) |
| R1 and NB-02 inherited repairs | Accepted/merged PR #4 | [Evidence](r1/VERIFICATION.md) |
| P1-A SQLite session storage | Accepted/merged PR #5 | [Evidence](p1a/VERIFICATION.md) |
| P1-B1 actual runtime capture | Accepted/merged PR #6 | [Evidence](p1b1/VERIFICATION.md) |
| P1-B2 stored replay and B2-E01 joined closure | Accepted/merged PR #7,50f4dff | [Evidence](p1b2/VERIFICATION.md) |
| V1-A service-owned execution | Accepted/merged PR #8,16d623a | [Evidence](v1a/VERIFICATION.md) |
| V1-B authenticated HTTP/API and history stream | Implemented; original 38 PASS/2 PARTIAL preserved; native Windows requirements withdrawn by owner; source cleanup CI passed | [Original evidence](v1b/VERIFICATION.md), [JSON](v1b/verification.json), [platform follow-up and merge gate](v1b/PLATFORM_FOLLOWUP.md), [API/CLI](v1b/API.md), [security](v1b/SECURITY.md) |
| Browser GUI | Not implemented; separately contracted future work | Uses the service API, not a replacement backend. |

V1-B frozen requirements remain [contract](v1b/CONTRACT.md), [matrix](v1b/MATRIX.md),
[validation](v1b/VALIDATION.md) and [old prompt](v1b/IMPLEMENTOR_PROMPT.md). Their
platform applicability is explicitly superseded only by the owner's dated policy.
The original V1B-03/V1B-33 Windows proof gaps are not retroactively passed.

V1-A sourcefad3855/evidencec828f8a was merged at16d623a with identical tree. Push
35325229157 and PR35325232536 attempt2 passed all six Cargo gates on all three
then-supported OS. Earlier watchdog failures remain historical, not proven fixed.
[Merge closure](https://github.com/zer09/wi/pull/8#issuecomment-5733501460) records scope.

V1-B original source6e28cc3 and reportheadf0adbdd have their own reported/hosted
evidence. Windows withdrawal changes source; do not call it source-equivalent to
6e28cc3. Cleanup source4edb2d7 passed push35458188836 and PR35458191471 attempt1,
all six gates on Ubuntu/macOS. Final documentation-head checks and merge are later
PR #9 closure evidence, not results fabricated in this pre-merge record.

HTTP JSON plus committed-history SSE retains separate owner bearer authentication,
explicit workspaces, loopback HTTP and same-host HTTPS proxy requirements. No GUI,
native TLS/device-login, new provider OAuth, deployment or live acceptance is added.
The next fresh local implementor must independently verify Windows removal and
current documentation before feature edits; see the platform follow-up.

Ledger31/50 used,19 remaining, not authorization. No task restarts on Wi startup.
No RunLimits, replacement budget, history-lifetime cap, automatic retry or deletion.
Earlier gateway/auth/M3/C1/S1 records remain in the archive; do not reimplement them.
