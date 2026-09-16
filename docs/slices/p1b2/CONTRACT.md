# P1-B2: explicit submissions against stored conversation history

Contract **p1b2.0**, 2026-09-16. **PLAN ONLY / NOT IMPLEMENTED / NOT RUN**.
Baseline: `6fe0a538edf6bae39c9f933db8394b7d8483e2be` (P1-B1 merged).
Read SCHEMA.md, MATRIX.md, VALIDATION.md and IMPLEMENTOR_PROMPT.md together.

## 1. Outcome and supported scope

Add `wi::execution::run_in_session`: a NEW explicit user task uses the saved model-
visible conversation in that application session, including after process restart.
Execute through B1's shared controller, registry, lifecycle hold and awaited storage.
Do not flatten a transcript into one user string, invoke another agent, reread old
skills or execute tools again to obtain their historical outputs.

Support **closed ordinary exchanges**: complete authoritative responses with all
required correlated results. A stopped/interrupted run can contribute when its actual
committed exchanges are closed. A complete trailing result batch is usable by a NEW
user submission without automatically requesting the abandoned old continuation.
Partial native responses, uncertain requests, incomplete tool batches and missing
results cannot be repaired by invented output, summaries, tail skipping or retries.
Reject their replay explicitly; the stored history stays readable. This is a data-
validity boundary, not a runtime count/time or session-age restriction.

Pre-B2 runs lack selection/binding provenance. They remain readable but cannot be
silently assigned today's account or treated as a chain of context-aware submissions.
Native replay of those legacy runs is unsupported here. Schema migration never fills
that evidence gap. Fresh B2 sessions and their later explicit submissions are supported.
Incomplete-tail reconstruction, legacy provenance adoption and cross-model conversion
remain separately designed work, not pretend-success modes inside this implementation.

B1 run_persisted stays a supplied-input recording API. Ordinary wi run stays its current
nonpersistent diagnostic path. New library APIs and conversation_offline demonstrate B2;
normal CLI session commands, service-owned task manager, client auth, browser protocol,
GUI, compaction/branching/import and advanced tools are not this assignment.

## 2. Compatibility

Keep one database engine/topology and one agent loop. No new dependency; Cargo files
stay unchanged. Preserve RunRequest fields, InputItem variants, public legacy run/Tool
behavior, runtime/provider envelope schemas 2/1 and GatewayError::code(). Add default
unsupported replay methods so existing Provider/SessionControl implementations compile.

Session database v2 and lazy v1 migration are explicitly authorized by SCHEMA.md; catalog
schema remains1. Preserve original history/receipt bytes, IDs and ordering. Storage
recovery/migration/list/read never executes providers/tools. No RunLimits, budgets,
task deadlines, history/session lifetime ceilings, automatic deletion or task resumption.

## 3. Entry point and types

```rust
pub async fn run_in_session(
    gateway: &Gateway,
    session: &SessionHandle,
    request: PersistentRunRequest,
    tools: &ToolRegistry,
    cancel: CancellationToken,
) -> Result<PersistentRunResult, PersistentRunFailure>;
```

Reuse operation_id, run_id and RecordedRunInput. That input describes ONLY the current
new task/context. No caller-supplied history path, old response ID, arbitrary seed
replacement, SQL or account override. Keep Executed/Duplicate semantics. Add failure
stages History and ProviderBinding; preserve existing stage names. No new wire schema
for composition types. Static/redacted diagnostics never expose history or account data.

Expose read-only `execution::prepare_session_replay(session, provider_id, requested_model)`
returning private-field PreparedSessionReplay with owned getters for selection, replay
and structural dispositions. It calls storage only. run_in_session uses this builder.
It does not select credentials, open a provider, execute a tool or import arbitrary text.

Add provider-neutral owned types with validating constructors/deserialization and
redacted Debug (a focused provider submodule is allowed):

