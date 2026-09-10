# Wi C1: delete the run-limit feature

Status: PLAN ONLY; implementation and verification NOT RUN. Contract: `c1.1`.
Prepared 2026-09-10. Runtime baseline: `640b221b70dbb4d68704e6fa70d12f9533654cf5`.

**The user requires removal, not optional configuration. This revision replaces c1.0 in full. Do not implement its Option-based RunLimits, optional CLI budgets, or replacement cache-budget machinery.**

Read [the matrix](WI_EXECUTION_POLICY_C1_MATRIX.md), then [the implementor prompt](WI_EXECUTION_POLICY_C1_PROMPT.md). The implementation decisions below are fixed. Private helpers remain the implementor's responsibility; a genuine contradiction must be reported, not used to reintroduce policy.

## 1. Purpose and source basis

The supplied reports, *Pi Interactive Prompt Flow and Execution Limits* and *Codex Interactive Prompt Flow and Execution Limits*, distinguish an interactive task from individual provider attempts, retries, and tool operations. They do not establish a mandatory global model-call count, tool-call count, or whole-task deadline. Pi's Bash timeout is optional per call, with no default. Codex's reported optional budgets and component timeouts are not requirements to implement such a feature in Wi.

The designer introduced Wi's 4-request, 8-execution, and 120-second defaults and their upper bounds. No demonstrated requirement or improvement for the user's workflow justified them. Tests can be supervised outside the product. The earlier attempt to preserve the feature as optional budgets failed to follow the user's requested simplification.

M3 correctly implemented its then-governing contract. Preserve its historical tests/results as history; do not pretend this correction was already verified. Preserve M3's reusable orchestration, event correlation, cancellation, validation, and provider separation. Remove the unnecessary limit feature and its dependent code rather than rename it.

## 2. Exact deletions and resulting contract

Delete from active implementation:

- `RunLimits`, its Default/validate/serde implementations, exports, helpers, and constructors.
- `RunRequest.limits` and every configuration/serialization path supplying it.
- `RunOutcome::LimitReached`, `LimitKind`, and run-budget-specific errors/branches.
- Run-level deadline creation, Instant/Duration plumbing used only for this feature, deadline checkpoints, deadline races, and budget preflight.
- `--max-model-requests`, `--max-tool-executions`, and `--deadline-seconds`, including help, defaults, ranges, and aliases.
- Limit payloads in `run_started`, CLI display, results, and examples.
- Tests whose sole assertion is that the removed product policy stops work. Retain and adapt their independent validation/cancellation/sink coverage.

Do NOT leave any Option<RunLimits>, empty RunLimits, optional fields, disabled-by-default policy module, feature flag, preset, environment/config fallback, unlimited sentinel, alternate budget type, generic stop-policy framework, or public compatibility wrapper for the deleted feature. Do not replace it with a universal tool timeout or cache-budget feature.

The public request contains exactly the existing task fields:

```rust
pub struct RunRequest {
    pub provider_id: String,
    pub options: SessionOptions,
    pub prompt: String,
}
```

Keep the existing `wi::run::run(gateway, request, tools, cancel, emit)` operation. There is no run-policy argument. Keep one provider session per run and a fresh tool-result scope. The loop ends on normal response disposition, user cancellation, or a real provider/protocol/tool/resource/delivery failure. No total request count, total execution count, or elapsed-time policy stops it.

`RunOutcome` retains `Completed`, `Failed { code }`, and `CancelledLocally`. Existing summary counters remain observations, not execution permissions. They are useful for lifecycle evidence and debugging, not reasons to impose quotas. Use checked arithmetic (u64 where needed) instead of wrapping; numeric representation failure is a static arithmetic error, not a configurable execution budget. Remove `PreparedBatch.new_executions` if its only remaining purpose was advance quota checking; actual dispatch/reuse observations already supply statistics.

## 3. Cancellation and terminal behavior

Remove the controller's timer, not its stop mechanism. Every previous cancellation checkpoint and cancellation-aware await remains cancellation-aware. Waiting with no deadline must await the work or cancellation, not an extremely distant timer. Tools and observers still must cooperate; the controller cannot forcibly preempt blocking code, undo effects, or guarantee upstream termination.

Preserve the accepted terminal-observer race fix: a validated completed no-call response whose disposition is selected is not rewritten by a later cancellation. Call-bearing work must still check cancellation before dispatch. Close the owned provider session on controlled termination and drop. Do not introduce detached execution or a background worker.

Preserve fallible observation, event correlation, full-batch validation, uncertainty categories, and final-delivery-versus-execution distinction. Do not turn a broken event consumer into a successful run. Future drop, panic, and process loss still cannot guarantee a terminal event.

Tool-specific timeout behavior belongs to that tool. The generic Tool trait and shipped add_numbers tool receive no new timeout/context/progress API. A test-only cooperative tool may accept its own optional timeout argument; an elapsed tool-owned timer produces that tool's ordinary error/result. This is not a run deadline.

## 4. Remove demonstration count gates; do not replace them with new features

`src/tools.rs` also contains designer-added `calls.len() > 8` and a 128-entry result-cache count gate. Remove both. Retain full-batch validation, call identity/conflict checking, same-run result reuse, and fresh-run isolation. Nine small valid calls in one response and more than 128 small distinct calls across a run must not be rejected by those deleted demonstration quotas.

