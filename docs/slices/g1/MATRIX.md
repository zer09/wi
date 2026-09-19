# G1 bounded implementation and acceptance matrix

Contract **g1.0**. Baseline **76bb32fd04fd4737c0efcceaabc7d10387453147**.
**All 32 rows G1-00 through G1-31 are NOT RUN.** This is a requirements matrix,
not evidence. CONTRACT.md and CLIENT_PROTOCOL.md govern every assertion. Bounded
means scoped work and finite fixtures, not product task/time/history quotas.

## Oracles and isolation

Use actual Rust serving and SQLite with temporary synthetic owner/provider credentials,
workspaces, AGENTS.md and skills. The public browser uses the real compiled assets.
The joined oracle is:
`browser action -> actual HTTP -> auth/preparation -> RunHost -> B2 -> SQLite -> actual OpenAI loopback -> real tools -> committed HTTP/SSE -> DOM`.
Separate adapter tests, synthetic in-memory transcripts or mocked network responses
cannot satisfy the joined rows. Scripted providers remain useful for focused tests.

Use existing private barriers for acceptance, binding, model output, tool results
and shutdown. Never assert a paused writer is uncommitted by awaiting a public read
that needs its mutex. Use independent read-only SQLite snapshots/counters or correct
post-commit gates. No actual owner HOME/private skill/provider configuration. Disable
Playwright traces/HAR/video and request-header logging; screenshots use synthetic
conversation data with no visible token. Block browser requests outside explicit
loopback fixtures without fulfilling/mock-replacing the joined API responses.

For end-to-end tests, a cfg(test) ignored Rust child entry point may expose actual
http_api::serve using a synthetic gateway and stdin-driven fixture controls. Use the
Cargo JSON executable artifact rather than guessing a hashed test-binary filename.
All other tests invoke the real browser pages. Reap children and remove temporary
roots after shutdown. No production fake-provider flag, endpoint or credential bypass.
One Playwright worker is acceptable for repeatable fixture ownership; it is not a
runtime task limit. Multi-client concurrency is tested explicitly within fixtures.

## Required rows

