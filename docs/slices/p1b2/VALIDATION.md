# P1-B2 source validation and decision ledger

Contract **p1b2.0**, prepared 2026-09-16.
Baseline `6fe0a538edf6bae39c9f933db8394b7d8483e2be` (P1-B1 merge).
**Source/design validation only. No B2 Rust implementation or acceptance is claimed.**

## 1. Accepted baseline and review provenance

PR #6 source b1e46f3eb33a66c2682b3038066a9d20dadf17da was followed by evidence-only
ba83a5f7f7216b0a2f296553ab7e80d7334556a4. The planner corrected AGENTS.md only in
2948b8c3c693f2222bc4e0ecbfc4827222c08c13. Both exact-head workflows35088046786 and
35088051822 passed all six Cargo steps on Ubuntu/macOS/Windows. Expected-head merge
6fe0a53 has the same file tree. Historical reports were not rewritten.

Local601 Rust/2 ignored helpers/152 Node/five examples are attributed to the implementor
reports, not re-executed here. Planner source review found no new confirmed B1 runtime
blocker in its reviewed paths; it was not an exhaustive security/dependency audit.

B1 is actual capture of supplied prepared input. It is NOT restored application-session
history, account-bound native replay, normal CLI persistence or a network service.
Those absences are agreed B1 scope, not B1 merge defects.

## 2. Source-to-plan map

All paths below are pinned to the baseline above. Line references are avoided where
private layout may change; use named symbols and compare actual code before editing.

| Source/symbol | Implemented fact | New B2 work, explicitly authorized |
|---|---|---|
| src/execution/mod.rs: run_persisted/run_held | Receipt-first guarded acceptance, shared admitted engine, final record | Add run_in_session/pure replay preparation, reuse this path and failure/hold machinery |
| src/execution/observer.rs | Actual events/result bytes await SessionHandle append | Add actual opened binding capture for B2 only, preserve sticky failure |
| src/execution/types.rs | Executed/Duplicate, phase-specific failure data | Reuse types; add History/ProviderBinding stages, not another result framework |
| src/run/mod.rs: admit_with_snapshot | Current definitions read/compared once; input/caps/cancel validation before opening | Add pure replay/new-input validation and optional private admitted seed |
| src/run/mod.rs: run_admitted/drive | One loop; supplied UUID; guarded provider; awaits observer; new-input/results only | Local fresh-control install before drive, no second loop or old-ID continuation |
| src/run/observer.rs | Private Send returned futures; synchronous callback evaluated before ready() | Default no-op opened hook with immutable data, not &ProviderStream across await |
| src/tools.rs: execute_next_observed | Actual effect -> serializer -> cache -> result observer -> finish | Unchanged for replay; historical output must not be regenerated |
| src/provider.rs: InputItem/Provider/SessionControl | Only User/ToolResult input, no history-install interface | Add typed replay/default unsupported methods; leave existing InputItem and session fields intact |
| src/gateway.rs | Provider map private; capability/read/open delegation | Add pure validate_replay delegation; no auth in it |
| src/providers/openai_codex/state.rs: Conversation | Native retained input, pending calls, last-response parent,2048/8MiB capacity | Compile closed historical items locally, no old parent, no pending imported effects |
| src/providers/openai_codex/mod.rs: open_session | Managed selection once per new provider session; then Wire::open | Keep selection semantics; carry actual loaded account marker rather than infer from a profile alias |
| src/providers/openai_codex/wire.rs: Wire::open/send | One initial load; WS owns handshake creds; SSE owns account ID and rechecks later | Derive immutable marker from actual initial credentials, no second credential read |
| src/providers/openai_codex/auth.rs: account_id | Crate-private actual account getter; token fields redacted/nonserializable | Domain-separated account digest; never token hash/serialization |
| src/providers/openai_codex/codec.rs / finalized.rs | Native normalization and distinct recovery provenance | Reuse classification rules; don't lose effective recovered items by parsing native.output=[] alone |
| src/storage/records.rs: RecordedRunInput | Current task/prepared request and provenance; no replay binding | Preserve it; put selection/binding in real canonical storage records |
| src/storage/session_v1.sql | Closed seven-name event CHECK; FK-linked receipts/projections | Explicit v2 table rebuild/migration for two new facts, not an undeclared schema write |
| src/storage/session_schema.rs / catalog_sync.rs | Version1 validation and explicit summary refresh | Support verified v1/v2 and same-head schema upgrade without content/head regression |
| src/storage/session.rs / lifecycle.rs | Shared acceptance coordination, owned operations and execution hold | Reuse; atomic H check; no DB lock while waiting for models/tools |
| src/storage/history.rs / run_store/repair.rs | Typed paged history and streamed canonical validation | Recognize/check both new facts, hash raw row payloads and validate scoped links |

Primary source root:
https://github.com/zer09/wi/tree/6fe0a538edf6bae39c9f933db8394b7d8483e2be/src

## 3. Decisions introduced by this contract

These are Wi design choices, not claims that Pi/Codex/OpenAI already enforce them:

- Native replay uses closed ordinary exchanges; incomplete/unbound input is refused
  without losing its readable history. A complete trailing real result is replayable
  only when a new user operation explicitly requests work.
- Same recorded provider, requested model and account-marker format for this first
  replay implementation. Cross-model/account conversion is not silently performed.
- B2 records the actual opened identity and history prefix selection; old records are
  not retroactively assigned the current account.
- Account marker is domain-separated SHA-256 of actual account ID, not token or alias.
  This is equality checking, not anonymization/provider authentication proof.
