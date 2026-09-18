# V1-B acceptance matrix

Contract **v1b.0**, baseline `16d623a3317abc7796ec203e4fe15d580791a769`.
**All 40 rows V1B-00 through V1B-39 are NOT RUN.** This is a fixed implementation assignment, not test evidence. CONTRACT.md, API.md and SECURITY.md govern. Complete every subcase; no target test-count inflation.

## Fixtures and oracles

Use real SQLite in temporary roots, synthetic private owner-token files, independent authorized HTTP clients, actual Axum TCP serving and the public service API. Providers are scripted or the existing cfg(test) OpenAI-Codex WS/SSE loopback adapter. Use actual AddNumbers and S2 loader where specified. The JOINED oracle is HTTP authentication/command -> server preparation -> RunClient/RunHost -> B2 -> SQLite -> real OpenAI loopback -> real tool -> HTTP history/SSE. Separate component tests or manually installed replay cannot substitute.

Two workspaces A/B have distinct AGENTS.md and same-named project skills, with global skill metadata present. Include deleted/changed skill sources, unapproved path canaries, malformed frontmatter and inert supporting scripts. Native fixtures include terminal and recovered output, refusal/reasoning, Unicode/CRLF, error-shaped successful tool JSON, unknown/signed fields with private canaries. Separate secret canaries in owner Authorization, provider credentials, binding, config paths and arbitrary diagnostic messages. Intended conversation text is not confused with forbidden metadata.

Use controlled provider/tool gates and existing test-only commit barriers, independent counters and read snapshots. A database read that waits on the deliberately held writer lock is not a valid precommit assertion. Never use real credentials, HOME skill roots, auth commands or live requests. Tests may use fake clocks for observation waits; external watchdogs are not task policy. Network client retries must be explicit test actions, never automatic model retries. All finite fixtures are test workloads, not runtime quotas.

## Required rows

