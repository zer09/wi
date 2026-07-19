# Milestone 6 release-gate remediation ledger

Status: The independent remote re-review of PR #12 at `e120062` confirmed H1/H2/M1/H3/M2 resolved but requested changes for new Medium finding `WI-M6-M3`. M3 is fixed and the complete implementation-agent gate is green. Changes remain unstaged and uncommitted pending a fresh independent local review.

This record validates and remediates the release-gate review performed against `68e95d293f6a1d9c224570b026eba49d0a5c5e1d`. Reviewers should use the named regression tests below before reopening an item. A fixed item should be reopened only with a new reproducer against the current worktree.

## Review validation

| Finding | Validation | Resolution |
| --- | --- | --- |
| Recoverable replay failures could leave the UI stale | Confirmed. `replay.query_failed`, `replay.disconnected`, `replay.cursor_ahead`, and recoverable replay overflow were not handled; the dead `sequence_conflict` branch could never recover because the server marks it fatal. | Fixed. Every recoverable replay code has an explicit action. Ordinary failures use bounded jittered per-session retry; cursor-ahead rebuilds the in-memory projection from sequence zero; fatal conflicts remain sticky. Retry timers are deduplicated and cleaned on replay completion, unsubscribe, transport close, and client stop. |
| Re-selecting a visited session remained `replaying` | Confirmed. `App.openSession()` called `beginReplay()` while `WiSocketClient.openSession()` intentionally skipped a duplicate subscribe. | Fixed. Selecting the already-selected session is a no-op. Switching sessions unsubscribes the previous session; reopening performs a fresh subscribe and must reach `live`. |
| Large histories were unbounded and copy-heavy | Confirmed with nuance. `timeline` and `appliedEvents` retained two references to each full event rather than duplicating payload bytes, but memory and immutable-copy work were still unbounded. | Fixed with an explicit fail-closed v0.1 boundary: at most 2,000 retained events and 8 Mi canonical JSON code units per browser projection. Exceeding either produces sticky `history_limit_exceeded`, preserves the trusted cursor, and disables session mutation instead of silently dropping integrity evidence. Latest-message preview is now maintained incrementally rather than found by rescanning history. |
| Integrity and terminal states did not disable all mutations | Confirmed for selected-session controls and terminal connections. The suggestion to disable global session creation for a session-local integrity failure was rejected because it would violate smallest-fault-domain isolation. | Fixed. Terminal connections disable create, compose, cancel, approval, and input controls and expose a reload action. A fatal selected projection disables its compose/cancel/approval/input controls and exposes trusted reload, while global session creation and navigation remain available. Run and interaction changes now have live announcement semantics. |
| Visited sessions accumulated until the subscription limit | Confirmed. `closeSession()` had no production caller and reconnect could eventually send more than 256 resume cursors. | Fixed. The minimal single-pane GUI keeps only the selected healthy session subscribed and evicts the previous healthy projection. Fatal projections remain retained and sticky but are not reopened automatically. The socket remains multiplex-capable for a future bounded multi-pane UI. |
| Pending command indicators were global rather than session-scoped | Confirmed. Method-only counts could annotate or disable the wrong selected session. | Fixed. Session-scoped pending commands, approval IDs, and input IDs are filtered by the selected `sessionId`; only `session.create` remains global. |

## R2 race-condition review validation

| Finding | Validation | Resolution |
| --- | --- | --- |
| Replay-complete head mismatch could not recover | Confirmed. `completeReplay()` produced `gap`, App resubscribed without `beginReplay()`, and the next contiguous event inherited `gap` and was discarded while the resync guard was already set. | Fixed. A mismatched completion is converted back to `replaying` before the replacement subscribe. The trusted cursor advances through the missing suffix and only a matching later `replay.complete` returns the projection to `live`. |
| Session changes during hello/welcome could miss subscriptions | Confirmed. The hello resume array was a one-time snapshot with no welcome-time reconciliation. Removed hello sessions could also remain subscribed server-side. | Fixed. `WiSocketClient` retains the exact hello cursor map and reconciles it at welcome: added sessions subscribe, removed sessions unsubscribe, and cursor changes issue replacement subscribes. The snapshot is cleared on welcome, close, invalid transport, and stop. |
| Buffered frames could resurrect a closed subscription | Confirmed. App accepted any valid session frame, created a new projection for an evicted session, and gap recovery could add that session back to the socket map. | Fixed. App accepts event, replay-complete, and subscription-error frames only for sessions still present in the socket's open-session map. Fatal local projections also close their subscription intent immediately. |

