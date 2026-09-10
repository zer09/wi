# Wi C1 acceptance matrix

Contract `c1.0`; PLAN ONLY. Baseline `640b221b70dbb4d68704e6fa70d12f9533654cf5`.
All rows required and currently **NOT RUN**. Governing decisions are in
[WI_EXECUTION_POLICY_C1.md](WI_EXECUTION_POLICY_C1.md). This is a fixed implementation
assignment, not a request to let the implementor design a new architecture.

## Fixtures and measurement

- T: text-only completed response; empty/refusal/reasoning-only variations.
- A: one add_numbers call, correlated result, then completed answer42.
- B: two sequential addition cycles producing42 then50, then final50.
- L: 160 tiny ordinary calls in160 responses, followed by a final response. Distinct
  call IDs; one session;161 requests; no fake provider global cap. Known small
  payloads remain under storage/input limits.
- P: deterministic pending cooperative tool with explicit release/cancel barriers
  and optional tool-owned timeout_ms. Test-only; not a shipped sleep tool.
- C: nine small valid calls in one response, then one result-only continuation.
- Cache-capacity tests can inject a small byte budget under cfg(test). No production
  setting is added. Tests must distinguish count policy from retained bytes.

Fake providers record opens, generated inputs, identities and closes; pure tools
record dispatch/reuse. Use the actual controller and shared registry. Real adapter
integration uses loopback WebSocket/HTTP and synthetic auth only. A test watchdog
or explicit fixture budget is outside default product behavior. Node runner tests,
Rust tests, source inventory and live evidence are distinct categories.

