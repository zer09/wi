# Architecture and ownership

## One crate, explicit module boundaries

| Module | Responsibility |
|---|---|
| `provider.rs` | Traits, session options, normalized items/events, capabilities |
| `gateway.rs` | Provider registration and selection; no OpenAI protocol/auth logic |
| `providers/openai_codex/auth.rs` | Read-only credential source; no refresh writer |
| `providers/openai_codex/wire.rs` | WebSocket/HTTP transport, fixed destinations, TLS and bounds |
| `providers/openai_codex/codec.rs` | Native event decoding and typed item classification |
| `providers/openai_codex/state.rs` | In-memory transcript, parent response, pending result identities |
| `providers/openai_codex/session.rs` | Task lifetime, admission, independent control/output paths |
| `tools.rs` | Explicit tool registry and deterministic demonstration executor |
| `main.rs` | Temporary CLI caller, text/NDJSON output, bounded tool-demo driver |
| `demo.rs` | Pure acceptance checks for the fixed 17+25 CLI case |
| `smoke.rs` | Explicit synthetic live cases and sanitized acceptance summary |
| `providers/openai_codex/observation.rs` | Opt-in transport evidence; no generic event-contract change |

`Provider` is a Rust trait implemented by a compiled-in plugin. It is not a
shared-library ABI or runtime code loader. Adding a provider does not require
implementing OpenAI credentials or modifying the gateway. The external
`tests/provider_contract.rs` implements a provider without OpenAI imports.

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
registry policy: exactly one `add_numbers` call with `a=17,b=25`, one correlated
`sum=42` result, and final ordinary answer text exactly `42` after trimming.

Tool results are cached by call ID in the registry instance. Reusing the same ID
with different arguments is rejected. Identical repeated delivery uses the saved
result. This is a bounded in-memory convenience, not a durable exactly-once claim.

The ordinary continuation requires exactly the outstanding result IDs. An output
item ID is not a call ID. New user instructions can accompany a complete result
batch at the next-request boundary; this is not native mid-response steering.
A completed terminal with any incomplete function call remains visible, but its
settled output blocks both tool-result and user continuation. Incomplete call IDs
do not become outstanding result IDs.

## Submission and observation boundaries

`NotSubmitted` covers local body construction, WebSocket freshness and
serialization, and SSE credential reload, account affinity, headers, and request
construction. The transport sets `Unknown` immediately before polling its first
network-capable send. Send failures and cancellation after that boundary remain
uncertain. Only a codec-validated terminal changes the outcome to
`TerminalReceived`, including when a later local delivery or settlement fails.

The optional smoke observer belongs to one transport instance. It compares the
serialized WebSocket frame or built HTTP body at dispatch, not the model's claims.
It distinguishes native `response.created` from the codec's terminal-only
synthetic identity event. Only counts, static categories, and equality booleans
leave the observer. Opaque SSE replay is conditional on actual opaque output.
Normal sessions do not allocate or collect this observation state.

The smoke collector separately preserves admitted failure evidence in
`acceptance.request_failure`: an allowlisted static code, 401/403/429 status when
known, and the unchanged upstream outcome. It discards event messages and maps
unknown codes to `unclassified`. The top-level stage identifies setup, generation,
or acceptance. This summary does not change the provider-neutral event shape.

## Intentionally deferred

- Agent run/turn state machine, approvals, tool cancellation and sandboxing.
- Durable operation acceptance/settlement/recovery, sessions, branching, queues.
- Native steering acknowledgement/commit/pending-result protocol.
- Provider-native async tool scheduler and programmatic tool continuation.
- Tool discovery and skill resource loading/hosted uploads.
- HTTP server, GUI, browser OAuth, credential refresh, keyring and proxy support.

Advanced requirements fail closed instead of silently degrading or switching
billing/authentication modes. Item preservation is not advertised as execution
support. Subscription endpoint support still needs account-specific live tests.
