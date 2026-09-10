# Wi C1: correct default execution policy

Status: PLAN ONLY; implementation and verification NOT RUN. Contract: `c1.0`.
Prepared 2026-09-10. Runtime baseline: `640b221b70dbb4d68704e6fa70d12f9533654cf5`.

This is a correction to selected M3 policies, not M4 or a replacement harness.
The designer fixes the contract here and the acceptance matrix in
[WI_EXECUTION_POLICY_C1_MATRIX.md](WI_EXECUTION_POLICY_C1_MATRIX.md).
The implementor executes [the prompt](WI_EXECUTION_POLICY_C1_PROMPT.md); it must
not commission another architecture-planning pass or silently substitute policies.
A genuine contradiction is a scoped blocker to report, not permission to weaken
validation or change unrelated features.

## 1. Source basis and accountability

The user supplied two read-only source-investigation reports: **Pi Interactive
Prompt Flow and Execution Limits** and **Codex Interactive Prompt Flow and Execution
Limits**. Their source-derived conclusion is no fixed global tool-call quota, no
fixed global model-iteration quota, and no absolute interactive prompt/user-turn
deadline by default. Component timeouts, retries, cancellation, errors, usage
restrictions and explicitly configured policies remain separate.

The Pi report describes an optional Bash `timeout` argument with no default;
the model can request it and the executor enforces it. Other tools can differ.
The Codex report separates a user turn, logical sampling request, tool call,
stream retry and physical attempt. Its values 4, 8 and 120 refer respectively to
HTTP retries and the target-count/wait-time controls of `wait_threads`, not a
whole-task 4-request/8-tool/120-second policy. Its one-shot and interactive command
execution paths have different timeout semantics. Do not turn either report into
a claim of no timeouts anywhere, unlimited memory, or universal model control of
all timers. These findings come from the supplied reports, not new runtime tests
performed for this planning change.

Wi's 4 requests, 8 new executions, 120-second default and 600-second maximum were
designer-selected M3 product policies, not Pi/Codex requirements. The implementor
correctly implemented the supplied contract; M3's accepted evidence remains valid
for that contract. The design correction must not rewrite past results.

Inspected baseline code anchors:
- `src/run/mod.rs`: mandatory numeric RunLimits, Default/validate, a single absolute
  Instant, global count checks and statistics.
- `src/run_cli.rs`: defaulted count/time flags and 32/128/600 upper ranges.
- `src/tools.rs`: unrelated legacy eight-call batch and 128-entry cache guards.
- `src/provider.rs`: input/config/history and protocol-size protections.
- `docs/WI_RUN_VERIFICATION.md` and `docs/wi-run-verification.json`: accepted M3,
  244 Rust tests, 152 Node self-tests, separately authorized RL1/RL2 and 31/50 ledger.

Only the first paragraph's reference behavior is source-derived. The precise Rust
representation, migration and resource-accounting choices below are explicitly Wi
adaptations selected by this corrective plan. They are not claimed as copied
Pi/Codex designs.

## 2. Objective, authorization and non-goals

Normal `wi run` must not stop merely because it made its fourth model request,
eighth tool execution, passed 120 seconds, or crossed a larger arbitrary replacement
number. It continues supported sequential model/tool work until normal terminal
disposition, user cancellation, a real error/resource restriction, or a budget
explicitly selected by the caller. No claim of infinite practical runtime follows.

Keep the reusable M3 controller, one-session ownership, profile pinning, event
correlation, full-batch preflight, effective-output recovery, local cancellation,
result isolation and fail-closed execution. Keep tool and provider responsibilities
separate. No new tool API, universal tool timeout, progress feature, shell/file
executor, parallel/async work, steering, skills/search/PTC, GUI/server, persistence,
compaction, reconnect, retry, failover, model or authentication change is included.
The earlier proposed M4 per-tool/progress/one-hour policy is NOT this task.

This planning PR changes documentation only. When the user supplies the implementor
prompt, permitted work is the specified code/tests/docs and offline verification.
No real auth-file reads, profile listing/status, login, refresh experiments, model
requests, commits, pushes or releases are authorized by that prompt. Ordinary
trusted build dependency activity follows existing local permissions. Use isolated
synthetic credential locations and loopback endpoints for tests. Pi's authoring
conversation is not a Wi verification request. Keep the cumulative ledger at
31/50 used, 19 remaining; unused budget grants no additional authorization.

