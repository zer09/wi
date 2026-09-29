# Wi documentation

Updated September29,2026. **Accepted runtime:76bb32f. Current assignment:g1.1 on PR #10.** The branch also contains unaccepted browser checkpoint8f45dda. Do not confuse accepted master, partial code, new specifications and execution evidence.

## Start here

- [Current slice register](slices/README.md): accepted milestones and active work.
- [Architecture](ARCHITECTURE.md): implemented boundaries and explicitly proposed changes.
- [Events and representations](EVENTS.md): canonical/provider/runtime/raw API versus planned display views.
- [Platform support](PLATFORM_SUPPORT.md): Linux/macOS native targets; Windows withdrawn.
- [Provider authentication](WI_AUTH.md): existing managed/external provider credentials, separate from service access.
- [Product direction](WI_PRODUCT_DIRECTION.md): historical requirements; latest owner decisions and current slice contract take precedence where explicitly superseded.
- [Top-level usage](../README.md): current accepted service/CLI examples. New schema3/display behavior is not implemented by the planning commit.

## Resume G1.1

The owner resolved the history pause. Read the [G1.1 handoff](slices/g1/README.md), [contract](slices/g1/CONTRACT.md), [schema](slices/g1/SCHEMA.md), [Rust reads](slices/g1/RUST_API.md), [client protocol](slices/g1/CLIENT_PROTOCOL.md), [local access](slices/g1/SECURITY.md), [40-row matrix](slices/g1/MATRIX.md), [checkpoint disposition](slices/g1/DISPOSITION.md), [source validation](slices/g1/VALIDATION.md) and [entry prompt](slices/g1/IMPLEMENTOR_PROMPT.md).

The replacement uses newest human interaction first, transactionally saved display rows and identical live/history chronological rendering. The browser does not reconstruct raw agent events. Local HTTP needs no certificate; existing small bearer access remains. No Window B browser-internals experiment is required. All new G11 rows are NOT RUN.

Original [g1.0 checkpoint evidence](slices/g1/VERIFICATION.md), [JSON](slices/g1/verification.json), [design packet](slices/g1/DESIGN_REVIEW.md) and handoffs remain unchanged at their original stage. The earlier report15local-pass/14partial/2blocked/1not-run is not g1.1 acceptance. New results use VERIFICATION_G1_1.md and verification-g1.1.json during implementation.

## Accepted source and evidence

| Milestone | Current evidence |
|---|---|
| Gateway and managed auth | [Combined report](COMBINED_DESIGN_REPORT.md), [local report](LOCAL_VERIFICATION.md), [auth matrix](WI_AUTH_MATRIX.md) |
| M3 controller / C1 deletion | [M3](WI_RUN_VERIFICATION.md), [C1](WI_EXECUTION_POLICY_C1_VERIFICATION.md) |
| S1 / S2 | [S1](WI_LOCAL_SKILLS_S1_VERIFICATION.md), [S2](slices/s2/VERIFICATION.md) |
| R1 and NB-02 | [R1](slices/r1/VERIFICATION.md) |
| P1-A | [Storage](slices/p1a/VERIFICATION.md) |
| P1-B1 | [Capture](slices/p1b1/VERIFICATION.md) |
| P1-B2 and B2-E01 | [Replay](slices/p1b2/VERIFICATION.md) |
| V1-A | [Execution ownership](slices/v1a/VERIFICATION.md) |
| V1-B and platform withdrawal | [Original report](slices/v1b/VERIFICATION.md), [follow-up](slices/v1b/PLATFORM_FOLLOWUP.md), [API](slices/v1b/API.md), [security](slices/v1b/SECURITY.md) |

V1-B's original accepted=false and two Windows partials are preserved observations; later supported-scope acceptance/merge is in its platform follow-up and slice register. R1 and V1-A are merged, so unqualified old NOT RUN/open-PR language is not current status. Hosted/local/live evidence always retains its actual observer and revision. New docs do not rerun prior suites.

## Historical detail and archive

The previous comprehensive documentation index, including historical-citation errata, templates, packaging/source records and older detailed descriptions, is preserved unchanged at:
https://github.com/zer09/wi/blob/8f45dda2a2c168931735cf798560b8dfd02a1579/docs/README.md

The detailed previous architecture/event narratives are likewise preserved at that checkpoint. This current index replaces stale present-tense status summaries, not their historical evidence. Frozen verification reports, original requirements at their pinned commits and handoffs are not rewritten. Original NOT RUN headings describe planning time; later reports/merge records establish only their tested scope.

No live provider traffic, auth command, deployment or next milestone is authorized by reading an archived prompt. No RunLimits can be restored from old M3 text. The ledger remains31/50used19remaining; remaining balance is not permission.
