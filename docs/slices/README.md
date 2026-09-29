# Current Wi slice register

Updated **September29,2026**. Accepted runtime baseline **76bb32fd04fd4737c0efcceaabc7d10387453147**, PR #9. Native Linux/macOS only; see [platform policy](../PLATFORM_SUPPORT.md). Historical Windows results are not current support.

| Slice | Status | Evidence or assignment |
|---|---|---|
| S2 model-selected main SKILL.md | Accepted/merged PR3 | [Evidence](s2/VERIFICATION.md) |
| R1/NB-02 repairs | Accepted/merged PR4 | [Evidence](r1/VERIFICATION.md) |
| P1-A storage | Accepted/merged PR5,34b4cfd | [Evidence](p1a/VERIFICATION.md) |
| P1-B1 runtime capture | Accepted/merged PR6,6fe0a53 | [Evidence](p1b1/VERIFICATION.md) |
| P1-B2 replay and joined repair | Accepted/merged PR7,50f4dff | [Evidence](p1b2/VERIFICATION.md) |
| V1-A execution owner | Accepted/merged PR8,16d623a | [Evidence](v1a/VERIFICATION.md) |
| V1-B HTTP service | Accepted for retained scope/merged PR9,76bb32f | [Original evidence](v1b/VERIFICATION.md), [platform follow-up](v1b/PLATFORM_FOLLOWUP.md) |
| G1 original g1.0 | Unaccepted implementation checkpoint8f45dda; rejected history requirements superseded | [Checkpoint](g1/VERIFICATION.md), [design packet](g1/DESIGN_REVIEW.md) |
| **G1 replacement g1.1** | **Current local implementation assignment;40 G11 rows NOT RUN** | [Handoff index](g1/README.md), [contract](g1/CONTRACT.md), [matrix](g1/MATRIX.md), [prompt](g1/IMPLEMENTOR_PROMPT.md) |

G1 is not an empty planning-only PR: it contains203 checkpoint paths and partial code/tests. The new design commits change documents only. Valid checkpoint work is retained or adapted; full-prefix browser reconstruction and Window B proof are replaced explicitly. No original report has been relabelled PASS.

## V1-B/platform closure

Original source6e28cc3/reportheadf0adbdd recorded38PASS/2PARTIAL/accepted=false. The owner withdrew the Windows-only V1B-03/V1B-33 subcases, not their non-Windows assertions. Final reviewed6805640 passed push35458920521 and PR35458921748 attempt1, all six Cargo gates on Ubuntu/macOS; merge76bb32f has the same tree. [Merge closure](https://github.com/zer09/wi/pull/9#issuecomment-5744102056).

The G1 checkpoint reports an independent Windows-removal audit and residual USERPROFILE removal. G11-01 verifies that evidence and new changes; it does not restore native Windows or claim macOS managed-auth/live support. Prior watchdog and inventory failures remain preserved.

## Scope boundaries

Local Wi uses loopback HTTP and the existing shared owner token. No local HTTPS/proxy is required. Remote access/deployment, persistent browser login, project-management UI, rich Markdown/editor/terminal, general coding tools, skill resources/scripts, steering/queues, parallel tools, compaction/branching/search/import and new providers remain separate.

No automatic task resume, RunLimits/replacement budgets, task deadlines or lifetime history caps. Ledger31/50used19remaining remains unchanged and is not live-test permission. Earlier milestone material is indexed in [documentation](../README.md); historical prompts do not authorize current work.