- ReplayIdentity: provider_id:String, format:String, principal_digest:String; names
  nonempty, digest exactly64 lowercase hex SHA-256 characters. This is sensitive private
  session data and an equality marker, not encrypted or authenticated identity proof.
- ConversationReplay: version1, provider_id, requested_model, optional expected_identity,
  ordered ReplayRun records.
- ReplayRun: source_run_id, original prepared user prompt, ordered ReplayExchange values.
- ReplayExchange: actual ModelResponse and ordered Vec<InputItem> of its ToolResults
  only. No calls means no results; calls require the complete matching result set,
  including when no later model request occurred.

The new task is not part of the stored replay vector. Old prepared user prompts retain
user position; current instructions/tools remain current settings. Old skill bodies,
system instructions and tool definitions do not become new authority or registrations.

Add these methods with defaults (signatures below include CURRENT NEW INPUT explicitly):

```text
Provider::validate_replay(&self, options:&SessionOptions,
                         replay:&ConversationReplay, new_input:&[InputItem]) -> Result<()>
    default UnsupportedFeature("history_replay"); pure, no auth/open
Gateway::validate_replay(provider_id, options, replay, new_input) -> Result<()>
    delegates to the registered Provider, no provider opening
SessionControl::replay_identity(&self) -> Option<ReplayIdentity>
    default None; local/immutable/side-effect-free
SessionControl::install_replay(&self, replay:ConversationReplay) async -> Result<()>
    default UnsupportedFeature("history_replay"); local state installation only
```

validate_replay checks adapter support even for an empty replay and validates compiled
history PLUS new_input against existing provider-context constraints. Recheck input
capacity on actual generation, as today. Ordinary continuation capability alone does
not prove restored-history support. Implement these for OpenAI-Codex and an independent
scripted provider; add no placeholder registry or dynamic plugin framework.

## 4. Reconstruction policy: closed-exchanges-v1

Capture manifest head H. Read exactly1..H through existing fixed-head pages; never
buffer the whole token/event log. Retain current-run validation state, compiled provider
context, compact selection/hash checkpoints and diagnostic dispositions only. Preserve
all canonical records in storage. Rename events enter prefix provenance but not model
messages. Streaming/finalized-item notifications are evidence, not duplicate messages.

For each historical run in accepted order:

1. Require the B2 history selection anchored to its pre-acceptance prefix and verify its
   digest (section5). A B1/manual run lacking it is legacy unbound, not implicit context.
2. Require terminal recorded state. Do not wait for/cancel another active run. A run may
   contribute NO MODEL CONTEXT only if its actual committed RunResult has zero attempted
   and admitted requests, no last_response, and there are no provider/tool/result events.
   Report that exclusion explicitly. Missing events, accepted-only records or process
   death alone are not proof of no submission. Its history remains readable unchanged.
3. Every contributing run needs its actual provider-binding record. All contributing
   identities, format, provider and historical requested-model strings must agree with
   replay selection. Preserve ModelResponse.model; do not require it to equal a request
   alias. No current credential is consulted while examining old data.
4. Reconstruct actual run/turn/request correlation. Each turn that might have sent a
   request must have exactly one committed authoritative ResponseFinished with Completed
   outcome and ordinary Message/Reasoning/direct complete FunctionCall items. A later
   uncertain request cannot be ignored because an earlier prefix looked usable.
5. The first response follows that run's accepted prepared user prompt. Subsequent
   responses must follow the preceding complete tool-result set under the existing
   controller algorithm. There is no invented user text or unrecorded continuation.
6. Resolve calls in model order to exact run-scoped results. New calls require recorded
   intent and actual result; reused calls require that turn's reuse event and original
   saved result. Preserve original result request identity, exact output and observed
   is_error. Never call current Tool::validate/execute or reread sources for old calls.
   A result need not have a finish notification if process loss occurred after its
   actual commit. A complete trailing batch is valid; partial results are not.
7. A no-call response ends a run's model-visible segment. Empty/refusal/reasoning-only
   completed output remains valid. Partial text is not promoted to completed output.
   Unsupported executable output is rejected, not discarded or executed.

