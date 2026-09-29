# Handoff: G1 browser client continuation after increment 8c1d-b

## Session Metadata
- Created: 2026-09-22 16:14:11 Asia/Manila
- Project: /home/gc/projects/wi
- Branch: docs/g1-browser-conversation-client
- HEAD: 122166bf842cc174cf4942e6284440318b5564dd
- Accepted runtime baseline: 76bb32fd04fd4737c0efcceaabc7d10387453147
- Session duration: multi-day G1 implementation session

## Recent Commits
- `122166b` docs: plan G1 browser client with independent platform-removal audit
- `76bb32f` Merge PR #9: V1-B HTTP service and Linux/macOS native support
- `6805640` docs: align current platform guidance and preserve V1-B evidence
- `4edb2d7` refactor: remove remaining native Windows test accommodations
- `b2ba6c6` refactor: remove native Windows filesystem and signal branches

## Handoff Chain

- **Continues from**: None
- **Supersedes**: None

This is the first handoff for this task.

## Current State Summary

G1 contract g1.0 implementation is in progress. All changes remain unstaged and uncommitted. The implementation and independent three-review workflow are complete through increment **8c1d-b**, which added real joined-Chromium whitespace-only and HTTP-body-oversized task rejection. The next proposed increment, **8c1d-c**, made no changes because its assignment incorrectly expected HTTP 422. Current source and V1-B API policy require **HTTP 413 `context.input_too_large`** for post-framing provider-input overflow, distinct from **HTTP 413 `api.body_too_large`** at the HTTP body boundary. The working matrix assessment is 14 review-gated rows, 14 partial rows, no candidate or blocked rows, and 4 not-run rows. No final G1 verification reports, browser CI job, commit, push, deployment, real credential read, or live provider generation has occurred.

## Codebase Understanding

## Architecture Overview

The browser is a framework-free TypeScript client compiled to checked-in ES2022 modules under `web/dist/`. Rust embeds an explicit fixed asset inventory with `include_bytes!` and serves only exact public page/CSS/module paths after unchanged Host/Origin checks and before owner authentication. Every `/v1` installation-data route remains authenticated.

The browser path is:

`DOM action -> web client -> real Rust HTTP API -> context preparation -> RunHost/B2 -> SQLite -> OpenAI loopback -> real tools -> committed HTTP/SSE -> reducer -> DOM`

The browser stores the owner token only in memory. It uses same-origin fetch, strict runtime DTO validators, decimal strings and BigInt, immutable pending commands, receipt reconciliation, fixed-head history, applied-cursor SSE, epoch fencing, and text-only DOM rendering.

The ignored Rust browser fixture starts the actual HTTP service with synthetic roots, credentials, SQLite, controlled provider loopback, and stdin controls. Playwright discovers the Cargo JSON test artifact rather than guessing a hashed executable. Direct SQLite audit modules provide closed evidence for mutations and task execution. Traces, HAR, and video stay disabled; external browser requests are blocked without mocking the joined API.

The only production change after the core browser client is the HTTP-only exclusive task submission path. It detects a distinct live operation before expensive preparation, returns static `409 storage.active_run_exists`, and preserves one-time receipt reconciliation. Public `RunClient::submit` historical duplicate behavior and restart/no-live-entry behavior remain unchanged.

## Critical Files

