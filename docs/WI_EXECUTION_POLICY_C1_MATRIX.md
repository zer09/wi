# Wi C1 acceptance matrix — full feature removal

Contract `c1.1`; PLAN ONLY. Runtime baseline `640b221b70dbb4d68704e6fa70d12f9533654cf5`.
All 18 rows are required and **NOT RUN**. This replaces the c1.0 optional-budget matrix; none of its Some/None-budget or cache-reservation requirements remains active.

Governing contract: [WI_EXECUTION_POLICY_C1.md](WI_EXECUTION_POLICY_C1.md).

Fixtures: T is a text-only response (also empty/refusal/reasoning-only variants); A is one add_numbers/result/final42 cycle; B is two addition cycles/final50; L is 160 tiny calls followed by a final response; C is nine small calls in one batch; P is a cooperative pending test-only tool with explicit release/cancel control and optional tool-owned timeout. Use finite scripts, controlled clocks, synthetic credentials, and loopback transports. Test watchdogs stay outside product policy.

| ID | Required assertions and minimum evidence | Status |
|---|---|---|
| C1-00 | Record HEAD/worktree and observed baseline Cargo/Node gates. Preserve user work, completed auth/M3 evidence, and the 31/50 ledger. No real credentials or provider traffic. | NOT RUN |
| C1-01 | RunLimits, RunRequest.limits, LimitKind, LimitReached, quota helpers, and whole-run timer plumbing are deleted from active APIs/control flow. Inspect actual source and callers; no Option/no-op/renamed/feature-gated substitute remains. | NOT RUN |
| C1-02 | Public library run request contains provider_id/options/prompt only; T/A/B use the unchanged controller entry point and one owned session with independent non-OpenAI native shapes. Normal completion needs no quota exhaustion. | NOT RUN |
| C1-03 | L completes with 161 requests and 160 executions under small resource use; result identities/order are correct, no hidden 4/8/32/128 stop, no eviction/reexecution, and no detached work. | NOT RUN |
| C1-04 | P remains pending through controlled logical time beyond 120/600/3600 seconds with no controller timer, then completes on release and its result is consumed. No actual long sleep or disabled deadline preset. | NOT RUN |
| C1-05 | P's own optional timeout omitted means wait for release/cancel; supplied means its tool-owned timer yields an ordinary correlated tool error/result. No whole-run deadline outcome exists. Production Tool/add_numbers gains no timeout option. | NOT RUN |
| C1-06 | Cancellation before admission and during open/generate/events/tool/between calls preserves M3 cleanup and uncertainty. No later work or partial result submission; no fabricated successful tool finish or confirmed upstream stop. | NOT RUN |
| C1-07 | Completed-no-call terminal selection still wins over later observer-triggered cancellation. Pending-call cancellation stops work. Full/closed/failed observer and final-delivery failure retain M3 execution-versus-delivery semantics. | NOT RUN |
| C1-08 | Batch C runs nine valid calls in order. Existing per-request input capacity still rejects a result batch that cannot fit before dispatch. Complete actual output-vector byte/shape checks precede submission; no subset or rollback claim. | NOT RUN |
| C1-09 | More than 128 small cached results can be retained/reused; identical calls do not execute again, conflicts still fail, separate runs do not share results. No new cache capacity/reservation/eviction feature. Remove quota-only bookkeeping. Report run-lifetime memory growth without a false RSS guarantee. | NOT RUN |
| C1-10 | Whole-batch validation still rejects malformed/incomplete calls, invalid arguments/schema, wrong/oversized/duplicate identities, unsupported namespaces/callers/tools, and unknown executable items before new execution. Cached calls cannot bypass authority checks. | NOT RUN |
| C1-11 | Effective-output recovery/provenance, consistency before settlement, stream correlation, incomplete/error outcomes, and exact upstream uncertainty survive removal. Keep failure/sink/drop regression assertions previously combined with limit tests. | NOT RUN |
| C1-12 | Actual loopback WS and SSE exercise the corrected controller, same-socket linkage and effective native replay. Include a trace crossing former small defaults; synthetic provider request/credential/timeouts remain unchanged. | NOT RUN |
| C1-13 | wi run --help omits all three removed flags; supplying any fails before auth/open, not silently ignored. No presets/environment/config/budget fallback. Existing auth, tool opt-in, input, model, transport, output and exit semantics remain. | NOT RUN |
| C1-14 | Outer run schema2: run_started has no policy payload, RunRequest rejects obsolete limits fields, RunOutcome contains no removed variants; nested provider schema1 remains unchanged. Old recordings are historical, not rewritten or handled by a new compatibility feature. | NOT RUN |
| C1-15 | Summary/event counters are observational, never compared to a stop quota. Checked arithmetic prevents wrapping; no integer-max sentinel. Existing payload/history/network/auth protections remain scoped and documented as Wi choices rather than unverified provider requirements. | NOT RUN |
| C1-16 | Removed-policy-only tests are deleted or replaced by absence tests; other assertions migrate intact. Fixed smoke expectations and external watchdogs do not enter generic runtime. Offline example ends at50 without RunLimits. No real auth/live commands are added to CI. | NOT RUN |
| C1-17 | Six Cargo gates, verify.py, Node self-tests, offline example, and diff checks have actual recorded results. Independent complete-diff review finds no optional-budget remnant or scope expansion. Reports cover all18 rows, changed test counts, retained constraints, and NOT RUN live status; old evidence/ledger unchanged. | NOT RUN |

C1 acceptance is OFFLINE only after all rows and independent review pass. No target test-count increase is required. Report exact changed/deleted policy tests and preserved behavioral coverage. Do not call static searches or authored tests runtime evidence.

The implementor records any additional questionable feature or resource setting in its report with path, purpose, evidence, and effect. That is not authorization to remove unrelated validation, auth, or transport behavior. No next feature milestone or live request follows automatically.
