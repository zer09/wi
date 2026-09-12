# R1 source-to-contract validation

Date: **2026-09-12**. Contract **r1.0**.
Compared runtime: `4eed18be8baaf43be886164d192021b2e2e5aa28`.
Review type: connector-backed source and current-contract inspection, NOT executed
Rust regressions, live evidence, independent review, or whole-repository certification.
Rust/Cargo are not available in the planner environment. All repair rows are NOT RUN.

## Provenance and fixed boundaries

The original audit is PR #3 comment 5640780593. The S2 implementation corroborated
A-01..A-05 in `docs/slices/s2/VERIFICATION.md` and deliberately left them unfixed.
The owner authorized the next focused repair handoff after S2 merged. R1 does not
reopen S2 or invent an unexplained new limit/feature.

All sources below were read at the baseline, not inferred from old source paths.
The repository tree confirms current organized tests and the named files. Small
writer/open seams are explicitly NEW private implementation needs; they are not
symbols claimed to exist already.

| Finding / boundary | Actual source trace | Contract disposition |
|---|---|---|
| A-01 | `src/cli/mod.rs::collect` calls write_text for deltas, terminal suffix and fallback; write_text writes raw bytes. | New plain-output correction only; raw response and prefix state remain unchanged. Capture the real path, not a parallel sanitizer demo. |
| A-02 | `src/cli/run_cli.rs::render` applies context_cli::filtered; that helper removes all Unicode controls, including LF/HT. | New multiline helper preserves LF/HT. Existing single-line diagnostics/listing stay on the original helper. |
| Collector tests | `src/cli/collect_tests.rs` checks returned terminal text/correlation while the function owns stdout. | Minimal private captured-writer seam is needed for direct output evidence. Do not treat returned-text equality as proof of rendered safety. |
| A-03 | Legacy generate resolves input then calls open; SessionControl later validates input. `provider()` may locate managed/external auth before that validation. | Preflight initial vector, supplied follow-up separately, and actual options before open. Known invalid follow-up deliberately prevents first work. |
| Input policy | `src/provider.rs::validate_input` rejects empty text and >1 MiB serialized input; SessionOptions::validate checks model/instructions and serialized configuration. | Reuse exact validation; no invented trimming, aggregate two-message request, quota, or new error code. |
| A-04 | `src/error.rs::AuthExpired` says gateway never rotates; ManagedCredentials::prepare performs Wi-owned refresh when needed. | Display string only. Keep freshness behavior, session identity, rotation/store code and code mapping unchanged. |
| S2 code mapping | error.rs code() maps ToolFailed through `_ => gateway_error`; tools.rs serializes code() and caches before finish. | R1 leaves code() and tools untouched. The S2 mismatch cannot recur by assigning an enum-variant spelling to exported JSON. |
| A-05 | codec.rs required_str permits empty strings; response.created and parse_response use it for IDs. | Add a response-ID-specific nonempty check; do not tighten every string field or impose a new ID syntax/length rule. |
| Terminal uncertainty | decoder.terminal_received is set only after parse/correlation; session::drive copies it before handling decoded errors. | Reject ID before that flag. A post-send invalid identity is unknown, not terminal_received. Later recovery failure after valid identity remains distinct. |
| Run consumer | run::collect::Collector already rejects empty ID; run::collect_response maps RequestFailed to provider_request_failed and preserves upstream outcome. | Keep defense. Test adapter error and synthetic bypass separately; do not incorrectly require identical outer/nested failure codes. |
| Missing MIME | Strict prolog already checks initial response identity and uses unexpected_content_type on failed admission. | Preserve that existing category. Labelled SSE and WS fail in the normal decoder with protocol_error. |
| Historical gate semantics | scripts/verify.py checks inventory then runs six Cargo gates; its regex does not count all parameterized test attributes. | Inventory is not executed coverage. CI/local Node/examples remain separate evidence categories. |

