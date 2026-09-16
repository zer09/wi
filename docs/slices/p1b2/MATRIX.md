# P1-B2 acceptance matrix

Contract **p1b2.0**. Baseline `6fe0a538edf6bae39c9f933db8394b7d8483e2be`.
All **36 rows P1B2-00 through P1B2-35 are NOT RUN**. CONTRACT.md and SCHEMA.md fix the
requirements; VALIDATION.md separates source facts from the newly authorized changes.
No local/CI/live PASS is prefilled by this plan.

## Fixtures and evidence

Use real bundled SQLite, temporary private roots, synthetic context/credentials, a
separate scripted provider, and both existing OpenAI loopback transports. Use the real
public run_in_session path and real tools to produce history. Do not fabricate stored
success that the tested producer never emitted. SQL-only mutation fixtures are negative
integrity tests, not evidence of real execution. Use barriers, not timing guesses.

- A: first task uses add_numbers(17,25), receives exact sum42 and final text.
- B: second explicit task refers to A and uses another real call then completes.
- S: main SKILL.md is loaded in A; delete/change it before B and prove old bytes replay.
- R: native-terminal and validated-output-item-done recovery; encrypted/opaque fields,
  Unicode, CRLF, refusal, empty text and reasoning-only items.
- I: interrupted prefixes after complete response/results, unfinished response, tool
  intent without result, partial tool batch, and definitely unsubmitted failed attempt.
- X/Y: synthetic account identities; same account refreshed token, different account,
  provider/model/format mismatch and missing identity.
- D: duplicate commands before/after completion/reopen and concurrent absent lookups.
- V1: independent populated old SQLite schema; V2: new initialized/migrated schema.

Use finite workload sizes only in tests. No task/run/history lifetime budget, automatic
retention or arbitrary elapsed-time production restriction. Local testing must not read
real profiles/skills, invoke auth commands or contact a real provider. Build cache access
is not model usage. Old proof counts are historical, not targets.

## Required matrix