## R3 bounded-bootstrap, disconnect-window, and focus review validation

| Finding | Validation | Resolution |
| --- | --- | --- |
| Bootstrap truncation occurred after an unbounded catalog RPC | Confirmed. HTTP requested `catalog.listSessions`, so the worker materialized and serialized the complete catalog before the server kept 1,000 rows. | Fixed. `catalog.listBrowserSessionsBounded` validates a hard maximum of 1,001, excludes missing rows, projects only browser-safe columns, truncates title/preview in SQL, and applies `LIMIT` inside SQLite. HTTP returns the first 1,000 and derives `sessionsTruncated` from the extra row. |
| Required disconnect/idempotency windows lacked browser evidence | Confirmed. Only post-route/pre-ack message submission was gated. Replay interruption, pre-route loss, approval acknowledgement loss, and simultaneous real-UI resolution were absent. | Fixed. The isolated child fixture now exposes deterministic pre-route, historical-replay, approval-acknowledgement, and two-client approval-race gates. Tests require stable command IDs, one durable effect, exact replay recovery, converged tabs, and one typed `approval.already_resolved` loser. |
| Focus was lost when dynamic controls disappeared | Confirmed. Approval, input, and cancel controls could unmount while focused without a post-commit handoff. | Fixed. The initiating action records a session-scoped focus intent. A React effect after durable state render moves focus to the next enabled interaction, run status, or composer and clears the intent on session change. Keyboard E2E covers approval, cancel, and pending input. |

## R4 command-size, draft, and fixture-cleanup review validation

| Finding | Validation | Resolution |
| --- | --- | --- |
| Oversized UI input could close the socket with terminal `1009` and lose the draft | Confirmed. Browser schemas accepted unbounded strings/JSON, `WiSocketClient` serialized directly, and the default server rejected frames above 64 KiB before command routing. | Fixed. The browser socket client measures the complete serialized command envelope with `TextEncoder` and refuses anything above 60 KiB before pending-command insertion or transport send. Forms render the typed local error inline and retain message/input text; the connection stays usable. The 4 KiB margin is relative to the v0.1 default 64 KiB frame ceiling. |
| E2E fixture leaked its child/home when startup failed | Confirmed. Temporary-home creation and `fork()` preceded an unguarded ready wait, while the normal fixture `finally` began only after `startServer()` returned. | Fixed. Spawn and ready phases now own failure cleanup. Early exit or timeout force-kills when necessary, waits for process exit so the child is reaped, removes the temporary home, and reports aggregate cleanup failure without hiding the startup error. Normal timeout cleanup uses the same reap-before-remove discipline. |
| Composer and session-title drafts cleared before durable acceptance | Confirmed. Both controls cleared immediately after enqueue and could not distinguish acceptance from rejection. | Fixed. Drafts are controlled by App and remain browser-local while pending. Only the matching `command.accepted`, inspected before the socket removes its pending command, clears the unchanged draft. `command.rejected` leaves it editable for correction/retry. Each form prevents duplicate submission while its command is pending. |

## R5 final release-gate sign-off

**Verdict: PASS. No critical, high, medium, or low-severity implementation findings remain.**

Independent validation against the current R1–R4 worktree confirmed:

- untrusted timeline output remains React text inside `<pre>` with no raw-HTML or automatic-link path;
- DOM projection, retained browser history, serialized browser commands, catalog bootstrap, and transport queues remain bounded;
- React/socket cleanup does not issue `run.cancel`, while server disconnect cleanup removes subscribers and drains only already-dispatched commands;
- unresolved commands retain their original IDs across reconnect and acknowledged commands leave the retry map;
- replay mismatch, gap, duplicate/conflict, handshaking, stale-frame, multi-tab approval, and disconnect-window regressions remain covered;
- the browser stores no credential in script-visible cookie or persistent browser storage, and no automated accessibility-scanner dependency is present;
- the review's ten timing-sensitive scenarios passed five consecutive repetitions (50/50) with no leaked E2E child, Playwright process, or temporary runtime home.

The review's remaining items are accepted as non-blocking hardening opportunities. They do not require speculative Milestone 6 code changes and should be reopened only with a concrete invariant violation, accessibility requirement, or reproducible unsafe rendering/backpressure behavior.

## Independent remote remediation — Stage 1 (`WI-M6-H2`)

The remote review correctly reopened bounded session-index identity and ordering. The browser previously treated a bounded bootstrap page as authoritative: a valid omitted, unknown, or unavailable `?session=` target fell back to the first ready row, local accepted sessions could grow summaries beyond 1,000, and replay-only transitions could assign `Date.now()` and reorder history without a durable event.

Resolution:

- `apps/web/src/state/session-index.ts` now owns pure initial-target selection, summary projection, ordering, truncation, and bounded upsert;
- every syntactically valid explicit target remains authoritative and is subscribed exactly, whether included, omitted, unknown, or unavailable;
- omitted and unavailable targets are displayed explicitly while canonical replay or typed errors decide availability;
- summaries remain capped at `MAXIMUM_BOOTSTRAP_SESSIONS`, preserve the selected target during eviction, and keep truncation sticky once partial;
- replay-only state changes preserve catalog ordering, while newly applied events use the maximum durable `createdAtMs` observed;
- a newly accepted local session uses a zero-time selected placeholder until its durable `session.created` event supplies authoritative ordering.

Regression evidence:

- pure session-index unit tests: valid omitted/unknown/unavailable targets, invalid/empty fallback, replay-stable ordering, durable-event reordering, no invented summary, bounded local create, and selected-target retention;
- real-browser E2E seeds 1,001 catalog rows, opens the omitted durable session, verifies exact URL/hello cursor/heading/command target, and completes its run;
- real-browser E2E proves valid unknown and unavailable targets do not open an available fallback;
- focused Stage 1 E2E passed 9/9 under `--repeat-each=3`; the full browser suite passed 24/24.

## Independent remote remediation — Stage 2 (`WI-M6-M1`)

The remote review correctly found that the browser's fixed 60 KiB boundary could exceed a valid lower gateway frame configuration and that raw/deep input reached expensive parsing and recursive validation before a meaningful bound.

Resolution:

- bootstrap now carries a strict versioned `commandLimits` contract derived from the constructed gateway's actual frame bytes/depth and durable outbound/replay/storage capacities;
- the contract separately bounds complete frame bytes, canonical durable payload bytes, raw code units/UTF-8 bytes, and canonical JSON depth/nodes;
- forms refuse oversized changes without truncating or retaining them, and pending-input JSON receives iterative text preflight before `JSON.parse`;
- direct socket commands receive iterative structure/raw-value preflight before Zod recursion, canonical JSON, stringify, or UTF-8 encoding;
- `WiSocketClient` can atomically replace its validated limits after a later re-bootstrap, which Stage 4 authentication recovery can use;
- non-browser `wi.v1` clients remain wire-compatible and are still enforced by the authoritative server decoder/router.

Regression evidence:

- protocol and server unit tests validate strict contract versioning, actual-capacity derivation, exact payload bytes, escaping, Unicode, raw byte/code-unit limits, and pre-parse depth/node failure;
- `WiSocketClient` tests accept the exact complete frame limit, reject one byte over before pending insertion, and use refreshed limits for later commands;
- Milestone 5 integration advertises a configured 32 KiB frame contract and retains existing exact durable-payload/one-over server tests (82/82 focused integration tests passed);
- real-browser E2E against a 32 KiB gateway accepts an exact 32,768-byte command, rejects 32,769 bytes inline before routing, retains the draft, and keeps the connection connected;
- lower-limit and raw oversized-input E2E passed 6/6 under `--repeat-each=3`.

