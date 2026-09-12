# R1 acceptance matrix

Contract **r1.0**; runtime baseline `4eed18be8baaf43be886164d192021b2e2e5aa28`.
All **20 required rows, R1-00 through R1-19, are NOT RUN** in this planning PR.
Use [CONTRACT.md](CONTRACT.md) as the governing behavior; this matrix is a fixed
implementation assignment, not another planning request.

A-01..A-05 are inherited source findings, not previous passing repair tests. Row
PASS requires observed evidence through the indicated production path. Test loops
and repeated gate runs are not added together as unique coverage.

| ID | Requirement / finding | Required concrete observations | Initial status |
|---|---|---|---|
| R1-00 | Baseline and scope | Inspect actual HEAD/worktree, baseline ancestry, complete changed/untracked paths, current error consumers and gates. Record the unchanged baseline before fixing; preserve S2 and historical reports. Keep all test inputs synthetic. | NOT RUN |
| R1-01 | Multiline policy, A-01/A-02 | Golden tests retain LF/HT, spaces, Unicode and fenced code exactly; remove CR/ESC/BEL/NUL/DEL/C1 controls; CRLF becomes LF. Empty input works. Fragment-wise and whole-text filtering agree. Diagnostic filtering still removes all control scalars. | NOT RUN |
| R1-02 | Actual legacy output, A-01 | Capture the actual shared collect/write path used by generate/tool-demo for text/refusal deltas, terminal-only text, prefix suffix, and labelled fallback. Unsafe controls never pass to plain output; LF/indentation and existing labels remain. At least one behavioral regression fails on the baseline. | NOT RUN |
| R1-03 | Actual wi run output, A-02 | Exercise real render/handler with multiline final text, code blocks, provisional/refusal fragments, all existing terminal dispositions and run labels. Prove internal LF/HT survive and controls do not. Record a failing baseline formatting assertion. | NOT RUN |
| R1-04 | Presentation is not data mutation | Compare returned ModelResponse/text/native and decoded legacy/outer JSON records against original control-containing fixtures. Raw prefix comparison remains correct even where filtering changes length. Provider/tool/context/history objects remain unchanged; do not assert literal JSON escaping equals plain output. | NOT RUN |
| R1-05 | Output/cancellation compatibility | BrokenPipe/WouldBlock/other writer failures keep existing propagation and run sink categories/exit precedence. No later writes/work after a failed run sink. Legacy collector returns its existing I/O failure; no swallowing or new success. Existing controlled cancellation and finish-event tests remain passing. | NOT RUN |
| R1-06 | Initial input preflight, A-03 | Real generate handler with injected open/factory counters rejects empty, whitespace, oversized and serialization-overhead-overflow initial input before any provider/auth/open/generate call; stdout contains no response/events. Cover CLI prompt and stdin, retaining invalid UTF-8/raw stdin errors. Oversized argv data can use the in-process handler to avoid OS argument-size restrictions. | NOT RUN |
| R1-07 | Supplied follow-up preflight, A-03 | A valid first prompt plus invalid supplied follow-up yields zero open and zero generation, not one consumed first request. Test empty/whitespace/size and initial-invalid precedence. Validate the two one-item vectors separately; two individually valid inputs must not fail a new aggregate-byte rule. | NOT RUN |
| R1-08 | Options preflight, A-03 | Valid input with blank/invalid model or instructions, and oversized serialized SessionOptions, fails before open. Initial and follow-up errors precede option errors. Reuse current error variants/messages and preserve parser/runtime exit distinction. No actual auth command. | NOT RUN |
| R1-09 | Valid legacy generate compatibility | The actual injected handler sends unchanged initial/follow-up bytes, opens exactly one session, uses existing successful response checks, closes normally, and retains no-follow-up, failure and cancellation behavior. No implicit S1/S2 context preparation or change to legacy envelope schema. | NOT RUN |
| R1-10 | Accurate expiry message, A-04 | A synthetic freshness error remains AuthExpired but emits exactly the contract's owner-specific text; it distinguishes Wi from external Codex/Pi renewal and states WebSocket/new-session behavior. Demonstrate the old wording failure before its fix. No account/token/path data or new auth operation. | NOT RUN |
| R1-11 | Error consumer compatibility | GatewayError::code() is unchanged. AuthExpired remains auth_expired; ToolFailed remains gateway_error; Protocol remains protocol_error. Exercise at least one actual existing synthetic error-to-event/display path, not only a manually assembled expected JSON. Check exact-text consumers without broadening unrelated Node classifications. | NOT RUN |
| R1-12 | Created identity, A-05 | Direct decoder rejects response.created with empty required id without returning a normalized start or assigning the empty identity. Missing/null/numeric/object/array IDs retain failure. A nonempty opaque ID remains unchanged. Record the baseline accepting case. | NOT RUN |
| R1-13 | Terminal identity, A-05 | Direct parse_response and terminal-only apply reject empty required IDs for completed/done/incomplete/failed/cancelled with otherwise valid fixtures. No synthesized start/finish or terminal_received from the rejected terminal. Include a valid earlier start followed by an empty terminal and missing/non-string controls. | NOT RUN |
| R1-14 | Real adapter sessions, A-05 | Actual synthetic WS and labelled SSE sessions reject empty-created and empty-terminal-only cases: no successful response_finished, RequestFailed protocol_error/unknown after send, closed session, no second submission/settlement. Missing-MIME prolog preserves unexpected_content_type/unknown. Earlier valid starts need not be erased. | NOT RUN |
| R1-15 | Public run consumer, A-05 | At least one actual loopback adapter through wi::run::run fails with current provider_request_failed outcome and nested protocol_error/unknown; no tool dispatch or continuation. A fake provider bypassing the adapter still exercises the existing provider_correlation defense. Do not change the collector to hide lower-layer defects. | NOT RUN |
| R1-16 | Identity positive controls | Valid terminal-only IDs, created/terminal matching, empty text/refusal/delta fields, omitted compatible function status, valid tool continuations and finalized-item recovery remain valid. Valid terminal followed by later consistency/recovery failure retains terminal_received as before. Unknown native extensions are not newly rejected. No new ID trim/regex/length rule. | NOT RUN |
| R1-17 | Non-regression and diff boundary | S1/S2 catalog/pairing/loader, registry preflight/cache/event order, run ownership/counters/cancellation, auth/transport implementations, event schemas, no-RunLimits behavior and fixed smoke acceptance remain unchanged. Both WS/SSE S2 regressions and the three offline examples pass. No dependency, lock, CI weakening, budget, or new feature. | NOT RUN |
| R1-18 | Evidence and current docs | Both R1 reports identify every row/finding, actual tested revision plus worktree, first failure and final success, commands/counts, reviewers, platform limitations and unchanged ledger. Update active instructions/docs only to observed repaired behavior; preserve historical S2 findings and reports with links to later closure. No report template is labelled execution. | NOT RUN |
| R1-19 | Final gates and independent review | All local commands below pass on the accumulated implementation. Independent complete-diff review closes confirmed in-scope issues. Leave source uncommitted until separately authorized. Exact-head cross-platform CI is a subsequent merge gate, not falsely reported as part of the local run. | NOT RUN |

