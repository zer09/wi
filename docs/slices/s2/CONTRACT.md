# S2 — model-selected local SKILL.md loading

Contract: **s2.1**. Status: **PLAN ONLY — NOT IMPLEMENTED OR VERIFIED**.
Prepared: 2026-09-12. Runtime baseline:
`94d86e0c9db62d9fec208a26f5b4bb2487bcb5fa`, merging accepted S1 repair
`214a447b43a094640ba46b93462c684f883cf5da`.

### s2.1 documentation correction

This revision supersedes s2.0. The implementor correctly stopped on a conflict:
s2.0 described `GatewayError::ToolFailed` as serializing to `tool_failed`, but
`GatewayError::code()` and existing regressions use `gateway_error`. Correct the
specification, not the production mapping. `src/error.rs`, registry serialization,
existing error assertions and event schemas must not change to accommodate this
mistake. The 24 acceptance IDs and feature scope are unchanged.

[VALIDATION.md](VALIDATION.md) records the complete S2 handoff review against the
pinned source, the confirmed discrepancy, and boundary clarifications. This is
source/document review, not execution or acceptance evidence for the new feature.

## 1. Purpose and acceptance boundary

A task already receives the global/project skill frontmatter through S1. S2 lets
the model request the main instructions of a relevant catalog entry, without the
user having to supply --use-skill. Wi reads that known entry and returns a normal
correlated function result. The existing model/tool loop performs continuation.

```text
host selects workspace/global roots
  -> existing discover: frontmatter only
  -> shared S2 preparation: metadata + callable load_skill definition
  -> existing run controller opens a provider session
  -> model requests load_skill({"id":"project:review"})
  -> existing full-batch preflight and sequential executor
  -> validated SKILL.md body becomes a function_call_output
  -> same provider session continues with those instructions in its history
```

This is on-demand instruction loading, not automatic execution of a skill program.
Wi does not run another model to classify the task. The selected provider model
chooses from the metadata using the ordinary function-tool interface. A task can
complete without loading a skill; the implementation must not force a load.

The concrete approved on-demand resource in this slice is **the catalog entry's
main SKILL.md only**. References/assets/other files require a later explicit read
contract; scripts require a separately designed executor. This narrower acceptance
boundary must be stated in docs, not advertised as complete skill-resource support.

## 2. Established behavior and source anchors

At the pinned baseline:
- `src/context.rs` owns ContextRoots, SkillCatalog, SkillId, validated metadata,
  private SkillSource paths, discovery, and safe regular-file opening.
- `src/context/preparation.rs::prepare_run` loads selected bodies, revalidates
  their frontmatter, wraps task/project/catalog/active-skill context, and validates
  input/options before provider construction. Its current framing explicitly says
  no skill loader is implied. PreparedRun retains owned prepared text, not a loader.
- `src/tools.rs::Tool` has definition, argument validation, and async execute.
  S2's validation must be pure; the trait alone does not enforce purity for arbitrary
  third-party implementations. ToolRegistry provides whole-batch preflight,
  per-run call-result reuse, correlated error output and sequential dispatch.
- The registry converts an executed error with `error.code()` into
  `{"error":{"code":...}}` and marks the local finish event is_error=true.
  `GatewayError::ToolFailed` currently yields **gateway_error**, not a dedicated
  tool_failed wire category. Serialized results above the existing 64 KiB bound
  become tool_output_limit errors, not truncated success.
- `src/cli/run_cli.rs` is the context-aware CLI adapter. The reusable run operation
  and ToolRegistry are library-owned; their public protocols do not need redesign.

These are repository observations, not claims of parity with Pi or Codex. The
name load_skill and the integration helper below are Wi design decisions for an
already requested capability. Reference harness reports motivate progressive
loading; they do not require these exact APIs, names, or failure codes.

## 3. In scope / out of scope

Deliver a shared single-skill loader, one catalog-bound Tool implementation, one
shared preparation/registry helper, thin integration in wi run, deterministic
offline/loopback tests, an example, and current documentation updates.

No new RunRequest fields, run-controller branches for skills, session manager,
skill activation state machine, dynamic provider feature, skill upload service,
watcher, discovery heuristic, automatic rescan, body cache, general filesystem
reader, reference-file operation, shell/process/network tool, approval framework,
PTC, native steering, async execution, automatic retry/failover, storage or GUI.
No dependencies are required beyond those already present. A private module for
the concrete tool is appropriate; reorganizing the production provider is not.