A stopped run with closed exchanges can supply context to a NEW task and stays stopped.
An unfinished exchange fails `stored history is incomplete for native replay` before
new acceptance/provider work. There is no broken-tail selector or silent truncation.
Return included run/exchange counts and excluded definitely-unsubmitted run IDs through
explicit data getters; these are observations, not quotas or ordinary log content.

## 5. Prefix hash and atomic admission

StoredHistorySelection is specified in SCHEMA.md: policy, through_sequence H,
history_digest, provider_id, requested_model and optional expected_identity. H includes
ALL canonical records before acceptance, including renames and earlier selections.

SHA-256 convention: domain UTF-8 bytes `wi.history-prefix.v1\0`, followed by each row in
sequence order: u64 big-endian length then canonical UTF-8 JSON bytes. Canonical row has
sequence,event_id,event_type,event_version,created_at_ms,run_id,source_event_id,
source_sequence,payload (the parsed original payload_json), including nulls. Use P1-A's
recursive object-key sorting and preserve arrays/inner strings. Do not include mutable
manifest/catalog/schema values. This is not RFC8785 or raw transport-byte equivalence.

The execution builder cannot recover unknown stored payload fields merely by serializing
an existing typed DTO. Add a narrow CRATE-PRIVATE storage helper for a fixed H and requested
prefix checkpoints: stream raw canonical rows once, validate expected checkpoint digests,
and return H's digest. It runs as an operation-owned read, no model/tool callback and no
arbitrary SQL exposed. The builder can first gather checkpoint pairs from paged typed
history, then make this one hash pass. Do not reread each old prefix recursively. A
fixed immutable H tolerates later appends; acceptance still compares the actual head.

Admission:

1. Retain B1 execution hold and operation-keyed acceptance coordination.
2. Receipt lookup/recheck FIRST. For an old B2 receipt fetch its original selection and
   verify method/input/run identity with that selection; return Duplicate without fresh
   history compilation, capability/registry/auth checks. B1 accept_run under that ID
   conflicts. The old receipt never authorizes another execution.
3. For an absent receipt build replay; compare current definitions ONCE with captured
   RecordedRunInput, run shared pure admission, then pure Gateway::validate_replay with
   the SAME actual options/definitions/new input that will execute. No auth/network.
4. SessionHandle::accept_history_run atomically checks receipt first, current head==H,
   active-run constraints, then appends run.accepted and adjacent run.history.selected.
   Commit projections/head/receipt together. Head changed => storage.stale_history,
   NotCommitted, zero work; no automatic rebuild/retry. Receipt spans both events.
5. Only a successful unwarned, duplicate=false acceptance enters the admitted engine.
   Cancellation during commit follows B1's recorded cancellation path, not a new
   pre-admission rejection leaving unaccounted accepted work.

New storage APIs: accept_history_run(operation_id,run_id,input,selection),
history_selection(run_id)->Option<StoredHistorySelection>,
provider_binding(run_id)->Option<RecordedProviderBinding>. Share existing coordination,
transaction/receipt identity and typed validation. Do not duplicate a prior transcript
in every acceptance; store the prefix pointer/digest/policy and binding expectation.

## 6. Awaited binding and startup in the shared loop

AdmittedRun gains optional replay; legacy/B1 leave it absent. Extend the private observer
with a default-no-op awaited provider_opened boundary carrying immutable session/identity
data, NOT a borrowed ProviderStream. Preserve Send persisted futures and non-Send legacy
callbacks. The B2 observer reuses B1 event/tool-result recording and failure bookkeeping.

After RunStarted commits, open the provider ONCE with existing configured selection,
install its close guard, and set the real provider-session ID. For a B2 run:

- Read actual control.replay_identity locally. Missing identity selects normal Failed
  outcome code history_identity before generate; record terminal/result if storage works.