## Required local commands

Inspect commands and source first; use temporary synthetic HOME/XDG_CONFIG_HOME/
CODEX_HOME and workspace/skill roots. Preserve trusted installed toolchain/cache
locations explicitly; do not dump environment variables or inherit provider API
keys into tests. Existing tests requiring synthetic auth still run; they are not
real login/profile operations. Normal dependency-cache access is development work,
not a model request. No package upgrade or new dependency is needed for R1.

```bash
cargo fmt --all -- --check
cargo check --all-targets
cargo test --all-targets
cargo clippy --all-targets -- -D warnings
cargo build --all-targets
cargo test --doc
uv run scripts/verify.py
node scripts/cli_retest.mjs --self-test
cargo run --example run_offline
cargo run --example skills_offline
cargo run --example skill_loading_offline
git diff --check
```

Do not execute the two_turns example main, smoke commands, cli_retest --run-live,
capability probes requiring credentials, or any auth command. All malformed-ID
traffic uses loopbacks with synthetic credentials. Test watchdogs and barriers
must not become product deadlines. Use the existing per-request guards unchanged.

The baseline report records 374 Rust tests, 152 Node self-tests, inventory 123/361/25
and example answers 50, 42 and Reviewed offline. These are attributed prior counts,
not targets to fake or a requirement that every platform execute the same number.
Record actual passed/failed/ignored/filtered and compile-time exclusions separately.
The Python gate repeats six Cargo commands; do not count repetitions as new tests.
The doctest command may execute zero tests; record that honestly.

After owner-authorized push, fetch CI for the EXACT submitted head. Both configured
push/PR workflows and Ubuntu/macOS/Windows jobs must finish successfully for merge
readiness. Inspect downstream skipped steps if a job fails. Do not suppress lints,
disable an OS job, or catch a failed fixture and report PASS. Keep Linux-only
fixtures Linux-only; exercise portable assertions on their applicable platforms.
Node self-tests and examples are local gates, not automatically part of Cargo CI.

## Verification reports to create during implementation

Create `docs/slices/r1/VERIFICATION.md` and `docs/slices/r1/verification.json`.
They do not exist as completed evidence in this plan. The human report contains:

- Scope, r1.0, baseline, exact tested HEAD and uncommitted-diff status; OS/toolchain.
- A-01..A-05 disposition, real failing-before assertion, focused fix and passing-after
  regression; no claim of closure from source inspection alone.
- R1-00..R1-19, all unique, each linked to actual test names and observed results.
- Exact commands, outcomes/counts and any initial failures; separate repeated runs.
- Complete-diff independent review findings, actions and rerun evidence.
- Current docs/source changes, intentionally changed compatibility, limitations,
  platform/CI status and remaining unrelated findings.
- Credential/auth/provider traffic zero; ledger unchanged; no Git-write authorization
  implied by acceptance. Explain the review stage if the work remains uncommitted.

Machine report requirements (ordinary JSON, not a new runtime schema):

```json
{
  "schema_version": 1,
  "contract": "r1.0",
  "baseline": "4eed18be8baaf43be886164d192021b2e2e5aa28",
  "tested_revision": null,
  "tested_worktree_description": "fill with actual checked state",
  "status": "NOT_RUN",
  "accepted": false,
  "findings": [],
  "matrix": [],
  "commands": [],
  "independent_reviews": [],
  "submitted_ci": {"status": "NOT_RUN", "head": null, "runs": []},
  "live_started": false,
  "real_credential_reads": 0,
  "provider_generations": 0,
  "ledger": {"used": 31, "cap": 50, "remaining": 19, "changed": false}
}
```

Populate findings with exactly A-01..A-05 and matrix with exactly R1-00..R1-19. Each
entry has a status and evidence references. Additional fields for actual counters,
observations and limitations are allowed; new architecture is not. `accepted:true`
means offline repair acceptance, not live/merge/release approval. Keep original
S2 JSON/Markdown evidence untouched; later CI/commit facts get dated follow-ups,
not retroactive edits to what was known at an earlier stage.