## Independent remote remediation — Stage 3 (`WI-M6-H1`)

The remote review correctly found that unresolved commands existed only in `WiSocketClient.pending` and drafts only in React state, so refresh discarded queued-before-welcome commands, sent/unknown commands, their exact IDs, and recoverable draft text.

Resolution:

- a strict version-1 tab journal records canonical commands before in-memory enqueue, including queued versus sent/unknown phase and the submitted draft revision link;
- the journal restores commands and drafts before WebSocket creation and retries every unresolved method with the original `commandId` and payload;
- matching acceptance or rejection removes only its command; acceptance clears only an unchanged linked draft, while rejection and newer edits retain draft text;
- title, message, and pending-input controls are journal-backed and controlled by App state;
- hard limits are 64 combined items, 256 KiB per item, and 1 MiB aggregate, with visible local rejection and no partial mutation when full;
- strict load validation rejects old versions, malformed/noncanonical commands, bad IDs/methods, duplicate items, and byte-bound violations without crashing startup;
- a tab owner in `window.name` preserves reload identity but clears opener-cloned `sessionStorage`, so two tabs cannot retry the same hidden journal;
- the empty journal removes its storage key and its schema has no place for cookies, authorization headers, provider configuration, OAuth material, events, or backend state.

Regression evidence:

- journal, socket, and command-size focused unit coverage passed 26/26, including all five command methods, exact count/item/aggregate limits, sent phase, draft revision safety, corrupt/old/oversized/cloned data, current-limit revalidation, and empty-key cleanup;
- real-browser queued-before-welcome session creation reloads with one exact-ID route and one durable session;
- real-browser committed/lost-ack message reload retries the exact ID twice on the wire but produces one durable event/run and duplicate acceptance;
- an opener-cloned tab starts with an independent empty journal while the original draft remains intact;
- the three journal browser cases passed 9/9 under `--repeat-each=3` after correcting a case-sensitive status assertion in the new test.

## Independent remote remediation — Stage 4 (`WI-M6-H3`)

The required deterministic Chromium probe classified the finding as **NOT RESOLVED** before production changes. Server A and server B used the same fixed loopback origin/port and temporary `WI_HOME`, the page was never reloaded, and server B minted a new HttpOnly credential. The unchanged page made repeated failed WebSocket attempts, issued no second `/bootstrap`, and reached the 10-second reconnect ceiling while still displaying `reconnecting`.

Narrow resolution:

- after two abnormal pre-`welcome` failures, `WiSocketClient` serializes one abortable bootstrap refresh instead of scheduling another blind WebSocket attempt;
- the runtime-validated response rotates the HttpOnly cookie and atomically replaces WebSocket URL, subprotocol, and negotiated command limits;
- pending commands and journal-backed drafts remain intact across the refresh generation;
- one disconnected episode permits two refresh attempts; exhaustion or repeated refresh failure stops with a visible terminal Reload Wi path;
- successful `welcome` resets failure/refresh counters, while stop aborts and invalidates in-flight refresh work.

The exact same no-reload probe then classified the finding as **RESOLVED**: bootstrap count advanced from one to exactly two, Chromium recorded the original close plus two stale-auth pre-welcome failures and at least four WebSocket generations, and the page returned to Connected. The unchanged probe passed 3/3. Socket unit tests cover serialized success and bounded two-refresh terminalization (21/21 with journal tests).

## Independent remote remediation — Stage 5 (`WI-M6-M2`)

The remote review correctly found that the prior focus intent recorded only a target ID and unconditionally focused the first fallback after delayed durable removal. A user could move to another field while approval/input/cancel resolution was gated and then have that later focus stolen; local send failure also left stale intent armed.

Resolution:

- focus intent now captures the actual initiating DOM element along with session/action identity;
- a `focusin` listener consumes intent as soon as another connected element receives focus;
- after durable removal, fallback focus runs only when focus remained on the initiator or fell to body/document; initiator disconnection alone never overrides another active target;
- local validation/journal/send failure, command rejection, session change, terminal connection, explicit focus movement, and component unmount clear intent;
- unchanged positive handoff still prioritizes the next approval, input, run status, then composer.

Regression evidence:

- retained positive approval/cancel/input keyboard handoff plus new delayed no-steal approval, cancel, and pending-input cases passed 15/15 under `--repeat-each=3`;
- a constrained second tab forces local cancel envelope rejection, then a different tab durably cancels the run; the newer title-field focus remains unchanged;
- web/root typecheck and lint passed, and the strict Stage 4 restart probe remained green 3/3 after the focus change.

## Stage 6 independent local review

**Verdict: PASS — safe to push/update PR for CI and remote re-review.**

A fresh review-only agent inspected all 27 intended remediation paths against base `68e95d293f6a1d9c224570b026eba49d0a5c5e1d` and committed PR head `d295db7e1ab072ff7b5693c0719f86394e9cfbfc`. The reviewed implementation fingerprint was `8194ad2cf9a7f8632e7a07846272c73802ca53080730b25125136564b8ff7f1e`. It independently reproduced both H1 pre-fix failures from an isolated archive, re-opened H1/H2/M1/H3/M2 against current behavior, and found no critical, high, medium, or low findings.

Independent gates passed: lint, typecheck, build, 415 unit tests, 239 integration tests, 35 property tests, 47 process tests, 32 Playwright tests, 736 tests through `pnpm check`, and 39/39 focused remediation repetitions. Cleanup found no child process, listener, or temporary-home leak. `prompts/` and the handoff package remain local workflow artifacts and are excluded from the remediation commit.

## Independent remote re-review — `WI-M6-M3`

**Remote verdict at `e120062`: REQUEST CHANGES.** The gateway accepted client-frame depths 1 and 2 even though `wi.v1` needs depth 3 for hello with one resume cursor. Bootstrap correctly reserved two command-envelope levels, but raw JSON counted a root value container at depth 1 while direct structured preflight counted it at depth 0. At configured frame depth 3, direct `[[]]` therefore passed browser preflight even though its complete command frame reached depth 4 and the unchanged server decoder rejected it.

Pre-fix deterministic evidence preserved four expected failures: gateway construction did not reject depths 1 or 2, command-size preflight did not reject `[[]]` at advertised value depth 1, and `WiSocketClient` inserted/sent that over-depth command. The depth-3 decoder and resumed-hello controls already passed, isolating the defect to public configuration validation and the browser's structured-value convention.

Narrow resolution:

- `MINIMUM_WI_V1_CLIENT_FRAME_DEPTH` is the exported server-owned minimum, fixed at 3;
- gateway construction and browser-limit derivation reject lower depths without clamping or opening a listener;
- strict server frame decoding is unchanged;
- raw and structured browser checks now define primitive depth 0, root container depth 1, and each nested container as one additional level;
- complete command structural preflight reserves exactly the command root plus `params` object;
- depth-3 integration completes welcome/replay from a hello containing one resume cursor;
- direct socket preflight accepts `[]` and rejects `[[]]` before journal, pending state, or transport send;
- real browser/server coverage routes raw `[]` through the depth-3 decoder, rejects raw `[[]]` before routing, retains the draft, and keeps the connection connected.

Focused post-fix evidence: 34/34 unit tests, 3/3 minimum-depth integration tests, and 3/3 repeated real-browser depth-composition tests passed. The prior lower-byte, authentication restart, refresh journal, deep-link, and focus regression matrix remains required by the final gate.

## Implementation boundaries

### Recoverable replay