| ID | Requirement | Concrete acceptance observations | Status |
|---|---|---|---|
| P1B2-00 | Baseline and scope | Record HEAD/ancestry/worktree including untracked files, current gates, toolchain and unchanged dependency lock. B1 is merged; history restoration is absent. Preserve prior reports and no-live ledger. | NOT RUN |
| P1B2-01 | Additive shared interfaces | run_in_session and read-only preparation work through library APIs. Existing Provider/SessionControl implementors use unsupported defaults without rewrites. Legacy non-Send run callback still works; new future is Send. Same admitted loop/registry/B1 observer path, not a second engine. | NOT RUN |
| P1B2-02 | Genuine v1->v2 migration | Populate independent v1 with rename/multiple runs/native/effective/tool/receipt records. Explicit open migrates to v2, preserves every original row/payload string/ID/receipt and prefix digest, validates FK/index/trigger integrity. New sessions initialize v2 directly. Catalog schema remains1. | NOT RUN |
| P1B2-03 | Migration failure boundaries | Inject/exit during create-copy/drop-rename/precommit/postcommit; fresh-process reopen sees complete v1 or v2. Unknown/future/foreign/corrupt data is preserved; normal FK setting restored and connection retired. No run, account binding or model/tool work manufactured by migration. | NOT RUN |
| P1B2-04 | Typed canonical metadata | Two real new event types decode/read/serialize with storage envelope1 and event_version1; runtime/provider remain2/1. Selection and binding constructors reject malformed digests/IDs/policies/linkage. No fake provider event or secret-bearing field. Legacy event payloads remain unchanged. | NOT RUN |
| P1B2-05 | Atomic selected-history acceptance | H+1 accepted and H+2 selection share one transaction/head/receipt and original input. A failed second row rolls back both. Same method/content repeats original range; different method/run/input/selection conflicts. No selected-only row or later retrofit to old runs. | NOT RUN |
| P1B2-06 | Stale-head concurrency | Pause after compiling H; a rename or another completed run advances head. New acceptance fails storage.stale_history/NotCommitted with zero new run/provider activity. Existing identical receipt still wins over stale eligibility. No automatic rebuild/retry. | NOT RUN |
| P1B2-07 | Prefix digest and paged read | Verify independent digest oracle on actual canonical row values, including null/source fields, Unicode and exact embedded JSON strings. Hash across page boundaries; detect gaps/changed content/selection linkage. No repeated recursive full-prefix reads or full token-log retention; projection/schema/catalog changes do not change digest. | NOT RUN |
| P1B2-08 | Pure replay preparation | Builder opens no provider, reads no credentials/skill files and executes no tools. Same H yields deterministic typed replay and selection. It uses all required rows at fixed head despite later appends, distinguishing original user text from prepared model input. | NOT RUN |
| P1B2-09 | Initial B2 session | Empty conversation after create/renames yields empty replay but records selection and actual opened binding before first generate. Exact new prepared prompt and current instructions/tools reach provider; no extra classifier/model request. | NOT RUN |
| P1B2-10 | Second task in same session | Real A then explicit B create distinct runs. B receives A's user input, authoritative responses, actual results and B's new user input exactly once/in order. New task uses current definitions/instructions without promoting old skill bodies or tools into authority. | NOT RUN |
| P1B2-11 | Fresh-process explicit continuation | Produce A, close store/process, reopen and read without provider/tool work; only explicit B starts work using retained context. Old task stays terminal. The fresh control is not an old socket/response handle. | NOT RUN |
| P1B2-12 | Real tool/result ordering | Reconstruct multiple rounds and multi-call response order from actual records; success/gateway_error/tool_output_limit/error-shaped-Ok preserve exact output and flag. Original request and run-scoped identities are retained. No Tool::validate/execute is called by replay preparation. | NOT RUN |
| P1B2-13 | Call reuse and scope | Reuse within A and repeat call_id in B; old saved output is not executed/read again, current new calls have fresh cache scope. No global call-ID rewriting. Missing/wrong-origin/result conflict is rejected before new acceptance. | NOT RUN |
| P1B2-14 | Native and effective fidelity | NativeTerminal and recovery R both replay actual effective items; recovered native.output remains[] in storage. Preserve opaque encrypted values, refusal, Unicode and part structure. No delta duplication, UI-text flattening, empty-string overvalidation or stripping of opaque fields. | NOT RUN |
| P1B2-15 | Actual identity source | Marker is derived from credentials used by real loopback Wire::open, not a second load/profile alias/token hash. Rotated token for same synthetic account has same marker; accountY differs. Redacted diagnostics expose neither identifier nor marker. Existing managed/external tests and selection counts unchanged. | NOT RUN |
| P1B2-16 | Binding guard before history send | A bound toX; configure B toY. Record actual attemptedY binding and a truthful failed run with zero generate/tool calls; no old native history or new prompt leaves over either transport. No fallback/reselection. MatchingX control succeeds. Direct install with mismatched identity also rejects. | NOT RUN |
| P1B2-17 | Provider/model/format boundary | Unsupported provider default, changed provider, changed requested model and wrong replay format reject pure preflight before acceptance/auth/open. Preserve observed response.model aliases rather than assuming they equal request literal. Missing opened identity produces recorded history_identity failure without generation. | NOT RUN |
| P1B2-18 | Actor install lifecycle | Install once on a fresh control; no generation/events/network send. Invalid install leaves original state intact. Busy/used/closed/repeated/concurrent install/generate reject deterministically. Cancellation/drop closes ownership without a retry or unsolicited request; idle WS behavior remains. | NOT RUN |
| P1B2-19 | Closed interrupted exchange | Real process exits after complete response and complete real tool-result batch before old continuation, or after final no-call response before runtime terminal. Reopen interrupts old run once; NEW explicit task replays closed exchanges/results and does not execute/resend an old request automatically. Old run remains interrupted. | NOT RUN |
| P1B2-20 | Incomplete history fails honestly | Real partial response, uncertain admitted request, start-without-result, incomplete result batch, malformed/unsupported executable output: explicit replay rejects before new acceptance/provider work. Stored prefix is readable unchanged; no invented cancellation output, summary, tail skipping, opacity removal or task replay. | NOT RUN |
| P1B2-21 | Definitely unsubmitted attempts | Completed recorded attempt with actual RunResult zero attempts/admissions, no last_response/provider/tool records is explicitly excluded from MODEL context but retained in storage and returned disposition. Missing final result alone does not prove no submission. A prior binding-mismatch attempt does not poison otherwise valid history for a later explicit matching-account task. | NOT RUN |
| P1B2-22 | Legacy unbound histories | B1/manual v1 or v2 history with no selection/binding remains readable and repairable, but replay rejects missing provenance before provider access. Migration/current account cannot backfill ownership or pretend prior independent runs formed a chain. Empty session with no prior run remains usable. | NOT RUN |
| P1B2-23 | Duplicate races | Existing B2 operation with current cancelled token/unavailable provider/changed registry/history returns original receipt and current run without replay build or execution. Both absent-lookups race produces one executor; direct storage acceptance shares coordination. Conflicting reuse creates zero extra work. | NOT RUN |
| P1B2-24 | Input and context capacity ownership | Historical native input can exceed128 items/1MiB while fitting existing2048/8MiB context and succeeds. Validate new input separately; history+new task over existing context capacity fails before acceptance with no truncation/deletion/new budget. Escape overhead counted by actual serialized native input. | NOT RUN |
| P1B2-25 | Storage/cancellation failure ordering | Pause/fail selection, binding and ordinary B1 record commits. Await admitted SQL, retain IDs/certainty/warnings and actual outcome. Binding storage failure prevents history installation/generate; policy mismatch is a recorded execution failure, not false storage rollback. Final-result semantics and sticky first failure remain. | NOT RUN |
| P1B2-26 | Close/drop/process ownership | History preparation/install/provider/tool waits respect existing execution hold, child cancellation and close drain. Direct owning-future drop/abort is isolated-child quarantine, not browser detach. Reopen/migrate/repair/build performs zero auth/install/generate/effects; old receipts never resume. | NOT RUN |
| P1B2-27 | Real WebSocket restored path | A persisted using real adapter; B opens ONE fresh socket. Its first response.create includes full native history+new prompt and no old previous_response_id. B's subsequent result continuation uses ONLY new result plus B's new parent ID. Assert payloads at the real wire and persistence barriers, with native and recovered variants. | NOT RUN |
| P1B2-28 | Real SSE restored path | A then B with both labelled/missing-MIME controls. Full ordered effective/native history and real results are sent exactly; no parent ID, fallback or opaque loss. Failed/malformed admission preserves existing codes and upstream uncertainty. | NOT RUN |
| P1B2-29 | Real S2 context across submissions | Load skill in A, then delete/change source; B replays exact recorded body without reread. Current preparation can advertise current catalog independently. Historical script/resource canaries remain inert; historical metadata does not register/authorize tools. Same-name global/project identities retained. | NOT RUN |
| P1B2-30 | Version-aware repair and availability | Explicit streamed repair validates v1/v2, selection digest/linkage, unique actual bindings and run projections; corrupted metadata marks only affected session unavailable. It does not execute or bind missing legacy history. Catalog same-head schema refresh1->2 works only with matching canonical summary; stale/head/content protections remain. | NOT RUN |
| P1B2-31 | Isolation and independent observation | Two sessions, same call IDs, different accounts/contexts cannot leak input or cache. Retained run continues while history reader is dropped. Rename while execution awaits remains ordered; no DB lock across provider/tool waits and no new task manager. | NOT RUN |
| P1B2-32 | Existing contracts | All P1-A/B1/C1/S1/S2/R1/auth/provider regressions pass with unchanged behavioral assertions. Version-specific expectations adapt only to explicit migration. No CLI behavior change, new dependency, loop, retry, run limit, storage quota, server/GUI or credential-policy change. | NOT RUN |
| P1B2-33 | Public offline example and measurements | conversation_offline uses real public APIs: A with tool/S2 result, close/reopen, no-work read, explicit B that needs A, then new tool and final response. Assert exact seeded provider input. Record prepare/read/install/end-to-end timing and sizes, dev/release, no SLA/fastest claim. Five older examples still pass. | NOT RUN |
| P1B2-34 | Evidence and current docs | Both reports cover36 unique rows, first failures/fixes, source vs execution, schema migration, unbound/incomplete limits, identity privacy, exact reviewed revision and ledger. Current docs distinguish B1/B2/V1; frozen earlier reports stay unchanged. No claim all interrupted histories or live opaque portability work. | NOT RUN |
| P1B2-35 | Final independent review/CI | Complete accumulated diff including untracked files receives fresh independent review of migration, replay reconstruction, identity/transport gating, failure/duplicate/ownership paths. All local gates pass, then exact-head push/PR six Cargo steps on3OS after authorized push. No CI/lint/security assertion weakening. | NOT RUN |

