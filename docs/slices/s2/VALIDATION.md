# S2 documentation-to-source validation and s2.1 amendment

Date: 2026-09-12.
Reviewed planning revision: `737f24c5ff682ee19f9275712f8104166d9907b4` (s2.0).
Compared runtime: `94d86e0c9db62d9fec208a26f5b4bb2487bcb5fa` (accepted S1).
Disposition: **documentation correction, not production error-mapping change**.
The governing version is now **s2.1**. All 24 acceptance IDs remain NOT RUN for S2.

## 1. Scope and evidence limits

The planner reviewed the complete S2 CONTRACT, MATRIX (all 24 rows), implementor
prompt, AGENTS.md routing and documentation-index section against their relevant
implemented library/CLI boundaries. The product-direction requirements and accepted
S1 ownership remain unchanged. This is not a new feature proposal or a blanket
certification of every historical document or every runtime security property.

Evidence is read-only source/test inspection through the repository connector.
No Cargo, Rust, Node, example, live provider, authentication, or private-file
verification was executed by the planner. The local implementor's reported baseline
passes remain attributed to that report; they are not S2 acceptance or new planner
execution evidence. Rust/Cargo are absent from the planner's local environment.
No private delegated-agent diagnostic log was opened; the user-pasted report is
sufficient to identify the conflict and compare it against committed code.

New S2 APIs and behaviors are implementation requirements, not symbols or test
results claimed to exist already. Source-backed compatibility below establishes
how those additions must use existing boundaries; it does not establish that
unwritten S2 code compiles or passes the matrix.

## 2. Confirmed blocker

s2.0 CONTRACT section 8 and MATRIX S2-06 required a serialized `tool_failed`
category while prohibiting a change to the current production error boundary.
The user's report correctly identified the inconsistency. The implementor's
assignment_conflict was justified; no runtime repair should have been improvised.

Pinned source trace:

1. `src/error.rs` defines `GatewayError::ToolFailed`.
2. `GatewayError::code()` has no ToolFailed-specific arm. The wildcard maps it
   to `gateway_error`.
3. `src/tools.rs::PreparedBatch::execute_next` matches `Err(error)`, constructs
   `json!({"error":{"code":error.code()}})`, and sets local is_error=true.
4. It serializes and caches that result before emitting ToolExecutionFinished.
5. `src/tools/tests/execution_results.rs::overflow_and_oversized_output_are_bounded_correlated_cached_results`
   explicitly expects `gateway_error` for the ordinary error and `tool_output_limit`
   for serialization overflow.
6. `tests/run_support/tool_execution.rs::run_ordinary_tool_errors_and_output_bounds_are_correlated_results`
   and `run_tool_owned_optional_timeout_is_an_ordinary_correlated_result` expect
   the same mapping through the run controller.

Therefore the model-facing result for S2's executed ToolFailed mapping must be:

```json
{"error":{"code":"gateway_error"}}
```

The call_id is on the existing InputItem::ToolResult. The error boolean is on
ToolExecutionFinished, not a new JSON payload field. No provider-generated error
or new event kind is involved.

The original specification confused a Rust enum variant with its exported code.
The correction is to CONTRACT and S2-06, routing/prompt/version references, and
related explanatory assertions. Adding `Self::ToolFailed => "tool_failed"` or
changing existing error tests is expressly NOT authorized. Returning an Ok Value
shaped like an error is also not a substitute: it would report is_error=false.

## 3. Full-handoff compatibility findings

Beyond that confirmed literal mismatch, the review made the following existing
boundaries explicit to avoid a second ambiguous assignment. These are preservation
clarifications, not newly requested production behavior:

| Boundary | Implemented source | Clarification in s2.1 |
|---|---|---|
| Preflight versus executed error | `src/tools.rs::preflight` and `PreparedBatch::execute_next`; `src/run/mod.rs` | Invalid ID/schema rejects the batch before new execution. Only a failure after a valid dispatch becomes a normal correlated error result. A tool-error result need not fail the whole run. |
| Source-read versus output-size failure | `src/context/preparation.rs::read_bytes`; `src/tools.rs` output serialization | Whole-file >1 MiB fails loading and maps to ToolFailed/gateway_error. A successfully loaded Value above 64 KiB reaches tool_output_limit. Exactly 64 KiB remains allowed. |
| Result caching versus observer failure | `src/tools.rs::execute_next` and result reuse | The registry inserts the serialized completed result BEFORE the finish observer. Observer failure does not erase that completed entry. A dropped pending loader has no returned result to cache. Reuse emits its reuse event, not a second finish/is_error event. |
| S1 selection error precedence | `src/context/preparation.rs::prepare_run` | All selected IDs are validated before AGENTS.md and body reads. Refactoring to the new shared loader must preserve that order, not read each body while validating the list. |
| CLI diagnostic ordering | `src/cli/run_cli.rs::handle` | Discovery notices are emitted even when activation/final validation fails. Provider construction follows successful preparation and notice delivery. Do not lose notices by an early `?` in the blocking closure. |
| Registry pairing versus result scope | `ToolRegistry::fresh_scope`; `src/run/mod.rs::run` | The helper returns matching registrations; run() still creates its own fresh result cache. The returned registry is not the post-run cache. |
| Model-call count wording | Existing `drive` loop; planned S2 tool call | A normal request after load_skill is necessary to consume its result. The excluded request is a separate skill-selector/classifier outside the existing loop. |
| Pure validation | Existing Tool trait versus the new tool's requirements | Purity is required of S2 validate; the trait cannot itself guarantee arbitrary implementations have no side effects. |

No additional confirmed requirement-to-production contradiction was found in this
review. That is a scoped source-review result, not a promise that the future
implementation cannot reveal another issue.

## 4. All-row source-to-contract map

The table reports document review, NOT acceptance PASS. Paths/symbols refer to the
pinned runtime. New S2 functions/tool/helper/example are deliberately absent there.

| Row | Existing anchor / new requirement | Review disposition |
|---|---|---|
| S2-00 | PR base/head and existing scripts/gates | Keep source review, prior baseline execution and new S2 execution distinct. Corrected version recorded; no test counts invented. |
| S2-01 | context/preparation.rs selected-ID lookup and body read pipeline | Shared loader is additive; preserve all-ID-first ordering, categories, original API and no-context identity. |
| S2-02 | context.rs SkillId, Scope, valid_name, catalog entries | Qualified IDs and private source resolution already supply the boundary; no arbitrary paths needed. |
| S2-03 | provider.rs ToolDefinition; tools.rs Tool | New concrete definition/validation uses current trait and strict ordinary schema; no protocol change. |
| S2-04 | tools.rs full-batch preflight | Catalog membership check can be pure; missing file is a later execution failure. Clarified no per-call result on rejected preflight. |
| S2-05 | tools.rs execute_next serialization/events | New loader returns Value; existing registry owns correlation, serialization, finish and cache. |
| S2-06 | error.rs code(); existing execution-result regressions | CONFIRMED mismatch corrected to gateway_error; direct variant and serialized result tested separately. |
| S2-07 | preparation.rs metadata comparison and owned body | New executions may read body-only changes; metadata identity remains fixed, returned bytes remain owned. |
| S2-08 | tools.rs results, preflight conflict checks, fresh_scope | Reuse exact saved output/errors without a second body cache; clarify reuse event and isolation. |
| S2-09 | context.rs SkillSource opening; MR fixture guard | Reuse current filesystem protections and documented limitations, not new hostile-filesystem guarantees. |
| S2-10 | S1 instruction-data handling; new loader scope | Read main SKILL.md only. No generic executor or resource expansion is needed. New negative side-effect tests remain required. |
| S2-11 | preparation.rs options validation; registry registration; run fresh_scope | Pair the same catalog with actual returned definitions; clear options.tools; preserve duplicate rejection and template isolation. |
| S2-12 | S1 conditional framing/no-context behavior | New helper alone registers loader for nonempty catalogs. Existing prepare_run remains no-loader; empty-catalog path retains S1. |
| S2-13 | preparation.rs four JSON fields, sort_all_objects, instruction suffix | New truthful suffix is an explicit composition choice, not caller-string replacement or body promotion. |
| S2-14 | preparation.rs selected ordering/dedup and ContextManifest | Existing explicit bodies coexist with later tool results; manifest is initial provenance, not mutable activation state. |
| S2-15 | MAX_INPUT_BYTES and actual registry serialization branch | Clarified separate >1 MiB read and >64 KiB serialized-output stages; no altered thresholds or paging system. |
| S2-16 | gateway/provider public traits; run()/drive() | Independent scripted provider can exercise new tool using the existing run API; new implementation tests still needed. |
| S2-17 | open-ended drive and sequential ordinary results | Three-request loader/arithmetic fixture is a new finite test, not production operands or runtime call limits. |
| S2-18 | OpenAI state.rs continuation/body construction and existing loopback test locations | Extend tests only; retain WS parent/delta and SSE native replay. No extra selector model call; ordinary result consumption remains. |
| S2-19 | run cancellation; tools.rs biased stop/select and cache-before-finish ordering | Preserve completed/cache versus pending distinctions. New blocking-work test barrier must not change runtime cancellation semantics. |
| S2-20 | cli/run_cli.rs handle, cli/skills_cli.rs discovery boundary | New helper wiring stays thin; diagnostics precede construction even on preparation failure. No command subprocess backend. |
| S2-21 | existing request/events, captured catalog and per-run cache | No wire/event/error-category changes; distinct workspace bindings; no credentials or mutable global context. |
| S2-22 | current example/index locations; S1 library boundary | New offline example and current behavior documentation are future deliverables. No claim of model adherence from scripts. |
| S2-23 | Cargo.toml; scripts/verify.py; current CI/gate structure | Dependencies already cover serde/JSON/Tokio/tool traits. Gate list retained. Actual execution/CI counts remain implementor evidence. |