| ID | Required assertion and minimum evidence | Status |
|---|---|---|
| C1-00 | Verify actual HEAD/dirty tree; preserve user work and historical records. Isolated baseline Cargo gates and152-runner baseline are observed or accurately blocked. No new auth/provider traffic. | NOT RUN |
| C1-01 | RunLimits::default is exactly None/None/None. Rust constructors, CLI omission, missing serialized limits/fields and null do not inject4/8/120 or any substitute. Pre-cancel still rejects before open/events. | NOT RUN |
| C1-02 | Explicit model quota preserves attempted-versus-admitted accounting. Some(1) stops A before tool work; last permitted text response completes. Some(33) and larger representable values validate. Some(0), negative/malformed CLI fail before auth. Unspecified tools/time remain None. | NOT RUN |
| C1-03 | Explicit tool quota: Some(0) allows T and blocks A; one remaining slot rejects two-new-call batch atomically. Cached calls cost no new slot. Some(129) and larger values validate; invalid numeric input rejects without work. Other policies remain absent unless supplied. | NOT RUN |
| C1-04 | Optional deadline: zero/Instant-overflow reject; positive600/601/3601 seconds validate when representable. Some deadline remains absolute across open, model, tools and observer time. Earlier cancellation precedence and completed-terminal selection are retained. No unrelated new ceiling. | NOT RUN |
| C1-05 | Independently test each single configured policy and all policy combinations. Earliest applicable explicit stop wins under existing ordering. Default None cannot produce LimitReached for that absent policy. Explicit old4/8/120 reproduces intended old budget outcomes. | NOT RUN |
| C1-06 | L completes under defaults with161 requests,160 dispatches, correct result IDs/order, one session and final disposition. It crosses4/8/32/128 without count-based stops and without storage/context overflow or result eviction. This is finite evidence, not an infinite-run claim. | NOT RUN |
| C1-07 | With default no deadline, P remains active after paused-clock advances past120,600 and3600 seconds, then completes after release and the model consumes its result. No timer reset trick, real sleep, or detached background task. Explicit short run deadline stops equivalent pending work. | NOT RUN |
| C1-08 | P's optional tool-owned timeout: absent leaves tool pending until release/cancel; present returns the tool's ordinary error/result and permits normal model continuation. It does not become a whole-run Deadline limit. add_numbers and generic Tool interface remain unchanged. | NOT RUN |
| C1-09 | Cancellation with no timer: before admission, pending open/generate/events/tool, and between calls. No later work or fabricated result/finish; exactly one controlled close/result when deliverable. Pending external outcome remains uncertain; no rollback or guaranteed upstream stop. | NOT RUN |
| C1-10 | Preserve terminal-versus-cancellation and sink races from M3. A completed no-call terminal cannot be rewritten by cancellation from its observer. Pending-call cancellation stops. Full/closed/failed sink halts further work; failed final emission preserves execution outcome and reports delivery failure. | NOT RUN |
| C1-11 | Remove128-entry rejection: cache holds/reuses more than128 tiny results under the byte limit. Conflicting reused ID still rejects; fresh runs do not share cache. Cached replay at byte capacity allocates no new record and never executes again. No eviction to disguise a quota. | NOT RUN |
| C1-12 | Byte resource guard: whole-batch metadata/worst-output reservation fits or fails before any dispatch/reuse event. Exact bounded serialized sizes, JSON escaping, oversized-output conversion, actual commit/release and cancellation/error cleanup are tested. Failure is tool_cache_capacity/resource category, not tool-execution quota. Test helper capacity cannot enter production. | NOT RUN |
| C1-13 | C executes nine valid calls sequentially and delivers all results in order. Existing per-request128-item capacity still rejects a129-result batch before effects; this is not a global run count. Complete result vectors obey existing byte validation before submission; oversized results never cause partial submission or claimed rollback. | NOT RUN |
| C1-14 | Full-batch authority/security regressions pass in capped and uncapped modes: partial/malformed JSON, unknown tool, malformed namespace/caller/status, duplicate/conflicting/oversized IDs and unsupported executable output. No work/cache insertion on rejected preflight; cached first items do not bypass validation. | NOT RUN |
| C1-15 | Existing effective-output provenance/recovery, adapter consistency before settlement, input/history/frame bounds, incomplete/error outcomes, request correlation, no retries/fallback, profile pinning and auth behavior remain. Malformed/oversized synthetic inputs remain rejected; no blanket safety-limit deletion. | NOT RUN |
| C1-16 | Public independent-provider tests consume no OpenAI-native keys in run/. Text-only capability admission and required-feature rejections remain correct. T/A/B pass through the same library path and one owned session; normal no-calls completion does not require quota exhaustion. | NOT RUN |
| C1-17 | Loopback WS and SSE prove the new default-policy controller still uses same-socket parent/delta and exact effective-history replay respectively. Include a trace exceeding4 requests/eight new tools with tiny responses. Keep actual provider timeout/credential rules unchanged; do not claim unlimited connection lifetime. | NOT RUN |
| C1-18 | CLI/help: no default quota/time values, optional existing flags, explicit tool opt-in and auth arguments unchanged. Parse rejects invalid/overflow values before touching auth. Pure CLI handler tests exercise omitted/explicit options. Legacy commands and smoke oracles keep their behavior. | NOT RUN |
| C1-19 | Migration and accounting: outer run events schema2, inner provider schema1 unchanged; null/omitted fields decode None; old concrete JSON values decode Some. Explicit Duration shape preserved. Checked u64 counters/turn numbers and artificial overflow report failure without wrapping, new side effects or fabricated completion. | NOT RUN |
| C1-20 | Old budget tests specify their policies explicitly and retain their safeguards. Default-path tests use none, finite scripts and external test-only watchdogs. Offline example terminates normally without requiring limits. No production call to a test-policy helper, no ambient budget injection, no live command added to CI. | NOT RUN |
| C1-21 | All six Cargo gates, verify.py,152-runner self-tests baseline, offline example and diff checks rerun with actual counts; active docs match C1 and retained resource limits. Independent complete-diff review passes after fixes. New reports list all22 rows and unchanged31/50 ledger; no invented red runs, live PASS or rewritten M3 evidence. | NOT RUN |

## Completion rules

Each row needs observed evidence: exact test names/commands, assertions, results,
and blockers. A table-driven test may cover several rows; do not inflate counts.
No minimum new-test count is imposed. Regressions changed solely because their old
mandatory default expectation is intentionally superseded must be recorded as such;
security/explicit-budget coverage is migrated, not removed.

C1 can be accepted OFFLINE only when all required rows and independent review pass.
Partial work reports partial status. No live testing is included or authorized.
No fresh login/account is needed. Test environments must not read real profiles.

After C1, return to the original feature-slice discussion. Do not automatically
begin per-tool progress, skills/search, PTC/async tools, shell execution, persistence
or steering. Correcting defaults does not authorize another milestone.
