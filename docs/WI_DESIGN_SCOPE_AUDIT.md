# Wi: focused design-provenance review

Prepared 2026-09-10. Runtime inspected at `640b221b70dbb4d68704e6fa70d12f9533654cf5`;
prior planning PR at `86a2c1f80f6b0cccd5b7b9cd45720029548d5aae`.
This is a focused source/design review, not an exhaustive code audit, benchmark,
security certification, or proof that every remaining feature is necessary.

## Direct answer about RunLimits

The designer introduced the 4-request/8-execution/120-second product defaults.
No measured improvement or requirement for this user's workflow justified them.
They can make fixed tests stop, but external test supervision does not require a
production configuration API. C1.0 retained that unnecessary API as optional and
added a resource-accounting subsystem; both choices are now withdrawn. C1.1 deletes
the feature rather than explaining hypothetical future uses as current value.

The supplied Pi and Codex reports distinguish global execution, per-tool timing,
and provider transport controls. Their description of optional Codex budgets is
not authority to add such a capability to Wi without a user requirement. We make
no claim about user counts/popularity; those facts are unnecessary to this decision.

## Findings and disposition

| Item | Evidence / origin | Actual purpose and cost | Disposition |
|---|---|---|---|
| RunLimits, flags, global timers and quota outcomes | src/run/mod.rs; src/run_cli.rs; designer's M3 contract | Stops otherwise valid tasks by count/elapsed time; adds config, validation, branches, serialization, and tests. No demonstrated Wi workflow need. | DELETE entirely in C1.1. |
| Eight-call batch gate | src/tools.rs preflight; inherited designer-generated demo | Refuses the ninth valid call even when its payload fits. Not established as a Pi/Codex/provider requirement. | DELETE; respect existing input compatibility instead. |
| 128-entry result-cache gate | src/tools.rs preflight | Stops new calls by a lifetime entry count. Result reuse itself prevents repeated execution of the same call; the fixed entry ceiling is a separate restriction. | DELETE count gate; retain identity safety. Do not add c1.0 cache-budget machinery. |
| Optional budgets, byte reservations, generic timeout/progress extension | c1.0 plan and earlier M4 proposal, not accepted runtime | Additional speculative surface, not a demonstrated requirement. | WITHDRAW; not to be implemented. |
| 32 declared tools / 128 input items | src/provider.rs MAX_TOOLS and validate_input | Wi-local request/configuration shape restrictions. Exact values are not established provider limits or benchmarked needs. They can reject valid future workloads. | DISCLOSE; not removed silently in a run-policy deletion. |
| 2048 history items / 8 MiB history | src/providers/openai_codex/state.rs check_history and src/provider.rs | Bounds retained/replayed context in a prototype without compaction. It can still stop a long task; no parity with Pi/Codex compaction is claimed. | DISCLOSE current limitation; no new retention framework in C1.1. |
| Input/argument/output/frame/recovery byte guards | src/provider.rs; tools.rs; wire.rs; consistency/recovery modules | Restrict parsing, retained data and tool-result size. General purpose is concrete, but each exact threshold is a Wi choice, not automatically a provider mandate. | PRESERVE for this scoped change; list exact settings and effects in implementation report. |
| Static advanced-feature capability entries | src/provider.rs Feature and ItemKind | User asked for provider extensibility and later skills/search/PTC/async/steering. Present entries reject unsupported work or preserve native shapes; they are not working advanced features. | Keep boundary; no engines/frameworks authorized. Future dead scaffolding should be identified, not justified solely as future-proofing. |
| Run lifecycle, correlation, validation, cancellation | accepted M3 contract and source | Actual controller ownership, ordered observation, rejection of invalid calls, and stopping requested by user. Independent of quotas. | PRESERVE; do not throw away the useful controller. |
| Smoke/demo commands and structural observer | gateway verification work and reports | Acceptance instrumentation, not user-task policy. Adds maintenance cost and should remain visibly separate from generic execution. | Keep existing oracles for regressions; no silent test constraints in normal run. |
| Multi-account Wi auth, selection and renewal | separately authorized WI_AUTH_MATRIX and combined report | User-approved milestone, not an unrequested feature attributed to the run-limit designer. | PRESERVE; no auth redesign or new live test. |
| No automatic retry/reconnect/fallback; fixed session identity | explicitly stated gateway/M3 contracts | Avoid ambiguous resubmission/account changes; also lacks some Pi/Codex recovery behavior. These are visible behavior differences, not proof of identical harnesses. | PRESERVE accepted scope; disclose, do not silently add recovery. |

## What this review does not establish

The list does not prove that no other unnecessary abstraction, dead path, or
poorly chosen constant exists. Source inspected covers the current planning files,
provider contracts, run/tool paths already reviewed in this conversation, provider
history, and transport guards. It is not a line-by-line review of all auth, tests,
helpers, and retained files. A complete usefulness audit would require tracing
callers and requirements across the repository. Do not claim that work was done.

The implementor's final C1 report must list any further observed questionable
surface with file/symbol, who requested it if known, actual caller/use, runtime
cost, and a specific recommendation. Unknown origin stays unknown. Do not invent
provenance or delete unrelated security/compatibility behavior without authority.

Removing the run feature does not remove all constraints. Retained history/input
bounds, provider inactivity/connection behavior, credential expiry, cancellation,
errors, and OS resources still exist. Result-cache memory grows within the run;
there is no universal memory bound for arbitrary provider plugins and no durable
exactly-once claim. This limitation must remain visible rather than be 'solved'
by quietly adding another budgeting subsystem.
