# Wi M3 — bounded implementation and acceptance matrix

Status: **ALL ROWS NOT RUN**. Contract: `m3.1`, 2026-09-09.
Baseline: `2d9008b125c8a67dbc6977fe07fd65442cac7f9a`.
Authority: [WI_RUN_CONTROLLER.md](WI_RUN_CONTROLLER.md). Execute that plan; do not
replace it with another design pass. These are new acceptance requirements, not
results from the completed gateway/auth matrix.

## How to use this matrix

Each ID below is required for offline acceptance. A row passes only when every
listed subcase has observed evidence. One test may cover several assertions, but
list its exact name and command under every relevant row. Do not reduce coverage
to meet a test-count target. Add regression tests before fixes where practical.
Record PASS, FAIL, BLOCKED, or NOT RUN in the new verification report and JSON;
keep this specification's required oracles unchanged. Explain existing equivalent
tests explicitly rather than duplicating them. A baseline failure unrelated to M3
is evidence to report, not permission to weaken a gate.

All provider responses, auth stores, tools, and networks below are synthetic or
literal loopback. No real credential access or auth/generation request is authorized.
Normal tests must pass with HOME/XDG/CODEX_HOME redirected to isolated temporary
directories and with live credential paths absent. The host Pi assistant's own
conversation is outside these project tests.

## Fixed fixtures and measurements

- **T**: one Completed response with ordinary final text `hello`, no calls.
- **A**: complete direct add_numbers(17,25), local result `{ "sum": 42 }`, then
  Completed ordinary final text `42`. Distinct item_id and call_id.
- **B**: call add_numbers(17,25), correlated result 42; second call with a distinct
  call_id for add_numbers(42,8), result 50; third response final `50`.
- **C**: ordinary complete batch with two calls in declared order; the second can
  be swapped for a malformed or unknown call. No new first-call execution on
  whole-batch rejection.
- **P**: cooperative pending provider/tool futures controlled by oneshot/barriers.
  Cancellation/deadline tests must not depend on sleeps winning a race.
- **O**: native-final and validated-output-item-done recovery fixtures from the
  existing adapter. Preserve explicit provenance and opaque fields synthetically.

The independent fake provider records open count, generate-attempt count, receipts,
input vectors, close calls, and ordered events; its native objects deliberately
use non-OpenAI keys. Fake tools record actual execute invocations separately from
start-event dispatches. Use distinct sessions that intentionally reuse call IDs
for isolation tests. No fake completion may be labelled as live evidence.

## Matrix

