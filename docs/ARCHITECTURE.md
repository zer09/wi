# Wi architecture and ownership

R1 repairs are locally implemented and offline accepted in the uncommitted
worktree. The [R1 evidence](slices/r1/VERIFICATION.md) records passing local gates
and repeated complete-diff review; `accepted=true`. Exact-head cross-platform CI
is NOT RUN. S1/S2 ownership and public schemas remain unchanged.

## One crate, explicit module boundaries

| Module | Responsibility |
|---|---|
| `provider.rs` | Traits, session options, normalized items/events, capabilities |
| `gateway.rs` | Provider registration and selection; no OpenAI protocol/auth logic |
| `context.rs`, `context/*` | Explicit-root discovery, shared main-file loader, catalog-bound `load_skill` tool and validated preparation |
| `providers/openai_codex/auth.rs` | Read-only snapshots and explicit external files; separate preparation hook |
| `providers/openai_codex/managed_auth.rs` | Selected profile binding and cancellation-independent renewal ownership |
| `providers/openai_codex/browser_login.rs` | Experimental browser login and strict TLS token-response parsing |
| `providers/openai_codex/refresh.rs` | Private fixed-endpoint Pi-compatible refresh exchange |
| `providers/openai_codex/managed_store.rs` | Protected Linux JSON store, locking and atomic updates |
| `providers/openai_codex/profile_selection.rs` | Metadata-only exact or uniform random session selection |
| `providers/openai_codex/wire.rs` | WebSocket/HTTP transport, fixed destinations, TLS and bounds |
| `providers/openai_codex/codec.rs` | Native event decoding and typed item classification |
| `providers/openai_codex/state.rs` | In-memory transcript, parent response, pending result identities |
| `providers/openai_codex/session.rs` | Task lifetime, admission, independent control/output paths |
| `providers/openai_codex/consistency.rs` | Bounded provisional/effective-output validation before settlement and terminal publication |
| `tools.rs` | Shared two-phase registry, fresh result scopes and deterministic addition executor |
| `run/mod.rs` | Provider-neutral run controller and cooperative cancellation ownership |
| `run/events.rs` | Outer run lifecycle and provider/tool wrappers, fallible observer contract |
| `run/collect.rs` | Generic receipt/envelope correlation and one-response collection |
| `main.rs` | Program entry point and Tokio runtime startup |
| `cli/mod.rs` | Private CLI arguments, shared helpers, routing, legacy text/NDJSON, generate and fixed tool-demo callers |
| `cli/auth_cli.rs` | Authentication command dispatch; provider retains credential and file ownership |
| `cli/run_cli.rs` | Run validation, shared preparation, rendering and cancellation adapter |
| `cli/context_cli.rs` | CLI cwd/environment root resolution and safe context diagnostics |
| `cli/skills_cli.rs` | Metadata-only catalog listing; no provider/auth or execution path |
| `cli/demo.rs` | Pure acceptance checks for the fixed 17+25 CLI case |
| `cli/smoke.rs` | Explicit synthetic live cases and sanitized acceptance summary |
| `cli/*_tests.rs` and inline CLI tests | Private binary-only CLI unit tests |
| `tests/cli/*` | Process-level CLI integration tests, included by top-level Cargo test entry modules |
| `providers/openai_codex/observation.rs` | Opt-in transport evidence; no generic event-contract change |

`Provider` is a Rust trait implemented by a compiled-in plugin. It is not a
shared-library ABI or runtime code loader. Adding a provider does not require
implementing OpenAI credentials or modifying the gateway. The external
`tests/provider_contract.rs` implements a provider without OpenAI imports.

## Workspace context and skill loading (S1 + S2)

`context::discover(ContextRoots)`, `load_skill(&catalog, &id)`,
`prepare_run(request, &catalog, selected, &tools)` and
`prepare_run_with_skill_loading(request, Arc<SkillCatalog>, selected, &tools)`
are synchronous library boundaries. They use explicit host-selected roots or the
catalog captured from those roots, not cwd, HOME or auth-manager configuration. The
CLI resolves cwd once and resolves a relative workspace against that snapshot.
Its global root is absolute nonempty XDG_CONFIG_HOME plus `wi/skills`, or absolute
nonempty HOME plus `.config/wi/skills` when XDG is unset/empty. Relative XDG and
missing/invalid fallback HOME fail explicitly. Resolution creates no directories.