## 3. Optional run policies: normative contract

Keep the names `RunLimits`, `RunRequest.limits` and existing CLI flags to minimize
migration; make each field independently optional:

```rust
pub struct RunLimits {
    pub max_model_requests: Option<u64>,
    pub max_tool_executions: Option<u64>,
    pub deadline: Option<std::time::Duration>,
}
```

`Default` is None/None/None. Missing limits/fields and JSON null deserialize as
None, without consulting old numeric defaults. Some(value) is an explicit local
caller policy. A serialized old numeric limit or Duration value deserializes into
Some(value), retaining that explicitly supplied policy; do not silently discard it.
There is no zero/unlimited sentinel, preset selector, environment fallback,
mandatory test profile, or very-large-number substitute for None.

| Field | Omitted/None | Explicit values |
|---|---|---|
| max_model_requests | No configured global request quota | 1..=u64::MAX; zero rejected |
| max_tool_executions | No configured global new-dispatch quota | 0..=u64::MAX; zero means no new tools |
| deadline | No run-level timer | Positive Duration representable as an Instant offset at admission; zero/overflow rejected |

Remove the old 32/128/600 policy maxima, not replace them with 3600 or other arbitrary
maxima. Representation overflow is a technical invalid input, not a chosen product
quota. With Some(deadline), calculate one absolute monotonic Instant using checked
addition after normal admission validation. With None, do not construct a timer.
Keep the cancellation branch active either way. No per-turn reset or activity-based
extension of an explicit deadline. Preserve cancellation ordering and the accepted
terminal-completion-versus-late-cancellation behavior from M3.

Explicit model/tool budgets retain M3 semantics: count attempted generate polls,
separately record receipts, count new dispatches (including errors), and do not
charge cached result reuse as a new execution. Before any batch dispatch or reuse,
require another model request only if a model-request quota is configured, and
compare total new dispatches only if a tool quota is configured. Full-batch rejection
must precede work; do not execute the portion fitting a budget. No retry or partial
result submission is added. LimitReached(ModelRequests/ToolExecutions/Deadline)
can occur only for a configured policy of that kind.

Counters and turn numbers become u64 with checked increments/conversions. Avoid
wrap, saturation used as silent accounting, narrowing casts, or using a counter's
presence as a default quota. Artificially seeded overflow tests may return a static
`counter_overflow` failure; this is not a normal operational call cap. Preserve
last_response, provenance, upstream uncertainty, sink behavior and cleanup.

## 4. Tool-specific timing stays tool-specific

Do not add `--tool-timeout-seconds`, a default timeout around every tool, or an
execution context/progress API in C1. The existing Tool interface can represent
cooperative work and can implement a tool's own optional timeout in its schema.
The only shipped tool remains add_numbers and gains no irrelevant timeout field.

Use a synthetic test-only tool to demonstrate this distinction: its optional
`timeout_ms` argument is interpreted inside that tool. With the field omitted,
waiting continues until test release or user cancellation; there is no controller
tool timer. With a value present and the tool's timer expiring, the tool returns
its ordinary error/result, which may be sent back to the model. That is different
from an explicitly configured run deadline stopping the whole run. No process
execution, actual long sleeps, detached tasks or live provider calls are needed.

None means no whole-run timer, not guaranteed survival. Existing per-request
network timeouts, provider/session closure and credential-expiry semantics remain
unchanged. Blocking tools/observers cannot be forcibly preempted by this controller;
cooperative cancellation cannot undo external effects. Preserve those limitations.

## 5. Remove hidden count quotas without removing resource protection

Changing RunLimits alone would leave a 128-new-call stopping point in the registry.
Do not describe that result as removing fixed global execution quotas. Also remove
the unexplained eight-call demonstration batch ceiling from the shared executor.

### 5.1 Batch input capacity

No special eight-call policy remains. Batches still must fit existing protocol/input
capacity. Extract the existing 128-item value used by validate_input into a named
shared constant if necessary; use that existing per-request capacity before batch
work. This is a request-shape limit, not a count across the run. Preserve other
input byte bounds and whole-batch validation. Nine small valid calls must work.

