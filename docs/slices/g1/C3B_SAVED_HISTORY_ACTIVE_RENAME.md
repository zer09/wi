# C57: active Rename and saved history with an absent workspace

**C57R2 runtime PASS at `9f1687cc12e293997c59a1764abeb3f9e7864fb3`.** One fresh unchanged-source Chromium case supplies the two browser observations that were NOT_LOCATED at the [C55/C56 cutoff](C55_CLOSURE_AUDIT.md). It does not promote G11-31 or any other row. All 40 official rows remain PARTIAL and accepted=false.

This document reports observed execution and its limits. Parent scoped review and local checkpoint receipts are separate records, listed below. No final master-wide review, hosted CI, push or acceptance follows from this result.

## Cutoffs and preserved failures

| Increment | Actual result and boundary |
|---|---|
| C57 | FAILED/verification_failure before Task at the populated catalog guard. Connect/Create/explicit Refresh list ran. Task, Rename, workspace move and fresh observer did not run. Two markers were consumed. The packet retained only `stage=catalog, code=catalog`; its exact first predicate remains UNOBSERVED. |
| C57R1 | Independent F1 verification reproduced an oracle defect in 10 synthetic actual-helper scenarios/21 checks. The null-cursor guard rejected production-shaped populated final pages. A two-file offline repair now requires the last returned ID. Both offline scoped reviews passed. Local checkpoint `9f1687c` includes the unchanged spec required by the unit controls. No repaired-source browser case ran in R1. |
| C57R2 | Exactly one new invocation of the existing case passed, workers1/retries0, with fresh output and two new markers. No repository source, assertion, deadline, dependency, browser or native artifact changed during execution. |

C57 therefore has two runtime attempts: one FAILED and one PASS, with four distinct marker paths. R1 is offline work, not a third runtime attempt. Later evidence does not replace either earlier cutoff or recover the original failed predicate.

## Bound execution

Case: `saved populated history survives absent recorded workspace after Rename during active execution` in `web/e2e/saved-history-active-rename.spec.mjs:55-285`.

- Source revision: `9f1687cc12e293997c59a1764abeb3f9e7864fb3`.
- Spec SHA256: `29dc76d5411aa333679f0ec7989160cb2d717588fade323ba998de71adaef54b`.
- Helper SHA256: `e88eefa99accf8b8743afadb10f03646606f9a9fd72b06e1c4f9a9e78ca6d5ff`.
- Unit controls SHA256: `e68b02497c8736efb69d8789d30e55912966c26c2fcb5d7a13ba5cf3566fe477`.
- Native executable SHA256: `a59bdbc6b1300b82f77350c736511c2fc2ea3b07c3f8826a7cb8d31ffa13ddde`; all 443 compiled inputs and permission modes matched before and after.
- Installed Playwright/core1.58.2 and Chromium revision1208 were bound by package/registry/binary hashes. The pinned registry identifies Chromium145.0.7632.6. Runtime sampling observed the bound headless-shell executable; no separate version probe or download ran.

The owned runner bound its actual OS argv, identity, cwd, approved six-value environment and intended Playwright CLI before importing the unchanged CLI. The sole CLI selection used `web/playwright.config.mjs`, workers1/retries0, the exact spec and fresh owned output. Existing headless/default deadlines remained. Trace, screenshots, video and HAR were off.

`WI_C3A_FIXTURE` selected the validated existing executable. No Cargo discovery/build/relink, native preprobe, extra browser case or old proof replay ran. All traffic used synthetic credentials/workspaces and the loopback WebSocket provider.

## Observed active Rename

| Barrier | Head | Gate | Entries including human | Accepted / receipts | Completed / terminals / results |
|---|---:|---|---:|---|---|
| Held |16|3|4|1 / 1|0 / 0 / 0|
| Renamed |17|3|4|1 / 1|0 / 0 / 0|
| Completed |21|null|4|1 / 1|1 / 1 / 1|
| Fresh saved observer |21|completed state|equal completed page|native state unchanged|native state unchanged|

The browser connected, created and selected the session, then explicitly refreshed the list. The typed catalog contained the seed and created session. Both catalog barriers required the real final last-ID cursor, exact sorted IDs, metadata, selected row and corresponding DOM (`web/test-support/saved-history-active-rename.mjs:86-101,119-155`).

One explicit Task ran. Gates1/2 were driven; gate3 held existing tool output and provisional assistant text. A tool result existed, but no run result existed. Rename ran through the UI while the Task remained held. The exact command/receipt and independent `catalog_refresh=updated` checks passed.

Held and renamed observations had requests2, connections1, auth_loads1, auth_prepares1, prepared_exact2, fresh_parents1, continuations1 and tool_results1. Completion/terminal/result counters stayed0 during Rename. The metadata head advanced16→17. The complete active block/entries, identities/order/epochs/generations/exact bytes/recorded facts and normalized run DOM remained equal. Held and renamed DOM SHA256 was `96f5590106c260fbfc0166de0dbce0f90d5a00023d2eef34094643439149b50f`.

The previously loaded catalog stayed unchanged until explicit Refresh list. The refreshed catalog retained its two ordered IDs and published the renamed title/head17/running state. Gate3 then released once. Exact ordinary Task/tool/final-answer DTO/DOM and normal completion assertions passed at head21.

These assertions executed in the unchanged helper/spec. Raw DTOs and DOM were not retained. A changed heading, separately fetched typed page or advancing page cursor does not prove that the original browser consumed a particular Rename SSE frame.

## Absent recorded workspace and fresh saved history