Keep global/project scope resolution, ordering, same-name coexistence, discovery
warnings, root-only AGENTS.md behavior, standard-field parsing and unknown metadata
semantics from S1. No global skill-disable option is introduced. The existing
explicit --use-skill path remains supported. No new CLI enable flag is added.

## 4. Required library additions

Add these operations under `wi::context`. The public signatures below are fixed;
private helper/module names are implementor details. These are NEW S2 APIs, not
symbols claimed to exist in the baseline. Result below is the ordinary two-type
Rust Result, not the crate's one-error GatewayError alias.

```rust
pub struct LoadedSkill { /* private fields, redacted Debug */ }

impl LoadedSkill {
    pub fn id(&self) -> &SkillId;
    pub fn frontmatter(&self) -> &serde_json::Value;
    pub fn body(&self) -> &str;
}

pub fn load_skill(
    catalog: &SkillCatalog,
    id: &SkillId,
) -> Result<LoadedSkill, ContextError>;

pub fn prepare_run_with_skill_loading(
    request: wi::run::RunRequest,
    catalog: std::sync::Arc<SkillCatalog>,
    selected: &[SkillId],
    tools: &wi::tools::ToolRegistry,
) -> Result<(PreparedRun, wi::tools::ToolRegistry), ContextError>;
```

`load_skill` is a refactoring of the existing explicit-activation read/validation
path, not a second filesystem implementation. It checks even directly constructed
SkillId values, looks up only catalog entries, opens the recorded source through
existing safeguards, compares freshly parsed frontmatter with discovered data,
and returns a nonblank UTF-8 body. Preserve S1's error precedence and categories.
Do not expose absolute paths in LoadedSkill or its Debug output. Explicit body
and metadata access is sensitive application data, not safe telemetry.

Existing `prepare_run` must use the shared loader for its explicit bodies while
retaining its signature, no-loader behavior, framing, validation, and no-context
byte identity. S2 does not change its defaults behind existing callers' backs.
In particular, S1 validates ALL selected identities before reading root AGENTS.md
and then selected bodies in selection order. Do not turn that into a read-as-you-
validate loop: a later unknown ID must retain precedence over an earlier body's
read failure. Share a private pure lookup if necessary; do not duplicate file reads.

`prepare_run_with_skill_loading`:
1. Uses the caller's catalog Arc for both composition and the bound tool. It does
   not read environment variables, select a workspace, rediscover, or open auth.
2. Calls `tools.fresh_scope()` to create the returned registry without modifying
   or sharing result-cache contents from the supplied template.
3. If the catalog is nonempty, rejects a supplied tool named load_skill and then
   registers Wi's catalog-bound loader exactly once. Never replace another tool.
   A collision is ContextErrorKind::InvalidRequest before file body loading,
   provider construction, or execution. With an empty catalog there is no built-in
   tool to register or collide with; unrelated supplied tools are unchanged.
4. Prepares using the same S1 composition/validation pipeline and selected IDs,
   but the truthful loader-enabled framing in section 6. Validate with the actual
   returned definitions, including load_skill. Returned options.tools stays empty
   because the existing run controller remains responsible for the final snapshot.
5. Returns the prepared request/initial manifest and its matching registry. This
   pair is the caller's execution input. Do not introduce a new context engine.

The built-in Tool type may stay private in context's skill-loading module. It
owns only Arc<SkillCatalog>; it is stateless with respect to active skills and
results. No second registry, body/result cache, global singleton or cross-run
mutable state. Existing ToolRegistry fresh scopes retain their semantics.
The public run controller itself takes another fresh result scope from the supplied
registry. Thus returned tools are the registration template for that run, not a
cache handle that can be inspected for the run's results after completion.

## 5. Function-tool wire contract

Name: `load_skill`. Ordinary function tool; strict schema; no namespace,
programmatic caller permission, async flag, deferred search, or hosted operation.

```json
{
  "type": "object",
  "properties": {"id": {"type": "string"}},
  "required": ["id"],
  "additionalProperties": false
}
```

Definition description must state: load the main instructions for one advertised
qualified skill ID; supporting files and scripts are not read/executed. Do not
list every catalog ID in an enum or duplicate all descriptions inside the tool
schema: the metadata is already in the initial context.

