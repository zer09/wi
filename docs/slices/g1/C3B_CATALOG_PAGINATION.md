# C61: catalog pagination, hidden-tail oracle and request diagnostics

## Result and scope

**C61R2 COMPLETED_SCOPED_REVIEWED.** One fresh Chromium case passed on HEAD `d6d7c84fe139e8cb2416d2d6950763fd8aeabea2` with the then-uncommitted three-file C61 source. Both fresh reviews of the complete C61, R1 and R2 source and saved evidence passed with no findings. This parent publication has a later cutoff.

The browser now directly exercises **Load more sessions** and **Refresh list**. This supplies the finite browser-action binding that C59 did not locate. The case uses the actual Rust-served embedded app, native browser fetch and layout, with API destinations routed to a synthetic loopback DTO server. This is **B/C**, layered with separately reused actual **H** catalog evidence. It is not new Rust catalog SQLite or joined J proof.

The intermittent request fault was **not reproduced**. Its cause remains **UNVERIFIED**. Original C61's exact More predicate and C61R1's failed-request identity/cause also remain **UNVERIFIED**. A single passing case does not establish universal timing reliability or explain either failed case.

All 40 rows remain **PARTIAL**, `accepted=false`, and the global inventory remains **OPEN**. No push, hosted evidence or acceptance follows. C15, active1, application reader, SSE, no-store/access boundary, pins, deadlines, release-to-DOM waiver and ledger remain unchanged.

## Implemented test behavior

| Source | Behavior |
| --- | --- |
| `web/test-support/catalog-pagination.mjs:5-18,35-69` | Exactly 33 ready DTO rows, ID order contrasted with reverse activity timestamps, faithful nonnull final cursors and a strict settings/first/tail/Refresh pipeline. |
| `web/e2e/catalog-pagination.spec.mjs:72-115,207-237` | Actual Connect, Load more and Refresh actions; exact 32 → 33 → 32 rows, titles, metadata and as-of label; retained first32 identities; exact after_id and no automatic extra read. |
| `web/e2e/catalog-pagination.spec.mjs:84-106` | Hidden tail paginator; visible and enabled initial/Refresh paginator; measured `paginator_hidden`, not a phase-derived disabled claim. The retained renderer remains unchanged at `web/src/display-view.ts:400`. |
| `web/e2e/catalog-pagination.spec.mjs:43-66,158-203` | First eight frozen scalar request-failure records plus an uncapped total; closed route/error labels, event-time response/finished facts, active observation context and one shared Node event counter. Per-call terminal states retain all sequence witnesses. |
| `web/e2e/catalog-pagination.spec.mjs:239-277` | Immutable first snapshot prepared before packet writing; separate final snapshot; original error/custom codes and unchanged failure policy, including cleanup-only failures. |
| `web/test/catalog-pagination.test.mjs:24-498` | Actual client, renderer/observe and listener/classifier/packet-source controls. Covers wrong states/cursors, per-check attribution, cap/order/duplicates, immutable scalar snapshots and publication/cleanup boundaries. Deterministic seams are not native layout proof. |

Request failures still increment `faults.request` and fail the case. No cancellation tolerance, filtering, retry, sleep, extra settling wait, reader change or product change was added. Helper additions are pure classifiers only.

## Fresh runtime result

The one new C61R2 invocation used workers1/retries0 and unchanged case60s/global300s/action+expect10s limits. The saved framework summary is **1 passed (6.6s)** on Chromium145.0.7632.6. This duration is not a product latency measurement.

| Observation | Recorded facts |
| --- | --- |
| Initial | 32 exact ordered rows; paginator hidden=false and visible/enabled assertions passed. |
| Append | Actual Load more click; exact cursor GET; 33 exact rows; hidden=true; first32 DOM identities retained. |
| Refresh | Actual explicit Refresh click; 32 exact rows; hidden=false and visible/enabled; first32 identities retained; initial/Refresh DOM digests equal. |
| Traffic | settings1/catalog3/total4, all GET; four matched responses and four finished calls; nine embedded assets byte-equal. No extra automatic read or command. |
| Faults | All eight counters zero; request-failure total0 and records `[]`. There is no failed request to attribute in this case. |
| Privacy | Memory-only Connect and inert titles passed. Helper HTTP/API-body capture0 is source-bound; application JSON reading was not replaced. |
| Native work counters | null/unavailable, not inferred zero. |

All per-call terminal states are `finished`. These sequence values describe Node callback-entry observation order, including asset callbacks, not physical cause order:

| Closed route | request_seq | response_seq | finished_seq | failed_seq |
| --- | ---: | ---: | ---: | --- |
| settings | 28 | 29 | 31 | null |
| catalog_first | 30 | 32 | 33 | null |
| catalog_more | 34 | 35 | 36 | null |
| catalog_first | 37 | 38 | 39 | null |

Five registered cleanup steps passed: context, transport, native, retirement and faults. Native Stop acknowledged, reap completed, exit0/native stderr empty/no fallback/sandbox removal passed. Input-end/drain remain source-bound helper behavior, not separate runtime flags. Known runner/native identities retired; this is not complete descendant or all-host proof. Runner stderr346 bytes contains two NO_COLOR/FORCE_COLOR warnings, separate from empty native stderr.