- Await one run.provider.bound record with actual identity/session/requested model.
  Storage failure here uses ProviderBinding stage and B1 sticky observer failure. No
  history installation/generation follows a failed or warned intermediate write.
- Compare actual to expected identity for nonempty history. A mismatch selects normal
  Failed code history_identity; make zero generate calls and send no historical payload.
  The actual attempted binding is still recorded. No alternate account selection.
- Check cancellation; call install_replay on that fresh control. It must also check
  expected identity when called directly. A local installation failure selects normal
  Failed code history_restore, with no generation/retry. A cancelled local installation
  closes the guarded session, not a reissued request.
- Drive the SAME model/tool loop with only the NEW prepared input. B1 awaited intent,
  result/error serialization, finish, final-result, failure and ownership semantics apply.

Missing/mismatched identity or rejected installation is an EXECUTION failure, not a
storage error. When its terminal/result commits, return Executed with Failed outcome
and zero model attempts; do not strand an active run by falsely failing the persistence
observer. A later explicit request can recognize these definitely-unsubmitted attempts.

The caller's configured managed selection policy is unchanged. No explicit profile can
mean a different account is chosen and the binding check rejects it. Do not silently
search for a matching profile or fail over. The embedding caller may choose the intended
profile through existing configuration. Same-account refresh preserves identity; login,
refresh and real credential operations are not authorized by this offline assignment.

## 7. OpenAI-Codex replay implementation

Identity provider=openai-codex, format=responses-input-v1. principal_digest is SHA-256 of
UTF-8 `wi.openai-codex.account.v1\0` then exact account_id already loaded by Wire::open
for its WS handshake/SSE account binding. Derive it from those same credentials, never
another load, token hash, alias or path. It is an equality guard, not encryption,
anonymity or provider-verified provenance. Preserve existing auth selection/incarnation/
renewal checks, fixed endpoints/TLS, SSE same-account validation and handshake expiry.

Pure replay validation uses shared codec/classification helpers to check saved normalized
items against native ones, response identity/outcome/text/usage and provenance. For
NativeTerminal, effective output agrees with native.output. For ValidatedOutputItemDone,
keep original native.output=[] and use the recorded effective native items. Do not lose
recovery by reparsing only the empty native terminal or rewrite canonical source data.
Recovery provenance is recorded evidence, not cryptographic authentication.

Preserve exact effective item order/native objects, encrypted reasoning, IDs, arguments,
unknown NONEXECUTABLE fields and result strings. Validate function completeness/direct
origin/native namespace consistently with current safeguards. Message native role may
be absent (existing compatible fixtures) or assistant, not user/system/developer. Do
not promote a returned message to higher authority. Unsupported executable item kinds
reject. No old tool invocation is actually performed.

For each contributing run compile:

```text
native user item containing old prepared prompt
response1 effective native output items
its exact matching function_call_output items, if calls exist
response2 effective native output items
... complete trailing results, if present
```

Do not include run events, text deltas, historical system instructions or catalogs as
new duplicate items. Current options instructions/tools stay current. The requested
model must exactly match each contributing historical requested model for this first
native-replay contract; this is a conservative Wi compatibility scope, not an OpenAI-
wide restriction. No opaque stripping or plain-text downgrade to change models/accounts.

Compile and validate old context+CURRENT new input before acceptance. Apply existing
2048-item/8MiB provider history capacity to compiled native input. Apply128-item/1MiB
validate_input to CURRENT input separately, not the whole restored conversation. Reject
size overflow explicitly; no truncation, compaction, DB deletion or new storage quota.
Recheck on actual send and preserve existing frame/response safeguards.

Actor installation is allowed once, only on a fresh unused control. Add a closed local
install command/ack alongside generate; serialize admission so concurrent install and
generate cannot overlap. Reject busy/used/closed/repeated installs without replacing
context. Invalid install is atomic. No provider request or semantic event is produced.
Preserve WS idle/Ping/Pong and cleanup behavior; never retry a lost install reply.

