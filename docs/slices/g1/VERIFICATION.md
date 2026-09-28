# G1 browser client checkpoint verification

Contract **g1.0**. Accepted runtime baseline:
**76bb32fd04fd4737c0efcceaabc7d10387453147**. Implementation checkpoint:
**a89aeb49929929901e3613cc9bd3f450f3719f33**. Date: **September 28, 2026
(Asia/Manila)**.

Status: **PAUSED_DESIGN_REVIEW; accepted=false**.

This report records the implementation checkpoint on draft PR #10. It does not
accept G1, close the matrix, authorize a merge, or replace the frozen V1-B reports.
The owner paused implementation after confirming that the planned initial-history
model conflicts with the intended latest-activity and lazy-backscroll experience.
See [DESIGN_REVIEW.md](DESIGN_REVIEW.md).

## 1. Scope and evidence labels

- **PASS_LOCAL_REVIEWED** means the stated row has retained local evidence and its
  completed bounded increments passed their applicable independent review gates. It
  is not hosted CI, cross-platform browser, live-provider, deployment, or G1 acceptance.
- **PARTIAL** means useful evidence exists, but at least one required case, final
  review, or design-dependent assertion remains open.
- **BLOCKED_DESIGN** means implementation or evidence cannot be accepted until the
  planner resolves the identified product/API contradiction.
- **NOT_RUN** means no retained row-level execution evidence was established.

All browser fixtures use synthetic roots, owner/provider credentials, workspaces,
skills, and provider loopbacks. No real credential, private skill, authentication
command, live provider generation, deployment, release, or merge occurred. The
ledger remains **31/50 used, 19 remaining**; this checkpoint used no live generation.

## 2. Current matrix status