| ID | Area | Required observed assertions |
|---|---|---|
| V1B-00 | Baseline/scope | Record exact HEAD/ancestry and staged/unstaged/untracked work; preserve owner edits. Run baseline gates or record actual blockers. Confirm V1-A merged, no live authority, old evidence unchanged. |
| V1B-01 | Dependency/public library | Exact minimal Axum0.8.9 features, necessary transitive lock changes only; public serve works with injected RunHost on Tokio, no CLI/provider auth dependency in request types. Old manifests' direct dependencies unchanged except Axum. |
| V1B-02 | Configuration | Strict fields/version/options/absolute paths/origin/listener; invalid config and non-loopback library listener fail before serving/provider credential reads. Workspace canonical aliases deduplicate; no process cwd change. Missing global root retains S1 behavior. |
| V1B-03 | Token file/verifier | Valid64hex and optionalLF; malformed/BOM/CRLF/oversize/symlink/special/nonprivate applicable Unix input fails. Windows reparse tests where privileges permit. No token/ephemeral verifier serialization or Debug leak; loaded once, change requires restart. HMAC uses real verifier; never provider OAuth as client credential. |
| V1B-04 | Authentication gate | Missing/wrong/duplicate/malformed bearer gets identical static401 with zero storage open/migration/context/provider/tool work. Correct token works for all protected routes including reads/SSE/cancel. Cookie/query/body/forwarded-user spoof does not authenticate. |
| V1B-05 | Authority/origin/CORS | Wrong/ambiguous Host, absolute-URI disagreement, wrongport, IPv6/default-port cases, null/multiple/foreign Origin reject. Valid bearer cannot bypass explicit foreign Origin. Absent Origin still needs bearer. Allowed preflight does no storage/effect work; no wildcard/Credentials/unknown-header reflection. |
| V1B-06 | HTTP parsing | Wrong method/path, missing/unknown/duplicate fields/query, invalid UUIDs, nullability, MIME/content encoding and streamed body bound map exact static errors. An authorized stalled body is interruptible by owner shutdown before dispatch; body failure causes zero acceptance. No raw parser/body errors. |
| V1B-07 | Creation/idempotency | Real HTTP creation commits original identity/title/workspace; same command returns original CreateResult, changed content conflicts and no extra DB. Lost reply then explicit retry still one session. Workspace removal policy is explicit; original session remains readable. |
| V1B-08 | Listing/open/rename | Catalog-only keyset listing over several pages, canonical manifest read, rename during pending run, duplicate/conflict and exact title preservation. Canonical commit remains known if refresh fails; explicit refresh Updated/Unchanged map without invented head. No fabricated live catalog guarantee. |
| V1B-09 | Workspace authority | Unapproved request path rejected before probing it; a retired recorded workspace stays readable but cannot start new context work. Replaced canonical alias rejected before discovery. Matching accepted task retry works despite retired/deleted workspace and does not read it. |
| V1B-10 | Real preparation | Raw HTTP text reaches actual S1/S2 preparation/capture; globals always plus project metadata, no unselected body; load_skill automatically available only when catalog nonempty. Blocking reads off Tokio worker. Capture notices on successful/fatal preparation before provider work; no arbitrary tool/config from caller. |
| V1B-11 | Early durable acceptance | Pause actual acceptance transaction: HTTP202 unavailable and no provider opening. Commit then pause model:202 contains actual original receipt while task pending. No dispatch ID substituted for commit. Cancel during commit drains SQL under existing semantics. |
| V1B-12 | Observer/response loss | Drop HTTP request/ticket acceptance/completion observers before and after acceptance; no receiver-drop cancellation or result fabrication. After host dispatch, work completes and history remains. Drop during pre-dispatch blocking preparation does not later dispatch from orphaned read worker. |
| V1B-13 | Receipt-first raw retry | Matching operation/run/exact text returns original two-record B2 acceptance without context/profile reads, even after files/settings change or reopen. Different text/run conflicts. A rename/append/B1 receipt with same operation must not be accepted as a B2 command. Verify actual canonical acceptance range and RecordedRun input. |
| V1B-14 | Concurrent submissions | Two initially absent receipt reads, same raw command and changing preparation snapshots: one actual executor, loser resolves actual receipt after failure or reports its honest point-in-time failure. Different raw content conflicts. No second dispatch on reconciliation, invented IDs, retained cache or new acceptance framework. |
| V1B-15 | Accepted failures/certainty | Actual accepted open/binding/install/model/recording failure returns acceptance evidence without task-success claim. Unknown commit is not not_committed; known cleanup receipt retained. Read-only reconciliation may find receipt, absent read never proves rollback. Exact safe error/stage/upstream mappings through producer/consumer. |
| V1B-16 | Status and operations | GET run distinguishes accepted/running/terminal and result_recorded; actual RunFinished without finalResult remains truthful. GET operation yields real receipt and notfound without retry. No raw RunCompletion/RecordedRun serialization or queried provider state. |
| V1B-17 | Explicit cancellation | Exact session+run request signals target only; wrongsession/wrongrun not_tracked, completed not_tracked, closed503. Signal response does not claim durable/upstream cancellation. Other clients/sessions continue and admitted SQL is awaited. |
| V1B-18 | Basic history/projection | Each canonical event yields exactly one EventView/checkpoint; raw usertext, actual tool output/is_error, runtime outcomes preserved; no duplication of response text at finalResult. Validate pure reference reducer with actual persisted records, not hand-assembled output-only JSON. |
| V1B-19 | Native privacy/rich text | Actual native/recovered/refusal/reasoning items project only allowed scalar fields; opaque signatures/unknown fields/extensions/account markers/config snapshots stay absent. Unicode/newlines preserved, unsupported content marked. Unknown error strings cannot leak a canary. Canonical stored bytes unchanged. |
| V1B-20 | Cursors/numeric fidelity | UUID-qualified cursor rejects crosssession, malformed decimal, overflow and futurehead. IDs/seq/count/times above2^53 remain exact strings; no fullscale allocation needed. Page limits are windows only, multi-page history succeeds with no lifetime cap. |
| V1B-21 | Snapshot boundaries | Commit records between firstpage, laterpage and SSE attach; pages through H exclude >H, streamafterH includes them once and in order. Rename/private checkpoint at boundary cannot create a gap. No long SQL transaction during network waits. |
| V1B-22 | SSE wire | Real HTTP SSE content type/framing, JSON newline/Unicode safety, correct id per record, no raw control/header injection. after/header same accepted, conflict rejected. Initial auth/cursor/storage error is HTTP failure before200; heartbeat has noID. |
| V1B-23 | Live committed stream | Independent client observes committed partial output while model pending; nothing uncommitted is sent. Catch-up fixedhead then laterpoll has no missed records even if commits fall between reads. Controlled 250mswait/heartbeat without task deadline; no queue-based false commit acknowledgment. |
| V1B-24 | Reconnect and slow clients | Two authenticated clients see same session; one stalls/drops during snapshot/live and other/host progresses. Resume from lastapplied cursor; duplicate replay deduplicated, conflicting same-seq data detectable. No provider receiver ownership, unbounded stream queue or writer lock under slow send. |
| V1B-25 | Stream read failure | Actual post-header storage error emits static noID wi.error then closes; no false advancingcursor or runcancel. Initial error usesHTTPstatus. Owner shutdown closes SSE without masquerading as runfinished. Unavailable session cannot expose raw path/SQL. |
| V1B-26 | Joined WS | Actual HTTP->host->B2->SQLite->OpenAI WS->tools. First task in empty session has empty replay; second explicit task uses only prior same-session history, fresh connection without oldparent then normal newparent continuation. Native AND recovered variants. HTTP receipt/history/SSE assertions; no direct install_replay as action under test. |
| V1B-27 | Joined SSE | Same full path with provider SSE, labelled AND missing-MIME fixtures and native/recovered output. Exact native/effective input/results; browser SSE is distinct from provider SSE. Retain wrong-MIME/empty-ID error/uncertainty classifications with no fallback. |
| V1B-28 | Joined account guard | Persist A under synthetic accountX; open B withY via actual adapter and HTTP, record mismatch but zero history-bearing generation; later explicitX works. Both transports. Token-authenticated browser is not authorized to bypass B2 equality or search profiles. |
| V1B-29 | Joined S2 fidelity | Model actually loads skill viaHTTPtask and actualtool; saved result appears in history, source deleted/changed afterward; new explicit task receives stored result not reread historical instructions. Current preparation still follows its own current roots. Supporting script/resource canaries remain inert. |
| V1B-30 | Shutdown owned work | Start actual model/tool pending work plus reader/stalled-body clients, request shutdown: reject new commands, signal/drain host with storage writable, await HTTP drain and original ShutdownOutcome. Commit barriers prove no premature storage close. No deadline/abort shortcut; losing shutdown waiter does not cancel coordinator. |
| V1B-31 | Owner drop and worker loss | Isolated tests drop serving future/trigger serving error/panic and show shutdown initiation independent of handler Arc clones; only observed awaited completion claims clean shutdown. Existing host WorkerLost/quarantine remains explicit; no manually unlocked lease/fabricated terminal. |
| V1B-32 | Fresh-process reopening | Public server process records actual partial/complete history then stops; fresh process reads it and observes interruption once with zero provider/toolwork. Reconnect alone no resume. Only explicit new task invokes B2, refusing incomplete/unbound history and preserving readable records. |
| V1B-33 | CLI actual wiring | Real `wi serve --help` and injected start handler; strict config, actual boundaddress, no secret print/browserlaunch/auth command, correct signal/shutdown result. Process tests use synthetic paths/gateway; old CLI commands/help/exit/NDJSON remain unchanged. |
| V1B-34 | Whole-response/log privacy | Capture every route, error, SSE, config/token Debug and normal diagnostics with secretcanaries. Only explicit permitted user/toolcontent passes; no internalDTO serde escape hatch, provider message, opaqueJSON, auth or data path. Auth failure precedes all sensitive reads. |
| V1B-35 | Schema/core nonregression | All accepted B2/V1A/storage/context/tool/auth cases unchanged; sessionDB2/catalog1/stored1/runtime2/provider1. New HTTPapi1 is separate. No RunLimits, hidden scheduling/retention/deletion framework, provider/tool changes, auth fallback, new database or GUI. |
| V1B-36 | Offline example | `http_api_offline` uses actual TCP+auth, SQLite+RunHost+scripted provider+real AddNumbers, creates/submits, receives commitbeforefinal, consumes history/SSE, drops/reconnects clients, explicitly shuts down. No realconfig/auth/model/network beyond loopback. Existing seven examples still pass. |
| V1B-37 | Performance/resources | Three labelled finite samples (dev/release/loaded) measure acceptance latency, committed-record visibility, page read and shutdown/drain observations, client-held records, connections closed and DB sizes. Do not claim benchmark winner/SLA/constantRSS; report poll/open-close overhead and any timing failure. Slow client isolation measured, not hidden with a lifetime cap. |
| V1B-38 | Docs/evidence | Active CLI/API/security/deployment docs agree with implemented behavior, known proxy/sharedsecret/projection/catalog limits explicit. Full40-row JSON/human evidence, exacttestnames/commands/source paths/review roles, firstfailures and lateCI separate. Old contracts/reports untouched; update current indexes/status only. |
| V1B-39 | Final gates/review/CI | All local old/newgates and fresh independent complete-diff reviews pass; no misseduntrackedfiles. After separately authorizedpush, all sixCargo steps allOS on exacthead and both workflows. Retain failedattempts and diagnose; do not weaken jobs/lints/assertions or silently rerun untilgreen. |

