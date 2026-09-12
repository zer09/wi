# Wi 0.2.0

A headless Rust library with compiled-in provider plugins, shared workspace context
preparation, and a cancellation-aware run controller. The CLI calls the library.
OpenAI/Codex sessions use WebSocket or explicit SSE with typed events and ordinary
function-tool continuation.

See the [documentation index](docs/README.md) for current documentation and historical records.

**S2 status: implemented and offline accepted under contract s2.1.**
The [S2 verification report](docs/slices/s2/VERIFICATION.md) records all 24 rows
passing, 374 local Rust tests and 152 Node self-tests. Submitted-head CI for
`48e23b5` passed on Ubuntu, macOS and Windows; see the dated CI references below.
Live model selection/adherence remains NOT RUN. S2 did not repair its inherited
A-01 through A-05 findings. Planning documents and older reports retain their
original phase-specific wording as evidence.

**R1 status: OFFLINE_ACCEPTED in commit `88b76c5`.**
The [R1 verification report](docs/slices/r1/VERIFICATION.md) and
[machine report](docs/slices/r1/verification.json) record A-01..A-05 and
R1-00..R1-19 PASS, 421 Rust tests and 152 Node self-tests. The repeated
complete-diff review passed with no actionable findings; `accepted=true`.
A small follow-up closes NB-02 by applying the existing one-line filter to legacy
RequestFailed diagnostics. Its full Rust suite passes 422 tests.
Exact-head cross-platform CI is NOT RUN. No live checks or push occurred.

**Status: Wi managed-auth login, explicit renewal and all six generation cases passed on local Linux.**
Wi persisted its own eligible profile and confirmed it through fresh metadata status
both after login and after renewal. Automatic expiry-triggered renewal has offline evidence.
W1-W3 WebSocket text, continuation and add_numbers passed with managed auth and
gpt-6-astra. S1-S3 SSE text, continuation and add_numbers also passed.
Live opaque replay remains untested; stable provider support is unconfirmed.
See the [combined implementation report](docs/COMBINED_DESIGN_REPORT.md) for
commit boundaries and verification evidence. See [managed authentication](docs/WI_AUTH.md)
for implemented mechanics and limits.
The original delivery was uncompiled. Its [verification](docs/VERIFICATION.md)
is historical evidence, not the record of local repair. Normal tests use synthetic
credentials and loopback servers. Offline success does not prove account access.

## Scope

```
CLI / library caller
        |
 Context discovery / preparation (S1 + S2)
        |
 Run controller + registered local tools
        |
     Gateway
        |
 Provider trait
        |
 OpenAiCodexProvider
        |
 ProviderSession = command handle + event stream
        |                          |
 WebSocket or SSE          normalized output items/events
        |
 Codex subscription backend
```

The deterministic `add_numbers` executor is a separate module. The provider
never executes files, commands, model-generated JavaScript, or unknown tools.
There is no web server, GUI, database, persistent agent service, or sandbox here.
The cancellation-aware `wi::run::run` controller supports ordinary tool/result cycles.

## What is implemented in source

- Shared `wi::context::discover`, `load_skill`, `prepare_run` and
  `prepare_run_with_skill_loading` APIs with explicit host-selected roots.
- Always-discovered global and project skill metadata; explicit initial bodies
  and model-selected main `SKILL.md` loading through an ordinary function tool.
- Root workspace `AGENTS.md` preparation and metadata-only `wi skills list`.
- `Provider` and `SessionControl` Rust traits with an independent example provider.
- Read-only use of the user's existing Codex/Pi OAuth credential file.
- WebSocket as the default, with `--transport sse` as an explicit alternative.
- A single outstanding response per session; concurrent generation returns `Busy`.
- WebSocket continuation with `previous_response_id` and only new input items.
- Full native output replay on SSE, including opaque reasoning state.
- Typed response/item events; IDs for local session, request, event, response,
  output item, and tool call remain distinct.
- Completed, incomplete, failed, cancelled, and uncertain transport outcomes.
- A local function executor with argument validation and in-memory result reuse.
  `add_numbers` adds integers; `load_skill` reads main instructions from the bound catalog.
- No automatic retry, reconnect, transport fallback, or API-key billing fallback.

**Native steering, async tool calling, programmatic tool execution, and tool search
are NOT implemented or verified.** Their required capability flags fail before
authentication or network access. Generic unknown provider-native output remains
preserved without execution.

Hosted skills are excluded by product choice, not retained as a future capability.
S1 removes `Feature::HostedSkills` and its `hosted_skills` serialized name.
Existing required-feature input containing that name now fails unknown-variant
deserialization before provider/auth work. There is no alias to local skills,
upload integration, API-key billing fallback, or hosted execution.

## Build and test first

Use a current stable Rust installation with `cargo`, Rustfmt, and Clippy.

```bash
cargo fmt --all -- --check
cargo check --all-targets
cargo test --all-targets
cargo clippy --all-targets -- -D warnings
cargo build --all-targets
cargo test --doc
```

Or run the supplied local gate (Python 3.11+):

```bash
uv run scripts/verify.py
```

