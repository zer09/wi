# Wi M3 — bounded run controller: implementation contract

Status: **PLAN, NOT IMPLEMENTED**. Contract version: `m3.1`. Prepared 2026-09-09.
Baseline: `2d9008b125c8a67dbc6977fe07fd65442cac7f9a` in `zer09/wi`.

This document fixes the design. [WI_RUN_MATRIX.md](WI_RUN_MATRIX.md) fixes the
acceptance tests. [WI_RUN_IMPLEMENTOR_PROMPT.md](WI_RUN_IMPLEMENTOR_PROMPT.md)
starts the local implementation task, not another planning task. This PR contains
only documentation; none of the following new APIs, events, or tests exists yet.
Implementation details that do not change the contract remain the implementor's
responsibility. A genuine contradiction is a scoped blocker, not permission to
silently redesign the milestone or relax a test.

## 1. Evidence and authority

Source-derived baseline: [COMBINED_DESIGN_REPORT.md](COMBINED_DESIGN_REPORT.md)
records completed experimental Linux gateway and Wi-managed-auth matrices, 187
Rust tests, 152 verification-runner self-tests, and six passing Cargo gates.
`src/main.rs::tool_demo` is still an exact two-response demonstration.
`src/collect_lifecycle.rs` contains CLI-only consistency checks.
`src/tools.rs::ToolRegistry` owns local validation, execution, and result reuse.
`src/provider.rs` defines the independent provider/session/event contracts.
Those are inspected baseline facts, not claims that M3 has passed.

All requirements below are new design decisions. They do not add provider
capabilities or claim more authentication evidence. Use the latest/current
sections of [LOCAL_VERIFICATION.md](LOCAL_VERIFICATION.md) and
[local-verification.json](local-verification.json); their original failure fields
are historical. Do not use the old attached 86-test report as current acceptance.

The active M3 implementation authorization, when the user supplies the implementor
prompt, is **source changes and offline tests only**. No real profile reads,
login, renewal, auth checks, live generations, commits, pushes, or publication.
Normal development dependency downloads follow the user's existing tooling
permissions. Synthetic auth files and loopback servers are allowed. Pi's authoring
conversation is not a Wi live test. The historical generation ledger stays
**27/40 used, 13 remaining**; none of the remaining budget is authorized here.
Historical handoff instructions suggesting live runs do not apply to M3.

## 2. Objective and non-goals

Deliver one reusable Rust library operation that owns one bounded task:

```text
caller -> wi::run::run
           -> one Gateway::open_session
           -> validated model response
           -> zero or more sequential local tool batches and continuations
           -> one terminal RunResult
```

Reuse the existing provider and registry. Only `add_numbers` is supplied as a
production tool. Tests may register deterministic in-process fake tools. Keep
`wi generate`, `wi tool-demo`, `wi smoke`, their JSON, and their exact acceptance
oracles working. Add a thin `wi run` command; do not copy a loop into that command.

Do not add a persistent agent service, database, transcript tree, approvals,
steering (queued or native), retries, fallback, background jobs, shell/file/network
tools, new providers, GUI/server, tool search, skills, PTC, native async tools,
parallel tools, or account switching. Pi/Codex may author/review the code but may
not be invoked as a substitute runtime. Keep package/library/binary `wi`, version
0.2.0, provider ID `openai-codex`, client identity, model IDs, endpoint rules,
OAuth/storage/selection/renewal behavior, and provider-event schema unchanged.

## 3. Ownership and allowed changes

