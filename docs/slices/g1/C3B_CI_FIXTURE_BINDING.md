# C3b25: CI24-01 fixture publication correction

Status: **COMPLETED and scoped-reviewed**. All40 rows remain PARTIAL; accepted=false. Hosted CI and Chromium remain NOT_RUN for this configuration correction. Changes stay unstaged and uncommitted.

`.github/workflows/ci.yml:43-45` adds exactly three lines before unchanged unfiltered e2e. From the existing web directory, Node24 calls existing validated discoverFixture and appends one WI_C3A_FIXTURE assignment to GITHUB_ENV. Subsequent steps receive the executable. Discovery retains locked/offline Cargo JSON, exact root src/lib.rs/Cargo.toml, successful unique library-test artifact and regular-file checks. No filename/local path/glob/fallback/dependency is hardcoded.

The original673-byte native prefix and every previous native/browser step, trigger, permission and pin remain unchanged. No condition, filter, retry, failure masking, upload, credential input or Windows support is added. Workflow SHA256: `234a40162cc98483364e41a809a46bfc717f36c51ac774f23aadb0dd5f4d1f4f`.

## Observed verification

- Actual YAML/exact insertion/order/native preservation checks pass. Nine in-memory mutations reject. These are source controls, not unique product tests or actionlint/hosted execution.
- The actual extracted workflow command ran locally from web with NO incoming WI_C3A_FIXTURE and a new synthetic GITHUB_ENV. Real locked/offline discovery wrote exactly one validated executable line.
- A simulated subsequent child received that line and verified the current source/manifest/artifact hashes. It did not start the private fixture or browser.
- Existing fixture protocol12/12 and native platform_support1/1 pass. Both whitespace checks pass.
- Parent preservation audit matches758 nonassigned records, unchanged HEAD/index/cached284 and the full native prefix. Parent separately rehashes33 manifest records plus the current workflow/artifact/publication observations without product replay.
- Both fresh read-only reviews COMPLETED/PASS with no findings and Fastlane OFF. Neither executed commands/tests/browser/native/network/Git or changed files. These are scoped reviews, not the final three accumulated reviewers.

CI24-01 is corrected and locally verified in source/publication behavior. Complete hosted execution remains open. Prior parent retained52 PASS and fixed-head J PASS remain prior actual evidence; neither was repeated for this correction.

The pre-fix missing-binding rejection remains saved. The first external source-validator attempt failed because its wrong-cwd mutation reached a different assertion first. Only helper check order changed; both checks remain. Original source/lookup failures, C3b24 failed52/FAILED role and52 uncertified startup roots remain untouched and disclosed. No historical failure/cleanup or whole row is promoted.

All authored commands preserve the six exact local environment values. No production/reader/fixture/test/package/generated asset/real credential/private skill/auth/live/provider/Git/hosted change occurred. Ledger31/50/19 remains unchanged.

Evidence: (local record) and (local record). REPORT.md records exact commands; MANIFEST.json/SEAL.json bind the finite controls, actual publication, handoff, protocol/platform and original failures. Parent EVIDENCE_AUDIT.json and REVIEWS.md record independent checks.

Broad raw-source/helper retirement, real backscroll/restart/expanded parity/measurements, final native/browser gates, C15/active1 owner deferrals, final documentation/three complete-diff reviews and later authorized exact-head CI remain open. No Git or hosted authority follows.