- `apps/web/src/state/replay-recovery.ts` owns the explicit protocol-code-to-action classification.
- `WiSocketClient.retrySession()` uses the injected timer and reconnect policy, preserving deterministic clock/random testing.
- `replay.cursor_ahead` cannot safely continue from the local cursor, so only that recoverable case rebuilds local state from zero.
- `replay.sequence_conflict` remains non-recoverable and cannot be hidden by retry.
- A replay-complete mismatch calls `beginReplay()` before requesting the missing suffix; recovered events therefore remain `replaying` rather than inheriting and retriggering `gap`.
- The hello cursor map is connection-generation state. Welcome-time reconciliation closes removed resume cursors and subscribes additions before normal live operation.
- Frames for sessions absent from `WiSocketClient.hasOpenSession()` are stale transport residue and cannot recreate browser state or subscription intent.

### Browser command-size boundary

`apps/web/src/socket/command-size.ts` owns complete-envelope UTF-8 measurement and raw/structured JSON preflight under the strict bootstrap-advertised contract. The browser uses the server's actual frame bytes, durable payload, raw input, node, and depth bounds; it does not truncate payloads or enqueue an over-limit command. Root-container depth semantics now match the unchanged server decoder, while server-side validation remains authoritative for headless `wi.v1` clients.

### Durable draft clearing

Message drafts are keyed by session; the session-title draft is global to the create form. Components do not infer success from pending-state disappearance. App reads the original pending command while dispatching `command.accepted` and clears only a draft whose submitted value still matches. Rejection, local validation failure, and terminal transport failure preserve browser-local text.

### Failed-start fixture ownership

`startServer()` owns every resource created before it returns. Its test-only options permit deterministic early-exit and no-ready children, but production fixture startup still uses the real child script and 30-second deadline. Cleanup sends no production failpoint: it kills the isolated test child, observes exit, and recursively removes only that invocation's unique temporary home.

### Bounded bootstrap projection

The bootstrap catalog RPC returns protocol-level `BrowserSessionSummary` rows rather than internal `SessionSummary` rows, so database paths and other implementation fields never cross the worker boundary. SQL limits output to 1,001 non-missing rows and truncates title/preview to 256 Unicode code points; this remains within the browser's 512-code-unit schema even for astral characters and below catalog worker count/unit bounds.

### Deterministic disconnect gates

E2E gates are injected through existing `BrowserConnection` command/replay hook boundaries in the isolated test child. They do not add browser RPCs or production failpoints. Teardown releases every outstanding gate before server shutdown so failed tests cannot strand fixture processes.

### Focus restoration

Focus recovery is local UI state, not durable state. It is recorded only when this tab initiates approval, input, or cancellation and runs after the corresponding durable projection update commits to React. Priority is next approval, next input, run status, then composer.

### Subscription and memory ownership

The current GUI is single-pane: one selected session is one open subscription. Switching sessions sends `unsubscribe`, drops the previous healthy in-memory projection, and reconstructs it from durable storage when revisited. This is deliberately narrower than the protocol's multiplexing capability and prevents ordinary navigation from exceeding the 256-subscription server limit.

The browser history cap is not a scalable history protocol. It is a safety boundary that preserves exact duplicate/event-ID checks within the accepted projection and refuses to claim completeness beyond the bound. A future snapshot or paginated projection protocol should replace this boundary before supporting sessions larger than 2,000 events or 8 Mi canonical code units.

### Failure-domain control policy

- Terminal connection failure: all state-changing controls are disabled because no reconnect path exists.
- Session integrity failure: only controls that mutate that session are disabled.
- Global session creation and selecting another healthy session remain available after a session-local failure.

## Regression evidence

### Unit tests

- `replay recovery classification > retries recoverable replay.* failures`
- `replay recovery classification > rebuilds an in-memory projection when its cursor is ahead`
- `replay recovery classification > never retries fatal conflicts or uncorrelated errors`
- `WiSocketClient > unsubscribes a closed session and subscribes it again when reopened`
- `WiSocketClient > backs off recoverable session replay retries and cleans up their timers`
- `browser session reducer > tracks the latest user-message preview without rescanning history`
- `browser session reducer > fails visibly at the bounded browser history limits`
- `replay helpers > can restart replay after a replay-complete head mismatch`
- `WiSocketClient > reconciles sessions changed after hello but before welcome`
- `WiSocketClient > accepts the exact browser command byte limit and rejects one byte over` constructs complete 61,440- and 61,441-byte envelopes, verifies only the exact-limit command enters pending state, and exercises serialized UTF-8 measurement.