| Area | Required change / boundary |
|---|---|
| `src/run/mod.rs`, `src/run/events.rs`, `src/run/collect.rs` | New library controller, types, and provider-neutral request correlation. No OpenAI native JSON parsing. |
| `src/lib.rs` | Export `pub mod run`; keep existing exports compatible. |
| `src/providers/openai_codex/consistency.rs` | Move the existing CLI lifecycle validator here, preserving its bounds and conservative rules. Change `wi::` imports to `crate::` as appropriate. |
| `src/providers/openai_codex/session.rs::drive` | Apply that validator per response before settlement and publishing `response_finished`; see section 5. No transport/auth refactor. |
| `src/collect_lifecycle.rs`, `src/collect_tests.rs`, `main.rs::collect` | Remove the duplicate CLI-only validator after equivalent adapter/public-session regressions exist. Keep rendering/correlation behavior. Migrate tests, do not delete their coverage. |
| `src/tools.rs` | One shared two-phase preflight/execution implementation, fresh run-scoped cache, limit accounting, fallible execution observer and cancellation checkpoints. Preserve the existing `execute_response` public entry point as a compatibility wrapper. |
| `src/run_cli.rs`, `src/main.rs` | Parse `wi run`, resolve/register the already selected provider, call the library, render events/result. Reuse auth argument handling without changing it. |
| New run tests and `examples/run_offline.rs` | Independent scripted provider, pure tools, deterministic cancellation, and both loopback transports. |
| Active README / ARCHITECTURE / EVENTS | Document implemented M3 after it passes; fix the stale explicit-live-renewal statement in EVENTS. Do not rewrite old reports or hashes. |
| Cargo.toml | Only add Tokio `test-util` as a development/test feature if needed for paused-time tests. No dependency upgrades/new runtime framework; preserve Cargo.lock except justified feature resolution. |

This is a logical split, not a new crate/service/actor framework. Existing auth,
recovery, SSE-admission, smoke-runner and provider contract tests must remain.
Minimal test wiring changes are allowed. Unexpected necessary production changes
outside this table must be reported as a blocker or explicitly justified against
a matrix row before proceeding; no opportunistic cleanup.

## 4. Public API and fixed limits

Use an async function plus a synchronous, fallible event observer. Do not add a
second worker task, an internal event queue, or an unbounded event history. The
caller may run the future in its own task and cancel through a cloned token.

The following signature is normative API intent, not delivered Rust code:

```rust
pub async fn run<F>(
    gateway: &Gateway,
    request: RunRequest,
    tools: &ToolRegistry,
    cancel: tokio_util::sync::CancellationToken,
    emit: F,
) -> crate::Result<RunResult>
where
    F: FnMut(&RunEventEnvelope) -> std::result::Result<(), RunSinkError>;
```

`RunRequest` has `provider_id: String`, `options: SessionOptions`, `prompt: String`,
and `limits: RunLimits`. Initial input is exactly one user message; externally
supplied tool results and a pre-opened/session-resume ID are not accepted here.
`options.tools` must be empty on entry. The controller takes a fresh execution
scope from the supplied registry, obtains its validated definitions once, and
inserts those into options before opening the session. Registered tools are the
application's allowlist; no permissions/approval framework is implied.

`ToolRegistry::fresh_scope(&self) -> ToolRegistry` clones registered tool Arcs and
starts an empty result cache. The controller owns this scope for the entire run.
It never uses/mutates the caller registry's cached results. A second run creates
another scope, even when it receives the same registry and identical call IDs.
This is in-memory isolation, not crash recovery or side-effect deduplication across
runs. Trusted custom tools can share internal state through their own Arcs; Wi
cannot turn arbitrary tool implementations into isolated sandboxes.

| Limit | Default | Accepted range | Meaning |
|---|---:|---:|---|
| `max_model_requests` | 4 | 1..=32 | Each controller call to `SessionControl::generate`, including rejected or uncertain attempts, consumes one. A receipt is not an upstream write counter. |
| `max_tool_executions` | 8 | 0..=128 | New local tool dispatches. Cached result reuse consumes no new-execution allowance. Zero still allows text-only completion. |
| `deadline` | 120 seconds | positive, <=600 seconds | Absolute monotonic budget starting at run admission; includes session open, generation, tools and event processing. CLI accepts integer seconds 1..=600. |