| File | Purpose | Relevance |
|---|---|---|
| `AGENTS.md` | G1 handoff rules and mandatory platform preflight | Read first; it governs scope and evidence claims. |
| `docs/slices/g1/CONTRACT.md` | Fixed G1 contract | Governs all implementation and exclusions. |
| `docs/slices/g1/CLIENT_PROTOCOL.md` | Browser protocol and state rules | Governs command identity, receipts, cursors, retries, and UI truth. |
| `docs/slices/g1/MATRIX.md` | G1-00 through G1-31 acceptance matrix | Use as the row-level completion checklist. |
| `docs/slices/g1/VALIDATION.md` | Required validation and evidence policy | Governs tests, artifacts, and reports. |
| `docs/slices/g1/IMPLEMENTOR_PROMPT.md` | Original implementation handoff | Historical assignment context, not permission to rerun old milestones. |
| `src/http_api/assets.rs` | Fixed compile-time public asset inventory | Enforces exact public paths, MIME, CSP, no-store, and no fallback. |
| `src/http_api/router.rs` | HTTP boundary and asset/auth route order | Preserves Host/Origin checks and protected `/v1` fallthrough. |
| `src/http_api/router/runs.rs` | Task endpoint and HTTP-only exclusive submission | Active-run 409 and receipt reconciliation behavior. |
| `src/http_api/dto/errors.rs` | Static ErrorView mappings | `context.input_too_large` maps to HTTP 413 at approximately lines 202-221. |
| `src/http_api/input.rs` | HTTP body size enforcement | `api.body_too_large` occurs before JSON parsing when body exceeds the limit. |
| `src/context/preparation.rs` | Context composition and second provider-input validation | Lines 161-183 validate before framing, frame project/catalog data, then validate again. |
| `src/service/mod.rs` | RunHost/RunClient admission paths | Contains the scoped HTTP exclusive-submission support. |
| `src/http_api/router/tests/run_tests/active.rs` | Active-operation HTTP race and restart tests | Proves exact 202/409/reconciliation precedence. |
| `src/providers/openai_codex/tests/replay/http_api_joined/browser.rs` | Joined browser fixture entry and controls | Actual service/provider/browser bridge. |
| `src/providers/openai_codex/tests/replay/http_api_joined/browser/mutations.rs` | Closed create/rename/storage audit | Includes corruption-negative audit tests. |
| `src/providers/openai_codex/tests/replay/http_api_joined/browser/task.rs` | Closed task/run/storage audit | Includes 71 corruption cases and intentionally narrow successful-task assumptions. |
| `web/src/api.ts` | Runtime wire guards and request helpers | Strictly validates actual Rust DTOs. |
| `web/src/sse.ts` | Incremental SSE parser | Fatal UTF-8 and framing validation. |
| `web/src/state.ts` | Pure event/history reducer | Fixed-head pages, lifecycle, response, and tool invariants. |
| `web/src/client.ts` | Memory-only browser controller | Auth, reads, SSE, commands, retries, reconciliation, and epochs. |
| `web/src/view.ts` | Framework-free DOM renderer | Safe text rendering, controls, routing, focus, and scroll behavior. |
| `web/e2e/joined.spec.mjs` | Six native/recovered WS/provider-SSE cases | Main joined two-task provider/tool path. |
| `web/e2e/presentation.spec.mjs` | G1-25/27/28 Chromium evidence | Responsive, XSS/private boundary, and three finite measurements. |
| `web/e2e/create-recovery.spec.mjs` | Lost-create-reply recovery | Review-gated increment 8c1a. |
| `web/e2e/rename-recovery.spec.mjs` | Lost-rename-reply recovery | Review-gated increment 8c1b. |
| `web/e2e/task-recovery.spec.mjs` | Lost-202 task recovery and real completion | Review-gated increment 8c1c. |
| `web/e2e/task-active-conflict.spec.mjs` | Distinct-operation active-run 409 | Review-gated increment 8c1d-a. |
| `web/e2e/task-input-rejection.spec.mjs` | Whitespace and HTTP-body-size rejection | Review-gated increment 8c1d-b. |
| `web/test-support/fixture.mjs` | Cargo fixture discovery and closed control parser | Reject new fixture fields unless explicitly validated here. |

## Key Patterns Discovered