Runtime index: (local record). The referenced case `RESULT.json` has SHA256 `996a41606ddcba68f04a81c0a449f0c675b02388589ccfa41fe75a2b01d539a8`. It records `first:null`; no FAILURE.json was fabricated. Fresh invocation/case markers are retained. C61 totals are three invocations, two FAILED and one PASS, with six distinct marker paths.

## Offline gates and native reuse

All final pre-runtime gates bind the exact final three-file source. Counts overlap and are not summed.

| Target after configured Node | Recorded result |
| --- | --- |
| `--test web/test/catalog-pagination.test.mjs` | 93 PASS, 0 failed/skipped/cancelled. |
| `--test web/test/catalog-pagination.test.mjs web/test/display-client.test.mjs web/test/display-view.test.mjs web/test/api.test.mjs` | 510 PASS, 0 failed/skipped/cancelled. |
| `--test` plus all 73 sorted `web/test/*.test.mjs` paths | 5623 PASS, default concurrency, unfiltered, 0 failed/skipped/cancelled. Exact expanded argv is retained, not replaced by an inferred npm command. |
| `--check` for each of the three C61 files | All PASS. |
| `-- web/scripts/assets.mjs typecheck` | PASS. |
| `-- web/scripts/assets.mjs verify` | Eight generated assets verified without publication. |
| Playwright `test --config=web/playwright.config.mjs --list` | 89 registrations in34 files, no bodies. |
| Owned static recorder | Scope/privacy/whitespace/exact-section/diff checks PASS. |

The canonical launcher used configured Node24, both separators, empty bootstrap NODE_OPTIONS and the exact six values from (local record). Cwd was `<repo>`. Exact argv/environment/source/process/terminal/reap/log bindings are retained in the evidence root.

`CURRENT_SOURCE_INDEX.json` binds **ten** final gate records. `FINAL_GATES.json` contains **nine ordinary gates**, with static separately finalized. The parent initially expected ten in the ordinary index; `AUDIT_CORRECTION.json` preserves that comparator rejection and correction. No product proof reran for this correction.

Native evidence is unchanged-input reuse only: all444 inputs, strict C60 executable SHA256 `b44cc10d32773bd2ac4f474acc977abaa99b2dd0749e2d4be7b23f84ad281e3a`, C60 gate/log and exact catalog H PASS at log245 match. The named H case is `catalog_keyset_is_as_of_and_rename_refresh_preserve_exact_titles`, source `src/http_api/router/tests/metadata_tests.rs:144-241`. No Cargo, discovery, build, relink or native-functional gate ran. Only one ordinary reusable native asset-fixture child launched for the new browser case.

## Preserved failures and procedural limits

- Original C61 stays FAILED at More. Its first packet has requests3/server3/faults0 but no precise predicate. The parent supplied the wrong disabled-tail requirement; source verification does not retrospectively identify the failed runtime assertion.
- C61R1 stays FAILED at connect/initial/faults with request1, two matched responses and one finished request. No failed-request identity or physical cause was retained. Four cleanup steps passed; final faults failed. Normal native Stop/reap/exit0/sandbox removal did not make the body pass.
- Original and R1 focused/default gates, initial checker/scaffold failures, packets and consumed markers remain unchanged. R2 preserves regression-first61PASS/30FAIL, later92PASS/1FAIL packet-harness scaffold, static-tool parse failure and EOF whitespace failure before corrected final gates. Earlier successful source cutoffs are not current-source gate substitutes.
- R2's initial read of nonexistent root package.json and parent/reviewer metadata/search diagnostics are disclosed in their reports. The parent named-binding/report writer initially failed parsing before its body; its initial source is preserved and the closing delimiter was corrected. Review-a corrected a Unicode summary lookup without test replay. Neither review ran product bodies. No strict error-free procedural claim follows.

All prior reports retain their cutoffs. No retained failed fixture family or descendant was inspected or adopted. Ignored tool/build caches are excluded from preservation claims.

## Evidence, reviews and publication

Implementation report, full C61/R2 diffs, source archives, manifest, gates and packets: (local record).

Parent records under (local record):

- `SOURCE_BASELINE.json`:800 source entries,797 implementation-nonassigned,696 sealed prior references and444 native inputs.
- `IMPLEMENTATION_AUDIT.json`: all150 new R2 artifacts, ten final gates and finite runtime bindings.
- `REVIEW_AUDIT.json`: both fresh complete-C61/R1/R2 reviews PASS/no findings/0 product executions; three review files preserved. Scope excludes this later parent publication and the master diff.
- `NAMED_TEST_BINDINGS.json`: four selected exact bindings, appended to94 preserved inventory objects. The98 records are not98 new executions or a complete global assertion index.
- `PUBLICATION_AUDIT.json`: later documentation/preservation validation. `CHECKPOINT_RESULT.json` is written only after the authorized local checkpoint.

Review reports: (local record) and (local record).

Both C55 handoffs remain staged outside the checkpoint. Final assertion adequacy, other groups, current-head full-browser/auxiliary/platform/hosted gates, three final complete-master reviews and owner acceptance remain open. No automatic replay or new runtime follows this result.