Preserve existing input/config, response/history, per-batch eight-call, output
size, and cache-size limits. Do not multiply limits into a larger allowance.
The existing cache-capacity check must count **new distinct call IDs**, not every
cached reuse in a batch. Reject an oversized batch before any dispatch or reuse
notification; do not execute the portion that fits.

Before admission: validate limits, prompt/options/definitions, empty caller tool
list, provider existence, requested transport implementation, function-tool implementation when tools are registered,
and required capabilities using metadata-only calls. Check pre-cancellation. Failures return
`Err` with zero run events, zero provider opens/generates and zero new tool work.
Do not read credentials for validation. After successful admission, create run ID
and deadline and attempt `run_started`; all controlled outcomes thereafter return
`Ok(RunResult)`, including failure, limit, cancellation, and sink failure.

`RunResult` contains `run_id`, optional `session_id`, typed `outcome`, `summary`,
and `last_response: Option<ModelResponse>`, `events_complete: bool`, and
`sink_error: Option<RunSinkError>`. Retain a last validated response even
if the run later stops at a tool limit. Do not substitute a partial response.
`RunOutcome`: `Completed`, `LimitReached { limit: LimitKind }`,
`Failed { code: String }`, `CancelledLocally`. `LimitKind`: `ModelRequests`,
`ToolExecutions`, `Deadline`. Failure codes exposed by the controller are fixed
allowlisted local classes, never raw provider text or credentials.

`RunSummary` records turns started/finished, model requests attempted/admitted,
new tool dispatches, tool results prepared, reused results, optional last request
ID and last `UpstreamOutcome` (if a generation exists).
Attempted/admitted are local counters, not billable/upstream submission counts.
No token/cost aggregation or subscription quota accounting is added.
`Completed` means the controller has no supported pending calls; it does not prove
answer correctness. A completed response without calls can be empty, reasoning-only,
or a refusal. Preserve it and stop; do not silently retry it or invent output.

## 5. Preserve the safety boundary without provider coupling

Move `collect_lifecycle::Lifecycle` into the OpenAI adapter, not `run/`. Instantiate
it afresh per request in `session.rs::drive`. Observe normalized output events
before forwarding them, and validate the effective final `ModelResponse` **before**
`Conversation::settle`, `wire.end_response`, and terminal publication. Keep the
existing recovery tracker and native terminal handling; this validator does not
reconstruct output or replace them. A contradiction stops settlement, subsequent
submission, and execution. If the decoder already validated a terminal, retain
`upstream_outcome = terminal_received` when this local check fails.

This makes the previous CLI guarantee available to every library consumer. Once
adapter enforcement is proved through public-session tests, the CLI no longer
needs a second native-content validator. Neither `run/` nor `run_cli.rs` may read
`response.native`/`item.native` to interpret OpenAI keys. They may retain and
forward sensitive native values unchanged as part of the existing response.
Provider plugins are trusted implementations of a semantic contract, not an
untrusted-code security boundary. A fake provider must work with different opaque
native shapes. The registry's existing defensive native namespace rejection must
not be removed or bypassed as part of this move; no new generic OpenAI parsing.

The run collector checks session/provider/request IDs, locally increasing provider
event sequence (gaps allowed), consistent normalized response identity, and one
terminal result for the active request. `session_closed` with null request ID is
a session failure, not an invented response. A normalized synthetic start remains
allowed under the current provider contract; it does not prove a native start.
The adapter remains responsible for item/native protocol validity. Upon terminal
collection do not wait indefinitely for EOF or generate another request to probe
for a duplicate event. Existing adapter tests plus malicious fake-stream tests
cover duplicates/order contradictions that arrive before collection completes.

## 6. Execution algorithm

1. Validate and admit as above. Emit `run_started`. Open exactly one provider
   session under cancellation/deadline control. Opening failure ends the admitted
   run with zero turns. Authentication preparation remains the provider's concern.