| ID | Contract area / implementation target | Required cases and pass oracle |
|---|---|---|
| **M3-00** | Baseline and authority | Record actual HEAD, plan revision and existing dirty work. Preserve it. Existing six Cargo gates plus 152-runner baseline execute or blockers are recorded. Reconfirm no M3 live/auth permission. Historical reports/manifests/27-of-40 ledger are unchanged. Capture initial failures instead of replacing them with later PASS. |
| **M3-01** | Public library entry point and fresh ownership | `wi::run::run` accepts Gateway/RunRequest/registry/token/observer as specified. T works with the independent provider. Provider opens exactly once. The controller contains no OpenAI native-key parsing and does not invoke another agent. Return types and events are usable outside the binary. |
| **M3-02** | Before-admission validation | Empty/oversized prompt, invalid limits, nonempty caller options.tools, unknown provider, unavailable requested transport, invalid tool definitions, unsupported required capability, and pre-cancelled token produce Err; zero events, opens, generate attempts and tool calls. Check model limit 0/33, tools 129, deadline zero/>600s, and accepted boundary values. Metadata queries must not touch auth. |
| **M3-03** | One response and terminal output | T uses one attempt/admission/turn, no tools, and one Completed run result. Also complete empty output, reasoning-only output, and refusal-without-calls: stop without retries or invented content; preserve the full response/provenance. A terminal-only normalized start is allowed, but not labelled native-created evidence. |
| **M3-04** | Ordinary tool/result continuation | A produces exactly two attempts/receipts/turns, one actual tool call, output 42 under the originating call_id, and final 42. Continuation input has only the expected result. Tool dispatch/finish occurs after first validated response and before turn 1 finishes. No arithmetic or final-answer oracle is hard-coded in the generic controller. |
| **M3-05** | Repeated workflow | B completes three requests/two new executions, result 42 then 50, in one provider session. Assert each exact input vector, distinct call identities, stable session, final text 50, and no fourth request. A variant C checks same-batch sequential order and corresponding ordered result input. |
| **M3-06** | Whole-batch authority and validation | C variants: partial JSON, extra fields, noninteger arguments, unknown tool, duplicate call_id, conflicting reused ID, incomplete/malformed status, string/object/numeric namespace, programmatic/unknown caller, and unknown executable item. Any rejected subcase has zero new execute invocations, zero cache insertions and zero execution-start events for the entire batch; no continuation. Include inherited positive controls for omitted and exact completed status. |
| **M3-07** | Response outcomes and provenance | Incomplete, Failed and provider-Cancelled responses never execute tools or continue. Returned last response/outcome remains inspectable. Native-final and finalized-item recovery O both produce correct effective output and unchanged provenance/native metadata. Invalid recovery rejects, preserves terminal_received classification, and does not execute or settle. Missing/null/malformed terminal output must not become recoverable output. |
| **M3-08** | Validator relocation at real adapter boundary | Run the former CLI consistency regressions through a public provider session: discarded/changed streamed text, inconsistent finalized items, identity/index changes and tracking overflow fail before settlement, tool execution or next send. Prove valid interleaved text parts and bounded compatible output still pass. Both legacy collect callers and the new controller receive the guarantee without importing OpenAI parsing into `run/`. No removed negative coverage. |
| **M3-09** | Collector correlation | Fake streams with wrong session/provider/request ID, non-increasing local provider sequence, inconsistent response ID, idle session_closed with null request, and EOF before terminal are stopped and never continued. Sequence gaps alone are allowed. Preserve nested envelopes exactly. Duplicate terminal/order contradictions already covered by adapter tests remain covered; do not add a postterminal wait that hangs. |
| **M3-10** | Model-request boundary | Default and boundary limits apply to calls into generate, including rejection/uncertainty. B at max_model_requests=2 stops on the second response's call: two attempts, only the first tool executed, no second tool or third request. At limit=1, A's first call is not executed. Final text on the last allowed request still completes. An all-cached tool batch at the request limit is also not replayed/submitted. |
| **M3-11** | Tool budget and cache capacity | Zero execution budget accepts T but rejects a new A tool before dispatch. C with budget for only one new call rejects the whole two-new-call batch. A batch with one cached and one new call needs one slot, not two. Cache replay at 128 entries succeeds without a new entry; a genuinely new 129th entry fails before any dispatch. More than eight calls still fails. Count actual new IDs, not raw batch length. |
| **M3-12** | Isolation and cached replay | Repeating an identical call in one run reuses its result with no second execute invocation; changed tool/arguments under that ID fails. Two runs using the same registry template and same call ID each execute independently; prior caller cache is neither consumed nor mutated. Sessions/open count are distinct across runs and fixed within each run. Tool Arcs may be shared, result caches may not. |
| **M3-13** | Cooperative cancellation | Cancel before admission; during pending session open; pending generate before receipt; awaiting output after receipt; between two tools; and during a cooperative pending tool. No later dispatch/request follows observed cancellation. Controlled admitted cases return CancelledLocally and one terminal lifecycle if sink healthy. Mid-tool cancellation produces no fabricated result/finish. Before first generation is not_submitted; ambiguous generate awaits/active requests remain unknown unless stronger evidence arrived. |
| **M3-14** | Absolute deadline and priority | Paused-time or deterministic-clock cases during open, generation and tools share one admission-started absolute deadline. A completed early turn does not reset it. Cancellation and deadline becoming ready together choose cancellation; no completed terminal outcome is rewritten afterward. No external side-effect rollback or kernel-blocking deadline guarantee is claimed. No wall-clock time arithmetic. |
| **M3-15** | Tool errors versus controller failures | Checked-add overflow becomes a bounded correlated error result; the model can consume it within limits. Oversized tool output uses existing bounded error behavior. Malformed arguments/authority remain preflight failures rather than executable errors. Partial batch cancellation/failure sends no result subset. Cache results only when an actual local result exists; never fabricate a cancelled tool result. |
| **M3-16** | No retries/fallback or weakened uncertainty | Fake/loopback preflight rejection, 401/403/429, disconnect after potential send, failed admission reply, and terminal-valid/local-failure preserve distinctions. Exactly one attempted request at each step; no reconnect, second provider open, account reselection, automatic tool replay, or transport fallback. Preserve provider-reported not_submitted/unknown/terminal_received. M3 counters are not the live ledger. |
| **M3-17** | Lifecycle events and counters | Snapshot/assert T, A, B, open failure, and stopped-turn traces. First run event is run_started; last healthy event is run_finished. Each started turn gets one finish under controlled execution; no events/work follow terminal selection. Fresh run/turn IDs; same run/session IDs throughout; local run sequence increasing independently of provider sequence. Counters equal recorded operations, not guessed tool results. No agent/message/steering events are invented. |
| **M3-18** | Event observer and future-drop behavior | Observer Full, Closed and Failed at run start, provider forwarding and tool-start boundary select failed RunResult with events_complete=false. Final-emission failure retains the selected execution outcome but records sink_error/events_complete=false, emits no second terminal event, and makes CLI exit1. No retry to the failed observer; no subsequent tool/provider work. Callback adapter uses nonblocking bounded forwarding. Drop an active run future and verify its session close guard; do not expect a return value or final event after drop/process loss. No internal unbounded transcript/queue or detached tool task. |
| **M3-19** | Authentication/session preservation | Fake manager/provider observes exactly one profile preparation/selection per open, no controller auth method calls and no external-source fallback. Original managed-auth, incarnation, renewal, store, and read-only-source synthetic tests stay green. No production auth module changes. All run tests execute with live auth locations absent. Opening cancellation does not change the existing rotation-worker completion policy. |
| **M3-20** | Thin CLI and output safety | Test `wi run --help`, all limit/argument conflicts, repeat/unknown tool selection, stdin/input bounds, explicit managed source arguments, and no-auth prevalidation. JSON stdout is only new outer NDJSON; old commands' schemas stay unchanged. Plain output filters terminal controls; partial output is not marked complete. Completed exit0, cancelled exit130, other failure1. Ctrl+C signals cancellation and awaits controlled completion; broken stdout stops work. Exercise real handler with fake gateway, not only Clap parsing. |
| **M3-21** | New-controller WebSocket integration (loopback) | Register the test-only loopback OpenAI adapter in Gateway, drive A using the library function. Verify one socket, two response.create frames, correct previous_response_id/new-input-only linkage, same auth identity, and result call_id. Exercise recovered-output O and a disconnect/error variant. No `wi smoke` shortcut; this test must traverse the new controller. |
| **M3-22** | New-controller SSE integration (loopback) | Same A/library path, two HTTP requests, replay of ordered effective native items and correlated results. Test valid MIME plus existing missing-MIME/prolog-admission behavior and one explicit wrong-MIME failure. Replay synthetic opaque metadata exactly where the existing adapter requires it. Inspect only synthetic headers/body. No WebSocket fallback or provider changes. |
| **M3-23** | Deferred capabilities and unsupported output | Required steering, skills, search, PTC and async capability checks still reject before auth/network. Unknown/program/custom/hosted executable items are retained but rejected by this ordinary loop. No account-failover API, real shell, dynamic plugin loader or hidden authentication change is introduced. Default tool list is empty. |
| **M3-24** | Runnable independent example and regression gates | `cargo run --example run_offline` produces B's assertions using real controller and registry, no OpenAI/native shape dependency. All six Cargo gates, verification-runner self-tests, example and diff check pass; record actual totals and platform coverage. Keep existing 187/152 evidence historical, not an assumed minimum PASS count. |
| **M3-25** | Documentation and evidence alignment | Public API, event/CLI docs, examples and implementation agree. Correct current EVENTS renewal statement without rewriting history. New human/JSON reports map every row to evidence, distinguish offline/live and note zero new auth/generation traffic. No prefilled PASS or misleading `milestone_accepted=true`. All existing budgets/manifests and completed reports unchanged. |
| **M3-26** | Independent offline review | A reviewer separate from the implementor checks the changed diff, event traces, cancellation/sink races, limits, validator relocation, provider neutrality, and preservation of auth/transport protections. Regressions for findings pass after fixes. Record review identity/role, scope, findings and resolution. If reviewer unavailable, mark BLOCKED; do not invent sign-off. |

