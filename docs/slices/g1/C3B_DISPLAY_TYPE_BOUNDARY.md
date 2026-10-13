# C3b27: active display type boundary

Status: **COMPLETED and scoped-reviewed**. All40 rows remain PARTIAL; accepted=false. Changes stay unstaged and uncommitted. This prepares dependency-aware G11-32 retirement, not whole-row acceptance.

`web/src/display-client.ts:21-36` now owns the exact original ClientError, CapturedCommand and ClientDependencies declarations. `web/src/display-view.ts:2` imports ClientError with existing display-client types. `web/src/client.ts:17-18` preserves legacy type imports/exports as aliases of the same declarations. Only unused command DTO type imports were removed from the legacy file.

Names, readonly members, literal branches, DTO references, optional dependencies and legacy exported availability are unchanged. SnapshotValue, PendingCommand, MutationOutcome and CommandReply remain legacy-only. No raw reducer/receipt-range logic moved into active code. No new runtime/shared module or dependency exists.

The active app's seven-file static/type compiler graph now contains api/app/display-api/display-client/display-store/display-view/sse, with no client/state/view dependency. Actual TypeScript5.9.3 compilation of original and current sources emitted all ten assets in memory. Every byte matches the baseline and current dist. Runtime functions/imports, generated files, behavior and server assets remain unchanged.

## Executed checks and review

- `web/test/display-type-boundary.test.mjs:1-136` supplies3 positive source/compiler proofs and16 in-memory actual-path sensitivity negatives. It verifies the active graph, identical legacy alias symbols and exact type shapes. All19 pass; no external evidence or real synthetic repository file is needed.
- Retained active/legacy focused954 and full unfiltered Node3269 pass with zero failures/skips. Counts overlap.
- Typecheck, ten-asset nonmutating verification, syntax and whitespace pass.
- Unfiltered pinned Playwright collects78 tests/23files, including fixed-head and both deferred cases. Collection is not browser execution.
- Both fresh read-only reviews COMPLETED/PASS/no findings/Fastlane OFF. Neither executed commands/tests/Git/browser/native/network, recomputed hashes or changed files.
- Parent rehashes88 manifest records and current asset/type/source bindings without product replay. Preservation audit matches759 nonassigned records, three before copies, generated files and unchanged HEAD/index/cached284/all40 PARTIAL/accepted=false/ledger31/19.

Initial native-read ENOENT remains recorded. The first external summary launcher failed with EEXIST after its child produced the summary. Only the external summary filename/record label changed; corrected final evidence passed without rerunning product/collection/preservation gates. Both attempts remain saved. A parent optional SEAL lookup also returned ENOENT; the available88-record MANIFEST is the required evidence, not a missing seal.

All authored commands preserve the six exact local environment values. No browser/native/provider/live/hosted execution, C15 sampling, earlier J/display52 replay, credential/auth/private capture, Git write, reader/retry/timeout/platform change occurred. Historical failures and uncertified startup roots remain unchanged.

Evidence: (local record), source-emission-proof.json, evidence-summary-r1.json, initial failure records and MANIFEST.json; parent BEFORE/AFTER audits, source-before copies, EVIDENCE_AUDIT.json and REVIEWS.md. Broader raw modules/helpers remain present pending explicit disposition/removal. Backscroll/restart/expanded parity/measurements, owner deferrals/native risk, final native/browser gates/three complete-diff reviews and authorized exact-head CI remain open.
