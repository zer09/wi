# Wi: combined implementation and verification report

Prepared 2026-09-08 UTC for the design conversation.

## Result

The inherited Rust gateway was repaired, then extended into **Wi 0.2.0** with
Wi-owned multi-account authentication. Both bounded live milestones passed on
local Linux using `gpt-6-astra`. Pi was the authoring/review agent, not a gateway
runtime dependency or implementation substitute.

The work stopped at the agreed matrix. No further generation requests or feature
expansion are planned. This report and the latest live evidence are prepared for
the user's authorized commit and push to `origin/master`; final Git delivery
confirmation supplies the report commit ID.

## Commits and evidence boundaries

| Commit | Implementation | Evidence |
|---|---|---|
| `718c43afd2a0d826dccc85e7d1c50034139816e4` | Response recovery, lifecycle/tool validation and SSE admission repairs | External Codex OAuth: all six WS/SSE cases passed; 134 Rust and 152 runner tests |
| `27539bd39a19ea5fcf55e8d9159ccc89ce2dcbbf` | Wi naming, managed profiles and experimental browser login | 177 Rust and 152 runner tests; one successful live login |
| `17ba3c332519e5cb6337a1dae4c19ed4cc28a154` | Real credential renewal and two-account authentication | 187 Rust and 152 runner tests; L0 two-account login and L1 explicit refresh passed |

The first commit was already pushed. The latter two were local when this report
was prepared and are included in the authorized push. The new Wi-managed
W1-W3/S1-S3 live tests ran against unchanged runtime code at `17ba3c3`; their
records and this report form a separate documentation commit. Do not attribute
those later live results to evidence already present in the implementation commits.

## Milestone 1: repair the inherited gateway

The existing native Rust library and CLI remain the basis of the project:
compiled-in provider traits, persistent WebSocket sessions, explicit SSE, typed
items/events, continuation, and one deterministic local `add_numbers` tool.

Repairs established these boundaries:

- A validated terminal response remains authoritative. For a completed terminal
  with explicit `output:[]`, bounded, fully validated finalized items can supply
  effective output. Recovery is all-or-nothing and never reconstructs executable
  calls from deltas or provisional items. Conflicting associated evidence fails
  closed. Output provenance distinguishes recovery from native terminal output.
- CLI acceptance rejects discarded or conflicting streamed/finalized output.
  Tool validation rejects unsupported namespaces and incomplete or malformed
  calls before execution or continuation. The smoke tool case requires exact
  arguments, one correlated local execution/result and the final ordinary answer.
- Submission outcomes distinguish local preflight rejection from ambiguous
  network submission. No generation retry, fallback or reconnect replay was added.
- SSE admission normally requires `text/event-stream`. Only a successful response
  with an entirely absent Content-Type can use the bounded strict SSE prolog
  check. Inspected bytes are replayed exactly once through the ordinary decoder.
  Present invalid MIME types and failed HTTP responses remain rejected.
- Diagnostics retain sanitized structural evidence rather than raw provider
  streams, headers, tokens or identifiers.

All six external-Codex-auth cases passed: WebSocket text, continuation and tool
round trip; SSE text, continuation and tool round trip. Earlier failed attempts
remain in the historical ledger and were not rewritten as successes.

## Milestone 2: Wi-owned managed authentication

### Delivered behavior

- Package, library and binary are named **Wi**, version 0.2.0. The provider ID
  remains `openai-codex`. Client identification remains Wi, not Pi or Codex.
- Wi owns a versioned private JSON profile store under its XDG/HOME configuration
  directory. Managed persistence uses Linux filesystem protections, locking,
  atomic replacement and durable rotation guards. It is not an OS-keyring design.
- Multiple named profiles are supported. Explicit selection is deterministic;
  default selection samples uniformly from eligible profiles once per session.
  Selection policy is encapsulated for later changes, without quota-based routing.
- A session pins the selected profile, provider account and login incarnation.
  It cannot silently switch accounts after logout, replacement, expiry or failure.
- `wi auth login --experimental` performs bounded browser authorization-code
  PKCE login and persists Wi-owned credentials after successful exchange.
- `wi auth list` and `wi auth status` expose local metadata only. Logout deletes
  only the selected Wi profile; it does not revoke remote credentials.
- Real refresh-token exchange is connected to explicit refresh and automatic
  preparation. Serialization and durable rotation guards prevent unsafe reuse
  after ambiguous exchange, cancellation or persistence failure.
- Existing Pi/Codex credential sources remain explicitly selected and read-only.
  The new Wi live matrix did not read or alter their auth files. There is no
  credential copying, API-key fallback or API-billing fallback.

### When renewal occurs

| Situation | Behavior |
|---|---|
| New managed session | Refresh if expired or within the 30-second freshness margin |
| Before each SSE request | Prepare again; refresh if needed without changing the pinned identity |
| Existing WebSocket | Keep handshake credentials fixed; a request reaching the expiry margin fails and requires a new session |
| `wi auth refresh` | Force one refresh even if credentials are still fresh |
| Idle, list/status or read-only credential load | No refresh and no background timer |