Discovery always includes global frontmatter and adds workspace `.agents/skills`
when present. Both scopes remain identifiable by `global:<name>` and
`project:<name>`. Equal names across scopes coexist; within-scope duplicates fail.
The catalog sorts by scope then name. Discovery stops at each `SKILL.md` package
boundary and parses frontmatter only, not resources, root instructions or bodies.
Parsing stops at the closing delimiter; buffered I/O can read ahead into a body.
`yaml-rust2` 0.12.0 supplies the event parser with default features disabled.
Wi rejects tags, aliases/anchors, merge keys and multiple YAML documents, and
retains validated JSON-compatible metadata. Unsupported behavioral fields produce
diagnostics but grant no tools or permissions. Malformed files are excluded with
diagnostics; unreadable traversal directories fail rather than hide a partial catalog.

Preparation reads only root `AGENTS.md` and explicitly selected catalog bodies.
Both preparation paths use the shared `load_skill` operation for explicit bodies.
It revalidates selected metadata against discovery and reports `context_changed`
for a mismatch. All selected identities are checked before instruction/body I/O.
Preparation produces an owned `PreparedRun` plus `ContextManifest`. The manifest
records initial available IDs, explicitly included active IDs and project source;
it does not track later loads or delivery. Selection order is preserved with
first-position deduplication. All frontmatter enters prepared
context even without activation. No unselected bodies or resolved host paths
enter the request. Caller instructions remain an unchanged prefix followed by
fixed framing. Project and skill text is JSON-escaped user context, not system
instructions or executable configuration. Deterministic payload keys are `task`,
`project_instructions`, `available_skills`, and `active_skills`. No-context runs
retain the original prompt and instructions exactly.

`prepare_run_with_skill_loading` pairs preparation with a fresh registry bound to
the caller's same `Arc<SkillCatalog>`. A nonempty catalog installs one ordinary
strict `load_skill` definition and actionable loading instructions automatically.
A name collision fails as `ContextErrorKind::InvalidRequest` before body I/O;
existing tools are never replaced. Empty catalogs add neither definition nor
loader framing. Direct `prepare_run` retains its no-loader semantics, even if a
caller supplies an unrelated tool with that name.

Normal `wi run` uses the paired helper without an enable flag or `--tool load_skill`.
`--use-skill` still supplies explicit initial bodies. The model may load another
advertised entry, load an already supplied one, or finish without a load. There is
no separate classifier, forced load, skill-specific controller branch or second
model loop. The prepared request and returned registry enter `wi::run::run`.
The helper preserves the supplied template's cache; the controller uses another
fresh result scope. The returned registry is not the run's post-execution cache.

Existing input and tools-inclusive options validation applies to the final
rendered request. `PreparedRun` returns empty `options.tools` for the controller;
the actual registry remains authoritative. The CLI runs discovery and preparation
in one `spawn_blocking` task before provider/auth construction and prints sanitized
relative-label diagnostics on stderr, including when preparation later fails.
`skills list` calls discovery only. Its JSON output deliberately exposes metadata,
never bodies or private source handles.
Content-bearing library Debug implementations redact metadata and prepared input.

Selected roots may canonicalize through links. Descendant links are not followed;
a linked root `AGENTS.md` fails preparation. Final opens use Unix no-follow and
nonblocking flags or Windows reparse-point checks. Other platforms have pre/post
checks only. Ancestor replacement races and hardlinks remain trust limitations;
this is an owner-controlled filesystem boundary, not a hostile-filesystem sandbox.
JSON escaping protects payload structure, not against model prompt injection.