### Playwright tests

- `creates two sessions and runs both concurrently` now requires every reselected session to return to `live`.
- `retries a recoverable replay failure and returns to live` injects a recoverable replay query failure on the real WebSocket path and requires a replacement subscribe plus subsequent durable events.
- `disables state-changing controls after a terminal connection failure` verifies create/message/cancel/approval controls and the explicit reload action.
- `isolates a fatal session projection while leaving global session creation available` verifies session-scoped failure isolation and sticky fatal controls.
- `recovers when replay-complete advertises one missing tail event` drops the durable head event during historical replay and requires exact suffix recovery to `live`.
- `reconciles a session selected during delayed hello and welcome` holds the real welcome/replay frames while selection changes, then requires the new selection to subscribe and reach `live`.
- `ignores a stale event after its session is intentionally closed` injects an ordered stale frame and proves it cannot generate a second subscribe for the closed session.
- `retries the same command ID after disconnect before routing` blocks the first connection before command routing, reconnects, observes the identical ID retry, and requires one durable user message/run.
- `disconnects during historical replay and recovers the exact cursor` closes the real socket while a worker page is held and requires the durable head after reconnect.
- `reconciles approval resolution after disconnect before acknowledgement` closes both tab sockets after approval commit but before acknowledgement and requires duplicate reconciliation plus converged output.
- `serializes a simultaneous two-tab approval race through both UIs` holds both real UI commands before routing, releases them together, and requires one typed `approval.already_resolved` loser.
- `restores keyboard focus after approval and cancel controls disappear` activates both controls with Enter and requires run-status focus after durable removal.
- `restores keyboard focus after a pending-input response disappears` uses a routed protocol projection to exercise input-panel focus handoff until the fake backend gains a natural input-request scenario.
- `cleans child processes and temporary homes when fixture startup fails` covers both nonzero child exit and a live child that never sends ready, then verifies no process or per-start home remains.
- `preserves title and message drafts until durable acceptance` injects ordinary typed rejections, requires both drafts to remain editable, and then requires matching successful acknowledgements to clear them.
- `rejects oversized message and input drafts without closing the connection` uses multibyte message text and large JSON, requires inline limits plus unchanged controls, verifies no input command reached the routed socket, and keeps the connection usable.

### Integration tests

- `Milestone 5 loopback server and WebSocket gateway > bounds bootstrap rows and text inside the catalog worker query` creates 1,002 catalog rows including oversized astral title/preview fields, requires HTTP 200, exactly 1,000 summaries, `sessionsTruncated: true`, bounded text, and no internal catalog fields.

### Test-harness lesson

`WebSocketGateway.disconnectActiveConnections()` intentionally accepts only close code `1012` or application codes `4000`–`4999`; it cannot inject standard policy code `1008`. Terminal-close browser tests therefore use Playwright's routed real WebSocket and close it with `1008`, rather than weakening the production gateway test hook.

## Final verification

