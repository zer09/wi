# G1.1 merge review and focused completion assignment

Reviewed October 23, 2026. Contract: **g1.1**, unchanged.

**Decision: do not squash-merge yet.** One concrete joined-acceptance gap remains. No new production malfunction was established by this review. Finish the existing acceptance work; do not start another architecture or feature milestone.

- Accepted master: `76bb32fd04fd4737c0efcceaabc7d10387453147`.
- Reviewed PR #10 head: `d757646abfba6dfa17725c812594c33b6c216355`.
- Current fixed-browser source: `1b8b50c7abd8ebdac95d8964a4788bf257ce3547`.
- Branch: `docs/g1-browser-conversation-client`.
- Owner's request: review first; if acceptance fails, publish instructions for a fresh local implementor. This document is that conditional, documentation-only handoff. It does not authorize merging or deleting the evidence.

When supplied by the owner, this assignment supersedes old increment-specific instructions that indefinitely retain all 40 rows as PARTIAL or prohibit the next closure test. Historical failures, consumed test bundles and their original observations remain historical. Current tests need fresh ordinary fixture ownership, not reuse of consumed artifacts.

## 1. What the review checked

The review inspected the complete changed-path inventory, requirement/evidence indexes, representative production and test paths, the named C15/active1 investigations, current browser pin, and hosted workflow metadata/jobs. Substantive source inspection covered schema validation/migration and projection updates; ordered page/change reads; browser range merging, loading, viewport and command handling; admission/identifier changes; and the actual skill-fidelity test chronology. It was risk-based, not a claim that every changed line or every historical private log was independently read.

Both workflows on **d757646**, attempt 1, succeeded:

- [Push 39769763470](https://github.com/zer09/wi/actions/runs/39769763470).
- [PR 39769768744](https://github.com/zer09/wi/actions/runs/39769768744).

Both contain Ubuntu and macOS jobs with all six Cargo steps, plus the Ubuntu browser job with npm-ci, browser provisioning, typecheck, assets, units, preparation and guarded suite launch. These close the formerly missing hosted/install observations for that head. Hosted success is not an independently observed hosted case count or universal cleanup certification.

The local 1,252 native passes, 12 ignored helpers, 9,899 Node passes, 89 browser cases and example executions remain attributed to their recorded local revisions and environments. No local Cargo, Node or browser suite was rerun by this review. The comparison from 1b8b50c to d757646 changes documentation and a crate comment, not executable product/test behavior.

C80 records three independent complete-inventory/risk-based reviews. Its historical source ID is `1b201631d3a0fbb58925290bedf87764144c602c`; the report maps its published equivalent to `7365b1497fba35763a17a27036d524240a198fc4`. Do not use a missing pre-rewrite SHA as proof that the review never occurred. Equally, do not call those old reviews fresh reviews of later browser tooling. Inspect the later delta and its recorded reviews explicitly.

## 2. Finding G1-MR-01: G11-34 joined source-change sequence is missing

**Classification: merge-blocking acceptance-evidence gap, not a reproduced production defect.**

[MATRIX.md](MATRIX.md), G11-34, requires J-level proof of a real main-SKILL result, a source change/deletion **before the next task**, and valid stored-history use. J means browser -> actual HTTP -> RunHost/B2 -> real SQLite -> OpenAI loopback -> actual tools -> display/DOM.

The cited browser case is:

- `web/e2e/skill-source-fidelity.spec.mjs`, `saved main SKILL remains exact after owned source change and deletion without new work`.
- At the reviewed head its two-task loop completes before `stage='change-source'`; deletion occurs later in a read-only observer loop.
- [C3B_SKILL_SOURCE_FIDELITY.md](C3B_SKILL_SOURCE_FIDELITY.md) explicitly states A completes at H118, B at H235, then the source changes. Its final scope paragraph assigns source-change-before-next-task to the separate native C48 tests.
- [assertion-index-g1.1.json](assertion-index-g1.1.json) and the C77 report preserve this distinction. Native N51-N53 do not become browser J merely because B15 separately passes.

The existing tests are valuable and must remain: they prove saved display does not reread a changed/deleted source, and the native tests prove replay fidelity below the browser. They do not execute the exact joined sequence required by G11-34. No other submitted binding identified that missing sequence in this review.

### Required minimal addition

Add or extend **one representative WebSocket browser scenario**, using existing fixtures and real production paths:

1. Browser submits task A. The real S2 loader reads a synthetic owned SKILL.md whose body has an unmistakable ORIGINAL marker. A completes and its actual tool result is committed.
2. Before any submission of B, change that file's body while preserving valid metadata, or delete it. Record and assert this ordering using fixture state, not a sleep. The original immutable event/result remains unchanged.
3. The browser explicitly submits B in the same session. B may use ordinary configured tools or finish without another tool; it must not need to reload the removed skill to recover the old instructions.
4. Capture the actual loopback request for B. Assert the historical correlated tool result contains the exact ORIGINAL bytes, not replacement bytes, an omitted result, or a fabricated/manual replay. Distinguish old history from any legitimate current preparation.
5. Verify B's actual receipt, run, provider request and completion, plus saved A/visible B identities, ordering, content and no duplicate answer. Reads/rebase must cause no extra provider request or tool execution.
6. Assert the real load count: historical replay does not execute A's loader again. Preserve strict normal teardown and synthetic-root ownership.

Reuse the existing producer, fixture-control and safe assertion infrastructure. No new public endpoint, generic fault framework, browser monkeypatch, or permission-token system is needed. One representative mutation scenario supplies the missing J edge; retain existing native change/deletion and transport permutations instead of multiplying them into new browser variants. Do not introduce a production fix unless this test exposes an actual failing invariant.

If an already executed matching J case is found, show its exact source sequence, actual command/result and input binding instead of duplicating it. A new name or a matrix link alone is not proof.

## 3. C15 and active1 current dispositions

### C15: close the current browser-compatibility blocker

The active pin in `web/test-support/browser-pin.mjs` is Chrome for Testing headless shell **157.0.8103.6**, separately from Playwright **1.58.2**. It pins source `41520584daa68d0040db7746ae562a0ff82187f6` and loader blob `40bc0f095e25466f0309cdc2513217a77d38270e`.

The reviewed [Chromium loader source](https://github.com/chromium/chromium/blob/41520584daa68d0040db7746ae562a0ff82187f6/third_party/blink/renderer/platform/loader/fetch/response_body_loader.cc#L225-L240) calls `HandleResult(result)` before notifying the client, matching the reported completion/cancellation fix. C93 records eight-arm qualification and a complete local 89-case pass on the fixed browser. Current-head hosted browser jobs also pass.

Disposition for final current status: **CLOSED_CURRENT_BROWSER_COMPATIBILITY**. Preserve old failed samples and their individual attribution limits. Do not claim every old Wi failure was conclusively caused by Chromium, upgrade Playwright unnecessarily, or change the application JSON reader/no-store/SSE policy.

### active1: close the current acceptance-control blocker, retain unknown historical cause

[C3B_INPUT_REJECTIONS.md](C3B_INPUT_REJECTIONS.md) identifies the old failure at Create-201 body acquisition, before the first task and before the second task's active-run conflict. The follow-up added diagnostics and observed a passing case; it was not an active-run production repair. The retained active-conflict test subsequently passes in full-suite evidence, including the fixed-browser execution.

Disposition for final current status: **CLOSED_CURRENT_REGRESSION; HISTORICAL_CAUSE_UNDETERMINED**. Do not falsely identify the diagnostic patch as a product fix, conflate this with C57's separate Rename fixture repair, or require reconstruction of a lost historical exception before acceptance can finish.

The final normal regression gate must still include reload and active-conflict cases without filters. No extra repeated browser sampling campaign is required just to close these labels.

## 4. Finish the 40 existing rows, not 40 new implementations

Produce one concise current assertion assessment in the existing human/machine report. Use [MATRIX.md](MATRIX.md), [assertion-index-g1.1.json](assertion-index-g1.1.json), the C78/C79/C80 records and current hosted evidence. Check each row's subassertions and required evidence level. Record named tests, observed commands/revisions, and whether a conclusion is direct execution, qualified unchanged-source reuse, source inspection or an owner waiver.

| Rows | Closure work |
|---|---|
| 00-21 | Reconcile existing storage/projection/migration/HTTP/access proofs. No new missing feature is asserted here. Verify every required subcase before marking PASS. |
| 22-26, 29-33, 35 | Reconcile existing viewport, range, framing, parity, joined transport, lifecycle and process proofs at their actual levels. Do not promote synthetic browser DTO tests to J. |
| 27-28 | Apply the C15/active1 dispositions above and retain ordinary regression coverage. |
| 34 | Close G1-MR-01 with the joined before-B mutation proof. Other existing fidelity/identity results remain useful. |
| 36 | Retain finite measurements and the existing **WAIVED_BY_OWNER** exact release-to-DOM requirement. Do not invent an exact metric or demand another clock/telemetry project. |
| 37-38 | Bind current local/hosted gates and final review coverage. npm-ci and retained-platform CI at d757646 are no longer missing. Check changed runtime inputs, not only compiled-source hashes. |
| 39 | Publish current row outcomes and acceptance separately from owner merge approval. Replace stale current-status claims; retain dated failures and original reports. |

A row with adequate observed evidence can be PASS even though another row is still open. Do not perpetuate all40PARTIAL solely because merge authorization has not been given. Conversely, do not batch-promote rows from total test counts. Name any newly located real gap exactly; do not silently weaken its assertion or start unrelated work.

## 5. Permitted work and verification

Permitted: the focused test/fixture changes above; directly necessary small regressions; current acceptance mappings; a short current AGENTS/PR status pointer; final review and verification. Existing commands and isolation are described in [web/BROWSER_TESTING.md](../../../web/BROWSER_TESTING.md). Use a fresh preparation with the pinned browser and current guarded launcher. Do not reuse consumed bundles, replay old proof artifacts, use hidden filters, or broaden the test framework.

Run the affected focused tests first. Then execute the applicable existing native/browser regression gates on the completed diff. Preserve actual failures and diagnose before rerunning. Existing unchanged example/CLI evidence can be reused only with explicit source/runtime-input bindings; rerun unbound affected gates. No new benchmark, exact timing target, test-count target, physical power-loss certification or historical-root investigation is required.

Reconcile the C80 full-diff reviews with all later changes. The final required three independent reviews must cover the complete change inventory, the new joined proof and current assertion closure, using risk-based source inspection and explicitly attributed prior evidence. They need not each replay every test or every failed historical increment. One final review round, not three reviewers after each small edit. Report unavailable independent review rather than inventing it.

Retain current Linux/macOS native gates and Ubuntu browser job. After an owner-authorized push, inspect both workflows at the exact new head, including skips/attempts. The d757646 green runs do not certify a future changed head.

Production code is unchanged by this review. A production change during completion requires a reproduced violation and the smallest repair under g1.1. No database/API/auth redesign, dependency upgrade, new provider/tool, quota, timeout policy, automatic resume/retry, or resurrection of the raw browser reducer/Window B experiment.

Synthetic roots, credentials, skills and loopbacks only. No real credentials/private skills, login/refresh, or live provider generations. Ledger stays31/50used19remaining. Local implementation remains uncommitted until separate owner authorization. Do not merge, release or deploy.

## 6. Documentation cleanup and squash merge

Defer broad deletion until acceptance is complete. The owner's cleanup goal is valid: the normal documentation should explain the code and how to run/test it, not require reading dozens of increment diaries.

After closure, retain a compact product/developer set: quickstart/configuration, architecture/ownership, HTTP/display protocol, storage/migration, authentication/platform limits, and testing instructions. Consolidate overlapping current pages. Keep one concise acceptance/release note linking preserved evidence outside the normal reading path. Audit scripts/tests that depend on documentation paths before moving/removing them.

Do not remove the only evidence for an open finding or use cleanup to hide a failure. If process documents leave the branch before a squash, preserve a durable archive of the pre-cleanup evidence first; a branch-only history reference must not be assumed permanent. Then verify links, asset/source checks and required gates on the final proposed squash tree. The squash commit's tree must match the reviewed final PR tree.

**Squash merge is suitable after closure, but is not performed or authorized by this document.** No next feature matrix is required to finish G1.1.

## 7. Fresh-agent entry

Read this file first, then the current g1.1 contract/matrix and linked evidence. Verify actual HEAD/worktree and preserve owner changes. Close G1-MR-01 without redesigning G1.1, record the bounded C15/active1 current closures, and finish the existing 40-row assessment. Reuse valid evidence, preserve historical failures, run the required gates, and obtain the final independent review coverage. Do not copy old all-PARTIAL labels as a stopping rule. Report only remaining concrete blockers. Leave changes uncommitted; do not merge or perform the broad documentation cleanup yet.