Only explicit renewal has live acceptance evidence. Automatic expiry-triggered
renewal, cancellation, rotation failures and cross-process races have synthetic
and loopback evidence, not live failure-injection claims.

### Experimental authorization and trust limits

Browser login and renewal use the shared public Pi/Codex OAuth registration as an
explicitly selected compatibility experiment. Successful login, refresh and
inference do **not** establish OpenAI approval of independent registration reuse
or stable provider support. Wi must stop on provider denial or restriction.

The fixed TLS token response supplies account and expiry claims. Local claim
decoding is not JWT signature verification and does not validate arbitrary
imported credentials. Returned credentials and errors are bounded and redacted.
See [Wi authentication](WI_AUTH.md) for the exact configuration and protections.

## New managed-auth live matrix

Every row below is observed local Linux evidence. No case was repeated to obtain
a preferred random account or a passing result.

| ID | Case | Profile | Result | Generation submissions |
|---|---|---|---|---:|
| L0 | Two distinct-account logins and fresh status checks | Both profiles | PASS | 0 |
| L1 | One explicit refresh and fresh persisted status | wi-experiment | PASS | 0 |
| W1 | WebSocket text | Explicit wi-experiment | PASS | 1 |
| W2 | WebSocket continuation | Random wi-experiment | PASS | 2 |
| W3 | WebSocket add_numbers round trip | Random wi-secondary | PASS | 2 |
| S1 | SSE text | Explicit wi-secondary | PASS | 1 |
| S2 | SSE continuation | Random wi-experiment | PASS | 2 |
| S3 | SSE add_numbers round trip | Random wi-experiment | PASS | 2 |

W2/W3 proved actual same-socket reuse and required request linkage. S2/S3 proved
native history replay; the tool cases also proved correlated result delivery.
Both tool cases validated `add_numbers(17,25)`, exactly one local execution,
result `42` and final answer `42`.

All new live terminals had explicit empty native output; accepted effective
items came from validated finalized-item recovery. Effective expected, normalized
and streamed text checks passed where applicable. Native terminal text was
unavailable, not independently equal to the expected text.

All new SSE responses were HTTP 200 with missing Content-Type and passed the
existing strict SSE prolog check. No MIME-policy change was made during live
execution. Opaque items were not emitted, so live opaque replay remains untested.

## Offline checks and review

The final pre-push rerun completed at `2026-09-08T22:13:23Z` on unchanged runtime:

- `cargo fmt --all -- --check`: PASS.
- `cargo check --all-targets`: PASS.
- `cargo test --all-targets`: **187 passed**: 166 library, 16 CLI, one managed
  absence integration and four provider-contract tests. Zero failed, ignored,
  measured or filtered tests; example target had zero tests.
- `cargo clippy --all-targets -- -D warnings`: PASS.
- `cargo build --all-targets`: PASS.
- `cargo test --doc`: PASS, zero doctests.
- `node scripts/cli_retest.mjs --self-test`: **152 passed**, `live_started:false`.

The six Cargo commands ran through `uv run scripts/verify.py`. Tests used synthetic
credentials and loopback services; no live auth or provider request ran during
this rerun. Earlier final implementation reviews a/b/c reported no blockers.
The report-only step did not change runtime code or dependency versions.

## Accounting and remaining limits

- Cumulative assistant generation budget: **27 of 40 used, 13 remaining**.
- Earlier work consumed 17; the new six-case Wi matrix consumed exactly 10.
- User manual runs remain excluded under the user's explicit accounting rule.
- Separate cumulative auth traffic: two browser logins, two code exchanges and
  one explicit refresh exchange. These are not generation submissions.
- No automatic retries, transport fallback or account switching occurred in the
  new matrix. Remaining budget is not a request to spend it.
- Current live acceptance is Linux-only. Earlier cross-platform CI evidence does
  not establish current managed-persistence or live support on other platforms.
- Advisory store-lock waits can be prolonged. Synthetic persistence faults test
  control flow, not physical power-loss durability.
- No stable provider contract, quota/rate-limit capability, unrestricted model
  entitlement, automatic-expiry live renewal or live opaque replay is claimed.

The agreed implementation and bounded live work are complete. This report closes
the pending design-conversation handoff. Any broader supported-auth contract or
additional feature needs a separate decision. No GUI, server, database, keyring,
shell executor, dynamic plugins, account failover or background scheduler was added.

## Evidence record

- [Wi matrix and per-case records](WI_AUTH_MATRIX.md)
- [Local verification report](LOCAL_VERIFICATION.md)
- [Machine-readable evidence and historical ledger](local-verification.json)
- [Historical inherited verification](VERIFICATION.md), preserved unchanged

Dated pre-commit and earlier untested/blocked statements in the historical records
describe their original stages, not the final status above.