2. Install a close-on-drop guard owning the control Arc as soon as open succeeds.
   On every terminal path, call `close()` before attempting `run_finished`. An
   explicit call or guard performs local closure once. This is not remote stop
   confirmation. No reopen, account selection, refresh policy or retry here.
3. Before each turn, check cancel/deadline and the model-request limit. Create a
   fresh turn ID/1-based number; emit `turn_started`. Increment attempted requests
   immediately before polling `generate`. Record the returned receipt separately.
   Initial input is the prompt; every later request contains all and only the
   preceding finalized batch's results, in call order.
4. Drain that request's events, correlate them, and forward them without changing
   their inner schema. Failed event, unexpected EOF/session closure/identity, or
   observer failure stops the run. Never automatically resend an uncertain input.
5. Preserve final outcome and output provenance. Incomplete/failed/provider-
   cancelled responses end the turn/run as `Failed` with a static code. Do not
   execute their calls. Local cancellation is the distinct outcome above.
6. Accept only Message, Reasoning and ordinary FunctionCall item kinds in this
   loop. Other output is preserved as the last response but fails with
   `unsupported_output`. When no calls exist, end the turn and the run Completed.
7. Preflight the **entire** batch through one shared registry mechanism: tool
   allowlist, direct origin, namespace restrictions, completeness/status, JSON and
   per-tool schema, call identity and conflicts, output/cache/count limits. No
   execution, new cached result, or execution-start event occurs on rejected
   preflight. Cache reuse does not excuse invalid authority or contradictory input.
8. Before dispatching any call or replaying any result, require room for a further
   model request to consume the batch and for **all** new tool dispatches. If not,
   end LimitReached with no batch execution. This also applies to all-cached
   batches, because result delivery still needs another model request.
9. Execute accepted calls sequentially in original order. Before each dispatch or
   reuse check cancel/deadline and observer state. Preserve existing tool-error
   conversion and output bounds. Ordinary tool errors become correlated bounded
   results and may be consumed by the model; invalid authority/protocol remains a
   run failure. Do not automatically retry a tool. A tool-start event records the
   dispatch boundary, not proof that an external effect happened.
10. Collect a full result batch; only then can the next turn submit it. Cancellation
    or failure halfway through does not submit partial results or run the remaining
    tools. Already completed effects are not rolled back. Increment new-tool count
    at dispatch; cached replays have their own counter. `tool_execution_finished`
    means an actual local result exists, not that the provider received it.
11. Emit one `turn_finished` for each started turn when the observer is healthy,
    after its full batch or stop reason, then loop or finalize. On controlled
    terminal paths record one terminal RunResult and attempt one `run_finished`.
    Never emit more turns/tools after terminal selection.

The existing `execute_response` must use the same preflight and execution engine
as the controller. Add crate-private prepared-batch and one-call execution methods
as needed; do not maintain two validation implementations. Its legacy wrapper
uses default uncancelled execution and existing event payloads. New run execution
passes stop checks/fallible observation so a sink failure cannot be ignored while
later tools run. Keep cache replay at capacity working; conflict detection precedes
execution. Keep the eight-call batch cap.

## 7. Cancellation, errors and event delivery

Use cooperative cancellation and Tokio monotonic time, not wall-clock timestamps.
At explicit boundaries check cancellation first, then deadline, then proceed.
Use biased cancellation/deadline selection when waiting for provider or tool
futures; if both are ready, local cancellation wins. Terminal outcome is selected
once. Cancellation after a completed terminal selection does not rewrite it.
Drop an active tool future on cancellation/deadline; no detached tool task and no
fabricated finish result. Tools are trusted async application code, required to
yield and tolerate cancellation. Blocking code or already-issued side effects
cannot be forcibly undone by this controller. Tests use pure or cooperative fake
tools; no stronger sandbox/exactly-once claims.

