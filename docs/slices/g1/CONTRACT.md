# G1 — minimal browser conversation client

Contract **g1.0**. Planning date: **September 20, 2026 (Asia/Manila)**.
Accepted baseline: **76bb32fd04fd4737c0efcceaabc7d10387453147**, PR #9 merge.
**PLANNING ONLY: all G1-00 through G1-31 are NOT RUN.**
Read CLIENT_PROTOCOL.md, MATRIX.md, VALIDATION.md and IMPLEMENTOR_PROMPT.md together.
This is a fixed local implementation assignment, not permission to reinterpret old
milestones or to claim that the browser UI already exists.

## 1. Goal and first prerequisite

Deliver a small browser interface served by Wi's existing Rust HTTP service. An
owner can connect, create/select/rename conversations, submit an explicit task,
watch committed output, observe failure/cancellation, disconnect, and reopen the
same persisted conversation without owning or restarting execution.

Before browser changes, the fresh local implementor must independently audit the
PR #9 Windows withdrawal and current documentation. Compare original f0adbdd through
6805640/this merge; run the platform inventory and manual semantic checks, preserve
Unix protections, and run the baseline gates. G1-00/G1-01 record this work. Do not
relabel the original 38 PASS/2 PARTIAL report as 40 Windows passes. The platform
policy withdraws the native-Windows-only subcases, not the retained assertions.

A residual Windows-only compatibility branch or directly conflicting current
platform statement may receive a minimal, separately identified cleanup before G1.
Such a finding must have exact source/diff evidence and a regression where applicable.
Do not remove shared portable code, credential-isolation canaries, negative path
fixtures, historical reports or transitive lockfile metadata merely for containing
the word Windows. Other inherited runtime defects require a precise blocker report,
not an incidental redesign. Native Linux/macOS gates remain mandatory.

## 2. Explicit architecture decision

Use **framework-free TypeScript browser modules**, ordinary HTML and CSS. Rust
continues to own the server, authentication boundary, sessions, execution and tools.
There is no TypeScript/Node forwarding server, SSR layer, alternative agent loop or
browser-held provider credential. TypeScript is the selected implementation language
for this first small GUI, not an assertion that Rust/Wasm was technically impossible.
No React/Vue/Leptos, router framework, state framework, UI kit, bundler or Markdown
library is needed for this text-first increment.

Suggested module boundaries are web/src/api.ts, sse.ts, state.ts, view.ts and app.ts:
request/DTO validation, streaming parser, pure reducer, safe DOM and orchestration.
Behavior-based splitting is allowed; every emitted production module must have an
explicit embedded asset entry. Do not introduce a general plugin/component framework.

Exactly two direct JavaScript **development** dependencies are authorized:
- typescript **5.9.3**;
- @playwright/test **1.58.2**.

Pin exact versions in web/package.json and commit the npm lockfile. Use Node24.x
for build/tests, not production serving. These are deliberate documented release
pins, not a latest-version or security-certification claim. No JavaScript production
package dependency or new Rust dependency is authorized. Resolve only necessary dev
transitives; keep Cargo.toml/Cargo.lock unchanged unless a genuine contract blocker
is reported. Normal npm/browser downloads are build traffic, not provider probes.

Use strict TypeScript, noEmitOnError=true, target/module ES2022, DOM/DOM.Iterable
libraries, relative .js imports, rootDir src and outDir dist. No source maps or
declarations in public assets. Commit the generated web/dist JavaScript so Cargo
builds need no Node/npm/network or build.rs compiler. A nonmutating verifier must
compile to a temporary output directory and compare the complete output-file set
and bytes with checked-in dist, including untracked output files; git diff alone is
not a sufficient oracle. Type errors cannot publish a partial new asset set.

## 3. Narrow Rust delivery change

Add private fixed-asset serving inside the existing http_api module and router.
Embed web/index.html, web/style.css and each committed dist module with compile-time
inclusion. No runtime web-root path, directory traversal, arbitrary file endpoint,
external CDN, source-map endpoint, index fallback for arbitrary paths or filesystem
asset reads. Production has one Rust executable and the existing configuration.