The private catalog-bound tool owns no activation state or body cache. Pure
`validate` checks exactly one string `id`, qualified syntax and catalog membership
without opening a file. Invalid arguments reject full-batch preflight before any
new execution. `execute` defensively validates again, then calls the shared loader
through Tokio's blocking-work facility. It reads only the recorded main `SKILL.md`,
never a model-supplied path, supporting resource or script. Success returns exactly
`id`, `frontmatter` and the unchanged Markdown `body` as ordinary JSON tool data.
Loading instructions does not execute their workflow or grant permissions.

The catalog is the immutable metadata/source-selection snapshot for the run.
Each new execution reopens the main file and revalidates its frontmatter. Body-only
edits before that read are allowed; changed metadata fails. Added files require
fresh discovery. Owned results remain unchanged after edits/deletion. A distinct
call ID performs a new load; identical call-ID/argument reuse returns the existing
per-run cached result, including errors, without reading again. Conflicts retain
registry rejection. No environment change or skill text redirects the catalog.

Known-entry read, metadata, body and blocking-worker failures map to `ToolFailed`.
The existing registry serializes `{"error":{"code":"gateway_error"}}` and emits
`ToolExecutionFinished` with `is_error=true`; no flag is added to the result JSON.
This executed error can enter the next ordinary request. It differs from invalid
arguments rejected before execution. A whole file above 1 MiB fails loading first
(`InputTooLarge`, then `ToolFailed`/`gateway_error`). A loaded value whose serialized
JSON exceeds 64 KiB instead becomes `tool_output_limit` with `is_error=true`.
Exactly 64 KiB is allowed; metadata/escaping count and no success is truncated.
Existing combined next-input validation still applies. These guards do not add
paging, run quotas, deadlines or a resource-budget framework.

Cancellation can drop the awaiting tool future without forcibly stopping its
blocking read. That worker cannot publish results/events, change the catalog/cache
or submit continuation. A completed serialized result is cached before the finish
observer runs; failure of that observer stops later work but does not undo the cache.