Arguments are exactly an object with one string id. Examples:
- accepted when present in this catalog: `global:review`, `project:review`;
- rejected: a bare name, absolute/relative path, unknown scope, invalid name,
  unlisted ID, URL, null, additional property, missing id, or wrong type.

`validate()` is pure: check schema, qualified identity and catalog membership.
No file opens or metadata/body rereads during validation. Invalid arguments or an
unknown catalog ID return existing InvalidToolArguments, using ordinary full-batch
preflight. Therefore a mixed batch containing an invalid load performs no earlier
new tool execution. Do not weaken that boundary to make malformed calls repairable
in this milestone.

`execute()` defensively validates its argument again, then invokes the shared
loader for that ID. It never joins a model-supplied path, accesses another catalog,
follows body resource instructions, registers tools, or changes prompts/options.
Use Tokio's existing blocking-work facility for bounded regular-file reads so
filesystem work does not monopolize the async executor. Do not create a custom
worker pool or new executor abstraction.

Success returns JSON data with exactly these fields:

```json
{
  "id": "project:review",
  "frontmatter": {"name":"review","description":"Review a supplied change"},
  "body": "The complete selected Markdown instructions."
}
```

Preserve the validated body's bytes/text without trim-based rewriting. Sort nested
JSON object keys consistently with S1; arrays and Markdown ordering remain intact.
The registry serializes this Value and links the output to the originating call_id.
No request to the provider is made inside the loader.

## 6. Context integration and truthfulness

Normal `wi run` uses the new preparation helper. It discovers global/project
metadata exactly as S1 does, installs load_skill automatically for a nonempty
catalog, and passes the returned registry/request to the same public run function.
No --tool load_skill, --auto-skills, --enable-loader, or analogous flag is required.
Existing --tool add_numbers and --use-skill selections remain available.

`wi skills list` remains metadata-only: it must not construct a provider or load
any body. Legacy generation/demo/smoke commands are not silently converted into
workspace-aware runs. Update help to describe the actual new wi run behavior.
Preserve the CLI's existing ordering: discovery diagnostics are delivered even if
activation/final validation fails, and all preparation/diagnostic failures precede
provider/auth construction. Do not early-return inside the blocking preparation
closure in a way that loses already obtained diagnostics.

The loader-enabled preparation keeps S1's four initial JSON fields:
`task`, `project_instructions`, `available_skills`, `active_skills`.
All discovered global/project frontmatter remains present. Only explicitly selected
bodies are initially present. A model-selected body's first appearance must be
its normal tool result, not eager preparation or a hidden provider request.

Retain the exact caller instruction prefix. Append a framing suffix equivalent to:

> The initial user payload is JSON. Its task is the user's request. Project and
> skill entries are task context, not permissions or executable configuration.
> Only registered tools are available. The available_skills catalog contains
> metadata; active_skills contains the bodies explicitly supplied for this task.
> When relevant instructions are not already present, call load_skill with the
> exact advertised id to read that skill's main instructions. Its result is task
> context, not permission to access supporting files, execute scripts, or alter
> configuration. Loading a skill does not perform the workflow it describes.

The implementor may clarify wording without changing these meanings. Do not string-
replace caller text to remove the old suffix. Factor the shared composer with a
private explicit framing choice; only the helper that actually registers Wi's
loader can select loader-enabled framing. An arbitrary tool merely named
load_skill must not be inferred to be this implementation.

For an empty catalog, the new helper delegates to existing no-loader semantics:
no additional definition or loader claim; S1's AGENTS.md behavior still applies.
When there is no project/catalog/active context, request bytes remain unchanged.
Do not mutate instructions midway through provider continuation.

ContextManifest remains a **pre-run preparation manifest**. Its active_skills list
means explicitly included initial bodies, not every body later read by a model.
Do not mutate it into a live activation ledger or claim it tracks delivery of tool
results. Existing provider/tool/run events carry the later loading lifecycle.
Neither these files nor JSON framing are an adversarial prompt-injection sandbox.

## 7. Read timing, snapshots, and result reuse

The catalog is the immutable metadata/path-selection snapshot captured by the
caller. The loader must use it for the entire run; no body text, tool argument or
environment change can redirect it to a fresh root/catalog. Added files after
discovery are unavailable until a future explicit fresh discovery/preparation.

