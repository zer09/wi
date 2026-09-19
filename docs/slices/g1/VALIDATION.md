# G1 source-to-contract validation ledger

Contract **g1.0**. Date **September 20, 2026 (Asia/Manila)**.
Baseline **76bb32fd04fd4737c0efcceaabc7d10387453147**, the PR #9 merge.
**This is planning/source review, not executed G1 verification.** All matrix rows
remain NOT RUN; no browser app, Node lockfile, asset compiler or new test result is
included in this planning commit.

## 1. Baseline and actual closure

PR #9 final reviewed head was6805640444e98cd00ef06dcbad1e966b4d4d8a65. The merge
comparison has zero file differences and master was confirmed at76bb32f. Push
35458920521 and PR35458921748 attempt1 passed all six Cargo gates on Ubuntu/macOS.
Those jobs establish that head's native gates, not G1 TypeScript/browser behavior
or new local Node/example executions. See [PR #9 closure](https://github.com/zer09/wi/pull/9#issuecomment-5744102056).

The owner's native Windows withdrawal is in [PLATFORM_SUPPORT.md](../../PLATFORM_SUPPORT.md).
Original V1-B source6e28cc3/reportheadf0adbdd remains38PASS/2PARTIAL/accepted=false
in its historical evidence. Windows-only V1B-03 and V1B-33 assertions are withdrawn,
not retroactively tested. Separate [follow-up](../v1b/PLATFORM_FOLLOWUP.md) records
planner source changes, early inventory failures, later CI and limitations.
A fresh local audit is explicitly still required by G1-01; no independent local
review of that removal is falsely claimed here.

## 2. Existing interfaces inspected versus new work

All repository paths below refer to the accepted merge tree (identical to6805640).
Their meanings were checked against actual producer/consumer paths, not inferred
from Rust variant names or an illustrative transcript.

| Actual source | Observed baseline boundary | G1 use or authorized addition |
|---|---|---|
| src/http_api/router.rs | Common authority/origin/preflight/auth gate precedes `/v1` dispatch. Explicit routes, strict bodies/query parsing, no public GUI resources. | Add only an exact embedded GET/HEAD asset exception after unchanged authority/origin checks; keep all API auth and fallback behavior. This exception is NEW, not existing functionality. |
| src/http_api/boundary.rs and token.rs | Separate bearer credential, exact authority/origin checks and bounded verifier; not provider OAuth. | Browser supplies the existing owner token in memory via header. No new auth issuance, cookie or device identity. |
| src/http_api/config.rs and cli/serve_cli.rs | Explicit origin/workspaces/model/settings; loopback startup; supported Unix signal handling. No client deployment configuration endpoint. | Keep config shape and Rust CLI. Browser uses same-origin authenticated settings. No runtime Node or arbitrary API URL. |
| src/http_api/dto/mod.rs | Flat success objects, canonical SessionView wrapper, flattened catalog observations, actual receipt IDs, decimal strings and separate result_recorded. | TypeScript runtime guards mirror these exact shapes. No universal data envelope or invented last_activity/current catalog guarantee. |
| src/http_api/dto/errors.rs | ErrorView is flat api_version/code/stage/certainty/acceptance/notices; static safe mapping. | Handle command versus network uncertainty and retained acceptance; never expect a nested error object or display parser excerpts. |
| src/http_api/dto/events.rs | One EventView per stored event; selection/binding/extensions project to checkpoint; tool result bytes separate from finish. | Apply checkpoint sequences without phantom messages and render actual outputs only. Core storage/native schema unchanged. |
| src/http_api/dto/provider.rs | Closed ItemView/ResponseView, supported text blocks, actual provenance/usage and unsupported marker; no native field. | Browser handles projected content, not encrypted/native provider state. Authoritative response replaces provisional output. |
| src/http_api/router/events.rs | Initial committed page before SSE200, one qualified ID per emitted record, fixed window/head, later polling; noID wi.error/optional closure. | Fetch parser and applied-cursor reconnection. Network chunk/EOF cannot stand in for an event or task completion. |
| src/http_api/router/runs.rs | Raw operation/run/text retry validates actual B2 acceptance before current context; accepted receipt distinct from completion. | Immutable pending command and explicit same-body retry/reconciliation. No automatic POST/provider retry or changed IDs. |
| src/http_api/serve.rs and serve/transport.rs | Network waiter cancellation is separate from RunHost work; drain-before-close and guarded ownership. | Browser aborts observation only. New public assets cannot replace the server owner or change shutdown. |
| src/service/mod.rs and tickets.rs | Host owns task; weak client and passive ticket; early actual acceptance. | Closing a browser does not cancel. Only explicit existing cancel endpoint signals a run. |
| src/execution/mod.rs and replay.rs | B2 restores compatible selected history for explicit new task; no automatic resumption. | Client neither rebuilds provider context nor silently edits refused incomplete history. |
| src/providers/openai_codex/tests/replay/http_api_joined.rs and child modules | Actual HTTP/SQLite/OpenAI-loopback fixtures already exist. | Reuse privately where helpful, but browser joined rows must add actual DOM actions/assets and real wire observation rather than claiming these older tests prove GUI behavior. |
| tests/platform_support.rs | Lexical first-party regression inventory, not exhaustive semantic platform proof. | Run and supplement with manual removal audit; preserve portable/dependency/historical distinctions. |
| .github/workflows/ci.yml | Ubuntu and macOS six Cargo gates, no Windows after owner change. | Add an Ubuntu browser job; do not remove either native job or its assertions. |

P1 stored DB2/catalog1/stored-envelope1/runtime2/provider1 and V1-B HTTPapi1 are
unchanged. Native Windows withdrawal does not implement managed authentication on
macOS. The old Linux-specific auth and live limits remain even though native build
and loopback CI cover macOS. G1 offline fixtures must not silently use real profiles
to bridge that gap.

## 3. Newly selected G1 decisions

These are deliberate requirements of this handoff, not statements that they came
from Pi, Codex, the old TypeScript repo or previously shipped Rust behavior:

- A text-first, framework-free TypeScript client and fixed embedded HTML/CSS/modules,
  rather than Rust/Wasm or a full IDE framework. Rust still owns all backend work.
- Exact two dev-only package pins, checked-in compiled assets and a reproducibility
  verifier. Cargo users need no npm at startup/build; no runtime CDN dependency.
- Only same-origin requests; owner token held in page memory and cleared on local
  Disconnect/401. No browser credential/draft persistence or per-device revocation.
- Explicit manual observation reconnect and same-command retry. No automatic mutation
  retry, queue, steering or retry/backoff subsystem.
- Strict runtime wire validation, BigInt-backed decimal ordering, one applied
  canonical cursor and epoch fencing, plus pure reducer before safe DOM rendering.
- A narrow unauthenticated static-page exception that remains behind Host/Origin;
  all installation data still requires the existing API bearer.
- Plain text/collapsible tool/reasoning presentation with no unsafe Markdown/HTML,
  external images/links/fonts or service worker. Rich editing is deferred.
- A required independent Windows-removal preflight and a real Chromium->HTTP->host
  joined oracle, rather than treating old source tests as browser evidence.

These choices keep the first UI small without restricting useful task duration,
model/tool call counts, stored history lifetime or later compatible frontend changes.
No dependency or performance winner was established by this design review.

## 4. Primary external references consulted

The following official references were opened/checked during planning. They establish
release/API behavior only, not compilation of this new client or secure deployment.
Versions are selected pins, not assertions that they are latest.

- [TypeScript5.9.3 release](https://github.com/microsoft/TypeScript/releases/tag/v5.9.3).
- [TypeScript noEmitOnError](https://www.typescriptlang.org/tsconfig/noEmitOnError.html):
  emitting after type errors must be explicitly disabled for this build policy.
- [Playwright1.58.2 release](https://github.com/microsoft/playwright/releases/tag/v1.58.2).
- [Playwright network testing](https://playwright.dev/docs/network): network interception
  can replace the backend; such mocks are deliberately not the joined acceptance oracle.
- [HTML Standard SSE](https://html.spec.whatwg.org/multipage/server-sent-events.html):
  line/data/event/ID framing and blank-line dispatch inform the fetch parser. Wi's
  explicit token/cursor/error policy remains its own protocol, not automatic EventSource
  reconnect or an execution-resumption instruction.

Normal dev dependency/browser installation is allowed offline-test preparation. No
external reference authorizes reading owner credentials or contacting a live provider.
The local agent must record exact resolved packages, Node/Rust/browser versions,
actual build/asset checks and browser execution, and report a dependency conflict
before silently changing this contract's pins.

## 5. Known limits and evidence required

This planner did not compile a G1 Rust asset adapter or TypeScript, launch Chromium,
run a GUI accessibility audit, benchmark render performance, verify real HTTPS proxy
configuration, or exercise a real owner's model. Those are not hidden completed tasks.
The matrix specifies offline executable evidence for the local implementor.

A pure reducer test is not real DOM/network evidence. A screenshot is not a durable
receipt or provider call. A mocked API plus old provider test is not the joined
browser path. Source-marker absence is not semantic absence of every Windows-specific
accommodation. Green Cargo cannot certify browser versions or Linux-only auth on macOS.
Reruns do not erase failures or count as unique tests.

Memory-only token handling cannot protect against a malicious same-origin script,
browser extension, debugger or compromised host. Authenticated conversation content
can itself contain secrets. No comprehensive penetration-test/Internet-edge/constant-
RSS/exactly-once browser guarantee is claimed. Long selected histories can cost memory
and rendering time; no silent cap/eviction/truncation is authorized.

Future work remains: richer Markdown/editor/terminal, persistent client drafts/device
auth, compatibility beyond observed Chromium, general coding executors, steering,
parallel tools, compaction/branching/search/import, extra providers and deployment.
None is incidental G1 implementation. Source/document conflicts need exact evidence
and a narrow resolution, not another speculative architecture exercise.