The ordinary next model request consumes the skill result on the same session,
using the [existing continuation strategies](#continuation-strategies). Session
instructions stay fixed; native recovery and consistency validation are unchanged.
The CLI and a future service call the same library, not a CLI subprocess.

[`skill_loading_offline.rs`](../examples/skill_loading_offline.rs) exercises discovery,
the paired helper, registry and public controller using temporary synthetic roots
and a separate scripted provider. It asserts no initial body, one real load, exact
follow-up body and final fixture text in two requests. No ambient context/auth
roots, credentials or provider networking are used. Offline scripts and loopbacks
do not prove that a live model chooses or follows a skill; that remains NOT RUN.

## CLI presentation and legacy preflight (R1)

Plain answer presentation shares a private stateless filter across legacy
`generate`/`tool-demo` collection and `wi run` rendering. It keeps non-control
Unicode scalars plus LF and HT, and drops other controls. CRLF becomes LF; spaces,
indentation and Markdown fences remain without trimming. The filter is not an
ANSI parser: sequence-shaped payload text can remain after controls are removed.
Diagnostics, source labels and catalog descriptions retain the separate one-line
filter that removes all controls.

Filtering applies only to displayed bodies, including legacy deltas, terminal-only
text, suffixes and labelled fallback. Raw prefix comparison, returned response/native
data, JSON/NDJSON, labels, flushing and I/O failure propagation remain unchanged.
Private writer seams let tests capture the actual consumers without global stdout
redirection. This is not a general Unicode or terminal-emulator security guarantee.

The actual legacy `generate` handler reads the initial source, validates that
one-item input, validates a supplied follow-up as its own one-item input, then
validates actual session options before provider/auth/session construction.
An invalid follow-up consumes no first generation. Source errors precede input
errors; initial input precedes follow-up, which precedes options. Existing stdin
byte/UTF-8 checks, accepted bytes and provider-side defensive validation remain.
Valid requests retain one session and normal close. Runtime validation exits 1
with empty stdout; malformed legacy Clap syntax retains exit 2. No aggregate
request quota or implicit S1/S2 preparation is added to the legacy flow.

## Managed authentication boundary

The package, library, and CLI are `wi`; `Gateway` remains the routing abstraction.
Managed providers select once at every session open. A bound credential source
retains the alias, login incarnation, and provider account. `load()` is read-only.
The separate preparation hook is a no-op for external sources. It runs before a
new handshake and each SSE submission, never during an established WS session.
Renewal holds a stable file lock, rereads current state, and persists a reauth
marker before exchange. An owned worker completes persistence after waiter
cancellation. The default manager uses the real private refresh adapter. Explicit
refresh forces one exchange; automatic preparation skips fresh profiles and reuses
rotations completed by concurrent waiters. The adapter shares login's strict token
parser and fixed-TLS-response trust model. It permits no proxy, redirect, or retry;
connect/read limits are 10 seconds, exchange time 30 seconds, and response size
65536 bytes. Explicit renewal has live L1 evidence; automatic expiry and failure
paths have offline evidence.
`AuthExpired` now directs Wi-managed renewal through Wi and external renewal
through Codex/Pi, followed by a new provider session. Established WebSockets
cannot renew in place. Only display wording changes; `auth_expired`, the freshness
margin and all selection, renewal and persistence rules remain unchanged.
See [Wi auth](WI_AUTH.md#expiry-guidance-r1).

## Two interfaces, not one borrowed stream

`open_session(options)` returns `ProviderSession { id, control, events }`.
`control` is an `Arc<dyn SessionControl>`; events are an independently owned stream.

`generate(input)` validates and admits one request into an in-process worker.
The receipt confirms local admission only, not provider acceptance or durable
storage. The worker performs provider communication; the caller reads events.

A busy atomic flag rejects another generation immediately. Closing is driven by
an independent cancellation token, so waiting for network output or a slow event
consumer does not hold an exclusive session lock that blocks local cancellation.
Native steering returns `UnsupportedFeature` immediately in this version. We do
not pretend the command/event split itself implements upstream native steering.

Nonterminal events use a bounded queue and a finite stall deadline. Terminal
output/failure has one additional slot so a slow consumer can drain preceding
events and then observe why the session stopped. Use of that extra slot closes
the session to prevent a subsequent request overtaking its terminal event.

## Continuation strategies

WebSocket: reuse the authenticated connection. First request carries full input;
subsequent requests carry `previous_response_id` plus new input items. Config and
tool declarations remain fixed for the session. The payload omits HTTP `stream`
and `background` fields.

SSE: each request carries the full retained input and native final output from
preceding responses. `store:false` is retained; the adapter does not depend on a
stored-response lookup. Opaque reasoning blocks and metadata are kept unchanged.

The adapter retains its in-memory context even with WebSocket delta requests, but
does not automatically replay it on reconnect. Outcome-uncertain failures require
an explicit application decision, not a transparent transport retry.

## SSE admission boundary

The fixed subscription SSE transport normally requires successful status and
`text/event-stream`. Only entirely absent Content-Type on a successful 2xx response
activates strict prolog admission. Present wrong/empty/invalid MIME and non-2xx
responses retain their rejection and optional diagnostic sampling.

Admission reuses incremental `SseDecoder` framing in an opt-in strict mode.
The ordinary decoder's permissive field handling and final-frame-at-EOF behavior
remain unchanged. The prolog accepts initial BOM, fragmented UTF-8, LF/CR/CRLF,
comments, blank frames without data, and standard fields. Unknown lines and control
characters other than tab reject. Event labels use the last occurrence, including
empty reset. ID fields remain non-resuming metadata and reject NUL; retry values
must each be nonempty ASCII digits without enabling retries.

The first data-containing blank-line dispatch is decisive. Its JSON must carry a
nonempty response ID of at most 512 UTF-8 bytes and type `response.created` or a
recognized completed/done/incomplete/failed/cancelled terminal. A nonempty last event
label must match the JSON type byte for byte. A fresh trial `ResponseDecoder` must
produce ResponseStarted for created or ResponseFinished for a terminal. Trial events
are discarded without calling observation, settlement, or changing upstream outcome.
Malformed, empty, whitespace, DONE, or unknown first data rejects; later frames cannot
rescue it. EOF without the dispatch delimiter is not admission proof.

One absolute 10-second deadline and 65536 cumulative raw bytes from byte zero bound
the prolog, including comments and delimiters. Exact-cap proof is accepted; proof
beyond the cap is rejected. The send's cancellation and total deadline remain outside
this probe. The original HTTP receipt is recorded as missing/pending before awaiting
the body. Failure does not start another rejection sample or retry the request.

The byte stream checks cumulative fetched bytes against 32 MiB before Vec conversion
or retention. Consumed chunks move into a replay queue without another full-chunk
copy. The proof chunk's uninspected suffix stays intact. Replay precedes the remaining
body on the same POST and is charged once by ordinary receive accounting. A fresh
ordinary SSE decoder receives every byte in order. Its 8 MiB frame limit remains
unchanged. Admission stops as soon as proof is available, even on an open stream.

Admission runs identically with observation enabled or disabled. Its additive
`sse_prolog_*` sample states describe 64 KiB / 10-second admission, not ordinary
4 KiB / one-second rejection sampling. Only the first at most 4096 inspected bytes
supply a private body classifier; public metadata retains the original missing media.
See README for exact states and the pinned Pi compatibility reference. External
compatibility references are corroboration only, not gateway live evidence.

## Tool boundary

The provider records generated function calls; it does not execute them. A
completed response reaches the caller, which passes it to `ToolRegistry`.
Every call is preflighted before any new tool runs: finalized outcome, supported
origin, known tool name, unique call ID, JSON decoding, then tool-local validation.
Only ordinary direct function calls are executable in this version. The registry
uses normalized fields, but also rejects any non-null native namespace that
normalization omitted. This is a narrow consistency check, not general provider
wire parsing. Absent and null namespaces remain valid.
The CLI's fixed demo applies stricter acceptance before invoking the
registry validation: exactly one `add_numbers` call with `a=17,b=25`, one correlated
`sum=42` result, and final ordinary answer text exactly `42` after trimming.

Whole-batch preflight validates authority, arguments, identity and per-request input
compatibility before sequential execution. IDs permit at most 512 UTF-8 bytes.
`MAX_INPUT_ITEMS = 128` names the existing input-item capacity; a result batch that
cannot fit fails before new execution. It is not a lifetime tool-call quota.
Nine small valid calls in one response and more than 128 small distinct calls
across a run are permitted if retained input, payload and history checks pass.
Cached calls still require authorization. After execution, the controller validates
the complete actual result vector's existing byte/shape rules before submission.
It does not chunk results, submit a subset or undo completed effects.

`fresh_scope()` shares registered tool Arcs but starts an empty cache. Each run owns
one such scope, leaving the caller's cache untouched. Tool results are cached by
call ID in the registry instance. Reusing the same ID with a different tool name or
arguments is rejected. Identical repeated delivery uses the saved result.
The cache retains results until its owning scope ends, with no eviction or lifetime
entry-count ceiling. Memory can grow during a run; provider-history guards do not
guarantee a bound on cache memory or process RSS for arbitrary providers.
This is in-memory result reuse, not a durable exactly-once claim.

A tool owns any tool-specific timeout and reports expiry as its ordinary error/result.
The generic `Tool` trait and shipped `add_numbers` have no timeout option. The
controller adds no universal tool timeout or progress API.

The ordinary continuation requires exactly the outstanding result IDs. An output
item ID is not a call ID. New user instructions can accompany a complete result
batch at the next-request boundary; this is not native mid-response steering.
A completed terminal with any incomplete function call remains visible, but its
settled output blocks both tool-result and user continuation. Incomplete call IDs
do not become outstanding result IDs. Only omitted call status (intentional
compatibility) or the exact string `completed` marks a call complete. Every other
present value, including JSON null and non-string values, marks it incomplete.
The codec preserves the native value for inspection without enabling execution.

## Submission and observation boundaries

`NotSubmitted` covers local body construction, WebSocket freshness and
serialization, and SSE credential reload, account affinity, headers, and request
construction. The transport sets `Unknown` immediately before polling its first
network-capable send. Send failures and cancellation after that boundary remain
uncertain. Only a codec-validated terminal changes the outcome to
`TerminalReceived`, including when local finalized-item recovery, delivery, or settlement fails.
The decoder records this boundary before recovery and exposes it even on an error.
Invalid or mismatched terminal responses do not cross this boundary.

The shared decoder requires nonempty IDs for `response.created` and terminal
response parsing, including terminal-only synthesis and recovered effective output.
It rejects an empty ID as `Protocol("empty response identity")` before assigning
that identity, publishing a start/finish or setting `terminal_received`.
Missing/null/non-string required IDs retain their existing required-string error.
Nonempty IDs remain opaque without trimming or new length/format restrictions;
empty text and delta fields retain their own semantics. A previously valid start
need not be retracted when a later terminal is invalid.

After send, WS and labelled SSE use the existing `RequestFailed` path with
`protocol_error` and unknown upstream outcome, close the session and permit no
continuation. Missing-MIME SSE retains earlier prolog rejection with
`unexpected_content_type` and unknown outcome for an invalid first identity.
The public run consumer retains `provider_request_failed` with the nested adapter
error/outcome. A fake provider bypassing the adapter still meets the controller's
separate `provider_correlation` defense. No actor, registry or public API change
implements this repair.

The optional smoke observer belongs to one transport instance. It compares the
serialized WebSocket frame or built HTTP body at dispatch, not the model's claims.
It distinguishes native `response.created` from the codec's terminal-only
synthetic identity event. Only counts, static categories, and equality booleans
leave the observer. Opaque SSE replay is conditional on actual opaque output.
Normal sessions do not allocate or collect this observation state. Text comparisons
retain terminal `response.native.output` comparisons independently of effective text.
Separate effective counts, provenance, text state, and equality fields describe recovered
output without reclassifying an empty native array as native text. Streamed
text is assembled in observed order in private memory capped at 1 MiB per request.
Unavailable comparisons are null with static reasons, not successful proof. Terminal
text shape is captured before decoding; finalized-item categories retain counts only.
Counts include duplicates and saturate at 4096 per request. HTTP receipt records exact
numeric status and static media classes per send. Ordinary HTTP/MIME rejections
sample up to 4096 bytes for at most one second only with an enabled observer.
Missing-MIME admission uses the separate bounds and states described above. Sampling preserves the rejection
category and remains subject to existing cancellation and total limits. Nonempty
partial prefixes retain their safe class after timeout/read error; zero-byte timeout
remains unavailable, not empty. See the
README smoke section for additive diagnostic fields and their unavailable states.

The smoke collector separately preserves admitted failure evidence in
`acceptance.request_failure`: an allowlisted static code, 401/403/429 status when
known, and the unchanged upstream outcome. It discards event messages and maps
unknown codes to `unclassified`. The top-level stage identifies setup, generation,
or acceptance. This summary does not change the provider-neutral event shape.

The adapter consistency validator checks provisional text/refusal and finalized
message/call material against effective output before settlement or successful
terminal publication. Both public library sessions and legacy CLI callers receive
this protection; the run controller contains no OpenAI native-key parsing.
It rejects missing/conflicting evidence rather than reconstructing output. Per request,
item events consume a cumulative 1 MiB serialized-byte budget, including duplicates.
Tracking permits 4096 events and 512 finalized occurrences; item/content indexes must
be below 512. Each retained text copy is bounded by 1 MiB. Failure prevents conversation settlement and subsequent continuation. A previously
validated terminal retains `terminal_received` even if this local validation fails.

The provider decoder owns a private bounded finalized-item tracker. It recovers only
complete done objects after a correlated successful terminal explicitly supplies an empty
output array. Nonempty terminal arrays remain authoritative. The tracker validates the
whole batch and related item evidence; it never reconstructs items from deltas or
executes tools. Recovery populates existing output/text fields with explicit provenance,
without rewriting native terminal JSON. Conversation and registry consumers continue to
use effective output, including native item metadata for SSE replay. See EVENTS.md for
bounds, lifecycle validation, and fail-closed rules.

## Run ownership

`wi::run::run` accepts only `provider_id`, `options` and `prompt` in `RunRequest`.
Strict deserialization rejects unknown fields, including `limits: null`.
The controller validates before admission, then owns one session and a fresh tool
scope until completion or stop. The generic collector validates provider/session/
request identity, response identity and increasing provider-local sequence without
interpreting native payloads. It forwards unchanged inner envelopes and never waits
for a second terminal event. Only completed ordinary calls can continue.

The controller has no whole-run timer or request/execution quota. Open, generate,
collection and cooperative tool waits remain cancellation-aware; waiting races
work against cancellation, not a distant deadline. Cancellation checks also guard
transitions and dispatch. A validated completed no-call response whose disposition
is selected is not rewritten by later observer-triggered cancellation. Pending
calls still check cancellation before dispatch.
The controller never retries, reconnects, falls back or reopens a failed session.
It invokes no auth methods; provider opening and the existing same-profile SSE
preparation retain authentication ownership and renewal-worker completion policy.

The fallible synchronous observer receives outer lifecycle/provider/tool events.
It must not block; a channel adapter uses bounded nonblocking forwarding. No internal
transcript, durable queue or replay service is added. Sink failure stops later work;
final-emission failure preserves the selected outcome but marks delivery incomplete.
`RunResult` retains counters and the last full response, not a full run transcript.
Its outcome is `Completed`, `Failed { code }` or `CancelledLocally`. Counters use
checked `u64` arithmetic as observations, never quota checks; numeric overflow is a
static `counter_overflow` failure. Outer run-event schema 2 has payload-free
`run_started`; nested provider envelopes remain schema 1. See [events](EVENTS.md).
A close guard requests local session closure on return or future drop. Drop/process
loss cannot promise a result, final event, rollback or upstream cancellation.
`cli/run_cli.rs` validates inputs and prepares context before constructing the existing
provider. It renders events and signals cancellation without a second loop.

## Future service ownership (requirements only)

S1/S2 do not implement a service or persistence. The future service serves one
owner across multiple devices. A browser disconnect must not cancel admitted
service-owned work. A client subscription must not own the controller's observer
or provider receiver directly, because sink/receiver failure currently stops work.
Application sessions must persist in storage. Service restart stops active tasks
without automatic restart, resume, provider submission or tool replay. Continuing
requires an explicit user action. Storage design is deferred and must precede
service acceptance; no backend, store interface or recovery worker is selected.
The current `ProviderSession` is an in-memory transport handle, not that persistent
application session. See [product direction](WI_PRODUCT_DIRECTION.md).

## Intentionally deferred

- Approvals, sandboxing and noncooperative/external-effect cancellation guarantees.
- Persistent application sessions/history and durable operation state, branching, queues.
- Native steering acknowledgement/commit/pending-result protocol.
- Provider-native async tool scheduler and programmatic tool continuation.
- Tool discovery, supporting skill-file reads, scripts and other resource execution.
- HTTP server, GUI, keyring and proxy support.
- Stable provider support for the experimental shared OAuth registration.
  Browser login and explicit renewal have local Linux live evidence. Automatic
  expiry and failure paths have offline evidence. Historical M3 acceptance is
  recorded in [M3 verification](WI_RUN_VERIFICATION.md), not as C1 verification.

Hosted skills are excluded from the product, not a deferred engine. S1 removes
`Feature::HostedSkills`, the `hosted_skills` serialized variant and the provider
capability entry. Old required-feature input rejects as an unknown variant before
provider/auth construction. Local skills use shared preparation and ordinary
function tools, not a new provider capability.
No upload, hosted execution or API-key billing path is added.

Other advanced requirements fail closed instead of silently degrading or switching
billing/authentication modes. Item preservation is not advertised as execution
support. Subscription endpoint support still needs account-specific live tests.