| ID | Area | Required cases and pass oracle |
|---|---|---|
| G1-00 | Baseline and evidence | Inspect HEAD/ancestry, complete staged/unstaged/untracked work and owner changes. Confirm PR9 merge76bb32f and reviewed6805640 tree equivalence. Run isolated baseline gates or report actual blockers. Preserve original reports, source/CI attribution, ledger and no-live authority. |
| G1-01 | Independent Windows-removal audit | BEFORE feature edits review every f0adbdd->6805640 code/test/docs change; run `cargo test --test platform_support`. Manually scan source/tests/examples/scripts/manifests/workflows and current docs for true Windows-only branches, signals, reparse handling, SystemRoot, filename/suffix/script accommodations. Classify portable APIs/canaries/negative fixtures/transitive metadata/historical prose instead of deleting indiscriminately. Confirm all Unix safety/functional assertions remain. Record current Linux/macOS-only CI and the withdrawn03/33 subcases, not Windows PASS. Minimal residual cleanup has exact evidence and a separate diff; unrelated defect blocks rather than broadens scope. |
| G1-02 | Build and dependency boundary | Exact TypeScript5.9.3 and Playwright1.58.2 dev pins/lockfile, strict noEmitOnError, no frontend runtime dependency, no new Rust dependency. Committed dist builds into Rust without Node. Nonmutating recompile detects stale/missing/extra generated files including untracked ones. A deliberate type error fails without publishing partial assets. |
| G1-03 | Public asset delivery | Actual TCP GET/HEAD exact page/CSS/module paths deliver correct bytes/MIME/security headers with no token and zero per-request storage/context/provider/tool work. HEAD body empty. Query/nonempty body reject. Wrong Host/Origin still rejects. Unknown/traversal/encoded/private-source paths and unsupported methods do not enter a generic static-file/SPA bypass. |
| G1-04 | API security preserved | Every existing `/v1` read/write/SSE/cancel remains bearer/authority/origin protected after new public routes. Static exception cannot grant settings/history access. Existing common-boundary and secret-file/path tests remain. CSP has no inline/eval/CDN escape hatch; no source maps/config/token/session values in public bytes. |
| G1-05 | Token and connection lifecycle | Real Connect validates canonical token, clears field, gets settings/list without provider work. Requests use same-origin Authorization, credentials omit, no redirects/cache.401 clears state; Disconnect clears token/history/drafts and aborts readers but sends zero cancel/revoke/model requests. No token in browser storage/URLs/console/errors/assets/test artifacts. Browser extension/memory limits documented. |
| G1-06 | Runtime wire validation | Test actual DTO shapes including flat ErrorView, flattened catalog entry, canonical wrapper, nullable fields and api_version1. Wrong version/types/unknown kinds/missing fields/malformed media/JSON fail safely with static messages, not `as`-cast acceptance. No invented data/error envelope, provider-native fields or new API. |
| G1-07 | Session list and creation | Real UI settings-driven workspace selector, catalog pages/load-more/refresh, empty list and creation. Exact title bytes and actual generated session/receipt retained. Lost create reply plus explicit same-command retry yields one session; changed payload uses explicit new identity or honest conflict. No arbitrary workspace path/stat/probe or phantom restored messages in a fresh session. |
| G1-08 | Canonical selection and rename | Load selected canonical header/history; rename during active work, duplicate/lost reply, actual refresh updated/unchanged/failed/not_attempted handling. Stale catalog does not overwrite canonical title. Hash contains only valid sessionUUID; malformed fragment is inert; navigation never submits. Retired workspace history stays readable under existing API policy. |
| G1-09 | Early durable acceptance | Browser clicks Send while real acceptance SQL is paused: pending only, no saved transcript/202/provider open. Commit then pause model: actual matching receipt visible before completion. Canonical run.accepted replaces pending display once. Actual accepted failure is not labelled success. No local dispatch ID substituted for receipt. |
| G1-10 | Mutation idempotency/uncertainty | Immutable operation/run/exact text survives an ambiguous reply in page memory. Explicit receipt/run/history reconciliation verifies actual two-record B2 acceptance; absence or read failure does not prove rollback. Wrong-method/run/content receipt cannot confirm task. Explicit retry sends original body only; double activation has one pending command. Reload/EOF/navigation never POSTs automatically. |
| G1-11 | Failure and user input | Empty/oversized/context-invalid input, active-run409, stale-history, unknown commit, known acceptance warning, incomplete/unbound history and account mismatch display correct accepted/unknown/rejected distinctions. Preserve user draft/text and safe code/stage/certainty. No silent trimming, quotas, queueing, retry/fallback, context truncation or provider switching. |
| G1-12 | Fixed-head pages | At least three actual history pages; writes/rename/private checkpoints between first page/later pages/SSE attach. All initial pages stay throughH; later stream afterH includes every later record exactly once. Page32 is a read window, not a lifetime cutoff. No cursor advanced after a rejected page/read. |
| G1-13 | SSE framing | Byte/chunk-split tests for UTF-8/BOM/LF/CR/CRLF/comments/multipledata/blank delimiter/id/event fields. Parse actual server frames too. EOF partial frame not applied; bad UTF-8/JSON/schema/id/session rejects at last applied prefix. Heartbeats/no-ID errors/closed events never invent cursor or completion. No EventSource token URL or execution of retry fields. |
| G1-14 | Identity and numeric fidelity | Sequences/counters/indices/times above2^53 and near i64/u64 bounds stay exact strings/BigInt with no huge allocation. Qualified cursor crosssession/future/malformed/overflow errors remain visible. Exact duplicates are ignored; same-seq different eventID/content and gaps stop application. Object-key ordering alone is not a conflict. Cursor advances after successful reducer application only. |
| G1-15 | Observation epochs | Switch A->B while A page/frame/HTTP reply is pending, then release A: no A content/cursor/controls mutate B. Same check for Disconnect/reconnect and full-reload epochs. Old accepted work continues server-side; read abort does not call cancel. Pending mutation identity remains correctly associated or is explicitly lost on Disconnect, not silently retargeted. |
| G1-16 | Provisional/final rendering | Actual text/refusal/reasoning/function-argument deltas, item snapshots, multiple content/output indices and authoritative response replace provisional display without duplicate text. Native and recovered output, normalized-text fallback and unsupported marker are truthful. Run result does not append last answer. Validate pure reducer and rendered DOM text, not screenshots alone. |
| G1-17 | Tool fidelity and state | Real tool intent/start/result/finish/reuse: exact output strings/line endings/Unicode and actual is_error, including successful error-shaped JSON. Same call ID across runs isolated, reused result not a new effect/message. Finish without result does not fabricate output. Raw function arguments stay inert text, not commands or HTML. |
| G1-18 | Lifecycle and interrupted output | Distinguish response completion, run terminal, result_recorded and disconnected observer. Preserve committed partial content on failure/interruption, known upstream uncertainty and final recording failure. Old unbound/incomplete history can be read but cannot be made replayable by client omission. No false finished/cancelled state on EOF or server shutdown. |
| G1-19 | Explicit cancellation | Only explicit Cancel button POSTs selected session+run and `{}`. requested/not_tracked/closed distinguished from terminal truth; postcommit cancellation still preserves result evidence. Other session/client not affected. Closing tab, navigation, reload, Disconnect and parser failure send zero cancel commands. |
| G1-20 | Read reconnect | Drop stream mid-frame/afterreceived-beforeapplied/afterapplied; explicit Reconnect uses last APPLIED qualified cursor. Catch-up/replay duplicates do not duplicate transcript; conflicting duplicates fail. Preserve prefix and pending/executing state. Zero task resubmission, old provider-parent adoption or model retry follows observation recovery. |
| G1-21 | Multiple browser clients | Two independent authenticated contexts: A submits then closes its page while task pending; B watches actual committed output and final result, then issues a new explicit task. A's later reopened page reads same session. One slow/stalled reader does not cancel/block core or another browser; no shared browser token/storage dependency. |
| G1-22 | Joined WebSocket | Actual browser controls->HTTP->RunHost/B2->SQLite->OpenAI WS->real AddNumbers. First fresh conversation has empty prior replay; later task gets stored same-session history, no oldparent on new socket, then normal fresh continuation. Native AND recovered fixtures; real UI acceptance/history/SSE/DOM assertions and provider input/counter proof. No manually installed replay or route.fulfill substitution. |
| G1-23 | Joined provider SSE | Same complete path over provider SSE, labelled AND missing-MIME, native/recovered variants. Provider SSE and browser SSE remain independent streams. Preserve malformedidentity/wrongMIME uncertainty display and zero fallback. Verify real correlated output and rendered authoritative answer. |
| G1-24 | Joined S2 and identity guard | Browser task actually invokes catalog-bound load_skill, then real tool work; persisted skill result visible in UI. Delete/change source before later explicit task and prove historical result is restored, not reread as old instructions. Supporting script stays inert. Actual adapter accountX->Y rejection sends no history-bearing generation; UI shows honest failure, not an account picker/fallback. Both transport paths covered, sharing fixtures allowed. |
| G1-25 | XSS and private-data boundary | Exercise titles/user/model/refusal/reasoning/toolstrings containing HTML/script/URL/eventhandler/ANSI/control/Unicode canaries. DOM text stays exact where specified, zero execution/outbound resource fetch. Private owner/provider/binding/native/config canaries absent from all public assets/UI/errors/logs/storage. No unsafe HTML, automatic links, clipboard token or test trace leakage. |
| G1-26 | Process restart and shutdown | Real process stops during an accepted run; new supported-platform process over same storage, browser reopens and reads preserved interruption once, zero auto model/tool work. New explicit allowed task uses B2 or honestly refuses incomplete history. Server shutdown/wi.closed/EOF does not become fake completion; browser cannot keep host alive or manually release quarantine. |
| G1-27 | Keyboard/responsive presentation | Real Chromium at360x800 and1440x900; all connection/session/rename/send/cancel/reconnect controls usable with labels/focus and no pagewide horizontal overflow. Enter newline versus explicitSend/CtrlCmdEnter, no double-submit. Streaming doesn't stealfocus/force-scroll an earlier reader or flood livealerts. Inspect synthetic screenshots and actual keyboard/DOM assertions; screenshots alone not acceptance. |
| G1-28 | Finite resources/measurements | Record firstpage/acceptance/committedvisibility/reducer+render timings for three labelled finite conversation/client fixtures, including a long selected history and slow reader. No hard SLA, fastest or constantRSS claim. No task/history cap introduced to make rendering pass; document selected-history memory and rebuild-on-reload cost. Baseline provider/DB safeguards unchanged. |
| G1-29 | Native and offline regression | All six Cargo gates, platforminventory, verify.py, Node152suite and eight offlineexamples pass on actual accumulated diff. Existing publicAPI/provider/auth/schema/C1 protections remain. No Windows native CI/code restored, no fakeprovider production path, no ordinary CLI persistence change or hidden runtime budget. |
| G1-30 | Browser build/CI and complete review | npmci/typecheck/assetverification/unit/realChromiumE2E pass; browserjob is added without weakening two nativeOS jobs. Three fresh independent complete-diff reviewers inspect alltracked/untracked source, generatedassets, fixtures, privacy/receipt/reducer/signal paths and prerequisite platformaudit. Retain failures and diagnose; do not silently retry untilgreen or fabricate reviews. |
| G1-31 | Reports and submitted-head closure | Human/JSON report maps all32uniqueIDs/subcases to named actual tests/commands/sourcepaths/observer. Current docs describe actual text-first GUI, static public exception, memory-only ownerauth, manual observationreconnect, browserplatform and deploymentlimits. Historical reports unchanged. After separately authorizedpush verify BOTH workflows at exacthead: Linux/macOS sixCargo gates plus browserjob. Planning/docreview is not execution; no live/provider/deployment acceptance inferred. |

