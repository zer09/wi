# C3b4: retained six-transport joined suite adaptation

Contract: **g1.1**. Status: **SCOPED COMPLETE; REVIEW-A/B PASS**. Accepted: **false**.

`web/e2e/joined.spec.mjs` now uses the active display app in all six retained transport scenarios, with two explicit Tasks each. The real browser -> HTTP -> RunHost/B2 -> SQLite -> OpenAI loopback -> AddNumbers -> display HTTP/SSE -> DOM chain remains. This is existing-suite migration, not expanded S2/restart/parity work or acceptance.

## Scope and staging

The parent staged completed C3b3 work before implementation:233 cached changed paths, zero unstaged/untracked. The implementation and both reviewers left exactly one unstaged file,179 insertions/47 deletions, with zero untracked paths. Production, Rust, dist, helpers, configuration, dependencies and other suites had no unstaged edits. No Git mutation occurred in those roles. HEAD318b7f0 and both pinned ancestors remain.

The parent read the complete index-relative patch and implementation report. Parent checks matched actual Git diff to (local record) and checked scope/whitespace. Git, not whole-tree file hashes, tracks changes. Parent progress documentation is additional to the reviewed one-file increment. No commit or push occurred.

## Actual retained and replaced obligations

All locations below refer to `web/e2e/joined.spec.mjs`.

| Obligation | Disposition and actual evidence |
|---|---|
| WS native/recovered; provider-SSE labelled native/recovered; provider-SSE missing-MIME native/recovered | RETAINED, lines14-21. One complete test per scenario; two explicit Tasks each. |
| Exact title/task/arguments/result/answer bytes; Enter newline, Send and Control+Enter | RETAINED, lines6-10,176-240,291-358. Unicode/CRLF/inert markup stay exact. |
| Create receipt, canonical metadata/hash/empty chat and matching initial H | ADAPTED, lines176-213. Accepted Create article remains; real Latest200 precedes matching display SSE after native H=1. |
| Pending before actual SQL, immutable command/receipt/run identity and acceptance distinct from completion | RETAINED/ADAPTED, lines225-289. Existing BeforeCommit gate and independent zero-new-work audit remain. Accepted Task articles persist. |
| Empty first replay; correct stored history for next explicit Task | RETAINED, lines279-289,361-372. Native producer checks exact prepared input/history and real request/connection/auth/effect counts. UI reads cause no generation. |
| Actual AddNumbers bytes/is_error, one effect and correlated continuation | RETAINED, lines291-312. Supplied result/finish recording facts replace old inferred success labels. Tool disclosure opens; final answer/result is absent before release. |
| Native/recovered provenance and ResponseFinished < RunFinished < RunResult | RETAINED, lines314-330, through independent native/SQLite audit. No public provenance field is invented. |
| SQL completion is not browser observation | REPLACED raw Applied cursor, lines331-356, with streaming and actual final assistant/block/recording facts. Exact final bytes appear once, one Human anchor remains, and entries stay chronological. |
| Reload/full-prefix transcript equality | REPLACED, lines33-51,373-406, by explicit Reconnect latest and fresh-page Latest/matching-SSE. Test-memory comparison covers newest completed B's run/entry/field identity, order, exact text and recorded state. It does not force older A to reload. |
| Receipt truth across same-page rebase; fresh page has no command/token/automatic POST | RETAINED, lines386-410. Create and both Task receipts remain exact; fresh Connect reads only. |
| Read-only rebase/navigation, privacy/assets/Disconnect and Stop/reap | RETAINED/ADAPTED, lines87-164,407-457. Complete native proof remains unchanged except inspection ID. Exactly Create+Task+Task mutate; raw reads/runtime modules are forbidden. |

The newest-B comparison is a finite completed-state control. The native audit fixes the final canonical head; subsequent matching-H Latest/SSE and unchanged native proof accompany exact DOM equality. It supplies scoped completed-state evidence for G11-29, not full partial/refusal/reasoning/interruption parity or a universal race guarantee. It does not assert that every emitted provisional delta reached this browser.

## Independent checks and review

Implementation: (local record).

Fresh independent reports, both without Fastlane:

- (local record): COMPLETED PASS; no actionable findings.
- (local record): COMPLETED PASS; no actionable findings.