Installed state has compiled history, no outstanding calls, no imported old parent ID
and no advanced-output flag. Fresh response-identity tracking applies to NEW requests.
Old IDs/results remain unchanged in history; no cross-run cache or global ID rewriting.

WS first NEW response.create: full restored input+new prompt, NO previous_response_id.
Later requests on that socket: B's NEW parent ID and new result-only delta as today.
SSE: full ordered history on every request. Never send a stale parent first and fall
back. Snapshot getters/native values are sensitive application data, not public logs.

## 8. Storage and recovery

Implement SCHEMA.md v2: two new canonical facts, typed reads, transactional acceptance,
version-aware validation/repair and safe lazy migration. Do not encode them as fake
ProviderExtension events. Binding is recorded once after RunStarted and before turns,
updates the provider identity projection but not runtime source sequence, and remains
valid evidence even when it differs from the expected identity and execution is refused.

Extend full streamed repair to check selection digest/adjacency and binding uniqueness/
identity in addition to all old run/tool/provenance invariants. Legacy v1/v2 unbound
sessions can remain ready/readable while replay is unsupported. Catalog refresh may
observe1->2 at the same head only under matching canonical summary, never downgrade or
promote bad availability. No new metadata/credential/rendered-chat tables.

Keep B1 owned-future hold, child cancellation, close drain, admitted SQL wait, sticky
first failure and final execution-versus-recording distinction. Neither replay building
nor migration invokes install_replay/generate/tools. Only the explicit new submission
can open/install/generate. Duplicate old commands remain zero-work. No automatic
continuation of interrupted work even when a complete trailing tool result is available.

## 9. Error and limitation contract

Add only storage.stale_history (NotCommitted) to storage errors. Preserve old codes.
Unsupported adapters use existing UnsupportedFeature("history_replay"). History-stage
InvalidRequest messages are static:

- stored history has no replay provenance
- stored history is incomplete for native replay
- stored history provider or model is incompatible
- stored history replay metadata is inconsistent

Malformed canonical data detected by storage remains storage.integrity. Adapter-native
validation uses existing Protocol/InvalidRequest mappings. history_identity and
history_restore are new RunOutcome failure strings, NOT new GatewayError categories.
No code changes to ToolFailed->gateway_error or inferred is_error from JSON text.

Incomplete/unbound history stays readable and unchanged. No reset/import/skip switch
is delivered. Live subscription portability of opaque data and model adherence remain
NOT RUN; acceptance is offline binding enforcement and exact loopback native replay.
Do not claim physical power-loss, hostile same-user sandboxing, guaranteed upstream
termination or exactly-once external effects. Record measured costs without an SLA.

## 10. Scope, sequence, verification and authority

Allowed: execution replay builder/composition/tests; additive provider DTO/default
methods and Gateway delegation; private shared run opened/replay seam; OpenAI state,
control and same-loaded-identity plumbing/tests; storage v2 migration/recording/repair;
conversation_offline example and current docs/new reports. No authentication selection
or renewal redesign, dependencies, unrelated production reorganization or second loop.
Version-specific old tests may adapt to migration, but retain their behavioral assertions.

Sequence: baseline; migration/schema tests; pure replay builder; pure provider validation,
identity and actor install; shared execution integration; actual WS/SSE plus failure/race/
reopen cases; old/new gates; fresh independent complete-diff review; all36-row reports.
A source/contract contradiction is reported precisely before scope changes; the local
agent implements this fixed plan, not another architecture proposal.

Use synthetic private roots/skills/credentials and loopbacks only. No real profile/
credential/private-skill access, auth commands, provider requests or live probes.
Ledger31/50 used,19 remaining unchanged. No runtime quotas, timers, auto-deletion,
auto-resume, hosted skills/billing, new tools/providers, permissions, server or GUI.
Reports: docs/slices/p1b2/VERIFICATION.md and verification.json. No implementation Git
write, merge, release, deployment or subsequent milestone without separate owner approval.