## Required command groups

Inspect scripts before execution. Use explicit synthetic roots and preserve trusted
build caches. Record installed toolchains and exact actual commands/exit status.
Do not run `two_turns` main, smoke, auth/profile/login/refresh, a real service config
or an owner-provisioned token. Existing unit-test auth fixtures remain permitted.

```
cargo fmt --all -- --check
cargo check --all-targets
cargo test --all-targets
cargo clippy --all-targets -- -D warnings
cargo build --all-targets
cargo test --doc
cargo test --test platform_support
uv run scripts/verify.py
node scripts/cli_retest.mjs --self-test
```

Run these eight existing examples in dev mode: run_offline, skills_offline,
skill_loading_offline, storage_offline, persisted_run_offline, conversation_offline,
host_offline, http_api_offline. Retain V1-B's release http_api_offline and its --loaded
fixture. Node/examples are separate commands, not inferred from Cargo CI. Use
--locked/--offline after dependency resolution where supported, without claiming
that a command used those flags when it did not.

In `web/`, required package scripts are build, typecheck, verify:assets, test and
test:e2e. `npm ci`; typecheck; nonmutating verify:assets; Node built-in unit tests;
`npx playwright install --with-deps chromium` in the isolated development/CI
environment; and actual Chromium test:e2e. build is used deliberately to update
checked-in assets, followed by verify:assets. No production runtime npm invocation.
Record exact package/browser versions, executable Rust fixture provenance, generated
file inventory, and no-trace/no-secret policy. `git diff --check` and explicit
untracked-file inspection are required.

## Reports and stopping rule

Create only from observed work:
- docs/slices/g1/VERIFICATION.md
- docs/slices/g1/verification.json

Record contract, baseline, actual source/evidence heads plus uncommitted state,
environment, original/final diff, separate G1-00/01 prerequisite results, every
matrix ID, exact assertions/testnames/commands/outcomes, failures and fixes,
reviewer roles/scope, native vs browser vs live evidence, security/deployment limits,
current documentation links, generated asset consistency, and later exact-head CI.
Machine fields include status,accepted,commands,matrix,platform_audit,findings,reviews,
ci,live_started:false,real_credential_reads:0,provider_generations:0 and unchanged
ledger. Do not prefill PASS from this specification or inflate counts with reruns,
childhelpers, parameter combinations or source regexdefinitions.

The original platform-removal/frozen V1-B reports remain unchanged. A newly observed
residual problem receives a new dated finding and focused disposition, not an edit
pretending it was always covered. All baseline and new cases require actual evidence.
Leave implementation uncommitted until owner authorization. No merge, deployment,
release, live probe or next feature follows automatically from offline acceptance.