When no generation has started, summary last-upstream is None; a stopped turn
before its generate call is not_submitted. OAuth traffic is a separate concern. After receipt or an interrupted generate await,
use unknown unless an authoritative event establishes otherwise. Preserve the
exact reported outcome on `request_failed`. A valid terminal followed by local
failure is terminal_received. Direct pre-admission generate rejection is
not_submitted under the current SessionControl contract. Never infer acceptance
from request receipt alone or non-execution from a closed connection.

No new queue exists inside the controller. The observer is a passive synchronous
callback and must return promptly. A caller forwarding to its own bounded channel
uses nonblocking `try_send`; map Full/Closed/other output errors to `RunSinkError`
`Full`/`Closed`/`Failed`. Do not block or retry a full sink. Stop on its first error,
close the provider session and never call that failed sink again. A sink failure
before run finalization selects Failed with a static sink code. A failure while
emitting the final run_finished does not rewrite the already selected execution
outcome: set RunResult.events_complete=false and sink_error, emit no second final
event, and require the CLI to report delivery failure. The returned RunResult is
the authority on delivery; an observer may partially consume an event before
returning an error. Healthy execution/delivery returns events_complete=true and
sink_error=None. Controlled cancellation/deadline normally
emit terminal events if the sink still accepts them. A failed sink, caller dropping
the run future, process loss, or panic cannot guarantee terminal event delivery.
Drop cleanup still requests local closure when a control handle exists. During
cancelled session opening, existing provider/auth cleanup owns its resources;
Wi's durable credential-rotation worker must not be changed or forcibly aborted.

## 8. Run event contract (new outer schema, inner v1 unchanged)

`RunEventEnvelope` has `schema_version:1`, local `sequence` starting at 1,
`event_id`, `run_id`, optional `turn_id`, optional `session_id`, optional
`request_id`, and a flattened `RunEvent`. IDs are opaque; generate with existing
UUID support. Sequence counts attempted emissions; a failed sink ends delivery.
It is not a replay cursor. Never overwrite inner provider IDs/sequences.

| Serialized type | Payload and placement |
|---|---|
| `run_started` | Limits; serialize deadline as `{secs, nanos}`. Before open, so session/request/turn IDs are null. |
| `turn_started` | 1-based number; established session and new turn ID, request ID null until receipt. |
| `provider_event` | An unchanged nested `EventEnvelope`; outer IDs correlate the current run/turn. |
| `tool_event` | Existing nested `ToolExecutionEvent`; outer request ID is the model response that produced the call. |
| `turn_finished` | Number, optional response ID, outcome and upstream assessment; local failure has no invented ID. |
| `run_finished` | RunOutcome and RunSummary; outer turn ID null, terminal result applies to the run. |

These are four new lifecycle kinds and two wrappers. TurnOutcome is
`ModelCompleted`, `ToolsPrepared`, or `Stopped { reason: RunOutcome }`.
A ToolsPrepared turn is not proof of next-request submission. For each received
provider event set the outer request ID from the validated envelope; receipts
and the next turn's request events establish later delivery. Do not add a misleading
`tool_result_delivered` event, transcript/message events, or Pi name aliases.

RunStarted/Finished are observed runtime transitions, not fabricated provider
messages. Keep outcome, provenance, summaries and native payloads in RunResult;
do not retain an unbounded run transcript. Native values/prompts/deltas are
sensitive. Derived Debug on new types containing those values must be redacted.
Errors/reports use static codes. JSON streaming is explicitly sensitive application
data, not safe telemetry. CLI rendering never reconstructs authoritative output
from argument fragments and filters terminal-control characters.

## 9. CLI, tests and documentation