After durable completion, the case checked native PID/start/executable/PPID/cwd/TMPDIR and the owned root/workspace ancestry/dev/inode/mode, with no symlink and an absent destination. It moved only that owned workspace once to its same-parent sibling. Original-path ENOENT and destination identity were checked before and after fresh observation (`web/test-support/saved-history-active-rename.mjs:172-224`). No workspace contents were read for this proof.

The original context closed. A fresh browser context/page explicitly connected to the saved session. Original Latest200 preceded the matching SSE200 handshake. The renamed title, original non-null recorded workspace string, complete populated saved page and normalized run DOM matched the completed observation while the original workspace path remained absent (`web/e2e/saved-history-active-rename.spec.mjs:233-267`; `web/test-support/saved-history-active-rename.mjs:158-168`).

Completed/fresh DOM SHA256 was `e75178a8852d3f9b8c799a9a6dcba2957b09422100a94169e66c575b8e2af6e6`. Full typed-page/native equality executed, but there is no separately retained fresh-page hash. The fresh context made zero POSTs. Its native work and the final pre-Stop inspection matched completed state.

This proves a finite fresh-context history read with the original recorded path absent. It does not prove retired-allowlist behavior, a native/browser-process restart, destructive deletion, hostile same-user race protection or a general missing-workspace matrix.

## Traffic, privacy and cleanup

| Context | Total requests | GET / POST | Settings / catalog | Canonical session | Latest / SSE | Exact assets including document |
|---|---:|---|---|---:|---|---:|
| Original |19|16 / 3|1 / 3|1|1 / 1|9|
| Fresh |13|13 / 0|1 / 1|0|1 / 1|9|

The original POSTs were exactly Create, Task and Rename. Six independent helper reads comprised two catalogs and four Latest pages. They are not original browser response-body capture. All six traffic/response/console/page/privacy/asset fault counters were0. Existing inert-content, memory-only token and browser-storage boundary checks passed. No raw-history, backward-content or external request was admitted by the unchanged allowlist.

All three registered cleanup entries passed. The fixture reported normal Stop, clean acknowledgment, reap, exit0, empty native stderr and sandbox removal, with no SIGTERM/SIGKILL fallback. Input-end and drain are source-bound normal-path facts, not separately instrumented runtime flags: `web/test-support/fixture.mjs:722-745`; `src/providers/openai_codex/tests/replay/http_api_joined/browser.rs:1458-1494`.

The case, recorder and parent checked the new root's absence and known identity retirement. Ten sampled identities comprised three Node, six Chromium and one native identity; the separate recorder identity was also reported absent. Six Chromium identities are not six launches. No cleanup signals were sent. This is not complete descendant/all-host proof. No aggregate SQLite-handle count is available.

## Offline reuse and evidence limits

C57R2 revalidated, rather than reran, the C57R1 source-bound evidence:83 controls,476 serial affected controls,5530 default-scheduling Node tests, syntax/typecheck/eight-asset/static18/whitespace checks and88-in-33 unfiltered no-body collection. Gate HEADc0746920/index3f0b7824 are the offline cutoff; the later source checkpoint changed Git metadata, not the794 input file bytes/modes. Counts overlap.

Preserved qualifications:

- Original concurrent affected-subset failures remain unexplained. The serial pass does not explain or repair them.
- The initial R1 default-reporter red run lacked assertion diagnostics. Explicit TAP retained the valid71PASS/12expectedFAIL regression proof. Earlier unavailable diagnostics remain unavailable.
- Prior typecheck/assets stderr87/88 bytes and this runner's stderr344 bytes were discarded and remain undiagnosed. Native stderr is separately reported empty. Discarded-stream hashes are not retained-log evidence.
- R2's initial owned audit passed196/199 checks. Case-sensitive asset-summary matching and two Git-executable identity assumptions were corrected before runtime. The corrected before/pre/after audits each passed199/199. No product source, evidence or case was retried for those corrections.
- Runtime evidence consistency checks passed58/58. Parent independently bound22 new runtime files,794 unchanged runtime-source files,202 prior sealed records, the scalar result and known cleanup. New result documentation has its own later cutoff.

No original Latest/SSE body instrumentation, individual SSE-consumption proof, case latency/SLA, SQL trace, broad browser/native suite, macOS/hosted execution or final complete-master review is claimed. C15/active1/default-concurrency native SSE qualifications remain. Exact release-to-DOM stays **WAIVED_BY_OWNER, not measured**. Reader/SSE/no-store/access boundaries, pinned dependencies/browser, deadlines and ledger31/50 used19remaining remain unchanged. Retained failed-root families were entirely unaccessed.

## Evidence and parent completion records

- Original failure: (local record) and its immutable source/result/marker records.
- Offline verification/repair/reviews/checkpoint: (local record), `SCOPED_AUDIT.json`, `REVIEW_AUDIT.json`, `CHECKPOINT_RESULT.json`; repair report (local record).
- New runtime: (local record), `MANIFEST.json`, `RUNTIME_RESULT.json`, `EVIDENCE_CHECKS.json` and the manifest-addressed scalar `c57/RESULT.json`.
- Scalar case-result SHA256: `678624f8518b71842d0cb62f4db41f009ee3a75a7c271a1ea71424b7e950ece2`.
- Parent preservation/result binding: (local record), `AFTER_RUNTIME.json`, `IMPLEMENTATION_AUDIT.json`.
- Parent scoped review and Git completion receipts belong at (local record) and `CHECKPOINT_RESULT.json`. Their completed verdicts/cutoffs are separate from the runtime result; this document does not substitute for them.

The two previously missing browser observations now have this bounded result binding. The rest of G11-31's assertion inventory, whole-suite/platform/final-review closure and all40 PARTIAL/accepted=false dispositions remain separate. No next matrix increment, push or acceptance is started by this report.
