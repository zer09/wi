# C3b3: retained real Task reply-loss recovery

Contract: **g1.1**. Status: **SCOPED COMPLETE; REVIEW-A/B PASS**. Accepted: **false**.

This one-file increment adapts the existing native-WebSocket Task recovery case to the active display app. It retains the actual browser -> Rust HTTP -> RunHost/B2 -> SQLite -> scripted OpenAI loopback -> AddNumbers -> display HTTP/SSE -> DOM chain. This is one scoped J scenario, not all-six transport coverage or expanded Phase D proof.

## Scope and staging

The parent staged completed C3b2 work before implementation:231 cached changed paths, zero unstaged and zero untracked. The implementation and both reviews left only `web/e2e/task-recovery.spec.mjs` unstaged, with117 insertions/54 deletions. Production, Rust, dist, helpers, dependencies, configuration and other suites had no unstaged changes. No commit or push occurred.

The parent inspected the complete index-relative patch. The parent matched the current Git diff directly to (local record). Change tracking used Git, not whole-tree hashes. HEAD318b7f0 and the accepted master/checkpoint ancestry remain unchanged. Parent evidence documentation is additional to the reviewed one-file increment.

## Retained and replaced assertions

All locations below refer to `web/e2e/task-recovery.spec.mjs`.

| Obligation | Disposition and actual evidence |
|---|---|
| One same native-WebSocket/nonrecovered real producer fixture | RETAINED, lines18-41. No synthetic transcript or API DTO substitution. |
| Exact create/selection, canonical metadata, empty chat and matching Latest H before display SSE | ADAPTED, lines70-85,135-177. Public handshake capture keeps path/status/Boolean only; the independent initial audit proves H=1. |
| Pending before actual SQL commit, immutable captured text after draft editing, original IDs and zero premature work | RETAINED, lines179-217. Actual storage pause, receipt2..3 and independent acceptance/checkpoint identities remain. |
| Running display cannot manufacture acceptance | REPLACED raw browser acceptance reduction, lines218-251. One canonical Human anchor renders while the command is sending, then uncertain after lost202. No receipt appears without server proof. |
| Browser operation/run/history receipt-range proof | REPLACED, lines253-274. Explicit read-only POST reconciliation sends the exact original operation/run/text and returns the actual receipt/current run_view. No second Task, tool or provider effect. |
| Actual arguments/result/is_error and one AddNumbers execution | RETAINED, lines276-291. Tool disclosure shows exact bytes and supplied result/finish recording facts. |
| Provisional answer, authoritative final answer, native provenance and response < RunFinished < RunResult | RETAINED, lines293-345. Exact Unicode/CRLF bytes appear once; native audit observes17 < 19 < 20. Human/assistant/tool/assistant chronology and original entry/receipt identities remain. |
| Final explicit status/result read | REPLACED, lines347-368, by a second same-body reconciliation. The actual completed run_view shows terminal19/result20 and result_recorded. Independent final SQL audit and zero extra effects remain. |
| Privacy, inert DOM, memory-only Connect, active assets, exact requests and Disconnect/Stop/reap | RETAINED/ADAPTED, lines37-133,360-392. Raw history/events/operation/run GETs and active raw runtime modules are forbidden. |

`Read run status` remains at `web/src/display-view.ts:210-212`. The final reconciliation deliberately replaces this test's prior status action. The parent corrected its initial assumption that the control was absent; no production or policy change followed. Separate raw RunView routes and their lower-level tests remain.

The generic committed-reply fault in `web/test-support/mutations.mjs:1-57` remains unchanged. It targets completed202 loss, not Window B network-byte observation. Both reconciliation bodies remain in test memory. No API body/header/query, credential or DOM snapshot is saved.

## Completed checks and independent review

Implementation report: (local record).

Fresh independent reports, both without Fastlane:

- (local record): COMPLETED PASS; no actionable findings.
- (local record): COMPLETED PASS; no actionable findings.

The corrected implementation and each review passed the complete Task file1, complete real create/rename controls2, unfiltered Node1345, typecheck, external nonmutating ten-asset name/byte parity and complete display-app9/display-view43 controls. Counts overlap and are not summed. Browser workers1/retries0, existing deadlines and off trace/screenshots/video remain unchanged. Commands invoking fixture Cargo discovery used a shared external flock during review. No long native gate ran.

Each external report and `logs/*.json` retains exact argv, cwd, UTC times, PIDs, exits, environment and log hashes. Parent (local record) rehashed11 implementation,8 review-a and9 review-b records, including every saved failure. Exact patch, scope and cached/uncached whitespace checks passed. No finding required verification or remediation.

Fixture: (local record), SHA256 `0866b7011b1fac6167708d681d9e05e78fbda8ef501d2192d687c0c2c7b809ab`. Existing short locked/offline Cargo artifact discovery remains. Synthetic child HOME/XDG/CODEX/TMPDIR isolation remains separate from the required gate-launcher environment. Six native gates remain prior C3b1 attribution, not fresh execution.

Review-a's closure passed. Review-b's two closure scripts failed: first from a fixture-count assumption, then from comparing identical artifact membership in different array orders. Neither failed script becomes PASS. The parent inspected the second failure and its source. A separate parent read-only evidence audit confirmed the exact artifact sets, matching log hashes, unchanged one-file scope and absence of all recorded gate/descendant PIDs. Only `.last-run.json` files exist in the implementation/review browser output directories. All real fixture tests completed mandatory Stop/reap. No existing service, cache or evidence was removed.

## Preserved failures and process deviations

- Implementation `task-first` failed a broad Human `pre` selector because each entry has content and error pre elements.
- `task-diagnostic` added safe line diagnostics but repeated the same proof before a material correction. It failed at line222. This equivalent retry is a process deviation, not a new pass.
- The narrow `[data-field] pre` and tool-result disclosure correction then passed the complete file. Both original failed records remain.
- Review-b's external Context Mode attempts were blocked or malformed; they supplied no evidence. Its count/marker assumptions and both failed closure diagnostics remain in its report. Review-a retains a failed nonexistent-path discovery.
- The parent's first completed-log inspection used an incorrect `.stderr` suffix and returned a missing-path error. Inspection of the actual `.stderr.log` then showed the artifact-order assertion failure. No gate was rerun.
- Prior concurrent router103/1 failures remain open. Serialized104 was not a fix. No equivalent router rerun or Rust diagnosis occurred.

Technical review completion does not claim perfect procedure compliance.

## Evidence levels and remaining work

The Task supplies **J for one native-WebSocket scenario**. Create/rename controls remain actual H+B with zero provider work. The52 display controls remain synthetic C/B plus separate embedded-asset H. Node/typecheck/parity are C/build evidence. Source inspection, prior native execution and hosted evidence remain separate.

G11-33 becomes PARTIAL for this retained single scenario. Totals become **38 PARTIAL / 2 NOT_RUN**, accepted=false. G11-29/34 remain NOT_RUN. No whole-row acceptance follows. All-six transports/next-task replay, S2/account/reuse, fixed-H live/saved DOM parity, multi-client/restart, other old-suite adaptations, raw/exclusive-helper retirement, measurements/examples/Ubuntu CI/final reviews and hosted closure remain open.

Only synthetic roots/skills/credentials and scripted loopback providers were used. No real credential/private workspace/provider skill/auth/live generation, new dependency/auth mode/runtime budget, Windows restoration, hosted mutation, commit/push or acceptance occurred. Ledger31/50 used19remaining is unchanged. Completed work is staged before the next implementation/remediation delegate; staging does not authorize commits or pushes.