## Exact observations and deliberate changes

The intended AuthExpired message change is explicit in CONTRACT section 5. Its
public static code stays `auth_expired`. Only that human message and the specified
plain rendering/fail-fast/invalid-ID acceptance behavior change; provider schema 1,
run schema 2, public RunRequest and callable tool schema remain unchanged.

The previous source audit's stale Node lifecycle-guard literal is not one of the
five R1 repairs. The examined script has its own conservative stderr inference and
fixed-model live entry points. R1 must inspect consumers of any message it changes,
but must not broaden that script's unrelated classification or usage accounting.
No live runner invocation is necessary.

Opaque response IDs are checked for emptiness only in this repair. The contract
intentionally does not borrow the strict prolog's 512-byte admission bound for all
native IDs, nor rewrite nonempty whitespace or other character forms. That avoids
an unrelated compatibility policy change. Empty required strings for deltas/text
remain governed by their original fields, not by an overbroad helper edit.

## Matrix coverage map (reviewed requirements, not PASS)

| Rows | Source anchor / newly required evidence |
|---|---|
| R1-00 | merged HEAD/ref, current source, gate definitions and protected diff inventory |
| R1-01..R1-04 | existing one-line filter, both actual renderer paths, collect prefix logic and JSON serialization; new captured-output regressions |
| R1-05 | legacy I/O propagation and run renderer sink_error/exit_code; retained cancellation/sink regressions |
| R1-06..R1-09 | real legacy generate/open and provider.rs validators; new private injected-open regression seam |
| R1-10..R1-11 | exact AuthExpired display attribute, freshness paths, GatewayError::code and real error consumers |
| R1-12..R1-13 | response.created, parse_response, terminal-only synthesis and flags in codec.rs |
| R1-14..R1-16 | existing loopback harnesses, actor drive/settlement, strict MIME admission, public run collection, positive recovery cases |
| R1-17 | S1/S2 regressions, public APIs, scopes, transports, auth and C1 deletion |
| R1-18..R1-19 | new report requirements, current docs, offline gate commands and separate future CI/review evidence |

## Immutable source identities inspected

| Path | Blob SHA |
|---|---|
| src/cli/mod.rs | 19e95e7f006b873928e44c79a1ca5d0815dc5b97 |
| src/cli/collect_tests.rs | 9eb7bbde9ea822183e16758228528cb6f8fb5091 |
| src/cli/run_cli.rs | 325a57ea885839a3ade0a4190b0c2d30bd69785e |
| src/cli/context_cli.rs | 09bd1f409b940d1903b98bcdc44656ed00999d5f |
| src/provider.rs | 886601a369cde8869dd239e6786e8a27de7797a9 |
| src/error.rs | fdddf4f997af400792def9deffae32aa9509960d |
| src/providers/openai_codex/codec.rs | de89df0189edf945292553f8c5b9480e016c6312 |
| src/providers/openai_codex/session.rs | ee6c2b175bb5ddd35666545273bbf1bf97fcde17 |
| src/providers/openai_codex/managed_auth.rs | ab123bc81fce21be507935f28c24f39571a2d4d4 |
| src/run/mod.rs | ea167d12cfc13da73b27c34cc64dfc08500cac6f |
| scripts/verify.py | 936a076a8f504e9b2bb914c3bee15d7f49bb6920 |

Hashes establish which file was inspected, not that its behavior was executed.
The earlier supplied Codex/Pi reports remain reference material for overall harness
direction. R1 is based on Wi's concrete five findings; it does not import retry,
timeout, storage, tool or event policies from those reports.

The plan was checked for field/variant names, error-code ownership, ordering,
platform applicability and edit-scope compatibility. This does not prove the future
implementation compiles or eliminates every defect. An actual conflict must be
reported with its producer/consumer source chain, not silently resolved by changing
an unrelated API. No pre-existing or proposed test is represented as newly run.