Validate the complete result vector against existing input-shape/byte rules before
submission. Some result sizes are only known after execution; if they exceed those
rules, stop with a static resource/input error, do not send a subset, and do not
claim completed effects were rolled back. Do not expand provider payload limits or
implement result chunking merely to accommodate a larger batch.

### 5.2 Cache retention

Replace the 128-entry quota with a retained-payload resource bound using Wi's
existing `MAX_HISTORY_BYTES` magnitude (8 MiB), exposed internally as
`MAX_TOOL_CACHE_BYTES`. This is a deliberately retained Wi memory safeguard, NOT
a Pi/Codex default, a new global action allowance, or an exact allocator/RSS cap.
Cache and conversation history are separate pools; do not claim a combined 8 MiB
process limit. There is no new public knob in C1.

Account the canonical serialized cache record containing call ID, name, parsed
arguments and output string. Use bounded/counting serialization rather than
unbounded temporary copies. Before the first call in a batch, preflight existing
occupancy plus a conservative reservation for every new record, including its
known key/argument metadata and the existing maximum output-string size (64 KiB)
after JSON escaping. The reservation can use serialized empty-output record size
plus six times the maximum output bytes; this is a conservative JSON-size bound,
not new output entitlement. Retain the existing oversized-output conversion.

Reserve the whole batch before execution, commit actual serialized size as each
result is cached, and release unused reservation. Cached reuse needs no new record
space. On cancellation/error release unused reservation, retain already prepared
results, and preserve no-rollback semantics. Existing scope borrowing can keep
reservation local; do not add another worker or generic memory framework.

If insufficient storage remains, fail before new execution/reuse notifications
with a static resource category such as `tool_cache_capacity`, NOT
LimitReached(ToolExecutions). Never evict an old result and later rerun the same
call as new, omit identity-conflict checking, or grow unbounded storage. No
compaction or durable cache is added. Tests may inject a tiny capacity under
cfg(test), not through production endpoint/config overrides.

This allows more than 128 small results but can still reject a smaller number of
large results. Document that distinction. No numerical execution-policy parity
claim is made for Wi's memory/request limits. A later resource-lifetime design is
separate from C1 and not authorized here.

## 6. Events, serialization and CLI migration

Keep event names, result outcomes, ID relationships, provider contracts and nested
ProviderEvent schema unchanged. Because RunStarted.limits now permits null and run
statistics widen, emit outer RunEventEnvelope schema_version **2** for the new
controller. Do not pretend old strict schema1 readers accept it. Provider envelopes
nested within it remain their existing version1. No fake agent/message/steering
events are added. Record this focused breaking Rust/outer-event change explicitly;
keep package name, version0.2.0, transport and client identity unchanged.

Retain JSON field names. Emit all three limits, each null or its explicit value;
Duration keeps its existing {secs,nanos} shape when present. Deserialize old concrete
policies as explicit Some values; null/omitted as None. No v1 emitter or compatibility
mode is required. Update new fixtures, consumers and docs; preserve historical M3
reports and schema1 recordings without rewriting them.

For `wi run`, flags remain optional value-bearing arguments with NO defaults:
`--max-model-requests`, `--max-tool-executions`, `--deadline-seconds`.
Missing means None; deadline CLI accepts positive whole seconds that pass checked
Instant addition. Negative, malformed, zero model/deadline and representation-
overflow values fail before auth/open. Explicit tool zero remains valid. Do not
change old generate/tool-demo/smoke commands, auth-source defaults, tool opt-in,
exit codes, plaintext filtering or JSON sensitivity warnings.

No new `--unlimited`, profile, interactive UI, or execute-everything shortcut is
needed. A normal `wi run` without budget flags simply has no run-level budget.
Only explicitly bounded tests/host applications select budgets. Do not call None
'infinite guaranteed execution' in help or documentation.

## 7. Test controls are not runtime defaults

Preserve existing M3 bounded-policy tests by specifying Some limits explicitly.
Do not delete their security/cancellation/sink assertions or rewrite historical
passes. Add a test-only helper for the former 4/8/120 values if useful; never call
that helper from production defaults, CLI, environment or provider selection.

All synthetic sequences terminate deterministically or use an explicit test
cancellation/barrier. A test supervisor may have its own watchdog, clearly outside
Wi runtime policy. Long-time tests use paused Tokio time with deliberate barriers,
not real sleeps or numerical time estimates. Advance logical time past 120, 600
and 3600 seconds to prove absence of the old/global timer; this adds no one-hour
runtime requirement. Ensure a paused clock cannot auto-advance past the intended
observation before the test establishes its barrier.

