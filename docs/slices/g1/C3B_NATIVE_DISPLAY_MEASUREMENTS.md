# C37-C42: finite native display measurements

Status: C39 and C41 implementation COMPLETED with both scoped reviews PASS. C40 is passing parent-owned execution only. C42 technical checks and both reviews PASS, but its role remains FAILED/policy_violation. All40 PARTIAL/accepted=false. No full G11-36/final-native/Chromium/hosted/final3/acceptance claim. Earlier C37/C38 records below remain historical.

## Staging and implemented changes

Owner authorized staging before implementor/remediation. The current checkpoint was staged once: HEAD318b7f0/branch docs/g1-browser-conversation-client unchanged,378 cached paths/zero unstaged-untracked. That became the comparison baseline, not a new commit. Historical284-path audits stay historical.

C37 changes no source. Parent captures the existing exact native scale test once with nocapture. Six finite synthetic fixtures compare100/10000 older blocks across newest-B activity2+60000bytes/activity2+6000000bytes/activity145+60000bytes. These are direct synthetic canonical/projector records, not10000 actual provider/tool/browser runs.

C38 changes only:
- `src/storage/conversation/reads/pages/tests/scale.rs:242-304`: Before/Within Instant timing immediately around successful scoped reads; actual bounded JSON encoded lengths; new fields appended to existing records.
- `web/test/presentation-evidence.test.mjs:1187-1188`: one extra final LF removed, no logic/content change.

Timing excludes encoding and subsequent assertions. All six fixtures, SQL/EXPLAIN/metrics/hooks/corruption controls/cleanup and retained Before regression remain. No thresholds/helper/feature/production/config/generated/workflow/dependency/auth/platform/reader change. C38 ended with both source changes unstaged against378; parent progress docs were separate. The owner then authorized staging that reviewed checkpoint:379 paths/zero unstaged-untracked/cached whitespace PASS before C39. C37/C38 failed cached checks remain historical. Current new native source edits are unstaged against379; no additional staging, commit or push occurred.

## Actual observations

C38 changed-scale execution emits the following. Activity and field_bytes describe B's existing fixture. Before reads its immediate predecessor. Collector association uses log order, not new stdout labels. These are14 observations inside1 test, not14 tests.

| older | B activity | B field_bytes | Latest encoded / us | Before encoded / us | Within encoded / us |
|---:|---:|---:|---:|---:|---:|
|100|2|60000|66846 / 76594|12030 / 30224|none|
|100|2|6000000|66844 / 71417|12030 / 25613|none|
|100|145|60000|524288 / 1362917|12030 / 37230|524288 / 1315181|
|10000|2|60000|66869 / 74021|12051 / 19747|none|
|10000|2|6000000|66867 / 69110|12051 / 31578|none|
|10000|145|60000|524286 / 1215141|12051 / 35633|524287 / 1339139|

Latest candidate/decoded/descriptor/chunk work matches paired100/10000 fixtures:2/2/6/9 for activity2;65/17/36/69 for activity145. Content-byte work matches54472/56072/462952 by case, validation_bytes676, not zero. Exact encoded differences23/23/2bytes include sequence/cursor decimal widths. Before has2descriptors/2chunks/8800 content bytes, encoded width differs21bytes. Within has65candidates/17decoded/462952 content bytes, encoded differs1byte. No warm raw-prefix or universal work/time guarantee is inferred from bounded validation metadata or this finite sample.

Prior C37 unchanged-source native test passed once over166865981983ns whole Cargo/setup/fixtures/read/cleanup interval. Linux kernel RUSAGE_CHILDREN reported largest child RSS112076KiB. This is not summed concurrent-tree, per-operation, browser or server RSS. C38 adds no RSS measurement; its whole scale interval211612704627ns includes33.52s compile. Values are separate samples, not a combined peak/statistical latency/SLA/constantRSS/fastest claim.

## Actual gates and reviews