- Treat the Rust DTOs and storage behavior as source authority. The planning protocol has known discrepancies: operation lookup receipts are flattened; catalog entries omit `head_sequence`; Rust permits the same provider `response_id` in later turns, so the client retains turn-scoped response instances despite the protocol document's run-scoped wording.
- Every explicit Send creates a fresh `operation_id` and `run_id`. Retry uses the original immutable body only when the command remains uncertain. Canonical accepted recovery without a receipt permits GET reconciliation but never reposting.
- A matching canonical task acceptance can precede the HTTP 202. Contradictory late receipts remain visible immutable conflicts and never become `last_mutation`.
- Safe notices are memory-only, frozen diagnostics. Preserve them through HTTP errors, accepted ErrorView responses, canonical acceptance, conflicts, and reply-null finalization.
- HTTP active-run conflict must remain operation-aware and HTTP-only. A same-operation delayed receipt gets one reconciliation chance; a distinct live operation gets static 409 before context preparation. Do not add a global RunHost guard.
- Joined browser evidence must use the real loopback service and real browser. Do not use `route.fulfill`, mocked API responses, production fake-provider flags, or manually fabricated transcripts.
- Browser diagnostics must never retain request headers, raw large bodies, owner credentials, full private context, UUIDs when booleans suffice, or task digests. Use bounded counters, lengths, 64-character boundaries, and boolean comparisons. Sanitize catch blocks because Playwright call logs can expose input values.
- The retained read-only SQLite connection in the joined fixture avoids fixture-only `SQLITE_BUSY`. Keep snapshots short and synchronize DOM assertions to the browser applied cursor reaching the persisted final sequence.
- Test-only audit `exact:true` must be independently derived. Reviewers already found and required fixes for create and task audit false-positive paths. The task audit intentionally accepts only one fresh successful task and is not a general storage auditor.
- Do not use root-level npm commands. Run npm commands from `web/` or with `npm --prefix web`.

## Work Completed

## Tasks Finished

- [x] G1-00/G1-01 mandatory independent platform preflight, residual `USERPROFILE` removal, and Unix comment alignment.
- [x] Pre-existing 4,097-event consistency-loopback flake remediation by using the existing 600-second total timeout while preserving the 5-second per-event watchdog and production behavior.
- [x] Framework-free TypeScript/Playwright foundation with exact dev-only pins and atomic reproducible generated assets.
- [x] Strict browser API DTO and SSE modules.
- [x] Pure reducer/history/epoch/display state with lifecycle, tool, response, numeric, duplicate, gap, and fixed-head invariants.
- [x] Narrow compile-time embedded asset serving with complete TCP security boundary tests.
- [x] Memory-only browser controller with immutable commands, receipt reconciliation, no automatic mutation retry, and notice retention.
- [x] Safe DOM UI with hash selection, connection/session/history/composer/recovery controls, focus, scrolling, responsive layout, and explicit reload/reconnect/cancel actions.
- [x] Real joined Chromium over WS and provider SSE, native and recovered, including actual HTTP, SQLite, provider loopback, AddNumbers, SSE, reducer, and DOM.
- [x] G1-25/27/28 presentation, privacy, keyboard, responsive, scroll/focus, and three finite measurement fixtures.
- [x] Increment 8c1a real lost-201 CREATE recovery and independently hardened create audit.
- [x] Increment 8c1b real lost-reply RENAME recovery, post-recovery navigation/reload, and refresh semantics.
- [x] Increment 8c1c real lost-202 TASK recovery, GET-only canonical reconciliation, real tool execution, and independently hardened task audit.
- [x] Increment 8c1d-a operation-aware HTTP active-run conflict with 409/reconciliation races and stable joined E2E.
- [x] Increment 8c1d-b exact whitespace and HTTP-body-oversized task rejection, including fresh command identities and strict page-console leakage checks.

## Files Modified

All implementation changes are intentionally unstaged. The authoritative current inventory is `git status --short`; do not infer the complete diff from this summary.