A finite scripted workload of 160 tiny new calls and a final answer must finish
under defaults (161 model requests), with correct correlation, one session, no
cache eviction/reexecution, and resource use below existing storage/input limits.
This demonstrates crossing 4/8/32/128, not mathematical infinite execution.

No live test is required to accept C1 offline. None is authorized. Old RL1/RL2
passes are baseline evidence, not proof of the new policy. Keep the31/50 ledger
unchanged. Do not run an unbudgeted live command to test the absence of limits.

## 8. Allowed changes and implementation sequence

1. Inspect actual HEAD/worktree and read current accepted reports. Preserve user
   changes. Run isolated baseline gates and record results, not presumed counts.
2. Add regressions for optional defaults, crossing prior caps, no-timer behavior,
   explicit policies, hidden registry quotas and migration. Record actual failures
   against the old behavior before fixing; do not fabricate red transcripts.
3. Change RunLimits/summary/turn number handling in src/run/, CLI option plumbing
   in src/run_cli.rs, and optional cancellation/deadline helpers. Preserve M3
   admission/cleanup/terminal/sink semantics.
4. Adjust the shared registry's batch/cache resource accounting in src/tools.rs
   and focused tests. Keep the compatibility execute_response wrapper on the same
   preflight/execution engine. src/provider.rs may only name the existing input
   item constant; do not change provider event schema or input capacity.
5. Adapt old explicit-budget test callers, add independent scripted cases and
   WS/SSE loopback integration, update examples and active docs. Existing smoke
   oracles remain fixed. No production auth/wire/codec/state changes are authorized;
   a regression requiring them is a scoped blocker, not a rewrite opportunity.
6. Run all gates, obtain one independent complete-diff review, repair confirmed
   in-scope findings and rerun affected/full gates. The reviewer does not redesign
   the plan. Report a real contract contradiction rather than silently improvising.
7. Create the new C1 reports and stop. Do not commit, push or publish implementation
   changes without separate instruction.

No new dependencies should be necessary. Preserve Cargo.lock; existing Tokio test-
util can support paused-time tests. Test wiring changes are allowed; do not alter
existing production connection limits or auth/renewal to make long tests pass.

## 9. Verification and deliverables

Read [the required matrix](WI_EXECUTION_POLICY_C1_MATRIX.md). Every row starts
NOT RUN. Evidence must name actual commands/tests, observed results and exact
assertions; authored tests and mock successes are not live proof. Baseline report
counts are 244 Rust and152 Node tests, not a minimum target for this correction.
Account for migrated/table-driven/platform tests and report actual totals.

Run: cargo fmt --all -- --check; cargo check --all-targets;
cargo test --all-targets; cargo clippy --all-targets -- -D warnings;
cargo build --all-targets; cargo test --doc;
uv run scripts/verify.py; node scripts/cli_retest.mjs --self-test;
cargo run --example run_offline; git diff --check.
Use isolated HOME/XDG_CONFIG_HOME/CODEX_HOME and trusted existing toolchain caches,
as in M3. No credential commands belong to an offline gate. A missing toolchain
or genuine environment blocker is a recorded blocker, not a passed check.

Update active README/ARCHITECTURE/EVENTS/CHANGELOG and public API/examples for the
new default/explicit-policy distinction, schema2 and resource restrictions.
Preserve historical M3 contracts, verification, old manifests and previous ledgers.
Mark that C1 supersedes only the stated policy/range/schema expectations, not the
accepted safety behavior or the truth of prior M3 evidence.

Create `docs/WI_EXECUTION_POLICY_C1_VERIFICATION.md` and
`docs/wi-execution-policy-c1-verification.json` after work. Include baseline/actual
implementation revision or dirty diff, contract c1.0, all C1 row statuses, actual
commands/counts, fixes, compatibility/resource changes, independent review, remaining
limits, `live_tested:false`, and unchanged ledger used31/cap50/remaining19. Keep
current status unambiguous rather than mixing it with historical root failure fields.
Until execution occurs, no PASS or accepted flag is justified.

Strongest authorized verdict: **C1 offline accepted; default global quotas/deadline
removed; optional budgets and resource protections verified; no new live evidence.**
