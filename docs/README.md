# Wi documentation

**Accepted master:76bb32f. Historical unaccepted checkpoint:8f45dda. Current local source:uncommitted G1.1 on PR #10.** Local schema3, typed reads, display HTTP/SSE and the browser display store are implemented. All 40 G11 rows remain PARTIAL, accepted=false. Source completion is not final acceptance, hosted CI or live evidence.

## Start here

- [Current slice register](slices/README.md): accepted milestones and active work.
- [Architecture](ARCHITECTURE.md): current execution, storage and browser boundaries.
- [Events and representations](EVENTS.md): canonical/provider/runtime/raw API and materialized display views.
- [Platform support](PLATFORM_SUPPORT.md): Linux/macOS native targets; Windows withdrawn.
- [Provider authentication](WI_AUTH.md): existing managed/external provider credentials, separate from service access.
- [Product direction](WI_PRODUCT_DIRECTION.md): historical requirements; latest owner decisions and current slice contract take precedence where explicitly superseded.
- [Top-level usage](../README.md): service/CLI examples and the local storage-only display example.

## Current local G1.1

The owner resolved the history pause. Read the [G1.1 handoff](slices/g1/README.md), [contract](slices/g1/CONTRACT.md), [schema](slices/g1/SCHEMA.md), [Rust reads](slices/g1/RUST_API.md), [client protocol](slices/g1/CLIENT_PROTOCOL.md), [local access](slices/g1/SECURITY.md), [40-row matrix](slices/g1/MATRIX.md), [checkpoint disposition](slices/g1/DISPOSITION.md), [source validation](slices/g1/VALIDATION.md) and [entry prompt](slices/g1/IMPLEMENTOR_PROMPT.md).

The current browser installs the newest human block before requesting older content. It consumes transactionally saved display rows, not raw agent events. Public static assets are separate from bearer-protected APIs and memory-only Connect. Normal literal-loopback HTTP needs no certificate/proxy; provider authentication and the remote HTTPS boundary remain unchanged.

Current evidence: [human report](slices/g1/VERIFICATION_G1_1.md), [JSON](slices/g1/verification-g1.1.json), [offline display example](slices/g1/C3B_OFFLINE_DISPLAY.md), [raw runtime retirement](slices/g1/C3B_RAW_RUNTIME_RETIREMENT.md) and [native auxiliary checks](slices/g1/C3B_NATIVE_AUXILIARY.md). Later scoped results include [rich partial parity](slices/g1/C3B_RICH_PARTIAL_PARITY.md), [client close/handoff](slices/g1/C3B_CLIENT_CLOSE_HANDOFF.md), [native restart](slices/g1/C3B_NATIVE_PROCESS_RESTART.md), [browser restart and binding remediation](slices/g1/C3B_BROWSER_PROCESS_RESTART.md), [C48 saved S2 typed display](slices/g1/C3B_S2_SKILL_DISPLAY.md) and [C49 skill-source browser fidelity](slices/g1/C3B_SKILL_SOURCE_FIDELITY.md). C49 passed one complete42.2s case and both accumulated-scope reviews. Latest [C50 interrupted parity](slices/g1/C3B_INTERRUPTED_DISPLAY_PARITY.md) passed one15.9s case and both scoped reviews: two independently fresh connected browsers match exact interrupted H24 after owned producer death, with zero observer POSTs/work. Prior failed roles/tests remain unchanged; none of these results is whole-row acceptance.

The [current handoff](../handoffs/2026-10-13-032423-g1-1-c49-reviewed-resume.md) and [fresh-agent prompt](../handoffs/2026-10-13-032423-g1-1-c49-reviewed-resume-prompt.md) record the prior staged-checkpoint boundary and proposed C50. That bounded task is now complete; another increment needs a new owner request. C15 and active-conflict remain owner-deferred; the application reader is unchanged. Upgrade/reopen, expanded barriers, qualified transport/browser-server measurements, final required gates, exact-head CI and three fresh complete-diff reviews remain open.

Original [g1.0 checkpoint evidence](slices/g1/VERIFICATION.md), [JSON](slices/g1/verification.json), [design packet](slices/g1/DESIGN_REVIEW.md) and handoffs remain unchanged at their original stage. The earlier report15local-pass/14partial/2blocked/1not-run is not g1.1 acceptance.

## Accepted source and evidence

| Milestone | Current evidence |
|---|---|
| Gateway and managed auth | [Combined report](COMBINED_DESIGN_REPORT.md), [local report](LOCAL_VERIFICATION.md), [auth matrix](WI_AUTH_MATRIX.md) |
| M3 controller / C1 deletion | [M3](WI_RUN_VERIFICATION.md), [C1](WI_EXECUTION_POLICY_C1_VERIFICATION.md) |
| S1 / S2 | [S1](WI_LOCAL_SKILLS_S1_VERIFICATION.md), [S2](slices/s2/VERIFICATION.md) |
| <a id="offline-accepted-and-merged-repair-r1"></a>R1 and NB-02 | [R1](slices/r1/VERIFICATION.md) |
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