| Area | Files | Changes and rationale |
|---|---|---|
| Platform preflight | `src/providers/openai_codex/auth.rs`, `src/providers/openai_codex/tests/authentication/auth_edge_tests.rs`, two HTTP test comments | Remove the retired `USERPROFILE` fallback, prove process-isolated defaults ignore it, and align Unix-only comments. |
| Reliability | `src/providers/openai_codex/tests/consistency/consistency_loopback_tests.rs` | Use existing default total timeout for the 4,097-event test without production changes. |
| Public assets | `src/http_api/assets.rs`, `src/http_api/router.rs`, `src/http_api/mod.rs`, `src/http_api/router/tests/asset_tests.rs`, router test modules | Add exact embedded public assets and boundary tests. |
| Active HTTP submission | `src/service/mod.rs`, `src/service/types.rs`, service tests, `src/http_api/router/runs.rs`, `src/http_api/dto/errors.rs`, active/receipt router tests | Add operation-aware HTTP-exclusive admission and exact static active-run ErrorView while preserving public RunClient behavior. |
| Joined browser fixture | `src/providers/openai_codex/tests/replay/http_api_joined.rs`, `fidelity.rs`, `browser.rs`, and `browser/` modules | Add ignored actual-service browser fixture, controls, audits, presentation, mutation, and task evidence. |
| Browser client | complete untracked `web/` tree | Add source, generated assets, Node tests, Playwright configuration/support, and seven E2E specs. |
| Handoff | `handoffs/2026-09-22-161411-g1-browser-client-continuation.md` and companion prompt | Transfer current state only; not implementation evidence. |

At handoff creation, tracked changes were 19 files with 353 insertions and 15 deletions, plus the untracked Rust browser/assets/tests, complete `web/` tree, and handoff files. Re-run `git status --short`, `git diff --check`, and explicit untracked inspection before work.

## Decisions Made

| Decision | Options Considered | Rationale |
|---|---|---|
| Compile-time fixed public assets | Generic static directory, SPA fallback, explicit inventory | Explicit inventory prevents arbitrary file exposure and keeps Node out of Cargo runtime/build requirements. |
| Framework-free browser | Framework/runtime dependencies, plain TypeScript | Contract forbids production JavaScript dependencies and requests a small text-first client. |
| Atomic generated-asset build | Direct compiler output, staged output then replace | Failed builds cannot partially publish checked-in assets; verifier catches stale/missing/extra files. |
| Turn-scoped response instances | Reject repeated run-level response IDs, retain per-turn instance | Actual Rust collector/storage allows the same `response_id` in later turns. Final reports must record the protocol contradiction. |
| HTTP-only exclusive task admission | Global RunHost active guard, router precheck only, operation-aware exclusive API path | Gives deterministic browser 409 without changing historical public `RunClient::submit` behavior or losing receipt-race reconciliation. |
| Test-only closed audits | Trust UI alone, expose private diagnostics, SQLite-derived closed evidence | Joined tests need independent proof without leaking stored private content. |
| Context-size response is 413 | Incorrect 422 expectation, production mapping change, source-defined 413 | `src/http_api/dto/errors.rs` and V1-B API both require 413 for `context.input_too_large`. The error code distinguishes it from `api.body_too_large`. |

## Pending Work

## Immediate Next Steps

1. Load and verify this handoff against `AGENTS.md`, the ordered G1 documents, current branch/HEAD, full staged/unstaged/untracked tree, and the mandatory fresh-agent platform preflight requirements. Do not edit until that verification is complete.
2. Resume increment **8c1d-c** as a new implementation increment. Add one focused real joined-Chromium case where the actual JSON task body is accepted at or below `MAX_INPUT_BYTES`, context framing pushes the provider input over the limit, and the exact result is **HTTP 413 `context.input_too_large`**, stage null, certainty `not_applicable`, acceptance null, notices empty. The prior attempt changed no files.
3. Prove 8c1d-c uses one explicit Send, preserves exact draft/immutable command bytes, creates no task/run/provider/auth/tool work, and differs from HTTP-layer **413 `api.body_too_large`** by code. Keep full text, IDs, and digests out of diagnostics. Run the focused checks and the required independent three-review gate.
4. Continue remaining G1-11 cases in bounded increments: stale history, unknown commit, known acceptance warning, incomplete/unbound history, and account mismatch. Do not bundle unrelated lifecycle rows.
5. Continue G1-12, G1-15 through G1-21, G1-24, and G1-26 as separate joined increments. Then add browser CI, run final accumulated gates/examples, obtain complete-diff reviews, and create G1-31 reports only from actual retained evidence.

## Blockers/Open Questions