The tests use synthetic credentials and local loopback HTTP/WebSocket servers.
They do not read your auth files or consume your subscription. Cargo dependency
downloads still need network access. GitHub Actions runs the six Cargo gates on
Ubuntu, macOS and Windows. On 2026-09-12, both the
[push run](https://github.com/zer09/wi/actions/runs/34678063675) and the
[PR run](https://github.com/zer09/wi/actions/runs/34678065367) passed every configured
OS job at `48e23b5330ba6aa69be0bf02a4aab6c8d7226426`. These are revision-specific
results, not a claim about later commits or live provider behavior. Node
self-tests, Python inventory checks and executed examples are separate local
evidence; the GitHub workflow does not run those commands. The original
uncompiled-delivery report remains historical and is not current CI status.

`Cargo.lock` is retained after local dependency resolution. The direct HTTP and
WebSocket crate versions remain pinned. Use the lockfile for reproducible
resolution. Managed auth directly uses the already locked `ring` and `rustix`
crates for secure randomness and safe Linux filesystem operations.
Local frontmatter uses pinned `yaml-rust2 = 0.12.0` without default features.
Its parser events let Wi reject unsupported YAML constructs before loading values.
The offline skills examples use the existing `tempfile` dev dependency.

## Run controller (C1.1)

`wi::run::run(&gateway, request, &registry, cancel, observer).await` accepts a strict
`RunRequest` containing exactly `provider_id`, `options` (`SessionOptions`) and
`prompt`. Deserialization rejects unknown fields, including obsolete `limits`
values, even `null`. Caller `options.tools` must be empty; the registry supplies
the declarations. Validation errors return `Err` before events or session opening.
Admitted runs return `RunResult` with outcome, counters, last full response and
delivery status. Outcomes are `Completed`, `Failed { code }` and `CancelledLocally`.
The provider-neutral controller opens one session and performs sequential ordinary
function-tool/result cycles. It has no retry, reconnect, fallback or resume path.
Each run shares registered tool implementations but starts a fresh result cache;
it neither consumes nor changes the caller registry's cached results.

The independent example uses synthetic responses and no credentials or network:

```bash
cargo run --example run_offline
```

It ends with `Completed: 50 (1 session, 3 model requests, 2 tool executions; offline)`.
M3 is OFFLINE ACCEPTED after the repeated accumulated independent review.
The separately authorized RL1 WebSocket and RL2 SSE checks passed with
`gpt-5.6-luna` and Wi-managed gateway authentication. They used two submissions
each with no retries. The user then raised the cumulative cap to 50 without
adding submissions. The ledger is 31/50 used, 19 remaining; M3 itself retained
zero allocation and the post-M3 RL checks used four. See
[M3 verification](docs/WI_RUN_VERIFICATION.md). Those historical results predate
C1.1 and do not verify the changed contract.

The following is usage documentation, not authorization to make a live request:

```bash
wi run --auth-source codex --model "YOUR_ENABLED_CODEX_MODEL_ID" \
  --prompt "Add 17 and 25, then add 8 to the result" --tool add_numbers
```

Use exactly one of `--prompt` or `--stdin`; input must pass the existing 1 MiB
serialized-input bound. `--instructions` defaults to `You are a helpful assistant.`
The default auth source is Codex and transport is WebSocket; SSE requires
`--transport sse`. Managed auth requires explicit `--auth-source gateway` and
accepts `--account`, not `--auth-file`. A nonempty skill catalog automatically
exposes `load_skill`; no `--tool` or enable flag is needed. An empty catalog adds
no loader. `--tool add_numbers` enables the other shipped tool; duplicate or unknown
selections fail. There is no follow-up, resume or steering option.

`wi run` has no model-request count, tool-execution count or whole-run deadline
flags. Deleted flags are unknown-argument errors before provider construction or
credential access; no replacement setting is available. The controller has no
whole-run timer. It stops on normal response disposition, cancellation or a real
provider, protocol, tool, resource or delivery failure, not a count/time quota.

Tool batches are fully validated before dispatch. Nine small valid calls in one
response and more than 128 small distinct calls across a run are not policy-rejected
by count. The existing `MAX_INPUT_ITEMS = 128` capacity is per request, not a lifetime
tool quota. A batch whose results cannot fit that item capacity fails before
execution. The controller validates the complete actual result vector's existing
byte/shape rules before submission; it never sends a subset or rolls back completed
effects. Other input, payload and provider-history checks still apply.

Results remain cached until the run scope ends, with no eviction or lifetime
entry-count ceiling. The cache can grow; provider-history guards do not guarantee
bounded cache memory or process RSS for arbitrary providers. Summary counters
observe work using checked `u64` arithmetic but never grant execution permission.
An unrepresentable count produces a static `counter_overflow` failure instead of wrapping.

Cancellation is cooperative; Ctrl+C signals the token and awaits controlled
completion. Tools and observers must cooperate. A selected completed no-call
response stays completed if an observer cancels later; pending calls still check
cancellation before dispatch. Neither cancellation nor future-drop cleanup
guarantees that upstream work stopped. Tool-specific timeouts remain tool-owned;
the generic `Tool` trait and shipped `add_numbers` define no timeout option.

`--json` emits only outer schema-2 `RunEventEnvelope` NDJSON on stdout. `run_started`
has no event-specific payload; nested provider events remain schema 1. Nested native
items, text and tool data are sensitive application data, not sanitized telemetry.
Diagnostics remain on stderr and use the one-line filter, which removes all
control scalars. Plain answer output preserves LF, HT, indentation and non-control
Unicode scalars but drops other controls, including CR, ESC and C1 controls.
CRLF becomes LF without trimming or normalization. Labels still distinguish
provisional output from validated responses. JSON/NDJSON and returned response
text remain unchanged. This is a control-character policy, not an ANSI parser or
a general Unicode/terminal security guarantee. Completed exits 0
(including refusal, not proof of correctness), local cancellation exits 130, and
other failures or startup/parse errors exit 1. Help exits 0; old command parse
errors retain exit 2. Output delivery failure takes precedence and exits 1, even
after completion; broken stdout stops further work.

## Workspace context and local skills (S1 + S2)

Only `wi run` prepares task context. `--workspace PATH` defaults to the CLI cwd;
relative paths resolve once against that cwd. The library canonicalizes the
explicit workspace and global roots. No directory is created by preparation.

Global metadata is always discovered from `$XDG_CONFIG_HOME/wi/skills` when
`XDG_CONFIG_HOME` is nonempty and absolute. Otherwise Wi uses
`$HOME/.config/wi/skills` with nonempty absolute `HOME`. A nonempty relative XDG
value is an error, not a fallback. Missing or nonabsolute fallback HOME is an error.
Project metadata adds `<workspace>/.agents/skills`; it never replaces globals.
Missing skill directories are empty scopes; unreadable or wrong-type roots fail.

List frontmatter without reading `AGENTS.md`, activating bodies, opening auth,
constructing a provider, executing tools, or accessing the network:

```bash
wi skills list --workspace /path/to/workspace
wi skills list --workspace /path/to/workspace --json
```

Plain output lists qualified ID/name and description with terminal controls
filtered. JSON contains `entries` (each with `id`, parsed `frontmatter`, relative
`source`) and `diagnostics` (`scope`, `source`, static `category` and `message`).
It excludes bodies and resolved host paths. Metadata is sensitive user data and
can itself contain private text or paths. Diagnostics also go to stderr.
Malformed entries are excluded with diagnostics; valid entries remain visible.
Fatal root errors or duplicate names within one scope exit nonzero.

Both `global:review` and `project:review` can exist. Listing sorts globals by name,
then projects by name. Repeat `--use-skill global:review` or
`--use-skill project:review` on `wi run` to include main `SKILL.md` instructions
initially. Bare names and raw paths are invalid. Selection order is preserved;
a repeated ID activates once at its first position. No selection is required to
include all frontmatter. These flags do not extend `generate`, `tool-demo`,
`smoke`, or auth commands.

Normal `wi run` also exposes `load_skill` when the catalog is nonempty. The model
can request `load_skill({"id":"project:review"})` to read advertised instructions
when needed. Unselected bodies first appear in correlated tool results, not in
the initial request. The model may finish without loading any skill, load another
skill, or request an already explicit body. Wi runs no separate classifier or
selection model. The ordinary next model request consumes the tool result.

Shared discovery reads only frontmatter. Shared preparation reads root-only
`AGENTS.md` and explicitly selected bodies. It preserves caller instructions as
a prefix, then adds fixed framing about context and tool authority. The initial
user payload is deterministic JSON with `task`, `project_instructions`,
`available_skills`, and `active_skills`. Task bytes remain unchanged inside that
payload; file bodies never enter higher-priority instructions. Without context
or selections, the original prompt and instructions remain byte-identical.
`ContextManifest` records initial preparation only: available IDs, explicitly
included active IDs and the project-instruction source. It is not a live ledger
of later loads or proof that the provider received a result.

Library callers use `prepare_run_with_skill_loading(request, Arc<SkillCatalog>,
selected, &tools)` and pass its prepared request and returned registry to
`wi::run::run`. The helper binds metadata and the tool to the same catalog.
Direct `prepare_run` retains its no-loader behavior. An empty catalog adds no
loader or loader instructions. See [architecture](docs/ARCHITECTURE.md) for registry
pairing and cache ownership.

The CLI validates arguments, task, tools and auth shape before preparation. One
`spawn_blocking` task calls shared discovery and preparation. Final input/options
validation and diagnostic delivery finish before provider/auth construction.
The prepared request then uses the existing controller, cancellation and event
schemas. Skill text grants no tools, permissions, model/provider selection, auth
changes or capabilities. The same WebSocket parent/delta and SSE full-history
continuation consumes skill results; session instructions stay fixed. Local context
can travel to the chosen model; local skills do not mean offline inference.

### Loading boundaries

`load_skill` reads only the catalog entry's main `SKILL.md`. It returns exactly
`id`, validated `frontmatter` and the complete Markdown `body`. Supporting files,
references, assets and scripts are not read or executed. Loading does not perform
the workflow described by the skill. There is no generic file reader, shell or
network tool, upload integration, watcher or automatic rediscovery.

- Preflight checks argument shape, qualified ID and catalog membership without
  filesystem I/O. Malformed or unknown IDs reject the whole batch before any new
  execution; they do not produce a correlated skill error result.
- A valid entry that fails during loading returns the existing correlated
  `{"error":{"code":"gateway_error"}}` through the registry. `ToolFailed` keeps
  that code. `ToolExecutionFinished` has `is_error=true`; the result JSON does not.
  The next ordinary model request can consume this error; it need not fail the run.
- The whole-file guard is 1 MiB. A larger file fails loading first and follows the
  `gateway_error` path. A successfully loaded value whose JSON serialization exceeds
  64 KiB instead returns `tool_output_limit`, also with `is_error=true`. Exactly
  64 KiB is allowed. JSON escaping and metadata count; Wi does not truncate success.
  Some explicitly selectable bodies therefore do not fit a loader result. Existing
  complete next-input validation still applies.
- The catalog fixes metadata and source selection at discovery. Each new execution
  rereads the main file and revalidates frontmatter. Body-only edits before that read
  are allowed; changed metadata fails. Returned text is owned and cannot change
  after later edits or deletion. Added files require fresh discovery/preparation.
- The same call ID and arguments reuse the saved per-run result, including errors,
  without reopening the file. Conflicting reuse fails. A distinct call ID performs
  a new load and can observe a body-only edit. There is no separate skill-body cache.

Existing no-follow, regular-file and root checks remain. Owner-controlled roots,
ancestor races and hardlinks remain trust limits; JSON framing is not a
prompt-injection sandbox. See [architecture](docs/ARCHITECTURE.md) and
[events](docs/EVENTS.md) for cancellation, cache ordering and sensitive-data handling.

### Offline examples

The explicit-selection example proves metadata inclusion, initial body activation
and one ordinary addition/result continuation without credentials or networking:

```bash
cargo run --example skills_offline
```

It finishes with `Completed: 42` using two catalog entries and one active skill.
The [model-selected loading example](examples/skill_loading_offline.rs) uses
synthetic temporary workspace/global roots and a separate in-process provider:

```bash
cargo run --example skill_loading_offline
```

It asserts absent initial bodies, one real `load_skill` execution and exact body
text in the follow-up input. It finishes with `Completed: Reviewed offline.`
using one session and two scripted model requests. Neither example uses ambient
context/auth roots, real credentials or provider networking. Scripted and loopback
checks do **not** prove live model selection or adherence; that remains NOT RUN.
See [S1](docs/WI_LOCAL_SKILLS_S1.md) for metadata parsing and filesystem limits,
and [S2](docs/slices/s2/CONTRACT.md) for main-file loading semantics.

## Future service and storage (not implemented)

The service is for one owner using multiple devices. Browser disconnect must not
cancel service-owned work. Application sessions must persist in storage. Service
restart stops active tasks; it must not automatically restart or resume them.
Continuing requires a new explicit user action. Storage design precedes service
acceptance and remains deferred. S1/S2 add no server, storage interface, database,
recovery worker, or UI. `ProviderSession` is an in-memory transport handle, not a
persistent application session. See [product direction](docs/WI_PRODUCT_DIRECTION.md).

## Experimental Wi browser login

On Linux or WSL's private Linux filesystem, explicitly opt in:

```bash
./target/debug/wi auth login --provider openai-codex --account personal --experimental
```

This writes only Wi's separate secure store. An existing alias requires `--replace`.
Without `--experimental`, login fails before path access or network activity.
Linux `/usr/bin/xdg-open` must open a browser and exit successfully within 10 seconds.
On WSL, configure that launcher beforehand; Wi does not use `cmd.exe` or another fallback.
Port 1455 must be free. Wi never cancels an existing listener.
The command prints static progress and local alias/expiry/persistence metadata, not
an authorization URL or tokens. Do not enable HTTP tracing or process-argument logging.
The browser and local launcher necessarily receive the authorization URL.

The shared public-client configuration follows Pi's browser flow, with honest `wi`
identification. This does not establish OpenAI approval, stable support, or entitlement.
No retries, device flow, manual-code fallback, or API-key exchange are implemented.
`wi auth refresh --provider openai-codex --account personal` renews the selected
Wi-owned profile and prints safe current metadata. `--auth-source gateway` enables
automatic preparation near expiry before a new session or same-profile SSE request.
Established WebSockets never renew mid-session. The token exchange uses fixed TLS,
no proxy/redirect/retry, 10-second connect/read limits, a 30-second exchange limit,
and a 65536-byte response limit. Explicit renewal has live L1 evidence;
automatic expiry and failure paths have offline evidence.
See [Wi auth](docs/WI_AUTH.md) for bounds, trust assumptions, and persistence behavior.

## Reuse your own subscription login

Keep credentials on your computer. **Never upload `auth.json`, a token, or raw
provider-output logs to a chat, issue, or repository.**

```bash
# Local structure/expiry check only; not a live account check:
cargo run -- auth-check --auth-source codex
cargo run -- auth-check --auth-source pi

# Nonstandard path:
cargo run -- auth-check --auth-source codex --auth-file /absolute/path/to/auth.json
```

Default files:

- Codex: `$CODEX_HOME/auth.json`, otherwise `~/.codex/auth.json`.
- Pi: `~/.pi/agent/auth.json`, selecting only the `openai-codex` OAuth entry.

Codex may store credentials in the OS keyring rather than a readable file. This
reader does not access the keyring or modify your credential-storage settings.
Use file-backed credentials only deliberately, or retain the existing client as
your auth/runtime owner. API-key auth files are rejected, not silently reused.

The file must be a regular file. On Unix it must exclude group/other permissions;
the final path component is opened with `O_NOFOLLOW`. Protect its parent directory
as well. Windows ACLs are not validated by this milestone. Paths are supplied by
a trusted local caller; do not accept credential paths from remote HTTP users.

The external-source reader never logs, writes, copies, or refreshes credentials.
Wi-owned profiles use a separate protected file store; see [Wi auth](docs/WI_AUTH.md).
JWT decoding provides hints only; OpenAI authenticates the token cryptographically.

**WebSocket:** credentials and account are fixed at the handshake. Renew expired
external credentials through Codex/Pi or Wi-managed credentials through Wi, then
open a new provider session. Established WebSockets cannot renew in place.
`AuthExpired` retains code `auth_expired` and the 30-second freshness margin;
[R1 changes its guidance only](docs/WI_AUTH.md#expiry-guidance-r1), not auth behavior.

**SSE:** the selected file is reread before each request; a changed account is
rejected to avoid sending the previous account's conversation to a new account.

## Sanitized live smoke helper

Only an authorized operator may run these commands after offline and security
review. Each invocation uses the real gateway/provider path. It has no retry,
fallback, alternate model, raw-event output, or automatic auth check.
`--auth-source pi|codex|gateway`, `--transport`, `--case`, and `--model` are required.
There is no default auth source or fallback. The smoke helper rejects models other
than exact `gpt-6-astra` before credential access.

```bash
# One generation. The deadline is external; timeout leaves upstream outcome unknown.
timeout 180s target/debug/wi smoke --auth-source pi --transport websocket \
  --model gpt-6-astra --case text
# Each of these can submit two generations on one session.
timeout 180s target/debug/wi smoke --auth-source pi --transport websocket \
  --model gpt-6-astra --case continuation
timeout 180s target/debug/wi smoke --auth-source pi --transport websocket \
  --model gpt-6-astra --case tool
```

Select `--transport sse` explicitly for equivalent SSE cases. The original handoff's
10-submission allowance (five per transport) is historical, not a renewed allocation.
Count every attempt, including ambiguous writes, under the owner's current explicit
authorization and stop a failed sequence. The recorded cumulative ledger remains
31/50 used, 19 remaining; the balance alone authorizes no requests. These examples
are not evidence that this model or account is supported. No real credentials or
live calls were used to implement the helper.

The single JSON summary contains only static categories, counts, and booleans.
`submissions` records dispatch attempts, transport, socket reuse, request-body
comparisons, actual native-created counts, allowlisted terminal type/status, and
delta counts. `acceptance` records normalized-start counts, answer equality, and
strict tool/executor/result checks. `acceptance.request_failure` preserves an
allowlisted failure code, HTTP status for 401/403/429 only, and the original
`upstream_outcome`. Unknown codes become `unclassified`; messages and native
bodies are discarded. Read this field with the top-level `stage`. The top-level
`error_code` remains the local helper error and can be `provider_error` even when
the structured evidence identifies a more specific failure. Setup failures have
no request-failure record and use the safe top-level error code.

Effective output may come from a validated complete done batch when the successful
native terminal array is explicitly empty. See [EVENTS.md](docs/EVENTS.md) for the
bounded recovery policy. Native JSON remains unchanged.

The additive observer fields do not change smoke schema version 1 or acceptance:
- `native_terminal_items` counts native terminal items; `effective_items` separately
  counts effective items. `output_provenance` identifies their source.
- `effective_text_state`, `effective_expected_text_equal`,
  `normalized_effective_text_equal`, and `streamed_effective_text_equal` compare
  effective output separately, using the same private 1 MiB text bound.
  Recovery leaves native counts at zero and native text comparisons unavailable.
- `native_expected_text_equal` compares terminal native ordinary text, trimmed,
  with the fixed answer for that case/request. The first tool response has no
  expected answer (`null`).
- `normalized_native_text_equal` compares both normalized ordinary output and
  `response.text` with `response.native.output`, without trimming.
- `streamed_native_text_equal` compares text deltas assembled in observed order
  with terminal ordinary text, without trimming. Its private aggregate is capped
  at 1 MiB and resets at each request.

Only message `output_text` parts count as ordinary text. Refusals, unsupported or
malformed parts, diagnostic overflow, and missing terminal text yield `null`, not
success. No deltas also yields `null` for streamed equality. Diagnostics are
captured before acceptance can fail. Exact trimmed answer acceptance, required
lifecycle proof, and tool assertions remain unchanged.

`terminal_text_state` distinguishes `available`, `no_ordinary_parts`,
`missing_or_invalid_output`, `malformed_content`, `unsupported_kind_or_part`,
`over_limit`, and `no_terminal`. `streamed_text_state` distinguishes `available`,
`no_deltas`, `malformed_content`, and `over_limit`. Each equality has a corresponding
`*_unavailable` reason: null when compared, otherwise one of these static states,
`not_validated`, or `not_applicable`. First-turn tool expected text is not applicable.
Terminal shape is captured before decoding; validation is recorded only after parsing.
`finalized_items` counts total, message, function_call, reasoning, other, and malformed
done events, including duplicates. Counters saturate at 4096 per request;
`finalized_items.overflow` indicates additional done events. No native item is retained
for counting. Existing lifecycle/delta counters also saturate at 4096.

`submissions[].http.status` is the authoritative exact numeric HTTP status when
an SSE response arrives, including rejected success statuses and generic errors.
The legacy failure status remains limited to inferred 401/403/429 categories.
`http.media` is `missing`, `invalid`, `event_stream`, `json`, `html`, `plain_text`,
or `other`. No header value or parameter is exposed.

Ordinary HTTP/MIME rejections with an enabled observer receive a body-prefix sample:
at most 4096 bytes, with a one-second timeout within existing cancellation and
total limits. `sample_state` is `not_sampled`, `unavailable`, `complete`,
`read_error`, `timeout`, or `truncated`. `unavailable` preserves the initial HTTP
receipt if sampling does not finish, for example after cancellation.
Reaching the cap reports `truncated` conservatively, even if the body is exactly
4096 bytes. `body_class` is `empty`,
`json_like`, `html_like`, `text_or_other`, `binary_or_non_utf8`, or `null` when
unavailable. A nonempty prefix remains classifiable after timeout or read error.
A zero-byte timeout/read error stays null; only zero-byte EOF can classify empty.
Classes are prefix heuristics, not failure causes. Labeled accepted SSE is
`not_sampled`; a disabled observer collects no diagnostics. Sampling never replaces
the original rejection category. There are no redirects, retries, or fallback.

Within this fixed subscription adapter only, a successful 2xx response with an
entirely absent Content-Type can enter strict SSE prolog admission. Present wrong,
empty, or invalid MIME values and non-2xx statuses retain their rejection behavior.
Admission requires the first blank-line-dispatched data frame to qualify within
65536 raw bytes from byte zero and one absolute 10-second deadline. Comments and
blank frames without data may precede it. EOF without that delimiter rejects.
The first data frame is decisive: empty/whitespace data, `[DONE]`, invalid JSON,
and unknown event types reject without searching for a later valid frame.

The prolog accepts an initial BOM, incremental UTF-8, LF/CR/CRLF, comments, and
standard data/event/id/retry fields. Unknown lines, invalid UTF-8, and control
characters other than tab reject. The last event label wins, including an empty
reset; a nonempty label must equal the JSON type exactly. IDs do not enable
resumption; retry fields must each contain nonempty ASCII digits and never enable
retries. The JSON response ID must be a nonempty string of at most 512 UTF-8 bytes.
Only `response.created` or terminal `response.completed`, `response.done`,
`response.incomplete`, `response.failed`, and `response.cancelled` may qualify.
A fresh trial response decoder must produce the corresponding recognized lifecycle
event. Trial events never reach observation, settlement, or caller state.

All fetched chunks, including the uninspected suffix of the proof chunk, replay
once in order into a fresh ordinary SSE decoder. Admission stops at proof, not EOF.
The existing 32 MiB response and 8 MiB later-frame limits still apply. Fetched bytes
are checked against 32 MiB before retention or conversion to the existing byte-stream
Vec; replay contributes once to normal receive accounting. Cancellation and total
request limits still enclose admission. Admission failure is `unexpected_content_type`
with unknown upstream outcome, except for existing outer cancellation/size/timeout
categories. There is no second rejection sample after consuming a candidate.

The original `http.media` remains `missing`. Admission adds `sample_state` values
`sse_prolog_pending`, `sse_prolog_admitted`, `sse_prolog_rejected`,
`sse_prolog_timeout`, `sse_prolog_read_error`, and `sse_prolog_truncated`.
These describe **64 KiB / 10-second admission**, not 4 KiB / one-second rejection
sampling. The pending HTTP receipt survives cancellation. Only the first at most
4096 privately inspected bytes contribute to `body_class`; no raw data or IDs leave
this diagnostic. Observer enablement does not change admission behavior.

Compatibility corroboration: the pinned [Pi v0.85.1 adapter source](https://github.com/earendil-works/pi/blob/v0.85.1/packages/ai/src/api/openai-codex-responses.ts)
parses the response body without a MIME gate. That reference is not live proof for
this gateway; this adapter deliberately requires the stricter bounded proof above.

Zero text deltas means streaming text was not
observed; terminal-only output is not streaming evidence. Missing native-created
or required continuation proof makes the helper exit nonzero.

SSE `opaque_replay` is `matched`, `mismatched`, or `not_emitted`. The last value is
not a failure and does not prove opaque replay live. `null` means not applicable.
The disabled observer does not retain native observation state. The enabled
observer retains comparison material only in memory and never serializes it.
The summary contains no headers, credential/account/response/call IDs, native
payloads, model text, or raw error bodies. An external kill can prevent summary
output; conservatively count the case's maximum submissions in that situation.

## Fixed CLI retest runner

`scripts/cli_retest.mjs` runs the built `target/debug/wi` directly. It never
runs Cargo, Pi, or the Codex executable. Help and synthetic self-tests do not
start the gateway or read credentials:

```bash
node scripts/cli_retest.mjs --help
node scripts/cli_retest.mjs --self-test
```

After separate source review and live authorization, the parent may run each
fixed case once. Each invocation reserves at most two submissions:

```bash
node scripts/cli_retest.mjs --run-live --case continuation
node scripts/cli_retest.mjs --run-live --case tool
```

Both commands explicitly select Codex auth, `gpt-6-astra`, WebSocket, and CLI JSON.
Continuation uses exactly `Remember the word lantern and acknowledge.` followed
by `What word did I ask you to remember?`. The tool case runs `tool-demo` with its
existing validators. There are no arbitrary arguments, prompts, models, auth
paths, retries, or default live action. The subprocess has ignored stdin and piped
stdout/stderr. At 180 seconds, the runner sends SIGTERM, then SIGKILL after one
second, and bounds pipe cleanup by another second. Interruption does not prove
upstream cancellation. Do not pipe raw CLI output into reports.

The runner emits one sanitized JSON object. `requests` contains per-request
normalized lifecycle/delta counts, separate `done_items`, `effective_items`, and
`native_terminal_items` counts, static `output_provenance`, allowlisted terminal
status and `effective_text_state`, lantern-presence and final-42 booleans, and effective function-call
semantics. Old payloads default to `native_terminal`. The runner does not implement
recovery; it validates effective output and requires a clean CLI exit. `executor.correlated` requires actual
linked start/finish events for the complete direct namespaceless add_numbers call
with a=17 and b=25. Text `42` alone cannot pass the tool case.

The CLI does not serialize tool-result input or transport dispatch evidence.
Thus `executor.result42_observed` and `accounting.observed_transport_submissions`
are always null. `result42_validated_by_cli_inferred` records that correlated
executor events and a second request crossed the reviewed CLI result validator;
it is not observed wire linkage. Distinct private request IDs establish only
`observed_request_ids`. `conservative_upper_bound` is two unless a complete
first-response guard/no-tool failure supports the explicitly labelled
`inferred_first_response_stop` bound of one. Missing, invalid, truncated, killed,
or otherwise incomplete evidence always reserves two. No events never means
no send. These fields cannot prove socket reuse or the encoded continuation body.

`assertions_passed` requires exit zero, two completed lifecycles, and the case's
text/tool assertions. The runner exits nonzero otherwise. `reason` contains only
static parser/process categories. `public_error` matches exact known CLI errors;
all other stderr becomes `unclassified`. Raw lines are bounded to 8 MiB, total
stdout to 64 MiB, stderr to 64 KiB, ordinary text comparisons to 1 MiB, and retained
request summaries to two. Limits fail closed and terminate the child. Native
items, IDs, arguments, text, headers, stderr, and exception details are never
written or echoed. All fixtures and subprocesses in self-tests are synthetic.
These instructions are not live verification or permission to exceed the budget.

## General CLI examples (not sanitized evidence)

Replace the placeholder with the exact model ID already enabled in your own
Codex/Pi installation. A catalog entry alone is not evidence of account access.
Running these commands consumes subscription allowance.

```bash
cargo run -- generate \
  --auth-source pi \
  --model "YOUR_ENABLED_CODEX_MODEL_ID" \
  --prompt "Reply with exactly: gateway connected"
```

Test one continuation on the same connection:

```bash
cargo run -- generate \
  --auth-source pi \
  --model "YOUR_ENABLED_CODEX_MODEL_ID" \
  --prompt "Remember the word lantern and acknowledge." \
  --follow-up "What word did I ask you to remember?"
```

Test the ordinary function round trip:

```bash
cargo run -- tool-demo \
  --auth-source pi \
  --model "YOUR_ENABLED_CODEX_MODEL_ID"
```

The model is asked to call `add_numbers(17, 25)`. The client validates the finalized
call, computes `42`, and returns a `function_call_output` under its original
`call_id`. The demo requires exactly one completed direct call, no namespace, and arguments
exactly equal to JSON `{"a":17,"b":25}`. It checks one result with the original
call ID and JSON `{"sum":42}`. It requires completed ordinary message output text
that trims to `42`, without refusal or extra answer text. There is no forced tool
choice, and a missing tool or additional tool cycle fails acceptance.

These examples explicitly select Pi. The general CLI default remains Codex;
select `--auth-source codex` only when the operator chooses that source.
Use SSE explicitly by adding `--transport sse`. A WebSocket failure never silently
switches to SSE, as that can change continuation and execution semantics.

Read private prompts from stdin rather than shell arguments:

```bash
cargo run -- generate --auth-source pi \
  --model "YOUR_ENABLED_CODEX_MODEL_ID" --stdin < prompt.txt
```

After parsing, legacy `generate` reads the chosen prompt source, validates its
one-item input, validates any supplied follow-up separately, then validates the
actual session options before provider/auth construction. An invalid follow-up
prevents even the first generation. Existing stdin byte/UTF-8 checks and validation
errors remain; accepted input bytes are not trimmed. There is no combined quota
for the two requests. Validly parsed invalid operations exit 1 with empty stdout;
malformed legacy Clap syntax retains exit 2. This does not add S1/S2 preparation
to legacy commands.

`--json` emits NDJSON. **This includes native provider items and opaque continuation
material and must be treated as sensitive application data.** Normal text mode
prints exposed text/refusal content, not reasoning summaries. Legacy `generate`
and `tool-demo` use the same multiline answer policy as `wi run`, including deltas,
terminal-only text, suffixes and labelled authoritative fallback. Filtering is
stateless across fragments; escape-sequence payload characters can remain visible.
Raw prefix comparisons, returned responses, JSON and writer errors are unchanged.
Final response text is authoritative. Both modes treat streamed output as provisional. If a completed
effective output omits or conflicts with streamed nonempty text/refusal or finalized
message/function-call output, the adapter rejects before settlement or successful terminal publication, and the
CLI exits nonzero before tool execution or follow-up. Recovery and consistency
validation belong to the provider adapter, not the CLI.
Terminal-only responses and matching text prefixes with terminal suffixes remain valid.
The guard compares streamed parts by item identity and content index, not their
combined arrival order. Valid interleaving remains valid; text mode prints a labelled
terminal response when arrival order is not a prefix of terminal text.
The per-request guard charges every item event's serialized bytes, including duplicates,
and the separate rendered-text copy against a cumulative 1 MiB. It permits at most 4096 events, 512 finalized occurrences, and item/content
indexes below 512. Private retained text copies are each bounded by 1 MiB; finalized
native items share the cumulative byte budget. All adapter consistency tracking resets at each request.
Conflicting identities or finalized native content fail closed, even if only metadata differs.
The shared decoder rejects empty created and terminal response IDs before publishing
an invalid start/finish or settling conversation state. Nonempty IDs remain opaque,
without trimming or a new format rule. Post-send WS/labelled-SSE rejection is
`protocol_error` with unknown upstream outcome. Missing-MIME SSE rejects an invalid
first identity earlier as `unexpected_content_type`; that distinction is unchanged.
See [event identity rules](docs/EVENTS.md#native-mapping).

```bash
cargo run -- capabilities
cargo run -- generate --help
```

The separate [two-turn library example](examples/two_turns.rs) shows direct use
without coupling the library to Clap or a web framework. That example explicitly
uses Codex credentials, not the handoff's selected Pi source. It prints response
text and IDs and is not a sanitized acceptance helper.

## Cancellation, failures, and limits

`SessionControl::close()` and Ctrl+C interrupt local transport and close the whole
session. They do **not** guarantee that provider computation stopped. There is no
in-place reconnect or response replay after an uncertain failure.

Dropping the event receiver also closes its session, even if it was never polled.
This provider receiver is a runtime-owned stream; a future browser connection
should observe the runtime's own event store, not own this receiver directly.

Terminal response output is not equivalent to the whole agent task completing.
Function calls are selected only from a finalized completed response. Truncated,
unknown, namespaced, or programmatically owned calls cannot execute in this demo.
Argument fragments are never parsed into executable commands during streaming.

Retained Wi-local protections include a 15-second connection timeout, 90-second
provider-event idle timeout, 10-minute request lifetime, 30-second event-consumer
stall limit, 64 queued events, 8 MiB per incoming frame, 32 MiB per response, and
8 MiB / 2048 items of retained context. They also include 32 declared tools and
128 input items per request. These are request, parsing and history protections,
not whole-run quotas or asserted provider requirements. The fixed CLI demo accepts
exactly one call. Context limits fail explicitly; there is no implicit compaction.

Both transports connect directly; HTTP/SOCKS proxy support is not included.
Redirects and automatic retries are disabled. Production endpoints are fixed
inside the subscription adapter; only unit-test builds can target loopback servers.

## Compatibility and boundaries

This is a compatibility integration with the Codex subscription backend, **not**
an API-key request to the public `/v1/responses` endpoint. OpenAI's public feature
schema is not a promise that every feature is available on this endpoint, for this
account, with a particular model. See [sources](docs/SOURCES.md).

In-memory transcripts and cached tool results are not a durable operation log and
do not guarantee exactly-once external effects after a crash. No billing estimate
is computed from API prices for subscription traffic.

See [architecture](docs/ARCHITECTURE.md), [events](docs/EVENTS.md), and
[migration notes](CHANGELOG.md) for the deliberate 0.1 → 0.2 contract change.