## Fixed trace examples

T, healthy sink:

```text
run_started
turn_started(1)
provider_event(response_started ... output ... response_finished)
turn_finished(1, model_completed)
run_finished(completed)
```

A, healthy sink:

```text
run_started
turn_started(1)
provider_event(... validated completed response containing call ...)
tool_event(tool_execution_started)
tool_event(tool_execution_finished)
turn_finished(1, tools_prepared)
turn_started(2)
provider_event(... final text response ...)
turn_finished(2, model_completed)
run_finished(completed)
```

These omit item-level event multiplicity for readability, not permission to
fabricate/drop provider items. Request two's inputs are separately asserted by
the fake provider or loopback observer. There is no invented result-delivery ACK.
At a limit, the current turn finishes stopped/limit_reached and the run finishes
limit_reached before any unauthorized new tool. Open failure has run start/end
but no turn. A failed observer stops emissions; returned RunResult is the evidence.

## Required verification commands

Run on the real checked-out source; record initial and final exit codes separately.

```bash
cargo fmt --all -- --check
cargo check --all-targets
cargo test --all-targets
cargo clippy --all-targets -- -D warnings
cargo build --all-targets
cargo test --doc
node scripts/cli_retest.mjs --self-test
cargo run --example run_offline
git diff --check
```

Baseline/final `uv run scripts/verify.py` is also required when uv is installed;
if not, record the missing wrapper and the directly executed gates. Formatting
repairs use cargo fmt followed by another check; no blanket lint suppression or
removal of failing cases. Report actual Rust versus Node counts, ignored/filtered
and platform-specific exclusions, doctests (including zero), commit and dirty-tree
state. Old transport smoke success is not evidence for the new path.

## Deferred live checks: NOT AUTHORIZED, not offline acceptance rows

| ID | Future purpose | Strict maximum if separately authorized |
|---|---|---:|
| RL1 | New run controller, one `add_numbers(17,25)` round trip over WebSocket; structural socket/input/call/result assertions. | 2 provider generations |
| RL2 | The same new-controller case using explicit SSE and native replay assertions. | 2 provider generations |

Do not implement or run a new live helper as part of M3. Do not run these through
an old fixed smoke path and call that M3 evidence. A future instruction must name
cases, account policy, model, cap and ledger allocation; budget is not assumed
available. No auth experiments are needed for this proposal. M3 offline acceptance
must explicitly say live NOT AUTHORIZED / NOT RUN. The 27/40 ledger is unchanged.
