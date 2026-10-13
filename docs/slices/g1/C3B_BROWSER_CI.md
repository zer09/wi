# C3b23: Ubuntu browser CI source

Status: **scoped implementation and both source reviews complete**. Actual browser and hosted CI remain **NOT_RUN**. All40 matrix rows remain PARTIAL; accepted=false. Changes stay unstaged and uncommitted.

## Implemented change

`.github/workflows/ci.yml:24-43` appends one unconditional Ubuntu browser job. The previous673-byte workflow prefix stays byte-identical, including push/pull_request triggers, contents:read, Linux/macOS matrix and all six Cargo gates.

The job uses checkoutv4, stable Rust and setup-nodev4 with Node24.18.0. It prebuilds the locked library test executable at repository root. That prepares dependencies/artifacts before the existing browser helper's locked/offline fixture discovery at `web/test-support/fixture.mjs:16,26-57`.

Web commands run from `web`:
1. `npm ci`
2. `npx --no-install playwright install --with-deps chromium`
3. `npm run typecheck`
4. `npm run verify:assets`
5. `npm test`
6. `npm run test:e2e`

The root prebuild overrides the job's default web directory. Chromium comes from the installed Playwright1.58.2 package. Existing Node24, TypeScript5.9.3, npm lockfile and checked-in assets remain unchanged. Asset verification does not publish generated files.

No condition, filter, retry, failure masking, credential input, artifact upload, cache framework, Windows job or dependency was added. Existing workers1/retries0 and capture-off configuration stay unchanged. Deferred cases remain in the full suite; future CI can expose unresolved whole-task failures. This source change does not waive those cases or authorize hosted execution.

Workflow SHA256: `bbfd3a37fd262a8eb382c4eb396d42087ed3a564933480b7bccf16cf6c5506ac`. Appended553 bytes SHA256: `936e3d1a09204b43f44e39947219dc895d1c820db090b2366d64700236dd3898`.

## Local checks and evidence levels

| Check | Actual result and limit |
|---|---|
| Existing YAML parser plus finite workflow assertions |18 source assertions passed. Parser came from installed Playwright tooling; no dependency added. This is not actionlint or GitHub Actions execution. |
| Five in-memory sensitivity mutations |All rejected: missing Chromium installation, wrong web cwd, masked e2e failure, filtered e2e command and late prebuild. These are source-validation controls, not unique product tests. |
| Baseline negative check |Expected missing-job rejection recorded before editing. Not a failed product test or passed browser gate. |
| `cargo test --locked --offline --test platform_support -- --test-threads=1` |1 actual native test passed; no native Windows support restored. |
| `npm run test:e2e -- --list` in web |78 tests across23 files collected. Reload/active-conflict and fixed-head remain; retired read-reconnect is absent. No test body, beforeAll, Chromium, private native child or provider executed. |
| Diff/whitespace/ownership |One workflow file changed:20 added lines, zero removed. All755 nonassigned records and HEAD/index/cached284 remain unchanged. |
| Parent saved-evidence audit |131 manifest records,36 execution records and72 log bindings rehashed; source/platform/collection results bound. No product replay. |

Only the platform test executed. Full native, Node and Chromium suites were not rerun for this configuration-only increment. Existing earlier execution evidence remains earlier evidence. The six native CI gates were retained in source, not freshly executed on either hosted platform.

The implementation used the required six-value local environment prefix. It did not hardcode local absolute paths into the future GitHub workflow. No live credentials/private skills/auth commands/provider generations, dependency downloads, browser downloads, Git writes or hosted writes occurred.

## Independent reviews and preservation

Both fresh complete-current-increment reviewers COMPLETED/PASS with no findings and Fastlane OFF. Each inspected source and saved evidence using native reads/CodeGraph. Neither ran commands, tests, Git, browser/native/network operations, writes or another agent. These are scoped source reviews, not the three required final accumulated reviewers.

The parent independently matched755 nonassigned records and the original native workflow prefix. HEAD remains318b7f0da7d503e2e3a8cf33be84e78ebbe8affb; index SHA2562592c3d79271d456e1fa884b46d1ac45245f8c7152cbaf7415dc8da990250698; cached284. Historical reports, failures, archived prototype dispositions, hooks, guards and owner work remain preserved. Ledger31/50 used,19 remaining is unchanged.

Implementation reported no unexpected check failure or procedural deviation. A parent evidence auditor initially required optional signal/error fields on launcher records. The supplied records correctly had exit0 without those fields. The parent corrected only that metadata check and rehashed saved evidence without product replay. The initial diagnostic and correction remain in `AUDIT_CORRECTION.json`; no missing metadata was invented.

## Evidence paths and remaining scope

- Contract, baseline, byte copy and independent audits: (local record).
- Implementation report, parsed source, sensitivity controls, platform/collection logs and sealed manifest: (local record).
- Review record: (local record).
- Parent evidence audit: (local record).

The Ubuntu browser job is now implemented in source. G11-38 remains PARTIAL because complete browser/native acceptance, three final accumulated reviews and later exact-head hosted CI remain open. Broad raw-browser retirement, scripts/examples/measurements, documentation closure and C15/active1 owner deferrals remain unchanged. No push, CI dispatch, merge, release or deployment follows.