The corrected implementation and each review passed complete joined6 with both Tasks each, complete Task/create/rename controls3, complete display controls52, unfiltered Node1345, typecheck and external nonmutating ten-asset name/byte parity. Controls3 contain one real J Task recovery case and two actual H+B metadata cases; they are not three zero-provider cases. Counts overlap and are not summed. No suite filters/skips, changed deadlines or retry increase were used. Browser workers1/retries0 and off trace/screenshots/video remain. Each review serialized Cargo-discovery browser commands with a shared external flock.

Exact argv/cwd/UTC/PIDs/exits/environment and log hashes are in the external reports and `logs/*.json`. Parent implementation-check.json rehashed14 implementation records, including failures. Parent review-check.json rehashed6 review-a and8 review-b records, checked exact launcher environments, current patch/scope/whitespace and absence of recorded PIDs. Both independent reviews passed their required gates on the first attempt. No finding required verification/remediation.

Fixture (local record) remains SHA256 `0866b7011b1fac6167708d681d9e05e78fbda8ef501d2192d687c0c2c7b809ab`. Existing short locked/offline Cargo discovery remains. Node24.18.0/TS5.9.3/Playwright1.58.2/Chromium145.0.7632.6 are observed. Six native gates remain prior C3b1 attribution; no long native gate ran.

Native variants observed Task1 response/terminal/result17/19/20 and Task2 36/38/39. Recovered variants observed19/21/22 and40/42/43. These12 per-run observations are native sequence/provenance evidence, not browser applied-prefix proof. After both Tasks, provider requests4, tools2, terminals2/results2 remain. WS uses connections2/auth loads2/prepares2; SSE uses connections4/auth loads6/prepares6.

## Preserved failures and closure limits

- First joined run:2 WS passed,4 SSE failed a new auth-count assumption. Source inspection showed SSE open plus two sends load/prepare credentials three times per Task. The material test correction then passed complete6. The original failure remains.
- First display-control launch omitted required WI_C3A_FIXTURE. All52 failed before native spawn. Supplying the verified fixture then passed complete52. No test/helper guard changed.
- That failed launch allocated52 empty external synthetic directories. They remain failure artifacts, not claimed successful cleanup.
- First implementation closure failed because one optional `/proc` environment sample was unavailable. The corrected parser records the gap:51 observed environments plus unchanged source and52 clean Stop/exit records, not52 observed environments. Review-a separately sampled52; it does not rewrite the original gap.
- A nonexistent external baseline read and inherited color/npm warnings remain disclosed. No unchanged failed gate was repeated. Review-a retains a nonexistent documentation-path discovery and an unmatched helper lookup; neither is gate evidence.
- Prior concurrent router103/1 failures remain open, unrerun and undiagnosed. Serialized104 was not a fix.

All started fixtures completed mandatory Stop/reap, including the initial failed joined cases. Recorded gate/descendant PIDs were absent at parent checks. Review browser outputs contain only `.last-run.json`; no trace/screenshot/video/DOM/API/header/query/credential artifact exists. Actual command and newest-B comparisons stay in test memory. Synthetic native-child environment differs intentionally from the launcher. No existing service, cache, report, handoff or failure artifact was removed.

## Progress and deferred work

G11-33 gains actual six-transport/next-Task J evidence. G11-29 becomes PARTIAL for the finite newest-completed-B live/rebase/fresh-page comparison. Totals become **39 PARTIAL / 1 NOT_RUN**, accepted=false. G11-34 remains NOT_RUN. No row receives acceptance.

Other old-suite migrations, raw/exclusive-helper retirement, full fixed-H partial/refusal/reasoning/interruption parity, S2/source deletion/account/Reuse fidelity, multi-client/restart, measurements/examples/Ubuntu CI/final complete-diff reviews and hosted closure remain open. The original joined suite is adapted; the entire browser suite is not claimed green.

Only synthetic roots/skills/credentials and scripted loopback providers were used. No real credential/private workspace/provider skill/auth/live generation, new dependency/auth mode/runtime budget/provider/tool, Windows restoration, hosted mutation, commit/push or acceptance occurred. Ledger31/50 used19remaining is unchanged. Completed work is staged before the next implementation/remediation delegate.