Exact public resources: GET/HEAD `/`, `/index.html`, `/assets/wi.css`, and explicit
`/assets/<module>.js` entries for the emitted production modules. This is an
intentional additive exception to V1-B's formerly all-protected router:

1. Run the existing Host/absolute-authority and Origin validation unchanged.
2. Only for an exact known asset with GET/HEAD and no query/body, return embedded
   bytes (HEAD has no body). Do not consume/validate provider or owner credentials,
   open a session, migrate data, prepare context or dispatch work for this request.
3. All `/v1` paths and all requests not matching that narrow exception follow the
   existing authorization/router behavior. No unauthenticated prefix wildcard.

Known static paths with query or nonempty body reject without echoing input. HEAD
must have the same MIME and security headers as GET. Unknown paths/methods keep the
existing authenticated error behavior; do not add a permissive SPA fallback.
Public assets contain no installation data, workspaces, token, model, instructions,
paths or current session history. Settings are fetched from the authenticated API.
Existing tests asserting that `/` was private may be adapted only for these exact
new resources; preserve every `/v1` denial and common-boundary regression.

Use correct HTML/CSS/JavaScript MIME, no-store, nosniff and Referrer-Policy:no-referrer.
The HTML response must enforce CSP:
`default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'none'; font-src 'none'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'`.
Use external same-origin modules/styles, no inline handlers, eval, unsafe-inline,
remote fonts, telemetry, service worker or cache manifest. No new HTTP mutation,
settings, credential or transcript endpoint is needed.

## 4. Owner connection and security

The UI connects only to its own origin and fixed `/v1` paths. Permit HTTPS or
literal-loopback HTTP consistent with the current service policy. Do not add an
arbitrary backend URL/proxy, insecure remote-HTTP mode or weaker Host/Origin/CORS.
Remote access still needs the separately configured same-host HTTPS proxy. G1 does
not deploy that proxy or implement native TLS.

Provide a labelled password-style owner-token field and explicit Connect action.
Require the exact 64 lowercase hex characters; do not quote invalid input in errors.
Keep the token in page memory only, clear the input after connection is attempted,
and use Authorization:Bearer on authenticated fetches. Use credentials:omit,
redirect:error and cache:no-store. Never store the secret in URLs, cookies,
localStorage/sessionStorage/IndexedDB, history state, logs, screenshots, reports,
telemetry, compiled assets, config or provider state. There is no remember-me feature.
Autocomplete suppression is best effort, not control of browser extensions/password
managers. JavaScript reference disposal is not a memory-zeroization guarantee.

Connect reads settings and session listings, not a provider or auth profile. A401
clears the connection secret and sensitive in-memory/DOM state and returns to the
connection screen. Other failures retain appropriate visible state without showing
raw response/parser/exception details. Disconnect locally aborts observation/read
requests, clears drafts/history/token references, and does **not** call cancel or
revoke the shared owner secret. Other devices and RunHost work continue.

All model/user/tool/title strings are untrusted text. Construct DOM with textContent,
form values and explicit element creation. No innerHTML, insertAdjacentHTML,
DOMParser-generated content, HTML Markdown, untrusted href/src/style, eval, or automatic
links/images/resource fetches from conversation data. Tool arguments/results display
as their original strings; an error-shaped successful tool result remains success
unless its actual is_error says otherwise. No content scanning or secret-removal
claim is made for text intentionally supplied by the owner/model/tools.

## 5. User-visible interface

A small responsive layout is sufficient:
- Top bar: Wi, connection/observation state, current provider/model as read-only
  settings, and Disconnect. Never expose provider alias/token/internal config.
- Session pane: catalog-as-of list, load-more, refresh-list, create-title/workspace
  form using only returned allowed workspaces. Creation returns the real session ID.
- Conversation pane: canonical title/workspace, rename, explicit catalog refresh,
  ordered messages and collapsible text-only reasoning/tool details, and clear
  accepted/running/terminal/interrupted/recording states.
- Composer: multiline task text, explicit Send, pending/uncertain receipt state,
  explicit reconcile/retry controls, and separately labelled Cancel current run.