- [ ] No current technical blocker. The last delegate stopped intentionally because its assignment expected 422, contradicting established 413 behavior. Correct the assignment rather than production code.
- [ ] `CLIENT_PROTOCOL.md` says response identity is `(run_id,response_id)`, but source-valid Rust behavior allows the same `response_id` in later turns. The implemented client keeps turn-scoped response instances. Record this contradiction and request authority in final reporting; do not silently change runtime behavior.
- [ ] Determine the deterministic task byte count for 8c1d-c before sending. The current client JSON envelope added 115 bytes in 8c1d-b, but the new test must assert the captured actual body is `<= MAX_INPUT_BYTES` and must not rely on an unverified magic value. One task POST only.

## Deferred Items

- G1-12 actual three-page fixed-head interleavings with writes, rename, private checkpoints, and SSE attachment.
- G1-15 real A→B/disconnect/reload epoch races.
- G1-16 remaining joined refusal/reasoning/multiple-index/normalized-fallback/unsupported-marker variants.
- G1-17 joined tool reuse and error-shaped successful output.
- G1-18 interruption, result-recording failure, shutdown, and incomplete-history behavior.
- G1-19 joined cancellation distinctions.
- G1-20 real stream-drop/reconnect cases.
- G1-21 two-browser ownership and stalled-reader behavior.
- G1-24 S2 `load_skill`, historical restoration, and account identity guard over both transports.
- G1-26 process restart and preserved interruption.
- G1-29 final accumulated six Cargo gates, `platform_support`, `verify.py`, CLI self-test, and eight examples.
- G1-30 browser CI plus three fresh complete-diff reviews.
- G1-31 human/JSON reports and separately authorized exact-head hosted CI closure.

## Context for Resuming Agent

## Important Context

- Project instructions require reading, in order: `docs/PLATFORM_SUPPORT.md`, `docs/slices/v1b/PLATFORM_FOLLOWUP.md`, `docs/slices/v1b/platform-followup.json`, then all five G1 documents, followed by current V1-B API/security and actual source.
- Native Windows backend support is withdrawn. Do not restore it or remove portable APIs, synthetic negative fixtures, historical Windows evidence, or third-party target metadata by keyword.
- Accepted runtime baseline is `76bb32fd04fd4737c0efcceaabc7d10387453147`; current planning HEAD is `122166bf842cc174cf4942e6284440318b5564dd`. All G1 changes are uncommitted owner work and must be preserved.
- Latest matrix assessment is a working status, not the final G1 verification report:

| Status | Matrix rows |
|---|---:|
| Review-gated locally | 14 |
| Candidate pass, awaiting review | 0 |
| Partial evidence | 14 |
| Currently blocked | 0 |
| Not run | 4 |