C38 passes fmt/locked-offline all-target check/warning-denied Clippy/all-target build/doc0; changed exact scale1+retained exact Before1+platform1; Node syntax/unfiltered3116pass0fail0skip/typecheck/nonmutating8 emitted7 served assets; working and combined HEAD whitespace checks. Exact selectors filter925 other library tests; they are scoped measurements/regressions, not a complete native functional suite. Native all-target functional execution is NOT_RUN for C38 and remains a final-gate obligation. Existing C35 full1193/11 ignores is prior execution, not relabelled as this source revision's result.

The historical C38 cached whitespace check was FAIL exit2, exactly `web/test/presentation-evidence.test.mjs:1188: new blank line at EOF.` That unchanged378-path checkpoint contained the old second LF. C38's corrected working HEAD diff passed. Later owner-authorized staging created379 and actual C39-C42 cached checks passed. Those later checks do not change the historical failure.

Both fresh scoped review-a/review-b use native reads/CodeGraph only, zero commands/tests/Git/browser/network/hash recomputation/file writes/nested agents/Fastlane OFF. They verify timing/payload placement, all retained assertions and EOF-only fix. Parent binds16 gate records/32 logs/current two-path diff/731 nonassigned source records without product reexecution. Source/index state HEAD/branch378 retained,2 unstaged/0untracked; document phase excludes4 additional progress files, so727 nonassigned records remain. This is not final3 complete-diff review.

## Preserved failures and limits

C37 initial uv preflight FAILED_RUNNER/ValueError because uv changed PATH. Parent diagnostic/source ordering establish no Cargo/native log/child launch existed; the old conservative UNKNOWN record remains. R1 uses uv's selected /usr/bin/python3 with an exact inner6-value env, separate paths, same test. No bare Python/new dependency/relaxed environment/product retry. Optional /usr/bin/time absence and uv --no-sync/no-project warning remain observations.

First C37 collector failed on newly staged EOF whitespace. The file had been untracked during prior diff checks, so they did not inspect its EOF. The collector records that failed obligation, not an ignored/filtered test. One subsequent parent collector command omitted /usr/local/bin and /usr/sbin in PATH; preflight rejected before data/Git/output/product work. Strict C37 all-authored-prefix compliance is false; native launch/runner/test had exact6. The later compliant collection is not a historical cure. Parent also used one large direct external evidence listing instead of preferred Context Mode; no product/source action followed it.

C38 initial absent external directory, incorrect docs/PLATFORMS.md and docs/slices/v1-b lookups/long listing remain disclosed failures/limits. No C38 product gate failed/retried or prefix deviation occurred; zero Python/ctx_execute_file/nested agents/Git writes. Historical failed roles/reports/C15/active-conflict deferrals remain unchanged.

Evidence: (local record) and `r1/{native-scale.json,native-scale.child-launch.json,native-scale.launch.json}`; (local record) with original files/exact command/launch/identity/log records; (local record).

## C39: public Entry and Content reads

`src/storage/conversation/reads/tests/content.rs` adds actual public-read timers, encoded EntryPage lengths, fragment ranges and per-read differences of existing store hooks. All original assertions/fixtures/roundtrip/privacy/reconstruction/cleanup and other two tests remain. No production change. One complete content module execution passed3 tests/923 filtered; two fixtures each reconstruct192000 bytes through1Entry+11Content reads. Every read uses1 transaction/1352validation bytes/no projection pages or commits.

| C39 fixture | Read microseconds | Encoded bytes/page | Descriptors/chunks total | Content/validation bytes total |
|---|---:|---:|---:|---:|
|Human|86369..138128|52572..65876|48/94|710144/16224|
|Assistant|70295..112804|22831..33621|36/58|372296/16224|