## Commands and evidence

Record exact installed toolchain/OS, isolation, baseline/final heads and uncommitted state. Normal dependency fetching for Axum is development traffic; it is not permission for provider probes. Use --locked/--offline after the authorized lock resolution where available. Do not invoke smoke, two_turns main, login, status, refresh or real serve configuration.

```
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
cargo run --example host_offline
cargo run --example http_api_offline
cargo run --release --example http_api_offline
git diff --check
```

The V1-A reported750 passes/6 ignored helpers/152Node are historical comparison, not an expected exact new total. Separate source definitions, unique harness passes, helpers, examples, focused reruns and zero doctests. Cross-platform exclusions need narrow grounds and positive applicable coverage. Three fresh final reviewers inspect the complete accumulated diff, especially security, raw-command idempotency, projection privacy, commit/cancel and HTTP-host-storage lifetime. Do not invent unavailable signoffs.

Create docs/slices/v1b/VERIFICATION.md and verification.json only from observed work. Human report: scope/revision/environment, baseline, actual changes, everyrow with concrete assertions/tests, commands/counts, firstfailures/fixes, source/dependency diff, reviewers, localvsCIvsunrunlive, performance, limitations, authorization/ledger. JSON required fields:

```json
{"schema_version":1,"contract":"v1b.0","baseline":"16d623a3317abc7796ec203e4fe15d580791a769","tested_revision":null,"tested_worktree":null,"status":"NOT_RUN","accepted":false,"matrix":[],"commands":[],"reviews":[],"findings":[],"ci":[],"performance":[],"limitations":[],"live_started":false,"real_credential_reads":0,"provider_generations":0,"ledger":{"used":31,"cap":50,"remaining":19,"changed":false}}
```

matrix must contain exactly V1B-00..39 once, each with status, assertions, tests, command references, actual observer and blockers. Offline acceptance is not deployment/live acceptance. Evidence count claims must be reproducible from reportdata. Leave implementation uncommitted until the owner authorizes Git writes. This document grants no merge/release/deployment permission.