| Command | Result |
| --- | --- |
| Focused client-state/socket/recovery unit tests | 3 files, 42 tests passed |
| Recoverable-replay E2E, `--repeat-each=3` | 3/3 passed |
| Terminal-control E2E, `--repeat-each=3` | 3/3 passed |
| Fatal-projection E2E, `--repeat-each=3` | 3/3 passed |
| R2 focused reducer/socket unit tests | 2 files, 38 tests passed |
| R2 replay/handshake/stale-frame E2E, `--repeat-each=3` | 9/9 passed |
| R3 bounded-bootstrap integration test | 1/1 passed with 1,002 catalog rows |
| R3 disconnect/race E2E, `--repeat-each=3` | 12/12 passed |
| R3 keyboard-focus E2E, `--repeat-each=5` | 10/10 passed |
| R4 command-size unit test | Exact 61,440-byte command accepted; 61,441-byte command rejected before enqueue |
| R4 startup-cleanup/draft/oversize E2E | 3/3 passed |
| `pnpm check` | 55 files, 708 tests passed; lint, typecheck, build, and package-export verification passed |
| `pnpm test:e2e` | 21/21 passed |
| Full Milestone 6 Playwright stress, `--repeat-each=3` | 63/63 passed |
| R5 timing-sensitive matrix, `--repeat-each=5` | 50/50 passed |
| PR #12 remediation focused unit matrix | 6 files, 41 tests passed |
| H2 deep-link E2E, `--repeat-each=3` | 9/9 passed |
| M1 lower-limit/raw-input E2E, `--repeat-each=3` | 6/6 passed |
| H1 refresh-journal E2E, `--repeat-each=3` | 9/9 passed |
| H3 unchanged same-origin restart probe, `--repeat-each=3` | 3/3 passed after pre-fix NOT RESOLVED reproduction |
| M2 positive/no-steal/local-failure focus E2E, `--repeat-each=3` | 15/15 passed |
| Final implementation-agent `pnpm check` | 58 files, 736 tests passed; lint, typecheck, build, and package-export verification passed |
| Final implementation-agent `pnpm test:e2e` | 32/32 passed |
| `pnpm dlx yaml-lint@1.7.0 .github/workflows/ci.yml` | Passed |
| `git diff --check` | Passed |
| Process leak check | No Playwright or E2E server processes remained |
| M3 pre-fix deterministic matrix | 4 expected failures: gateway depths 1 and 2, direct `[[]]` command preflight, and socket preflight before journal/pending/send |
| M3 focused frame/limit/client unit matrix | 4 files, 34/34 passed |
| M3 minimum-depth integration | Depths 1 and 2 rejected before startup; depth 3 hello/resume/welcome completed; 3/3 passed |
| M3 depth-composition E2E, `--repeat-each=3` | Raw `[]` routed and completed; raw `[[]]` rejected locally with retained draft and connected socket; 3/3 passed |
| M3 prior-remediation browser matrix | Lower byte limit, auth restart, refresh journal, deep links, and focus: 13/13 passed |
| M3 full `pnpm test:unit` | 36 files, 419/419 passed |
| M3 full `pnpm test:integration` | 6 files, 242/242 passed |
| M3 full `pnpm test:property` | 9 files, 35/35 passed |
| M3 full `pnpm test:process` | 5 files, 26/26 passed |
| M3 full `pnpm test:e2e` | 33/33 passed |
| M3 final `pnpm check` | 58 files, 743/743 passed; lint, typecheck, build, and package-export verification passed |
| M3 `git diff --check` and cleanup | Passed; no Playwright/E2E server processes or `wi-e2e-*` homes remained |

## Remaining non-blocking boundaries

- Histories beyond the browser cap require a future durable snapshot/pagination design; they fail visibly today rather than exhausting resources.
- The current GUI intentionally subscribes only the selected session. A future multi-pane GUI must add a bounded subscription/projection eviction policy below the server's 256-subscription cap.
- Pending-input UI remains implemented but lacks a natural Playwright path because the deterministic fake provider/run loop has no input-request scenario; current focus coverage injects a validated synthetic protocol projection.
- The rendering corpus does not explicitly automate SVG, ANSI, bidi, combining-character, or malformed-link strings. The shared React text-node path remains non-executable and performs no linkification.
- Slow-consumer browser recovery injects close code `4409`; it does not exhaust the real outbound queue through Playwright. Queue accounting and failure behavior remain covered below the browser layer.
- Multi-tab E2E compares durable outcomes, sequences, run state, approvals, and visible timeline behavior rather than serializing and comparing every private reducer field.
- Automated accessibility scanning, screen-reader verification, reduced-motion, and high-contrast testing remain future hardening work; semantic and keyboard regressions are green.