Add `wi run` with existing model/transport/JSON/auth-source/account/auth-file
arguments and current validation. Do not change defaults for old commands.
New command also retains the current external-source default; managed auth requires
explicit `--auth-source gateway`. Reuse the real managed provider path unchanged.
New options: `--prompt` xor `--stdin` (one required), `--instructions`, optional
repeatable `--tool add_numbers` (only one unique tool currently; reject duplicates),
`--max-model-requests` default 4, `--max-tool-executions` default 8,
`--deadline-seconds` default 120. No follow-up/resume/steer option. CLI validates
arguments/limits before provider construction/auth metadata is read. It renders
through the observer, not another loop. Ctrl+C signals the run's token and awaits
its controlled result; do not simply abandon the run future as the normal path.

JSON mode emits RunEventEnvelope NDJSON only on stdout; safe diagnostics/profile
alias remain stderr. Plain mode may display filtered provisional text and an
identified authoritative final response; it must not falsely mark partial text
successful. Completed exits 0 (including a model refusal, not a correctness
claim), local cancellation 130, all other outcomes/startup errors 1.
A sink error takes exit-code precedence and exits 1 even if the execution outcome
was already Completed. Broken output stops the run without further tool/provider
work. Reuse existing input-size checks. Keep old command/output schemas and fixed smoke oracles.

Add `examples/run_offline.rs`: a scripted independent provider causes two pure
addition cycles (17+25=42; 42+8=50), then final 50. It uses the real library loop and
registry, no credentials/network. Cargo dependency downloads are not live tests.
Use deterministic barriers/oneshots and paused Tokio time where useful, not
wall-clock races or flaky sleeps. Fake providers record exact inputs/opencount;
loopback adapters prove the real transport still follows the same controller.

Add the new contract to active docs only after implementation. Correct EVENTS'
stale statement to: explicit renewal has live L1 evidence; automatic expiry and
failure paths have offline evidence. Preserve the historical reports, manifests,
combined report and 27/40 ledger. Fill [WI_RUN_VERIFICATION.md](WI_RUN_VERIFICATION.md)
and [wi-run-verification.json](wi-run-verification.json) with actual new evidence.
All matrix rows start NOT RUN. Do not confuse authored tests with executed tests,
Node runner tests with Rust tests, CI with local execution, or mocks with live.

## 10. Execution order and stopping conditions

Implement in this order: baseline gate -> adapter consistency extraction with
regressions -> shared registry preflight/fresh scope -> controller and events ->
scripted matrix -> thin CLI and loopback matrix -> final gates -> independent
review -> report. Briefly state progress, but do not ask the implementor to design
another architecture or stop after writing a plan.

Pause only the affected work for a true contract conflict or missing permission;
record the conflict, evidence, and smallest proposed adjustment. Continue unrelated
offline checks. Do not relax a negative test, broaden scope, upgrade dependencies,
read credentials, or use old live budgets to resolve a blocker. Do not commit or
push implementation without a separate user instruction.

Required gates: `cargo fmt --all -- --check`, `cargo check --all-targets`,
`cargo test --all-targets`, `cargo clippy --all-targets -- -D warnings`,
`cargo build --all-targets`, `cargo test --doc`,
`node scripts/cli_retest.mjs --self-test`, `cargo run --example run_offline`,
and `git diff --check`. Run baseline/final `uv run scripts/verify.py` if available;
its six Cargo checks do not replace the runner/example checks. No test-count quota.
Zero doctests is reported as zero, not coverage. Preserve 187/152 as historical
baseline counts; report actual current counts, platforms, ignored and blocked tests.

A fresh local implementor conversation is recommended, not a new repository or
login. One implementor plus an independent offline reviewer is enough. The reviewer
checks matrix evidence, invariant preservation, and changed-file scope. Do not
fake reviewer sign-off if none is available; mark that gate BLOCKED.

M3 closes as **OFFLINE ACCEPTED; LIVE NOT AUTHORIZED/NOT RUN** only when every
required matrix row and final review pass. There is no automatic next phase.
Optional future RL1/RL2 require a separate user instruction: at most two generations
per transport for one run-controller tool cycle, no retries. Do not implement or
execute that live runner now, reset the ledger, repeat auth tests, or claim the
old smoke matrix tested M3.