| Row | Status | Current position |
|---|---|---|
| G1-00 | ✅ Review-gated | Baseline, ancestry, worktree, retained evidence, and prior reports inspected. |
| G1-01 | ✅ Review-gated | Full platform audit and residual `USERPROFILE` cleanup complete. |
| G1-02 | ✅ Review-gated | Exact dependencies, atomic build, and reproducible generated assets complete. |
| G1-03 | ✅ Review-gated | Narrow embedded public asset delivery and TCP boundary tests complete. |
| G1-04 | ✅ Review-gated | `/v1` authentication, Host/Origin, CSP, and protected-route boundaries preserved. |
| G1-05 | ✅ Review-gated | Real Connect/Disconnect, same-origin requests, memory-only token, and privacy checks complete. |
| G1-06 | ✅ Review-gated | Strict runtime DTO, error, event, and SSE validation complete. |
| G1-07 | 🟨 Partial | Real creation and lost-201 duplicate recovery pass; complete catalog paging and empty-list coverage remain. |
| G1-08 | 🟨 Partial | Real rename lost-reply recovery, duplicate retry, navigation, reload, and refresh pass; remaining canonical edge cases remain. |
| G1-09 | 🟨 Partial | Real paused acceptance and durable receipts pass; accepted-failure distinctions remain incomplete. |
| G1-10 | 🟨 Partial | Real lost-202 recovery and no-repost reconciliation pass; remaining uncertainty variants need joined evidence. |
| G1-11 | 🟨 Partial | Active-run 409 plus whitespace and HTTP-body-size rejection are review-gated. Context-framed overflow and other failure cases remain. |
| G1-12 | 🟨 Partial | Long multi-page history is exercised, but required write/rename/checkpoint interleaving across fixed-head pages remains. |
| G1-13 | ✅ Review-gated | SSE framing, malformed input, and actual server-frame consumption complete. |
| G1-14 | ✅ Review-gated | Decimal/BigInt, cursor, duplicate, gap, conflict, and identity handling complete. |
| G1-15 | 🟨 Partial | Epoch races have reducer/controller coverage; joined A-to-B, disconnect, and reload races remain. |
| G1-16 | 🟨 Partial | Native and recovered authoritative output pass; complete joined refusal/reasoning/index/fallback variants remain. |
| G1-17 | 🟨 Partial | Real `add_numbers` execution passes; joined reuse and error-shaped result cases remain. |
| G1-18 | 🟨 Partial | Normal completion is joined; interrupted, recording-failure, shutdown, and old incomplete-history cases remain. |
| G1-19 | 🟨 Partial | Cancel controls and client rules exist; joined cancellation distinctions remain. |
| G1-20 | 🟨 Partial | Reconnect logic has unit coverage; real stream-drop cursor recovery remains. |
| G1-21 | ⬜ Not run | Two-browser ownership, page closure, reopening, and stalled-reader acceptance remain. |
| G1-22 | ✅ Review-gated | WebSocket native and recovered two-task paths pass end to end. |
| G1-23 | ✅ Review-gated | Provider-SSE labelled/missing-MIME and native/recovered paths pass end to end. |
| G1-24 | ⬜ Not run | Joined `load_skill`, historical restoration, and account-identity guard remain. |
| G1-25 | ✅ Review-gated | Joined Chromium XSS, inert markup, external-request, and private-data boundaries pass. |
| G1-26 | ⬜ Not run | Process restart, preserved interruption, and zero automatic resumed work remain. |
| G1-27 | ✅ Review-gated | Responsive Chromium, keyboard, focus, scrolling, controls, and live-region evidence complete. |
| G1-28 | ✅ Review-gated | Exactly three finite presentation/resource fixtures and qualified measurements complete. |
| G1-29 | 🟨 Partial | Many native/offline gates pass, but the final accumulated-diff command group and eight examples must be rerun. |
| G1-30 | 🟨 Partial | Browser build and E2E exist; browser CI and fresh complete-diff reviews remain. |
| G1-31 | ⬜ Not run | Final verification reports and exact submitted-head CI closure remain. |

- Latest stable unit count is 281 Node tests. The latest broad browser run was 7/7 through presentation increment 8b. Five later focused specs passed independently: create recovery, rename recovery, task recovery, active conflict, and task input rejection. Do not claim a final accumulated all-browser run yet.
- 8c1d-b initially required five focused implementation executions. Retain these failures: wrong idle-stage expectation, one undiagnosed reply-observation failure, hidden role locator after Disconnect, and create-outcome timing. Its first review found two real test-oracle gaps: no direct fresh `run_id` proof and non-error console leakage. Both were independently confirmed, remediated test-only, and passed the repeated unanimous review gate.
- Retain all earlier failure/remediation history listed under Potential Gotchas. Final reports must include initial failures, reviewer disagreements, and limitations, not only green reruns.
- All work remains unstaged and uncommitted. Do not stage, commit, push, merge, deploy, or start hosted CI without separate explicit authorization.

## Assumptions Made

- Existing accepted increment boundaries remain fixed unless current source verification contradicts them.
- Synthetic fixture credentials, roots, workspaces, skills, and provider loopbacks remain authorized. Real credentials, live provider generations, auth commands, and owner-private data remain prohibited.
- Playwright Chromium works locally on openSUSE Tumbleweed under WSL, but this is not an officially supported Playwright platform. Ubuntu browser CI is the eventual supported-platform confirmation.
- A fresh parent agent should follow the repository's delegated implementation/review workflow for non-trivial increments rather than modifying broad scope directly.