Timing includes public scheduling/locks/connection validation/retirement and existing ID/cursor parsing, not encoding/reconstruction or SQL-only time. Content counts include repeated anchor reads. The24 individual intervals are independently checked for scalar-aligned contiguous descending coverage. They are not24 tests. Native fmt/check/Clippy/build/doc0/platform1/three whitespace checks andboth fresh read-only scoped reviews pass. Parent rehashes214 artifacts/50terminal records/100logs and733 nonassigned files without execution. Initial external literal-checker255 and native-read/retrieval errors remain; only the external checker changed, no source/product retry. Evidence: (local record) with `REPORT.md`, `per-page.jsonl`, `per-fixture.json`, `evidence-manifest.json`, reviews and parent audit. C39 source is later supplemented by C42; these are C39 execution values, not reattributed current samples.

## C40: existing warm changed-entity reads

Parent executes the unchanged exact native scale test once:1passed/925filtered/four fixtures. No source/config/generated change. Existing indexed-plan/corruption/read-only/caught-up/cleanup controls pass. Direct SQLite timings exclude setup/encoding/assertions, not public HTTP/SSE/browser latency.

| Old intents | Recent output bytes | Encoded bytes | Read microseconds | Content bytes |
|---:|---:|---:|---:|---:|
|100|60000|68076|80372|54494|
|100|6000000|68074|77830|56094|
|10000|60000|68086|75128|54494|
|10000|6000000|68084|72043|56094|

All four have1block/2entry candidates/8decoded/10descriptors/11chunks/676validation bytes. Paired100/10000 work matches and encoded width differs10bytes. Four caught-up batches have zero candidate/descriptor/chunk/content work; their timings are NOT_MEASURED. Sparse canonical/projector fixtures are not10000 real tool effects. Source734/index379/inherited C39 diff preserved. Evidence: (local record). No new memory/restart/native-whole-suite/CI claim.

## C41: genuine cold migration, warm reopen and disk boundaries

`src/storage/b2_tests/migration/activation.rs` adds47 lines to the existing two-version test. Original109 lines/cold timer+record/fixtures/canonical bytes/digest/provenance/settings/backfill256/tool output/gauge/cleanup/other helpers and tests remain. Cold1 includes1->2->3; cold2 includes2->3.

| Old schema | Cold microseconds | Warm microseconds | Database bytes before / after cold / after warm |
|---:|---:|---:|---:|
|1|1846325|92154;66677|413696 / 716800 / 716800|
|2|802486|99446;82695|417792 / 483328 / 483328|

Cold samples have2projection pages/max256, heads280/285. Warm samples have0projection delta/0explicit read snapshots/1318validation bytes/0recording commits/1other commit. That other commit finishes existing interruption reconciliation's BEGIN IMMEDIATE transaction even without unfinished work. These are not commit-free opens. Original canonical/projection equality checks pass. Database logical length increases303104/65536 bytes after cold, zero after warm. WAL/SHM/journal are absent at all24 named boundaries, not present zero-byte files. Those lengths cannot bound in-flight disk or allocated filesystem blocks.

Changed exact migration1 and retained exact failure1/eight stage fixtures each ran once/925filtered, native fmt after correction/check/Clippy/build/doc0/platform1/three whitespace pass. Both fresh scoped reviews PASS. Parent rehashes99 closed logs/12084501 bytes,15gate/26Git records and733 nonassigned/prior C39 diff. Initial bootstrap/discovery/identity/fmt/summary errors remain. Migration source copy was captured AFTER execution, not a pre-run binding; only helper println formatting followed, test body identical, later compile/regression final-source passed. Parent's initial audit confused physical index and stage-listing hashes; corrected external auditor binds each like quantity without product replay. Evidence (local record): `REPORT.md`, `measurements.json`, `final-log-manifest.json`, originals, reviews/audit/initial failure.

## C42: public append/projection and in-flight files

