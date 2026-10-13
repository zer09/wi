# C35: native auxiliary and retained HTTP offline checks

Status: **local auxiliary execution and source-preservation verified**. All40 PARTIAL/accepted=false. No repository implementation/configuration/generated-file change occurred. Parent writes only this progress document and four current report/matrix/disposition files after gates finish. C34's failed implementation role and initial incomplete native attempt remain unchanged.

## Actual execution

Exact six EXPECTED_ENV values remain unchanged. The unmodified full verifier inherits CARGO_NET_OFFLINE=true/RUST_TEST_THREADS=4 as explicitly recorded extra harness variables. This is one identity-recorded detached invocation, not a retry of C34 to cure its role. The full verifier is an independent required G11-37 check. Its existing subprocess command arrays are unchanged and do not include --locked; Cargo.lock/source hashes remain unchanged, and C34's separate locked/offline gates remain saved.

| Current record | Actual result |
|---|---|
| `uv run scripts/verify.py` | PASS; static inventory418 Rust files/1174 authored test definitions/25 fixture events; all six existing Cargo steps fmt/check/test/Clippy/build/doc pass |
| Verifier all-target tests |1193 passed/11 existing ignores/0 failed/0 filtered; library916/10 ignored/877.54s; counts overlap C34 |
| Doc gate | PASS; zero doctests, no invented behavioral cases |
| `node scripts/cli_retest.mjs --self-test` | PASS;152 synthetic cases/live_started=false; in-memory fake launches only |
| HTTP offline dev default and `--loaded` | Both PASS; exact real local RunHost/tool/store/raw HTTP/SSE and awaited shutdown |
| HTTP offline release default and `--loaded` | Both PASS; one recorded detached release-build/default invocation, then loaded invocation |
| Source/owner/Git checks | Before/after778 records byte/mode/path-identical; HEAD/index/cached284/ledger31 used19 remaining/all40 unchanged |
| Parent saved-evidence binding |6 root gate records/12 log bindings rehashed; actual labels/native totals/CLI counts/HTTP completion and drain assertions verified without product reexecution |

Source: `scripts/verify.py:13-67`; CLI safe branch `scripts/cli_retest.mjs:311-317` and fake-child cases `scripts/cli_retest.test.mjs:47-437`; HTTP synthetic setup/run/awaited cleanup `examples/http_api_offline.rs:531-886`.

Platform_support passes within the current full verifier, overlapping its1193 total. C34's separate platform1 stays saved. Native execution is Linux-local, not macOS or hosted evidence. Source and lockfiles stay exact; no Windows support is restored or guard removed.

C21 retains eight old offline-main passes plus conversation_view_offline main/regression and the exact Before no-replay regression. Their previous execution is not counted as C35. New example's current SHA256 remains899738e02cdec949ed3113a8b4a68a340abc3b73f253247f9cc9901206d22892; no unnecessary storage/host/skills/main replay occurs. C35 reruns the retained HTTP main because HTTP asset source changed and the release/loaded group remained required.

## Finite retained HTTP observations

These observations measure canonical raw API1/history/SSE, not the new display endpoints. They do not close G11-36 migration/warm display/content/projection/peak-memory requirements. No SLA, constantRSS or dev/release speed comparison is claimed.

Default fixtures:4 metadata backlog records/262144 bytes,1 reader/4 reject+empty-poll requests. Loaded fixtures:40 records/10485760 bytes,4 readers/64 reject+empty-poll requests. All four runs reach final sequence19/exact1 tool+answer/1 replayed canonical record/fixed4 pages excluding later commit/client held-record peak6. That record count excludes encoded/network buffers.

| Loaded observation | dev | release |
|---|---:|---:|
| Backlog setup ms |10849.153|5531.587|
| Gate release to202 ms |62.131|54.851|
| Commit ACK to SSE ms |110.078|54.836|
| Fixed-head pages ms |349.753|191.135|
| Final committed history ms |405.494|222.871|
| Host+HTTP drain ms |258.128|139.964|

All runs report3 tracked TCP connections closed, HTTP drained,2 synthetic provider connections opened/closed; source also asserts listener refusal, host Closed and reopened cancelled outcome. All loaded runs show before/after session DB11087872/11235328 bytes and catalog299008; WAL0 is point-in-time only. No RSS or server SQL-connection census was measured. This is finite local main execution, not browser/actual OpenAI joined evidence or cleanup certification for earlier incomplete gates. Old uncertain roots stay untouched.

## Evidence and limits

(local record) plus six `{label}.json` command records and12 byte/SHA-bound logs. Full verifier and release-default launch identities are saved. No role completion/review is invented: this is parent-owned execution/evidence, with no implementation delegate or final complete-diff review. C34's two scoped PASS reviews remain separate.

No source/schema/dependency/workflow/reader/credential/auth/live/browser/C15/stress/active-conflict/hosted/Git transition/root cleanup action occurred. Synthetic owner-token files and scripted providers are existing sample behavior, not real credentials or a new provider. Historical failures and role statuses are preserved. Documentation-phase preservation excludes four parent-updated progress files, yielding774 nonassigned records. Expanded display parity/restart/measurements/runtime docs/browser/exact-head CI/final three complete-diff reviewers/acceptance remain open.