- Selected prefix H/digest commits with acceptance; concurrent change is a reported
  storage.stale_history conflict, not hidden retry or silently newer context.
- Session schema2, two added canonical events, lazy transactional v1 migration. Catalog
  remains schema1. No new credential/message-projection tables or alternate engine.
- B2 uses a fresh provider control with full native input on its first request. It never
  tries an old previous_response_id on that new socket as a speculative fast path.

These choices implement the user's explicit session persistence/no-auto-resume goals;
they are not new runtime budgets. The user can revise future capability scope, but the
local implementor must not silently replace this contract while implementing it.

## 4. Important consistency checks before coding

**Current input is separate from old history.** Provider::validate_replay takes options,
replay AND new_input. A method that sees only old history cannot prove the combined first
request fits. Use the same current definitions/options vector as admitted execution.

**Fixed H applies to all evidence.** Do not consult an unbounded/current run_record or
tool_result projection and mistake a result committed above H for proof inside H.
Use sequence-bound canonical records or explicitly verify every referenced sequence<=H.
Terminal/state conclusions are derived from that prefix. Concurrent completion after
H cannot turn an incomplete captured prefix into a valid one. Test this under P1B2-07/20.

**Raw payload hash is not DTO reserialization.** Existing typed read objects may apply
defaults/discard unknown outer fields. Hash the actual stored parsed row payload using
the specified crate-private streaming helper, not a reconstructed UI or typed message.
One hash pass can validate all prefix checkpoints gathered by the builder.

**Call-result flags stay in their actual evidence layer.** InputItem::ToolResult contains
call_id and output, not is_error. Preserve/check the recorded finish/result boolean;
do not add an unsupported boolean to OpenAI native function_call_output or infer it by
parsing the output string. ReplayExchange passes actual native input strings.

**Binding failure is not necessarily a storage failure.** Missing/wrong identity with
healthy storage becomes an ordinary recorded failed run with zero model attempts.
Only an actual failed/warned binding write uses the sticky observer error path. This
prevents a policy rejection from unnecessarily stranding an active task.

**Migration is not just user_version=2.** Rebuild the closed event CHECK and preserve
FK-dependent data/triggers/indexes. The temporary foreign_keys=OFF exception is confined
to the migration connection and restored before normal work. Validate both old/new
schemas, preserve unsupported files, and test real fault/process boundaries.

**Replaying a tool output is not replaying its effect.** Complete saved trailing results
can accompany a new explicit task without invoking old tools or automatically sampling.
Pending effects/results must remain uncertain and never be invented.

## 5. External research and its limits

OpenAI official documentation was rechecked for conversation input and fresh WebSocket
continuation mechanics:

- https://developers.openai.com/api/docs/guides/conversation-state
- https://developers.openai.com/api/docs/guides/websocket-mode

These public Platform docs inform input/connection semantics. They do not prove that
subscription credentials authorize every Platform API, that historical opaque content
works for all models, or that an old response ID remains usable after reconnect. This
contract stays on Wi's existing Codex subscription endpoint and uses no API-key fallback.
No live entitlement or opaque-portability probe was performed.

The uploaded Pi/Codex lifecycle and Wi checkpoint/old-architecture reports remain design
context. Their older implementation status and auto-retry patterns do not override the
current Rust baseline or the user's no-auto-resume rule. No new upstream checkout was
benchmarked for this matrix.

SQLite migration guidance: https://sqlite.org/lang_altertable.html . The create/copy/
drop/rename strategy in SCHEMA.md is a new tested migration requirement, not something
shown to work merely by a source comment or an in-memory demonstration.

## 6. Planner checks actually performed

- Read B1 report, current contract/matrix, source paths and relevant producer/consumer
  implementations; inspected exact-head job/step results and merged only after correction.
- Confirmed baseline lacked replay control and account-binding records; selected an
  explicit schema change instead of demanding impossible behavior without one.
- Inspected new-input/history bounds, native/effective source distinction, actual loaded
  account availability, legacy observer compatibility and storage identity semantics.
- Ran a reduced in-memory SQLite3.46.1 SQL smoke test of create/copy/drop/rename, preserving
  populated old rows/strings and FK references, recreating immutability triggers and
  accepting the two new event names. This is below the required linked implementation
  floor and is NOT the full production schema, Rust/SQLx, WAL/power-loss or migration
  acceptance test. The implementor must run the real matrix on bundled SQLite3.51.3.

Cargo/rustc are unavailable in the planner environment. No B2 compilation, test suite,
independent implementation review, crash injection or benchmark was run. All matrix
rows remain NOT RUN. No broad defect-free guarantee is made.

## 7. Review checklist for the local implementor

Map each acceptance row to its actual producer/consumer. In particular trace:
canonical prefix -> replay builder -> selected acceptance -> opened identity -> binding
commit -> fresh actor install -> first wire body -> real new results -> durable final.
A manually assembled expected replay array cannot prove the production builder used it.

Keep failing-first observations for actual defects; do not force old source to have a
feature it never claimed. Test negative migration/replay cases and positive legacy
controls, actual process reopen, both transports, source deletion, same IDs across runs,
concurrent submission/rename and all no-auto-work assertions. Independent complete-diff
review must cover schema, auth-identity derivation and shared engine changes together.

Any real specification conflict is reported with exact source/consumer and proposed
minimal correction before changing policy. A passing baseline or green older CI is
not new replay evidence. No further implementation/Git/live permission is inferred.