The existing input path permits at most 128 input items per request. That is another Wi-local choice, not asserted provider law. C1 does not change the provider input format or implement result chunking. Reuse/name that existing input capacity to reject a batch whose result vector cannot fit before executing it; validate the actual complete result vector's existing byte/shape rules before submission. Never send a subset or claim already completed effects were rolled back. This is a per-request compatibility check, not a lifetime tool-call allowance.

Keep the existing result cache and its lifetime. Do not add c1.0's new byte reservation/commit/release subsystem, a cache budget knob, eviction, persistence, a deduplication service, or a replacement count ceiling. Cached results must not be evicted and then silently reexecuted under the same identity. Retained results grow during a run and are released with its scope. Report this resource limitation honestly: existing provider-history guards are not a proof of bounded cache/RSS for every possible provider. C1 is not a long-lived storage solution.

Preserve existing per-input, argument, output, frame, recovery, and history guards, credential protection, and request/network timeouts. Their exact numeric settings are Wi choices that require disclosure; they are not automatically required by Pi/Codex. This deletion task is not authorization to remove unrelated parsing protections or design replacements. [The scope audit](WI_DESIGN_SCOPE_AUDIT.md) identifies remaining choices and their purposes.

## 5. CLI, events, and migration

The new `wi run` interface has no count/deadline options. Supplying any removed flag is an ordinary unknown-argument error before provider construction or credential access; never silently ignore it. Preserve auth-source/tool-selection/model/transport/input flags and existing exit semantics. No new CLI option replaces the deleted ones.

`RunStarted` becomes a payload-free lifecycle event: `{ "type": "run_started", ...envelope fields... }`. No `limits` or `budget` object is emitted. Retain the four lifecycle event kinds and provider/tool wrappers. Emit outer run-event schema 2 because the payload/outcome contract changed; leave nested provider-event schema 1 untouched. Do not build a schema-1 compatibility emitter or optional-budget decoder.

Treat removal as a breaking Rust/run-event API change, not a product-version or client-identity change. `RunRequest` deserialization rejects obsolete fields such as `limits`, including null, rather than silently pretending to honor them; use strict request-field decoding. Historical schema-1 recordings/reports remain unmodified. New run results must not generate or accept removed limit outcomes. Update active consumers/tests/examples; do not require legacy configuration to continue working with deleted options.

## 6. Change scope and sequence

1. Inspect actual HEAD/worktree. Record baseline gates, preserve user changes, and read current M3/auth evidence. Later documentation commits are expected.
2. Add/adjust tests for actual removal and behavior beyond the old thresholds. Record observed failures, not invented red transcripts.
3. Remove the types, flags, timer/quota control flow, outcome variants, and dependent glue in `src/run/`, `src/run_cli.rs`, exports, and actual callers.
4. Remove the two demonstration count gates in `src/tools.rs` and quota-only prepared-batch bookkeeping. Preserve the shared validation/execution engine. `src/provider.rs` may name the existing input-item capacity for reuse; no provider schema/capacity expansion.
5. Update tests, `examples/run_offline.rs`, active README/architecture/events docs, and test/smoke helpers that constructed RunLimits. Fixed-case tools and expected-answer assertions remain test oracles, not generic runtime checks.
6. Verify the deletion with active-source searches and all gates. Obtain one independent complete-diff review against the concrete matrix; fix confirmed in-scope issues.
7. Create the new C1 verification reports and stop without an implementation commit or push unless separately authorized.

No auth, OAuth registration, profile policy, network timeout, retry/fallback, recovery algorithm, new provider, tool execution model, or connection lifecycle redesign. No new runtime dependency or cache framework. Do not add M4, progress, shell/files, steering, skills/search/PTC/async tools, web/server, or durable replay. If a genuine existing defect prevents the specified removal, record it specifically rather than expand scope silently.

## 7. Offline testing and evidence

Tests use finite scripted providers, pure tools, cancellation/release barriers, and paused time. An outer test watchdog may fail a stuck test; it must not be a production run-policy option, exported helper, or environment switch.

Required workload: 160 tiny new calls, one per response, then a final answer: one session, 161 model requests, 160 executions, correlated results, no count stop or eviction. This crosses old 4/8/32/128 thresholds without claiming infinite practical execution. A pending synthetic tool survives logical time beyond 120, 600, and 3600 seconds, then completes on release or stops on cancellation. Actual provider inactivity/session-expiry restrictions remain unchanged and separately tested.

Search active source/callers for remaining RunLimits, LimitKind, LimitReached, removed CLI flags, deadline fields, and renamed budget equivalents. Intentional negative tests and historical documents may name removed symbols; production feature code may not remain. A reviewer checks control flow, not just spelling.

Run the existing six Cargo gates; `uv run scripts/verify.py`; `node scripts/cli_retest.mjs --self-test`; `cargo run --example run_offline`; and `git diff --check`. Use isolated synthetic credential locations with trusted existing development caches. Baseline 244 Rust/152 Node results are historical reference counts, not a required new count: deleting obsolete policy tests may reduce totals. Do not retain useless tests merely to preserve a number or delete other safety assertions to make a gate pass.

Deliver `docs/WI_EXECUTION_POLICY_C1_VERIFICATION.md` and `docs/wi-execution-policy-c1-verification.json`, recording contract c1.1, all matrix rows, actual commands/results, removed code/API, changed tests, independent review, retained constraints, and blockers. Preserve historical M3/older evidence and manifests. No real credential reads or auth commands, provider generations, or live tests are authorized; the ledger remains 31/50 used, 19 remaining. Planning-PR publication does not authorize local implementation publication.
