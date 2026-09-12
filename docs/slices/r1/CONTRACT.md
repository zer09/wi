# R1: inherited consistency repairs

Contract: **r1.0**. Prepared: **2026-09-12**.
Status: **PLAN ONLY; repairs and acceptance NOT RUN**.
Runtime baseline: `4eed18be8baaf43be886164d192021b2e2e5aa28` (S2 merged in PR #3).

## 1. Purpose, authority, and scope

Repair the five corroborated inherited findings A-01 through A-05. This is not
another feature milestone or a redesign of S2. The owner requested the next
repair work and a fixed implementor handoff. The designer supplies this contract;
the local implementor executes it and the [matrix](MATRIX.md), rather than
commissioning another architecture plan.

The scope is precisely: plain CLI presentation, legacy generate preflight order,
one authentication-expiry message, and rejection of empty response identities at
the OpenAI decoder boundary. Initial source evidence and producer/consumer mapping
are in [VALIDATION.md](VALIDATION.md). New required behavior is identified below;
it is not described as already implemented.

Authorized local execution is source/tests/current-document repair and OFFLINE
verification. Implementation commits, pushes, merging, release/deployment, and
live tests require separate owner authorization. No real credentials, auth/profile/
login/refresh commands, private skill/project test inputs, provider generations,
or hosted probes. Ledger stays **31/50 used, 19 remaining**; balance is not permission.

S2 s2.1 remains accepted. Do not change its catalog, frontmatter, body loading,
registry pairing, result serialization, cancellation, or continuation contract.
No RunLimits, execution quotas, task deadlines, resource-budget framework,
permissions system, generic file/shell tools, progress API, P1 storage, V1 service,
provider reorganization, fallback/retry, or new dependencies are authorized.

## 2. Inherited findings and intended correction

| Finding | Observed baseline | Required correction |
|---|---|---|
| A-01 | Legacy generate/tool-demo write model text bytes directly to a terminal. | Filter unsafe controls at the plain presentation boundary, including every legacy output branch. |
| A-02 | wi run uses a single-line filter on answer text, deleting LF and HT. | Use multiline-safe presentation for answers while retaining the one-line diagnostic filter. |
| A-03 | Legacy generate opens auth/provider/session before validating initial input. | Validate the initial input, supplied follow-up, and session options before provider/auth construction. |
| A-04 | AuthExpired says the gateway never rotates refresh tokens. | Replace that message with accurate owner-specific renewal guidance; keep all codes and auth behavior. |
| A-05 | Decoder accepts an empty response ID; run collector rejects it. | Reject the empty established/terminal response identity in the shared decoder, before successful publication or settlement. |

These were source findings corroborated by the S2 implementor, not already executed
R1 counterexample tests. Every finding needs a focused failing-before/passing-after
regression. Existing broad suite passes are not evidence that a new assertion was
previously covered.

## 3. A-01 and A-02: plain text presentation

### 3.1 Exact response-text policy

Define one small, pure, private CLI helper for multiline response presentation.
For each Unicode scalar, retain it when it is not `char::is_control()`, OR when
it is exactly LF (`\n`, U+000A) or HT (`\t`, U+0009). Drop other control scalars.

Consequences are deliberate and testable:

- Preserve internal LF, HT, ordinary spaces, indentation, Markdown fences, and
  all non-control Unicode scalars without trimming or normalization.
- Remove ESC, BEL, NUL, DEL, CR, and other C0/C1 controls.
- CRLF becomes LF; an isolated CR is removed, not interpreted as cursor movement.
- Escape-sequence payload characters may remain visible as ordinary text after
  their control introducers/terminators are removed. Do not build an ANSI parser,
  styled renderer, terminal capability probe, or buffering state machine.
- Filtering is stateless and independent of delta boundaries. No incomplete
  escape-sequence buffer or dynamic size policy is needed.

This is a defined control-character presentation policy, not a general Unicode
spoofing, bidi, prompt-injection, or terminal-emulator security guarantee.

Retain the existing `context_cli::filtered` behavior for single-line diagnostics,
source labels, and catalog descriptions. Do not change that helper globally to
preserve LF/HT: those consumers must remain one-line. A focused private helper in
context_cli or a private CLI presentation module is sufficient; no public library
API or new crate is needed.

### 3.2 Exact consumers

The multiline helper must be used for:

1. Legacy `collect` text AND refusal deltas used by generate and tool-demo.
2. Its terminal-only output and final-text suffix path.
3. Its labelled authoritative-final fallback path.
4. `run_cli::render` provisional text/refusal bodies and authoritative response
   bodies, preserving existing labels and outcome selection.

Retain raw model text for collector prefix comparison and return values. In
particular, do not compare a filtered provisional prefix against raw final text.
Filtering only occurs when presenting a body to plain stdout. Preserve existing
wrappers and per-delta labels; recreating a TUI stream renderer is outside scope.

JSON/NDJSON still serializes the original event/response data. After parsing a
JSON record, the stored text must equal the original fixture, including controls.
Do not sanitize ModelResponse.text, native objects, tool input/results, provider
history, skill bodies, caches, event objects, or context preparation.

All actual rendering paths must be tested with captured writers. Introduce only
a minimal private writer seam so production collect/write_text and tests call
the same implementation; a disconnected helper-only test is insufficient. Do not
redirect process-global stdout in parallel tests. Preserve I/O error propagation,
flush behavior, labels, correlation, and current exit codes. A sink failure must
not be swallowed to make presentation pass.

Golden fixtures include `first\n\tsecond`, CRLF, a multiline fenced code block,
non-ASCII ordinary text, empty text, and synthetic ESC/BEL/CR/DEL/C1 sequences.
Test deltas that split sequence-shaped text as well as whole terminal messages.
No real terminal control sequence needs to be printed to the review conversation.

## 4. A-03: fail-fast legacy generate

This repair concerns the legacy `generate` command, not the already-correct S2
`wi run` preparation path. Preserve the current command names, flags, defaults,
read-only/external versus managed selection, output formats, and valid flow.

After Clap parsing, the production generate handler must perform this order:

1. Read the initial prompt from its chosen source, keeping existing stdin byte
   and UTF-8 checks. Preserve task bytes; do not trim accepted content.
2. Call existing `validate_input` on the exact one-item initial vector that will
   be sent (`InputItem::user`). This counts serialization/escaping overhead.
3. If `--follow-up` is supplied, call the same validator on its own one-item
   vector. Do NOT combine the two into one request or invent a combined quota.
4. Build and validate the actual SessionOptions, including supplied instructions.
5. Only then invoke the existing provider factory/open path.
6. Send the validated original input. Send the validated follow-up only after
   the existing first-response checks allow it. Keep one session and normal close.

Input-source errors precede input validation; initial validation precedes
follow-up validation; both precede option validation and auth/provider work.
Clap parsing still precedes the handler. This is an intentional error-precedence
correction: an invalid supplied follow-up must prevent even the first generation,
not consume it and then fail. There is no new input policy; reuse existing errors
and validators. SessionControl retains its own validation for non-CLI callers.

Keep stdin raw-size and UTF-8 error messages unchanged. For validation failures,
use the existing InvalidRequest messages/code, not a new CLI error category.
Legacy malformed CLI syntax still uses its current Clap exit behavior; a validly
parsed but invalid prompt/options operation exits 1 with no success output.

Introduce a minimal private dependency-injection seam for the real handler's
input/session-open path, not an alternate test algorithm. Invalid prompt, invalid
follow-up, or invalid options must leave injected factory, credential, session-open,
and generation counters zero. No stdout response/JSON events may be emitted.
Use fake callbacks/counters and synthetic filesystem roots, never an actual auth
command to establish absence of credential access. Keep valid no-follow-up and
valid two-request controls with exactly one session and unchanged inputs.

The helper may remain in cli/mod.rs or move the directly affected private function
to one small CLI module. Do not reorganize the rest of the binary or replace this
legacy flow with wi run: that would change event/output semantics beyond the fix.

## 5. A-04: expiry message only

Change ONLY the human-readable AuthExpired message, plus targeted tests/docs.
Required message text:

```text
login expired or expires within 30 seconds; renew Wi-managed credentials through Wi, or external credentials through Codex/Pi; then open a new provider session; established WebSockets cannot renew in place
```

This distinguishes credential ownership without embedding an account, path, token,
auth URL, or suggested automatic operation. The message does not perform refresh.

Keep `GatewayError::AuthExpired`, its exported code `auth_expired`, the freshness
margin, and every current renewal/selection/persistence/transport rule unchanged.
`GatewayError::code()` must remain byte-for-byte unchanged by R1; in particular
ToolFailed remains `gateway_error`. The S2 prohibition against changing mappings
still applies. R1 narrowly authorizes editing the AuthExpired display attribute
in src/error.rs, which was outside S2's edit scope.

Trace this message through actual synthetic freshness errors, normal error display,
and any relevant admitted RequestFailed path available in the existing fixtures.
Test the code independently from text. Review exact-message consumers before
editing, and adjust only an assertion that truly consumes the changed message.
Do not broaden a stale Node lifecycle-guard classification while repairing an auth
sentence. Real renewal and login are neither necessary nor authorized.

## 6. A-05: nonempty response identity at the decoder boundary

Use a focused private required-response-ID helper (or equivalent) that keeps the
existing required-string behavior and rejects the EMPTY string. Apply it to the
response identity established by `response.created` and to `parse_response`'s
required terminal `id`; the latter also covers all existing terminal aliases and
recovered effective response parsing.

Use the existing Protocol variant and code `protocol_error`. For the newly rejected
empty string, use static message `empty response identity`. Missing, null, and
non-string REQUIRED IDs keep the existing required-string failure behavior.
Do not include the supplied ID or native object in an error.

Do not change the generic required_str helper for every field. Empty output text,
refusal text, initial arguments and streamed delta fragments have other semantics.
Do not trim/normalize IDs or add length/character-format restrictions in this
repair. A nonempty ID remains opaque. Keep existing reported-ID correlation,
unknown extension preservation, allowed terminal aliases/outcomes, and all native
recovery/consistency rules unchanged.

### 6.1 State and delivery requirements

- Reject before assigning an empty normalized response identity or publishing a
  start/finish event for that empty identity.
- In terminal-only cases, validate identity before the synthesized normalized start,
  terminal_received flag, effective-output recovery, or conversation settlement.
- If a valid native start was already emitted, it need not be retracted; a later
  invalid terminal must still produce no successful response_finished.
- For a fault reached AFTER send through WebSocket or normally labelled SSE, the
  existing actor must terminate with RequestFailed(code=protocol_error,
  upstream_outcome=unknown), close the session, and admit no continuation. A terminal
  type string alone does not establish TerminalReceived.
- Missing-Content-Type SSE uses a separate earlier prolog validator. Preserve its
  existing rejection category `unexpected_content_type` and unknown outcome for
  an invalid first-frame identity. Do not force every layer to use protocol_error.
- Preserve cases where a valid parsed/correlated terminal is received but recovery,
  consistency, settlement or delivery fails: those can retain terminal_received.
  No code in the actor/state machine needs to be weakened to make the new tests pass.

The controller's existing defensive nonempty-ID check remains. A real adapter
failure entering the controller is reported by its current `provider_request_failed`
run category with the nested provider error/outcome, not by inventing a new public
run outcome. A fake provider bypassing the adapter still exercises the current
`provider_correlation` guard. Test these as separate boundaries.

### 6.2 Required malformed and valid controls

Use decoder tests for an empty created ID and empty terminal IDs in completed,
done, incomplete, failed and cancelled cases, with the appropriate otherwise-valid
status/output for each. Include missing/null/non-string required-ID negative
controls. Assert no successful returned events for the rejected invocation and
no terminal_received flag from its invalid terminal.

Then use ACTUAL local provider sessions on loopback WS and labelled SSE to prove
no invalid terminal publication/continuation. Cover both an empty created ID and
a terminal-only empty ID. Include the existing missing-MIME path without relaxing
its category. One representative run-controller integration must demonstrate no
tool dispatch or follow-up from the rejected response.

Positive controls must retain nonempty terminal-only IDs, valid created/terminal
matching, empty text/delta fields, nonempty IDs without trimming, normal tool
continuation, valid finalized-item recovery, and valid terminal failures. Do not
execute malformed function fragments merely to test empty text compatibility.

## 7. Allowed implementation footprint

- `src/cli/mod.rs`: affected presentation and generate ordering; minimal private
  writer/factory seams; corresponding existing/new private CLI tests.
- `src/cli/context_cli.rs` and `src/cli/run_cli.rs`: separate answer filtering from
  one-line diagnostics; preserve the S2 handler except necessary imports/test seams.
  One small private presentation or generate module is allowed if it reduces
  duplication; no public renderer/handler framework.
- `src/error.rs`: ONLY AuthExpired display wording and focused test coverage.
- `src/providers/openai_codex/codec.rs`: response-ID helper/use and focused tests.
- Relevant CLI/codec/run/loopback/auth test files, synthetic fixtures, and test-only
  module wiring under the existing organization.
- Current README, ARCHITECTURE, EVENTS, WI_AUTH, AGENTS and docs index: concise
  accurate descriptions of the repaired behavior and links to R1 evidence.
- New R1 verification reports as specified by MATRIX.md.

Keep src/provider.rs, public run interfaces/events, tool registry, context/skill
implementation, gateway, auth implementations, transport/state/consistency/recovery
implementations, manifests, lockfile, CI and scripts behavior unchanged. Read them
and extend existing tests where needed; test-only module wiring is allowed.
Do not change production endpoints or add a non-test override for a fixture.

If the named repair cannot be implemented within these boundaries, report the
specific source contradiction for an amendment. Do not add speculative features
or mark a failing required assertion inapplicable to bypass it. Other findings
remain recorded for separate work; they are not an invitation to sweep-refactor.

## 8. Execution order and evidence

1. Inspect current HEAD, ancestry and complete worktree. The planning commit is
   expected after the runtime baseline. Preserve user work; no reset/clean/stash,
   auto-commit, push or merge. Read this contract, matrix, validation and prompt.
2. Review affected source and exact error/event consumers. Run the unchanged
   offline baseline gates in synthetic roots. The prior 374/152 results are
   attributed baseline evidence, not a guaranteed count or a new R1 run.
3. Add narrow regressions and record each finding's failing assertion before its
   semantic fix. Private testability refactoring may precede the red run if it
   preserves baseline behavior; show that separately. Compile failures do not
   substitute for a demonstrated behavior failure.
4. Repair A-01/A-02 together using the small shared policy. Repair A-03, A-04 and
   A-05 in focused increments. Rerun relevant tests after each increment.
5. Execute all MATRIX.md gates against the accumulated diff. Use safe loopbacks
   and deterministic synchronization, not real credentials or a live model.
6. Obtain an independent full-diff review of fixes, tests, current docs and report
   drafts. Close confirmed in-scope findings and rerun affected gates. Preserve
   existing platform guards and strict lint rules; a Linux pass is not macOS CI.
7. Create the new verification reports, identify actual checked paths/revisions,
   and leave implementation uncommitted pending the owner's Git-write decision.

The local evidence threshold is all R1 rows PASS with actual regressions and
review closure. After separately authorized commit/push, merge readiness also
requires all configured OS CI jobs on the exact submitted head. The implementor
must not create a verification loop by rewriting historical results at every
commit; dated GitHub follow-up evidence can close the pre-push report.

Success means the five scoped findings have fixes and observed regressions. It is
not a blanket security certification, live verification, new feature acceptance,
or permission to start the next milestone.
