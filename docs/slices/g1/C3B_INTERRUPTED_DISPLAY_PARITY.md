# C50 same-H interrupted-task browser parity

## Result and scope

**COMPLETED_SCOPED_REVIEWED**, review-a and review-b PASS with no findings. One new Chromium case passed in **15.9 seconds**. All40 G11 rows remain PARTIAL; accepted=false. This is not final G1.1 acceptance, a full-suite result, hosted CI or Git authorization.

C50 creates only three test files. It reuses the C46/C47 restart child and rich-display helpers. No Rust, production API/storage, application reader, dependency, workflow, generated asset or earlier passing browser case changed. C49 and the original C47 case were not replayed.

| New source | Lines | SHA256 |
|---|---:|---|
| `web/e2e/interrupted-display-parity.spec.mjs` |1-171|`2acd3bda7bf0a6f6f3e94912c7cf4345573d33d241c25a76be381ec0b1617499`|
| `web/test-support/interrupted-display-parity.mjs` |1-182|`0b965e55318592b7fbc7766eccbd793604466ecfe58b257d4b4a29a7e697e2f7`|
| `web/test/interrupted-display-parity.test.mjs` |1-208|`0cdba7405c88617aea0414df4092e97e97b8c3834272c41cc4eac1100263f2bf`|

Parent contract: (local record). Implementation report and final manifest: (local record) and `FINAL_MANIFEST.json`.

## Genuine browser and process proof

The actual case at `web/e2e/interrupted-display-parity.spec.mjs:74-153` proves:

1. Chromium A creates a session and submits one presentation Task. Actual receipt2..3 and rich committed partial H23 match independently constrained human/reasoning/refusal/text/function fields and the live DOM.
2. A closes without Cancel. Native work and the exact public H23 snapshot remain unchanged. The identity-bound producer receives expected SIGKILL and is reaped.
3. A distinct native observer starts against the same synthetic root. Read-only Select and zero-work sampling precede any helper HTTP session open.
4. Independently fresh B starts with empty memory and explicitly Connects. B's original authenticated Latest renders interrupted/no-final-result status before independent helper reads. The original Request/Response identity precedes matching after-H24 SSE.
5. B stays connected while independently fresh C Connects. C independently establishes the same original Latest/SSE handshake. Both DTO snapshots and both real DOMs match exactly at committed H24.
6. Exact equality retains session/run/entry/field identity, human anchor, chronology/grouping, UTF8 text, metadata, content epochs, generations, ranges, provisional/recorded state, interruption and result absence. Only the specified interruption metadata changes from H23. DOM normalization removes disclosure-open state, not content or status.
7. Both observers remain streaming for final parity. Public H24 stays exact through read-only observations and browser closure. Observer Stop drains the host, closes native storage readers and exits normally. One read-only manifest query checks H24 after Stop and closes its handle before root removal.

The recovery-order guard protects the actual helper path at `web/test-support/interrupted-display-parity.mjs:121-145`. Strict work/request/head/cleanup assertions are at lines146-181. Controls at `web/test/interrupted-display-parity.test.mjs:30-208` call the actual helpers and collectors. They reject wrong H/status/result, changed/missing/reordered content or identity, early helper recovery, observer mutations, nonzero work and incomplete/fallback cleanup. Source controls bind the executed case and callback registrations.

### Exact observed facts

| Fact | Result |
|---|---|
| Browser POSTs A/B/C |2/0/0; one Create and one Task only|
| Original Latest/SSE per context |1/1 each|
| Served assets per context |9 each, byte/header checks|
| Interrupted display |2 entries/12 fields, H24, no final result|
| B/C DOM digest |Both `9c422c6f798a103aca14e1848f8935fa8ea13af37f4ae58394ff6f6650c8b6df`|
| B/C independently obtained DTO digest |Both `ecaf7272bdcdc04b0c6e9518d178da417c18318fa699cfd40014ebdb19c4f93f`|
| Collector faults |All seven counters0|
| Observer work |Six Sample replies plus stopped; all ten numeric counters0/fresh_emptyfalse|
| Shutdown |Producer expected SIGKILL/reap; observer acknowledged Stop/drained/exit0/signalnull/stderr0; all contexts/handles closed; same-start PIDs and owned root absent; no fallback|

Independent helper traffic is separate from browser requests: producer6GET/1read-only reconciliationPOST; observer10GET/2read-only reconciliationPOST. Observer reconciliation follows B's original recovery. Each receipt read is followed by exact stable H24 validation, with zero native work.

Actual Chromium proves UI submission, fresh Connects, DOM, original request/response/stream identity, inert/privacy/access/assets and zero observer POSTs. Independent Node HTTP proves typed DTO/addressed-entry/receipt/run facts. It does **not** capture original browser Latest bytes or prove application Fetch-body consumption. The post-Stop SQLite query proves only the manifest head, not a new immutable-prefix or interruption-once audit. [C46](C3B_NATIVE_PROCESS_RESTART.md) remains that separate P/H/S oracle. No tool executes in this deliberately interrupted Task.

## Checks and execution binding

Approved cwd `~/projects/wi`; absolute Node24 `~/.nvm/versions/node/v24.18.0/bin/node`. The canonical two-separator launcher and inspected recorders bind the exact six approved values and PATH order from (local record), SHA256 `62ac2be605e1d570863957472aae6702b196259228ab75d2f59215ec75240fb1`.

