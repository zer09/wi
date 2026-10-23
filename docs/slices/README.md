# Current Wi slice register

Accepted runtime baseline **76bb32fd04fd4737c0efcceaabc7d10387453147**, PR #9. Native Linux/macOS only; see [platform policy](../PLATFORM_SUPPORT.md). Historical Windows results are not current support.

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
| **G1 replacement g1.1** | **Committed runtime; evidence complete at e61c881, accepted=false** | [Current merge assessment](g1/VERIFICATION_G1_1.md#current-merge-readiness), [machine matrix](g1/verification-g1.1.json), [current index](g1/README.md), [contract](g1/CONTRACT.md), [requirements matrix](g1/MATRIX.md), [Historical C93 local and hosted verification](g1/VERIFICATION_G1_1.md#c93-fixed-browser-and-current-head-verification) |

The203-path g1.0 checkpoint is historical partial work, not an empty planning-only PR. The later committed G1.1 runtime adds schema3/display HTTP-SSE and the thin browser, with explicit raw-runtime/Window B retirements. Historical C93 records local and successful hosted verification scoped to source `1b8b50c7abd8ebdac95d8964a4788bf257ce3547`. Later documentation-only commits retain a separate cutoff and do not inherit exact-head CI results. Source completion alone proves neither CI nor acceptance. See the [current merge assessment and C15/active1 dispositions](g1/VERIFICATION_G1_1.md#current-merge-readiness) for row outcomes and revision-scoped checks. The application reader/SSE/no-store policy is unchanged; exact release-to-DOM remains WAIVED_BY_OWNER, not measured. Both workflows pass for submitted implementation e61c881; each later pushed head needs its own CI. Owner acceptance and merge approval are separate from row outcomes.

Historical [C49 saved-skill fidelity](g1/C3B_SKILL_SOURCE_FIDELITY.md), [C50 interrupted parity](g1/C3B_INTERRUPTED_DISPLAY_PARITY.md) and the October13 [handoff](../../handoffs/2026-10-13-032423-g1-1-c49-reviewed-resume.md) retain their recorded cutoffs. They are not current next-task authority. No original report or failed role is relabelled PASS, and this register authorizes no execution or Git transition.

## V1-B/platform closure

Original source6e28cc3/reportheadf0adbdd recorded38PASS/2PARTIAL/accepted=false. The owner withdrew the Windows-only V1B-03/V1B-33 subcases, not their non-Windows assertions. Final reviewed6805640 passed push35458920521 and PR35458921748 attempt1, all six Cargo gates on Ubuntu/macOS; merge76bb32f has the same tree. [Merge closure](https://github.com/zer09/wi/pull/9#issuecomment-5744102056).

The G1 checkpoint reports an independent Windows-removal audit and residual USERPROFILE removal. G11-01 verifies that evidence and new changes; it does not restore native Windows or claim macOS managed-auth/live support. Prior watchdog and inventory failures remain preserved.

## Scope boundaries

Local Wi uses loopback HTTP and the existing shared owner token. No local HTTPS/proxy is required. Remote access/deployment, persistent browser login, project-management UI, rich Markdown/editor/terminal, general coding tools, skill resources/scripts, steering/queues, parallel tools, compaction/branching/search/import and new providers remain separate.

No automatic task resume, RunLimits/replacement budgets, task deadlines or lifetime history caps. Ledger31/50used19remaining remains unchanged and is not live-test permission. Earlier milestone material is indexed in [documentation](../README.md); historical prompts do not authorize current work.