## Potential Gotchas

- `web/` and most browser fixture files are untracked. Ordinary `git diff` does not show their contents. Inspect `git status --short`, `git ls-files --others --exclude-standard`, and untracked-file whitespace explicitly.
- Rust `include_bytes!` depends on `web/index.html`, `web/style.css`, and all six `web/dist/*.js` files being present together. A missing untracked asset breaks Cargo compilation.
- `web/tsconfig.json` uses `moduleResolution: bundler`, so tooling explicitly rejects extensionless relative TypeScript imports. Use `.js` suffixes in source imports.
- SQLx 0.9 rejects dynamic SQL strings in the test helpers. Use literal query pairs; this caused earlier `E0277` failures.
- Playwright assertions can print large input or DOM content. For oversized/private values, assert bounded booleans and sanitize caught failures. Do not pass the full task to an assertion that can render expected/actual output.
- Chromium console resource-error wording is intentionally exact in `task-input-rejection.spec.mjs`. All other page console messages fault.
- The presentation spec takes four synthetic screenshots. They remain ignored and are cleared on failure. Do not run it casually when a task forbids new screenshot artifacts; when required, verify no token is present.
- Fixture `Inspect` combines some separate short SQLite snapshots only at quiescent gates. Do not treat it as an atomic general-purpose auditor.
- The retained task audit rejects source-valid failed, cancelled, later-task, and result-terminalized histories. Extend it before using it outside its one-fresh-successful-task scope.
- Stream EOF is not task completion. Final browser assertions must wait for the applied cursor to reach the persisted final sequence.
- A create/rename receipt-session Open action can be a no-op if already selected. Tests must first select another real catalog entry when proving navigation causes manifest/history reads.
- Active-conflict E2E must wait specifically for the task operation ID; generic accepted-receipt text can match the earlier create receipt.
- Do not erase these retained histories in final reports: preflight all-target timeout flake; SSE fixture `SQLITE_BUSY`; presentation locator/slow-consumer/body-capture/control failures; create audit reviewer disagreement; rename wrong-module/SQLx and receipt-open gaps; task audit disagreement and corruption false positives; active-conflict initial 422s and stale receipt assertion race; 8c1d-b failures and review remediation.

## Environment State

## Tools/Services Used

- Rust/Cargo with warm offline dependency and test-artifact cache.
- Node `24.18.0`, npm `12.0.2`.
- TypeScript `5.9.3` and Playwright `1.58.2`, exact dev-only pins.
- Local Playwright Chromium on openSUSE Tumbleweed under WSL.
- `uv` for Python commands and verification scripts.
- CodeGraph for indexed source exploration.
- Delegated implementation, verification, remediation, and three-role review gates.

## Active Processes

- No intentional long-running server, watcher, provider, or browser fixture remains active.
- `web/node_modules/`, Cargo build outputs, Playwright browser installation, and ignored `web/test-results/.last-run.json` may remain locally.

## Environment Variables

- No secret environment variable value is required or recorded in this handoff.
- Inspect `PI_*` names only if harness diagnostics are needed.
- Fixture credentials and provider configuration must remain synthetic and process-local.

## Related Resources

- `docs/PLATFORM_SUPPORT.md`
- `docs/slices/v1b/PLATFORM_FOLLOWUP.md`
- `docs/slices/v1b/platform-followup.json`
- `docs/slices/g1/CONTRACT.md`
- `docs/slices/g1/CLIENT_PROTOCOL.md`
- `docs/slices/g1/MATRIX.md`
- `docs/slices/g1/VALIDATION.md`
- `docs/slices/g1/IMPLEMENTOR_PROMPT.md`
- `web/package.json`
- `web/playwright.config.mjs`
- Companion continuation prompt: `handoffs/2026-09-22-161411-g1-browser-client-continuation-prompt.md`

---

**Security reminder:** This handoff contains no credentials, tokens, cookies, authorization headers, or private fixture payloads. Verify the current tree before acting; the handoff is context, not authority.