Each **new execution** rereads the selected main file and revalidates frontmatter.
A body-only edit before that read is allowed, matching S1's existing activation
behavior. Changed/invalid frontmatter fails; never accept a new identity merely
because a path is the same. After successful return, the result is owned data and
subsequent edits/deletion cannot alter bytes already delivered/in history.

A distinct later call ID is an explicit new load and can observe a body-only edit.
The same call ID/arguments uses the existing per-run result cache, including its
saved error, without reopening the file. Conflicting reuse retains the current
failure semantics. No extra body cache is needed. Loading an already explicitly
active skill is allowed but not automatically performed; normal instructions tell
the model it already has that body. There is no load-once policy or hidden counter.

Preserve current no-follow/reparse/regular-file/root checks and the documented
trusted-owner limitations, including hardlinks/ancestor races. S2 must not claim
hostile-filesystem isolation or broaden filesystem policy. Retain portable tests
and the Linux-only malformed-byte fixture guard.

## 8. Errors, output limits, and cancellation

The shared loader returns existing ContextError categories for local library use.
The Tool adapter maps read failure, changed metadata, invalid/oversized body, and
blocking-worker join failure to `GatewayError::ToolFailed`. The EXISTING
`GatewayError::code()` mapping serializes this through the registry as:

```json
{"error":{"code":"gateway_error"}}
```

The returned InputItem is correlated with the original call_id; the local
ToolExecutionFinished event has is_error=true. There is no is_error field added
to the error JSON, and the provider does not emit this local tool-finish event.
Raw paths, text, OS errors or parser excerpts must not appear in model error results
or ordinary diagnostics. Do not add `Self::ToolFailed => "tool_failed"`, fabricate
an Ok error-shaped Value, or alter existing regression expectations. An Ok Value
would otherwise make the registry report is_error=false.

Keep the layers distinct:

| Condition | Existing/public boundary to preserve | Expected observation |
|---|---|---|
| Bad schema or unknown ID | S2 validate returns InvalidToolArguments; registry preflight rejects | No new execution/result/finish from that batch; the controller's existing failure handling applies, not a correlated tool error result. |
| Known entry fails to load | Public load_skill returns its ContextError; Tool execute maps to ToolFailed | Registry returns the correlated gateway_error JSON above and is_error=true. It can be delivered to the next ordinary model request; it does not automatically fail the whole run. |
| Successful Value serializes above 64 KiB | Existing registry output-size branch | Correlated `{"error":{"code":"tool_output_limit"}}`, is_error=true; no truncated success. |
| Cancelled while awaiting a load | Existing controller/registry cancellation path | No new successful result or finish fabricated; cancellation is not converted into gateway_error. |

The current file-read/input guard is 1 MiB and the current serialized tool-result
guard is 64 KiB. **Do not change either guard in S2.** A whole selected file above
1 MiB fails the shared loader first: ContextErrorKind::InputTooLarge, mapped to
ToolFailed/gateway_error through the adapter. A successfully loaded file whose
id/frontmatter/body Value serializes ABOVE 64 KiB reaches tool_output_limit. Exactly
64 KiB remains permitted by the registry. These are different failure stages; do
not require both codes for the same stage or classify all oversized inputs alike.
The complete next-input validation also remains in force for combined results.
Document this existing limitation; no paging/reservation/quota system.

Malformed arguments/unknown IDs fail during preflight before filesystem work;
valid IDs whose files became unreadable fail during execution as normal tool
results. Both distinctions require tests. Errors do not cause Wi to rediscover,
retry, reconnect, select another account or fall back to hosted/API billing.
The model may choose another ordinary iteration, under the unchanged controller.

Controlled cancellation and observer failure retain M3/C1 behavior. If the pending
tool future is dropped, no successful finish/result/cache entry is fabricated.
After execution and serialization have completed, the registry ALREADY caches the
result before emitting ToolExecutionFinished. A failure of that finish observer
stops remaining work but does not roll back the completed operation or its cache.
Preserve this ordering; do not require a completed cached result to disappear.