| Row | Status | Current checkpoint evidence and remaining work |
|---|---|---|
| G1-00 | PASS_LOCAL_REVIEWED | Baseline, ancestry, complete worktree, retained reports, owner changes, and no-live authority were inspected. Final submitted-head closure remains G1-31. |
| G1-01 | PASS_LOCAL_REVIEWED | The complete Windows-removal follow-up was independently audited; residual `USERPROFILE` handling was removed; Unix safety and retained Linux/macOS policy were checked; `platform_support` passes. |
| G1-02 | PASS_LOCAL_REVIEWED | Exact TypeScript 5.9.3 and Playwright 1.58.2 dev pins, no production JS dependency or new Rust dependency, atomic generated modules, and six-asset reproducibility are implemented and locally checked. |
| G1-03 | PASS_LOCAL_REVIEWED | Exact embedded GET/HEAD asset inventory, MIME/security headers, Host/Origin boundary, method/query/body rejection, and no generic fallback have TCP coverage. |
| G1-04 | PASS_LOCAL_REVIEWED | Existing `/v1` bearer, authority, Origin, CSP, and protected-route behavior remains covered after the public asset exception. |
| G1-05 | PASS_LOCAL_REVIEWED | Real Connect/Disconnect, memory-only owner token, same-origin authenticated fetch, 401 clearing, request abort, zero implicit cancellation, and privacy checks have local browser evidence. This is one shared owner token, not registration, login, or per-browser isolation. |
| G1-06 | PASS_LOCAL_REVIEWED | Runtime DTO, decimal-string, ErrorView, event, media, JSON, SSE, and malformed-schema validation is implemented with safe static failures. |
| G1-07 | PARTIAL | Real creation and lost-201 same-command recovery pass. Complete catalog pagination, ordering/product semantics, and empty-list acceptance remain unresolved. |
| G1-08 | PARTIAL | Real rename loss/retry, canonical reads, navigation, reload, and refresh dispositions pass. Selection/history behavior now depends on the latest-first redesign. |
| G1-09 | PARTIAL | Paused acceptance, durable receipt, canonical replacement, and warning paths have joined evidence. Full row-level acceptance-failure closure and final complete-diff review remain. |
| G1-10 | PARTIAL | Lost-202 recovery, immutable command identity, explicit reconciliation, and zero repost pass. Remaining uncertainty variants and whole-row review remain. |
| G1-11 | PARTIAL | Joined evidence exists for whitespace/body/context limits, active-run conflict, stale history, commit-unknown, committed cleanup warning, incomplete history, unbound history, and account mismatch. The context-framing increment retained only two independent reviews rather than the originally requested three, so the row is not labelled fully review-gated. |
| G1-12 | BLOCKED_DESIGN | The planned ascending fixed-head replay (`sid:0` through `H`) was implemented and reviewed, including pages 32/32/2 and concurrent writes. The owner rejected this product behavior: initial load/refresh must start at latest activity and page backward on scroll. Existing evidence proves the wrong UX contract. |
| G1-13 | PASS_LOCAL_REVIEWED | Standard SSE framing, UTF-8 splits, comments, delimiters, IDs, malformed input, EOF partial-frame handling, and actual server-frame parsing have local coverage. The client uses a manual standard-SSE parser because native EventSource cannot set the owner bearer or disable automatic reconnect. |
| G1-14 | PASS_LOCAL_REVIEWED | Decimal/BigInt fidelity, qualified cursors, sequence gaps, exact/conflicting duplicates, session identity, and apply-before-cursor rules have local coverage. |
| G1-15 | PASS_LOCAL_REVIEWED | Joined selection A-to-B, Disconnect/reconnect, and full-reload epoch races passed bounded independent reviews. Full-reload expectations must be revised with the history design. |
| G1-16 | PASS_LOCAL_REVIEWED | Joined provisional reasoning/text/refusal/function deltas, terminal item replacement, unsupported marker, authoritative output, reload, and separate generic normalized fallback DOM evidence passed local review. |
| G1-17 | PARTIAL | Joined real tool execution, in-run reuse, cross-run call-ID isolation, exact output, and successful error-shaped JSON pass. Finish-without-result joined injection, provider-SSE parity, and whole-row final review remain. |
| G1-18 | PARTIAL | Joined native-WebSocket provider EOF with retained committed partial output and witnessed final-result rollback passes. Process restart, shutdown/browser-stream loss, provider-SSE parity, and all interruption variants remain. |
| G1-19 | PARTIAL | Joined explicit Cancel proves one 202 `requested` signal, distinct running truth, postcommit `cancelled_locally`, recorded result, and zero implicit cancels. Joined `not_tracked`, `api.closed`, and cross-client cases remain broader evidence gaps. |
| G1-20 | BLOCKED_DESIGN | The cfg(test) serialized-SSE fault foundation is review-gated and Window A mid-frame recovery works. Two Window B mechanisms failed to expose a complete selected frame in Chromium before JS consumption. More importantly, the row assumes the rejected full-prefix client model. Window C and terminal closure were not completed. |
| G1-21 | PARTIAL | The fixed-head fixture has two authenticated contexts and stalled-reader evidence, but does not complete the required close-pending/watch/reopen sequence. Its history assertions depend on the redesign. |
| G1-22 | PASS_LOCAL_REVIEWED | Native and recovered WebSocket two-task joined paths pass through real browser, HTTP, RunHost/B2, SQLite, loopback provider, AddNumbers, SSE, reducer, and DOM. |
| G1-23 | PASS_LOCAL_REVIEWED | Provider-SSE labelled and missing-MIME, native and recovered paths pass. Browser SSE and provider SSE remain separate. |
| G1-24 | PARTIAL | Joined account-identity mismatch evidence exists. Actual `load_skill`, stored-skill historical restoration through the browser, and both transport paths remain. |
| G1-25 | PASS_LOCAL_REVIEWED | Joined synthetic XSS/inert-markup, external-request blocking, safe text rendering, and private-data boundary evidence pass locally. |
| G1-26 | NOT_RUN | No retained joined process-restart/browser-reopen acceptance proves preserved interruption and zero resumed work. |
| G1-27 | PASS_LOCAL_REVIEWED | Responsive sizes, keyboard submission/newline behavior, focus, controls, scroll behavior, and live-region assertions pass locally. History-scroll behavior must be extended after backward pagination is designed. |
| G1-28 | PARTIAL | Three finite fixtures and measurements exist, but long-history rebuild measurements describe the rejected replay-from-zero design and cannot validate the intended lazy-backscroll product. |
| G1-29 | PARTIAL | The checkpoint passes all six local Cargo gates, `platform_support`, 466 Node tests, typecheck, and asset verification. `verify.py`, CLI self-test, and all eight examples were not freshly rerun after the final accumulated changes. |
| G1-30 | PARTIAL | Twenty-six real Chromium scenarios pass when the explicitly blocked read-reconnect prototype is excluded. No browser CI job, hosted run, or three fresh complete-diff reviews cover this checkpoint. |
| G1-31 | PARTIAL | This human report, machine report, design review, and handoff now exist. Exact submitted-head CI is intentionally NOT_RUN, G1 is not accepted, and PR #10 remains a draft. |

Summary: **15 PASS_LOCAL_REVIEWED, 14 PARTIAL, 2 BLOCKED_DESIGN, 1 NOT_RUN**.
These counts are checkpoint classifications, not the original matrix's planning state
and not an acceptance score.

## 3. Checkpoint validation

The following commands ran on the complete implementation tree immediately before
commit `a89aeb4`:

| Command | Result |
|---|---|
| `cargo fmt --all -- --check` | PASS |
| `cargo check --locked --offline --all-targets` | PASS |
| `cargo test --locked --offline --all-targets` | PASS; library summary 646 passed, 9 ignored helpers; all integration/example test binaries passed |
| `cargo clippy --locked --offline --all-targets -- -D warnings` | PASS |
| `cargo build --locked --offline --all-targets` | PASS |
| `cargo test --locked --offline --doc` | PASS; 0 doctests |
| `cargo test --locked --offline --test platform_support` | PASS; 1 passed |
| `npm --prefix web run typecheck` | PASS |
| `npm --prefix web run verify:assets` | PASS; 6 generated assets verified |
| `npm --prefix web test` | PASS; 466 tests |
| `env -u NODE_OPTIONS npm --prefix web run test:e2e -- --workers=1 --grep-invert "joined read reconnect"` | PASS; 26 Chromium scenarios in 4.2 minutes |
| `git diff --check` | PASS |

Environment observed by the joined fixtures: Node **24.18.0**, Playwright **1.58.2**,
and Chromium **145.0.7632.6**. The local host is openSUSE Tumbleweed under WSL;
this is not Ubuntu browser CI or native macOS browser evidence.

The excluded `read-reconnect.spec.mjs` is not silently green. Two retained executions
of the revised asynchronous-gate prototype failed at Window B because Chromium emitted
zero future `Network.dataReceived` events for the complete selected frame while the
native reader was held. The earlier debugger-pause prototype failed for the same
observable boundary. Those failures are part of the result.

## 4. Implemented checkpoint

Commit `a89aeb4` contains:

- framework-free TypeScript source and checked-in ES modules;
- exact embedded public assets and HTTP boundary tests;
- memory-only owner-token connection flow;
- strict browser DTO/SSE validation, reducer, epochs, commands, receipts, explicit
  cancellation/reconnect controls, and safe text DOM;
- actual joined browser fixture over HTTP, RunHost/B2, SQLite, OpenAI loopbacks, and
  tools;
- recovery, input, fixed-head, presentation, tool, lifecycle, cancellation, and
  partial read-reconnect fixtures;
- narrow production Rust changes for public assets and operation-aware HTTP exclusive
  task admission;
- test-only fault and storage hooks used by closed fixtures;
- removal of the retired `USERPROFILE` fallback and a bounded test-time reliability
  adjustment for the 4,097-event consistency fixture.

No JavaScript production dependency, Node server, new Rust dependency, production
fake-provider endpoint, source map, service worker, generic static fallback, browser
credential storage, automatic task retry, or implicit cancel was added.

## 5. Retained failure and review history

The checkpoint history includes, rather than erases:

- initial platform inventory and portability findings;
- the 4,097-event test timeout adjustment;
- joined-fixture SQLite and browser timing failures;
- create/task audit reviewer disagreements and subsequent negative-oracle hardening;
- stale-history Playwright failure-artifact and DevTools body-read defects, with
  privacy-safe remediations;
- the missing third review for the context-framing increment;
- G1-12's initial incorrect page-count assumption and accumulated Clippy finding;
- presentation fixture ordering, ID, formatting, and Clippy corrections;
- lifecycle final-append operation-ID correction;
- cancellation's public-read/mutex contradiction and corrected SQLite oracle;
- G1-20's initial RunView lock contradiction;
- G1-20 Window B failures under debugger pause and asynchronous pre-read gating;
- the owner-discovered latest-history design contradiction.

Increment reviews are bounded. They do not substitute for the three final independent
complete-diff reviews required by G1-30.

## 6. Design blocker

The frozen planner protocol requires selection and full reload to:

1. reset to `sid:0`;
2. page every event forward through a captured head `H`;
3. reduce the complete prefix; and
4. attach SSE after `H`.

The current server query is `sequence > after ... ORDER BY sequence`, and the browser
implements that plan. The owner instead requires initial selection and refresh to
start with the latest canonical activity, then fetch older conversation pages only
when the reader scrolls upward. This is a material product/API difference, not a test
adjustment.

Raw reverse event pages are insufficient because a page can begin after the event
that establishes a run's identity and state. The planner must choose a canonical
conversation projection/snapshot and define independent backward-history and live
observation cursors. See [DESIGN_REVIEW.md](DESIGN_REVIEW.md) for the decision packet.

## 7. Hosted and delivery status

- Draft PR: **#10**.
- Implementation checkpoint: **a89aeb49929929901e3613cc9bd3f450f3719f33**.
- Hosted CI for this checkpoint: **NOT_RUN by owner direction**.
- Commit messages use GitHub's supported `[skip ci]` instruction because the only
  repository workflow triggers unconditionally on both `push` and `pull_request`.
- Merge, release, deployment, and live-provider validation: **NOT_AUTHORIZED / NOT_RUN**.
- Overall: **accepted=false**.