## Required commands

```text
cargo fmt --all -- --check
cargo check --all-targets
cargo test --all-targets
cargo clippy --all-targets -- -D warnings
cargo build --all-targets
cargo test --doc
uv run scripts/verify.py
node scripts/cli_retest.mjs --self-test
cargo run --example run_offline
cargo run --example skills_offline
cargo run --example skill_loading_offline
cargo run --example storage_offline
cargo run --example persisted_run_offline
cargo run --example conversation_offline
cargo run --release --example conversation_offline
git diff --check
```

Inspect every untracked path for whitespace too. Normal build/dependency cache traffic
is permitted; no Cargo dependency changes expected. Do not execute two_turns/smoke/live
runner or authentication commands. Use explicit synthetic environment/roots while
preserving trusted toolchain caches. Native OS fixture applicability must be honest;
no skipped security fixture labelled PASS. Rust definitions, filtered tests, ignored
child helpers, examples, reruns and doctests are separate quantities. Zero doctests is
zero extra coverage. B1's601/2ignored/152 are historical observations, not a target.

## Reports to create from actual work

`docs/slices/p1b2/VERIFICATION.md` and `verification.json`.
Human report: verdict/revision/worktree; baseline; actual API/storage migration diff;
36-row assertions; replay policy and provenance; token/account handling; event and effect
ordering; duplicate/fault/process results; first failures/fixes; commands/counts/platforms;
actual independent review; finite performance; explicit unimplemented cases; authority.

Machine report minimum:

```json
{
  "contract":"p1b2.0", "status":"NOT_RUN", "accepted":false,
  "baseline":"6fe0a538edf6bae39c9f933db8394b7d8483e2be",
  "tested_revision":null, "worktree":null, "environment":{},
  "matrix":[], "commands":[], "migration_evidence":[],
  "replay_and_binding_evidence":[], "failure_and_reopen_cases":[],
  "reviews":[], "submitted_ci":[], "performance_observations":[],
  "limitations":[], "normal_cli_persistence_implemented":false,
  "service_implemented":false, "live_started":false,
  "real_credential_reads":0, "provider_generations":0,
  "ledger":{"used":31,"cap":50,"remaining":19,"changed":false}
}
```

Each matrix row includes ID/status/observer/assertions/tests/commands/source/blockers.
Store canaries, actual account markers and native content stay in temporary fixtures,
not public verification output. A source-derived claim is not an executed test. The
planner's DDL/contract validation is not Rust or crash acceptance. Preserve unrun cases.

No implementation commit/push/merge, release/deployment, real credential/provider test
or subsequent milestone is authorized by passing the offline matrix.