A blocking regular-file read may finish after its awaiting future is cancelled;
its worker must not mutate a registry/catalog, emit events, submit results, or
start further work. Do not promise forcible termination of blocking I/O. Test
cancellation with a deterministic test-only barrier, not long sleeps or new
runtime deadlines. Join-failure tests use a fixed synthetic failure and retain no
real file text or paths in panic/log output. No active task is detached for later
model continuation.

## 9. Allowed implementation footprint

- `src/context.rs` exports/shared metadata lookup as needed.
- `src/context/preparation.rs` refactors existing body loading and composer.
- A focused `src/context/skill_loading.rs` (or equivalent private module).
- `src/cli/run_cli.rs` and existing context CLI tests wire the shared helper.
- Tests under the current behavior-organized layout, with a small new integration
  target only when it adds a clear public-library boundary.
- Existing provider loopback test files may gain S2 cases. Production provider
  files, auth, run orchestration, Tool trait and result-cache implementation should
  require no behavior changes. If they appear necessary, report the concrete
  conflict rather than broadening the task. `src/error.rs` and existing error-code
  expectations specifically stay unchanged: s2.1 corrects the documentation.
- `examples/skill_loading_offline.rs` and concise current README/architecture/event
  documentation updates; update docs index without relocating historical records.

No public visibility sweep, broad test/file moves, dependency upgrades, CLI
subprocess backend, duplicate agent loop, or code-generation framework.
The new helper is additive. S1 prepare_run, RunRequest and run/provider event
schemas remain unchanged: outer run schema 2, nested provider schema 1.

## 10. Required proof and implementation order

1. Read this contract/matrix and current source; record actual HEAD/worktree.
   Preserve user edits. Run isolated baseline gates; do not trust old counts as
   proof of the new head. Note platform differences honestly.
2. Extract/reuse one loader and keep all S1 activation regressions passing.
3. Add the concrete catalog-bound Tool and shared registry/preparation helper.
   Verify preflight purity, output/error behavior and snapshot isolation.
4. Wire the thin CLI. Test default availability, explicit selections and no-catalog
   compatibility without real workspace/profile reads.
5. Drive an independent scripted provider through the public controller: initial
   metadata -> load_skill -> result -> final. Include a three-request case that
   loads instructions, then calls add_numbers, then finishes. No exact arithmetic
   belongs in the production loader/controller.
6. Extend both loopback transports to prove the same public preparation/tool path:
   same WebSocket connection with parent/new-input linkage; SSE full effective
   native-history replay with the skill result. Keep native-state validation.
7. Finish docs, all matrix rows and the isolated regression gates. Obtain a fresh
   complete-diff review. Repair confirmed issues and rerun affected gates; record
   actual evidence, not a target test count or another copied acceptance claim.

The offline example uses only temporary skills and a scripted provider. It should
prove no initial body, one real local load, body in the next model input, and final
fixture response. A larger integration fixture may then use add_numbers; neither
example makes provider requests. A model-generated load naturally requires the
next ordinary model request to consume its result. The forbidden extra request is
a separate classifier/selector/preparation-model call, not that tool continuation.

## 11. Reporting, authorization, and later slices

Future implementation reports (not supplied as fake completed files by this plan):
- `docs/slices/s2/VERIFICATION.md`
- `docs/slices/s2/verification.json`

Follow the matrix's report schema. Preserve historical S1/MR evidence and record
later CI closure separately. Original 339 Linux executions, 326 source definitions
and 152 Node self-tests are comparison observations, not required fixed totals.
A current test-definition count need not equal executed summaries across targets.

Authorization when the owner supplies the prompt: source/tests/current docs for
S2 and OFFLINE checks only. Synthetic roots/credentials, scripted providers,
loopback transport and ordinary trusted build tooling are permitted. No real
credential/private-project/global-skill reads for verification, auth/profile/login/
refresh commands, provider generations, hosted probes, implementation Git writes,
merge, release or publication. The ledger stays 31/50 used, 19 remaining. Pi's
authoring traffic is separate. Remaining allowance is not authorization.

S2 offline acceptance proves Wi exposes and services a model-selected call through
the real library path; it does not prove a live model chooses or follows a skill.
A future live check requires explicit authorization and its own evidence.

P1 persistent sessions must be designed before accepting V1 as a service. One
owner can switch browsers/devices without cancelling service-owned work; Wi restart
stops tasks without auto-resume/replay. These requirements remain fixed, but S2
adds no storage, server/session owner, transport subscription service or GUI.