`src/storage/conversation/reads/tests/content.rs:78-116` adds37 lines around its existing assistant delta. One successful192000-byte synthetic append takes217555us, with1recording commit/0other commits/0projection backfill/1352validation bytes/0read snapshots or conversation-read counters. This includes envelope construction/admission/validation/canonical append/projection/commit/retirement, not SQL-only/provider generation. One post-timer SELECT observes2entries/2fields/25chunks/192006field bytes including the6-byte anchor. Those are stored totals, not rows written.

C42's materially changed complete content module3once retains24 exact intervals. Human reads93301..145234us/52572..65876encoded bytes; assistant78357..118472us/22831..33621bytes. Every read retains1transaction/1352validation/no projection or commits. C39's original source controls are unchanged.

`src/storage/conversation/reads/tests/atomicity.rs:24-87` adds24 lines around the original commit/rollback DisplayApplied pause. Exact atomicity1once keeps independent H2/accepted visibility during uncommitted write, then H3/running/receipt on commit or storage.io/H2/accepted/no receipt on rollback. No new pause or ordinary latency claim for a paused write. Both variants emit12 file samples: database139264bytes at all3phases; WAL/SHM absent before/after, but present at the uncommitted pause with0/32768bytes; journal absent. These24 observations include actual in-flight files, not a true peak or zero transient growth proof. NotFound differs explicitly from present zero length; other I/O failures fail. Unwind/quarantine source remains unchanged.

Native fmt/check/Clippy/build/doc0/platform1/three corrected whitespace checks pass, with PRE-EXECUTION source bindings and no post-format source changes. Selectors report923/925 filtered, no new test definitions. Both fresh scoped reviews COMPLETED/PASS/no findings. Parent rehashes12564 manifest files/12gates/12pre-run bindings/24gate logs/732 nonassigned with prior C41 source/index379 unchanged. Three source paths remain unstaged, zero untracked before progress edits.

The implementation role remains FAILED/policy_violation. Three initial whitespace launchers omitted /usr/bin from PATH. Recorder preflight rejected before Git/product/source snapshot; corrected exact6 launches passed. Rejected launcher PIDs were not captured; their output is a disclosed Context Mode transcription, not recorder child logs. Initial directory/status routing limits also remain. Strict all-authored-prefix compliance is false. Reviews/passes do not cure or promote the failed role. No technical repair or passing-proof replay was needed. Evidence (local record): `HANDOFF.md`, `GATES.json`, `APPEND.json`, `READS.json`, `DISK.json`, `SOURCE_PRESERVATION.json`, `FILE_MANIFEST.json`, pre-run copies, failures, reviews and parent audit.

### C42 PATH repair

The owner requested a C42-only repair after noticing repeated delegate policy violations. The three failed launch commands omitted `/usr/bin`; the recorder correctly rejected them. The original prompt required repeated copies of a long PATH, which made those commands prone to transcription errors.

(local record) now loads the six approved values from `EXPECTED_ENV.json` once. It builds all three child commands from that JSON instead of separately typed PATH strings. The actual child-environment probe and working/cached/HEAD whitespace checks passed. All734 repository records/index379 and original C42 evidence stayed unchanged during verification. No product tests ran.

`RESULT.json` records PATH_REPAIR_VERIFIED. `INSTRUCTIONS.md` provides the C42-only prompt addendum. The original role remains FAILED/policy_violation; the repair does not erase its history or change global rules. The two progress records describe this repair separately. No staging/commit/push/acceptance occurred.

No new memory sampling occurred in C39-C42. Prior C37 kernel largest-child RSS remains separately qualified. No SLA/constantRSS/fastest/session-size-independence/true-peak claim follows from any finite sample. Full native functional execution for these new source revisions, expanded live/saved parity and P/J restart, actual Chromium, exact-head hosted CI, qualified browser/server memory, final3 complete-diff reviewers and owner acceptance remain open. Reader unchanged/no default browser stress/live/auth/private credentials. Ledger31used19remaining retained; no merge/release/commit/push/hosted action.