The contract, matrix, prompt, AGENTS.md and index now consistently use s2.1.
The matrix still has exactly S2-00 through S2-23. Historical s2.0 content is
preserved in Git history; references in this amendment identify the superseded
version explicitly instead of leaving a second active rule.

## 5. Source anchors for the correction

Relevant immutable blob identities at the reviewed runtime:

| Path | Blob SHA |
|---|---|
| src/error.rs | fdddf4f997af400792def9deffae32aa9509960d |
| src/tools.rs | 1ba4714faaa1a38eb29e6893f029c219ad63949a |
| src/tools/tests/execution_results.rs | e150ac3752abff0f7b959a7c991de3da3df3a10e |
| tests/run_support/tool_execution.rs | 8f3205ee7c111bacacd0ed6f75cee3a5d89b89b4 |
| src/context.rs | b7c89a6a23bdde7a16805408b2c83c9588038a8a |
| src/context/preparation.rs | b4db77892aa070d9b15bd025b553ab0d79bb88a1 |
| src/cli/run_cli.rs | 29d69d65647c5175dd64785480612a1738810e0d |
| src/provider.rs | 886601a369cde8869dd239e6786e8a27de7797a9 |
| src/run/mod.rs | ea167d12cfc13da73b27c34cc64dfc08500cac6f |
| Cargo.toml | da6a2579a73a8c58af66eb211a30dcc7e4dfd0a9 |
| scripts/verify.py | 936a076a8f504e9b2bb914c3bee15d7f49bb6920 |

Repository tree/path inspection also confirms the behavior-organized test layout,
current example targets, and existing continuation test locations. Hash identity
is an integrity comparison, not behavioral verification.

## 6. Resume boundary

Resume using [IMPLEMENTOR_PROMPT.md](IMPLEMENTOR_PROMPT.md) for s2.1 after updating
the existing PR branch without resetting user work. The feature remains main-file
skill loading only. A cleanly stopped implementation conversation can continue;
a new one is optional. No replan or source error-category change is requested.

The reported pre-blocker baseline results may be retained with attribution and
revision. They must not be relabelled as S2 PASS. Any incidental provider fallback
reported by the Pi authoring workflow is not evidence that Wi performed a fallback
or permission to add one to Wi. The private delegated-agent diagnostic file and
provider contents are not needed for this correction.

No runtime, test, dependency, authentication, historical-verification or ledger
file is modified by this amendment. No live traffic is authorized. The generation
ledger remains 31/50 used, 19 remaining. New implementation reports must use s2.1;
this VALIDATION.md is a planning review, not either completed report.