Session selection may be reflected only as `#session=<UUID>`; reject malformed or
extra fragment forms and never put secrets or drafts there. Reopen reads that selected
session only after Connect. Hash navigation/refresh is a read action, never task
submission. The empty session view says no messages yet; metadata/private checkpoints
are not phantom messages. Catalog ordering is the existing ID-keyset order, not an
invented activity-sort guarantee.

Do not trim, normalize or silently truncate text/titles. Enter inserts a newline in
the composer; Send or Ctrl/Cmd+Enter is the explicit submission action, with duplicate
activation guarded. The current server may reject a new task while another run is
active; show its actual error and retain the draft. Do not implement steering, a queue
or automatic follow-up. A receipt is shown as accepted, never finished/successful.
Do not put optimistic text into the canonical conversation before its stored event.

Cancellation is explicit, addressed by selected session and known active run ID.
`requested` means signal requested, not confirmed rollback/stopped upstream work.
`not_tracked` is not proof of success or cancellation. Subsequent canonical evidence
controls the final display. Closing a tab, changing sessions, signout, navigation,
pagehide/beforeunload and network failure must not send cancellation.

Use accessible labels, visible keyboard focus, semantic headings/buttons/forms and
status/error regions. Do not announce every streamed token as an alert or steal focus
on updates. Preserve newlines/indentation with CSS, wrap long text without page-wide
horizontal overflow, and keep controls usable at 360x800 and1440x900 viewports. A
near-bottom reader can follow new content; a scrolled-away reader gets a new-content
control instead of forced scrolling. No external font/image asset is required.
Plain text is deliberate: rich Markdown/code editing/terminal rendering is deferred.

## 6. Actual client protocol

CLIENT_PROTOCOL.md defines exact DTO consumption, commands, immutable operation
identity, fixed-head pages, incremental SSE parsing, duplicate/gap detection, reducer
semantics and observation epochs. It is mandatory, not a mock API suggestion.

The browser never installs native provider replay, reads SQLite, fabricates tool
results, mutates accepted context or determines model continuation. Only the server
performs those actions. Stream reconnect is observation, not execution recovery.
Use explicit read reconnect after an interrupted stream; no automatic POST retry,
backoff framework or polling-based task restart. No transport/library change follows.

## 7. Tests, build and scope

MATRIX.md requires pure protocol/reducer tests, real Rust asset-boundary tests and
real Chromium integration through actual Rust HTTP/RunHost/B2/SQLite/loopback
provider/tools. A stubbed HTTP response cannot prove that joined acceptance path.
A cfg(test) ignored Rust child fixture controlled through synthetic stdin is allowed;
no production fake-provider command, endpoint, environment flag or auth bypass.

Add one Ubuntu-only browser CI job, preserving both native Linux/macOS jobs and all
six existing Cargo gates. The browser job uses Node24, npm ci, typecheck, nonmutating
asset verification, unit tests and Playwright Chromium end-to-end checks. Use the
existing checkout/toolchain action convention plus an official Node setup action;
record its selected revision and actual tools in evidence. No Windows job returns.
Chromium offline evidence is not Firefox/Safari/native-Windows or real-device proof.

Allowed files: web source/assets/package/lock/build-check/test support; private
Rust embedded-asset/router changes and tests; narrowly necessary cfg(test) fixture
sharing; browser CI job; current usage/security/index docs; G1 reports. Small residual
platform cleanup from G1-01 must be separately identified before feature edits.
No new Rust dependency, core/provider/auth/tool/schema behavior, general static file
server, UI framework, Markdown parser, desktop app, service worker, persistent browser
cache, uploads, source editor/shell, search, branching, compaction, skills resources,
new provider, model/settings mutation, device auth or deployment is authorized.
No RunLimits, optional budgets, task-wide quotas/deadlines, lifetime history/session
ceilings, deletion, retry/failover or automatic task/model/tool resumption.

All fixtures use temporary synthetic secrets/workspaces and loopback/scripted
providers only. No real credential/private-skill reads, authentication commands or
live model requests. Ledger31/50used19remaining stays unchanged. The owner authorized
this handoff; local implementation commits/push/merge/release/deployment and later
slices still require separate permission. Leave implementation uncommitted for review.