| Check | Observed result |
|---|---|
| Source syntax |Three files PASS|
| Focused serial controls |629 passed;172 new controls included|
| Unfiltered Node, unchanged default scheduling |4022 passed;0failed/cancelled/skipped/todo|
| Typecheck/nonmutating assets |PASS;8 generated JS assets|
| Static validation |PASS;420source/1197Rustdefinitions/25fixtureevents is inventory, not native execution|
| Unfiltered no-body Playwright collection |83 cases/28 files; C15/reload and active-conflict retained|
| C50 Chromium |Exactly one case,15.9s,workers1/retries0,recording off|
| Review-a/review-b fresh controls |172/172 each, once; no browser/native/product proof replay|
| Six native gates |Prior source-bound Linux-local PASS reused, not rerun|

Counts overlap and are not additive unique product tests. Focused file scheduling is serial under the existing fixture-ownership qualification. Full Node scheduling is unchanged.

The consumed write-once marker is (local record). `BROWSER_RESULT.json` and `c50-browser.post.json` record the sole PASS/exit0, source/binding equality and valid cleanup. The shared fixture lock enclosed discovery and execution. Existing locked/offline no-run library discovery is not native test execution. No timeout increase, SDK/browser upgrade, skipped case, assertion relaxation, response-body fallback, CDP/global/Window B observer or response fabrication was used.

`NATIVE_REUSE.json` revalidates432 native/build records, TOML/lock, executable and six saved metadata/log bindings against C49's reuse certificate. Executable SHA256 remains `e8ddbb739d3fff1a33dc9d80aba6a8706dc925f1c8079e42726f95fd2b367a2c`. Path-only WI_C3A_FIXTURE publication and mandatory source/pre-spawn checks remain. Prior native1217passed/11ignored/fourthreads is not fresh C50 execution or repair of historical default-concurrency SSE failures.

## Review and preservation

Both fresh reviews completed PASS with no findings:

- (local record), SHA256 `b2ff90b4e4a3a06d50f8ecf53c02dc949f4c77918a16deb2edda9f65ea707283`.
- (local record), SHA256 `9e62d4bbac7c36083ef62cb71dc2afa2a400fba7f05fdeefe8ce1c73ca5ab2f7`.

Reviews cover the complete three-file increment and relevant integration, not the final master-to-checkpoint-to-current diff or later parent documentation. No verification/remediation was needed because neither review established a finding.

Parent `IMPLEMENTATION_EVIDENCE_AUDIT.json` rehashes886 distinct referenced records with no drift/environment mismatch. `REVIEW_AUDIT.json` checks both terminal172-pass records, environment, source and owned identity absence. Review-a saves a bounded summary that exactly matches terminal metadata; its recorded raw stdout hash is not a parent raw-log rehash. Review-b's saved log hashes match.

Entry state was416staged/2trackedunstaged/0untracked. Parent inspected and staged only the two authorized C49 handoff/prompt amendments before the implementation delegate. `BASELINE.json` records416staged/0unstaged/0untracked,764source records and index SHA256 `3494736b9987205ae9069dc470776a256afb84a1e698e4725497d9abf0444982`. The delegate left exactly three new files untracked. Parent confirmed all764nonassigned records and5112named historical records unchanged. HEAD/branch/index stayed unchanged after the authorized checkpoint. Parent reconciliation and final C50 files remain unstaged/uncommitted. No final staging, commit, push, hosted mutation, merge, deployment or acceptance occurred.

Preservation excludes ignored caches/node_modules/test-results and external build cache except the named executable. Process evidence covers finite readable candidates and sampled owned descendants, not all host processes or ignored files. Only synthetic roots, skills, credentials and loopback/scripted providers were used. Fastlane remained off; ledger31/50used19remaining is unchanged.

## Preserved initial failures and limits

- Initial entry recorder rejected inaccessible unrelated /proc candidates before child start. Corrected ownership-first scanning did not start product proof at that rejection.
- `entry-corrected` lacks terminal evidence and remains INCOMPLETE/unknown, not PASS. A bounded metadata continuation completed separately.
- Initial controls remain131pass/4fail. Four expectations undercounted the actual collector's two forbidden-Task faults. Corrected expectations retain the stronger collector; final172 controls pass.
- Initial preflight failed because sanitized collection output lacked required title evidence. Corrected collection capture and preflight passed before the browser marker was consumed. No C50 browser failure or replay exists.
- The implementation and review-a each disclosed an early long direct-shell filename inventory. Parent's first review-a log audit confused raw-output metadata with the saved summary. Parent corrected that schema assumption without rerunning controls. A parent inline diagnostic was rejected for an extra brace and emitted Node's automatic syntax diagnostic. No private data was present; no product ran or historical record was changed. The failed diagnostics remain indexed and are not passing gate evidence.

C49's failed reader role and all older browser/native/control/preflight failures remain unchanged. C15/active1 stay OPEN_OWNER_DEFERRED; keep the application reader unchanged. Native default-concurrency SSE failures remain unresolved. Legacy upgrade/reopen, expanded barriers/measurements, final full gates, exact-head hosted CI, macOS evidence, three final complete-diff reviews and owner acceptance remain open. C50 completes only this bounded same-H interrupted comparison; it authorizes no next increment.
