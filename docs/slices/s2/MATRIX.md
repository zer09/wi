# S2 acceptance matrix

Contract: **s2.1**. Runtime baseline:
`94d86e0c9db62d9fec208a26f5b4bb2487bcb5fa`.
Status of every row: **NOT RUN**. This is a fixed implementation/test contract,
not evidence that S2 exists. Read [CONTRACT.md](CONTRACT.md) first.

s2.1 corrects s2.0's erroneous tool_failed wire expectation to the existing
**gateway_error** mapping. It also makes preserved boundary semantics explicit.
All 24 IDs and the feature scope remain unchanged. [VALIDATION.md](VALIDATION.md)
records source-to-contract review; it is not a substitute for implementing or
running these acceptance cases. Do not change src/error.rs or existing error
assertions to satisfy the superseded wording.

## Required acceptance rows

### S2-00 — Baseline, scope and preservation

Record actual HEAD/worktree, initial user changes, toolchain/OS and accepted merge
baseline. Inspect AGENTS.md, S1/MR reports, current source and verification scripts.
Run the isolated baseline gates before edits. Preserve C1 deletion, auth behavior,
organization and historical documents. No real data/credentials or provider traffic.
PASS requires separate actual baseline results, not pasted old totals.
A previous same-source baseline run may be attributed and retained; do not count
it as S2 execution or relabel the reported assignment_conflict as an implementation
failure. Record the corrected contract revision used for resumed work.

### S2-01 — One shared loader, not duplicated reads

Implement context::load_skill and private-field LoadedSkill as specified. S1
prepare_run uses the same validated lookup/read path and keeps existing behavior.
Test valid global/project loads and direct invalid SkillId construction. No provider,
CLI, environment or credential dependency is required by the library operation.
Existing S1 tests pass without weakening assertions. In particular, preserve
all-selected-ID validation before AGENTS.md/body I/O; a later invalid/unknown
selection must not become masked by an earlier selected-file read failure.

### S2-02 — Same-name scopes and metadata-bound identity

A catalog with global:review and project:review loads each correct body and full
frontmatter. Directory/name mismatch behavior remains S1's documented behavior.
Bare names, unknown scopes, URL/path-like strings, non-catalog IDs and directly
constructed invalid names cannot select a source. No cross-workspace lookup.

### S2-03 — Strict ordinary function definition

The actual registered definition is load_skill, strict, with exactly one required
string id and additionalProperties:false. Its description states main instructions
only. No hosted/native-search/programmatic/async fields, tools-in-enum catalog
copy, body content or absolute paths enter the definition. Unknown/missing/wrong-
typed/null/extra argument fields fail local validation even if the server ignored
strict mode. All public Tool entry points defensively validate input.
Direct invalid execute calls return InvalidToolArguments, not an Ok error-shaped
Value. Do not infer a serialized category from the Rust variant's spelling.

### S2-04 — Pure full-batch preflight

After constructing the catalog, remove a source file. A valid ID's Tool::validate
still succeeds without reopening it; execution fails as a normal tool result.
In a mixed response containing add_numbers plus a malformed or unknown load ID,
preflight rejects the whole batch before any new execution, body read, cache entry
or successful tool event. Preserve unsupported caller/namespace/incomplete-response
and duplicate/conflicting-call protections with the loader present. This is a
preflight Err, not a per-call gateway_error result or ToolExecutionFinished event.

### S2-05 — Lazy successful result through the real registry

From an unselected catalog entry, execute a real complete function call via
ToolRegistry. Assert returned output parses to exactly id/frontmatter/body,
original Markdown text is preserved, nested metadata ordering is deterministic,
call_id linkage is correct, and existing start/finish events report success.
Do not substitute a directly fabricated tool-result Value for this acceptance.

### S2-06 — Changed frontmatter and execution errors

After discovery, alter or corrupt the selected frontmatter. Load fails with the
existing ContextErrorKind::ContextChanged at the public loader. Direct Tool execute
maps the load failure to GatewayError::ToolFailed. Through the ACTUAL registry,
assert a correlated output parsing to exactly:

```json
{"error":{"code":"gateway_error"}}
```

Assert ToolExecutionFinished has the same call_id and is_error=true; that boolean
is on the event, not added to the result JSON. Also cover missing/unreadable
manifest, empty body, non-UTF-8 body, oversized whole file and worker-join failure.
Use deterministic synthetic worker-failure injection for the join path; no runtime
hook/API is required. No file contents, host paths, OS strings or parser excerpts
escape in model errors or ordinary Debug. No automatic rediscovery/retry occurs.
The model may consume the error in the next normal request; do not require an
automatic failed run or fabricate a successful load. Keep the existing
src/tools/tests/execution_results.rs and tests/run_support/tool_execution.rs
expectations unchanged, including gateway_error versus tool_output_limit.

### S2-07 — Body read timing and owned results

A body-only edit before a new execution can be read if metadata remains identical.
After the result is returned, edit/delete the source and prove delivered result
bytes do not change. Another distinct call ID can observe a later body-only edit.
Files added after discovery remain unavailable. No watcher or implicit refresh.

### S2-08 — Existing result reuse, no new body cache

Execute once, change/delete the file, and resubmit the same call_id/arguments:
assert the registry reuses the exact saved result and emits reuse without another
load. Cover saved gateway_error and tool_output_limit result reuse and conflicting
ID/argument rejection. Reuse emits ToolResultReused, not a fresh start/finish pair;
that reuse event has no is_error field. A separate run's fresh result scope
performs its own load. Do not add mutable global or per-skill activation/body
caches to make the test pass.

### S2-09 — Filesystem boundary preservation

Reuse the actual S1 SkillSource opening protections. Cover selected manifest and
ancestor replacement links, Windows reparse/junction handling as supported,
special files, and canonical selected-root isolation. Preserve narrow platform
guards from the MR repair: Linux owns the real invalid-byte fixture; applicable
Unix tests continue on macOS. No arbitrary I/O-error catch-as-PASS, security-test
deletion, or assertion of hostile-filesystem/hardlink isolation.

### S2-10 — No supporting-file or execution side effects

Put commands, resource references, URLs and allowed-tools metadata in a selected
skill. With an inaccessible supporting-resource directory and a synthetic network
listener, loading returns only SKILL.md text, opens no resource, starts no process,
connects to no listener, and registers no extra tool. Tool names/root/auth choices
cannot be changed by metadata/body text. This is instruction loading, not a skill
workflow-completion claim.

### S2-11 — Shared preparation plus registry pairing

The new helper returns PreparedRun and the matching registry, preserving the
original tool template and its result cache. Assert same captured catalog for
metadata and loader, ordinary tool definitions retained, original options.tools
must be empty, final validation includes actual definitions, and returned
options.tools remains empty. A supplied load_skill name collision with a nonempty
catalog fails before body loading/provider construction and does not replace it.
The controller still creates its own fresh cache from this registry. Observe run
results/events rather than expect the returned template's cache to be populated
by wi::run::run. Automatic registration must still pass existing configuration
checks; do not widen those checks to fit another definition.

### S2-12 — Nonempty and empty catalogs

For nonempty catalogs, load_skill is available without --use-skill or a new enable
flag, including global-only and global-plus-project cases. Empty catalogs add no
built-in definition or false loader instructions. S1 project AGENTS.md behavior
remains. With no context at all, the helper preserves initial request bytes.
Existing no-loader prepare_run remains behaviorally compatible.

### S2-13 — Initial prompt and truthful instructions

Assert caller instruction prefix and task unchanged. All metadata remains in
available_skills; only explicit bodies are initially in active_skills. The helper
that registers the loader appends actionable loader-enabled framing; direct S1
prepare_run does not infer it from an arbitrary tool name. Test delimiter/JSON
escaping without claiming prompt-injection immunity. Do not rewrite caller text
using substring replacement or inject bodies into higher-priority instructions.

### S2-14 — Explicit and model-selected paths coexist

Use --use-skill/library selected IDs alongside a nonempty catalog. Initial bodies
and selection ordering/deduplication remain S1 behavior. A model can load a
second skill, or explicitly request an already supplied body, with no new policy
restriction. ContextManifest remains initial preparation provenance; it must not
falsely become an automatically updated delivery ledger.

### S2-15 — Existing size boundaries and no truncated success

Exercise the current 1 MiB file/input safeguards and 64 KiB serialized tool-result
boundary with actual registry output, including JSON-escape overhead. A whole
file above 1 MiB fails loading first (InputTooLarge in the public loader, ToolFailed
from Tool execute, gateway_error/is_error=true from the registry). A loaded
id/frontmatter/body Value at exactly 64 KiB serializes successfully; ABOVE that
boundary the existing registry returns tool_output_limit/is_error=true, without
truncation. Use different fixtures for these two stages. Do not widen limits,
add paging/budgets/reservations or hide that some S1-explicit bodies are larger
than the S2 tool-result capacity. Combined next-input validation stays.

### S2-16 — Independent provider, public run path

A separate scripted Provider receives global/project metadata and a normal
load_skill definition with no initial unselected body. It requests one real load;
the actual returned registry supplies the result; the next model input has the
same call_id and expected body; final scripted completion follows. Use the public
preparation helper and wi::run::run, not a new or duplicated model loop.

### S2-17 — Load then perform an ordinary tool cycle

Three scripted model requests: load_skill -> a returned workflow -> add_numbers
-> its result -> final fixture answer. Verify ordered tool definitions/results,
request correlation and one provider session. A separate fixture returns a final
answer without loading any skill; it must not be forced into a loader call. The
production code must contain no exact example operands/answer or selection model.

### S2-18 — WebSocket and SSE continuation

Run S2's public preparation/tool/controller path against both existing loopback
transports with synthetic credentials. WebSocket second request uses the same
socket, parent response and only new result input; SSE replays complete effective
native history including the initial context and load result exactly as expected.
Retain existing recovery/provenance/consistency handling. The ordinary next model
request consumes the load result; forbid an additional classifier/selector call
outside that loop, not the required continuation itself. This is offline protocol
evidence, not a live pass.

### S2-19 — Cancellation and observer failure

Cancel before dispatch, while the loading future is pending via a deterministic
test-only barrier, and after a completed load before another call. Preserve M3/C1
terminal/cancellation ordering and no fabricated successful finish/result after
interruption. A blocking worker may complete its read but cannot publish/cache or
submit anything after its waiter is dropped. Separately, when execution already
returned and the registry cached the output BEFORE the finish observer failed,
that completed cache entry is not rolled back; later work still stops. Test sink
failure and pending-future drop without adding runtime deadlines, progress APIs,
custom executor pools, or source changes to the existing cancellation semantics.

### S2-20 — CLI and non-CLI integration

The actual wi run handler uses shared S2 preparation and the returned registry.
No --tool load_skill or activation enable flag. Existing explicit --tool and
--use-skill semantics remain; skills list stays metadata-only. Fatal preparation
errors happen before provider/auth construction. Discovery diagnostics still reach
the diagnostic sink even when preparation fails; they do not enter run NDJSON.
Test injected synthetic factory and process-level parsing, using current wrapper
targets/layout. A library example works with explicit roots and no ambient
environment; no subprocess CLI backend.

### S2-21 — Isolation, privacy and schema stability

Concurrent independent workspaces with the same project ID load only their own
source. Returned registry fresh scopes never consume another run's result cache.
LoadedSkill/catalog/tool Debug and static error outputs expose no raw bodies or
host paths. JSON tool/provider output is explicitly sensitive, not a logging mode.
No RunRequest change; run schema remains 2 and provider schema 1. Auth/store,
provider feature declarations, RunLimits deletion and existing wire policy remain.
GatewayError::code and existing consumers/expected categories remain unchanged.

### S2-22 — Offline example and current documentation

Add examples/skill_loading_offline.rs using temporary synthetic roots and a
scripted provider, actual helper, registry, and controller. Demonstrate absent
initial body, real local load and body in follow-up input, then final completion.
README/help/architecture/events describe automatic availability, model-selected
loading versus explicit selection, initial manifest semantics, read timing,
64 KiB result limitation, and supporting-resource exclusion. No invented live
model-adherence result. Preserve historical documents and add index links.

### S2-23 — Final gates, review and evidence

Complete all rows with named assertions and observed outcomes; run gates below,
obtain a fresh independent complete-diff review, remediate confirmed findings and
rerun. Preserve organization and production-provider DEFER decision. If the owner
later authorizes a commit/push, inspect every configured GitHub OS result at that
exact head; local Linux success is not native macOS/Windows evidence. Never disable
jobs or warning-denied Clippy to close acceptance. Mark unrun checks honestly.

## Execution gates

All verification uses temporary synthetic HOME/XDG_CONFIG_HOME/CODEX_HOME/workspace
and skill roots. Preserve trusted build caches; no real credentials or owner files.
Record actual toolchain/OS and commands, including the isolation strategy. No
runtime call/time budget may be introduced to stop a test; external test-watchdog
behavior and controlled fixtures are separate from product execution.

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

Keep Cargo.lock/dependencies unchanged unless a demonstrable contradiction is
raised for a contract amendment. No new dependency is needed for the described
operations. Do not inflate test totals by counting reruns as different tests.
Report executed/failed/ignored/filtered/platform-excluded counts separately from
the static test-definition inventory. Zero doctests is zero additional coverage.

## Future report contract

Create `VERIFICATION.md` and `verification.json` in this directory during actual
implementation, not as fabricated acceptance artifacts in the planning PR.

Markdown sections: verdict; tested revision/worktree; environment/isolation;
source changes and compatibility; actual commands and totals; S2-00..S2-23 row
mapping with named assertions and evidence; first failures and fixes; complete-diff
review and reruns; platform/CI status; remaining limits; authorization/ledger.

Machine-readable report must include at least:

```json
{
  "contract": "s2.1",
  "status": "NOT_RUN",
  "accepted": false,
  "baseline": "94d86e0c9db62d9fec208a26f5b4bb2487bcb5fa",
  "tested_revision": null,
  "tested_worktree_description": null,
  "environment": {},
  "commands": [],
  "matrix": [],
  "reviews": [],
  "ci": [],
  "live_started": false,
  "real_credential_reads": 0,
  "provider_generations": 0,
  "ledger": {"used":31,"cap":50,"remaining":19,"changed":false},
  "remaining_limits": []
}
```

There must be one distinct matrix entry for each of the 24 IDs, with status,
assertion/test names, observer, actual evidence and blockers. Fill actual values;
the example above is a schema scaffold, not current execution evidence. Accepted
means offline technical acceptance within the contract. Live model selection or
adherence stays NOT RUN. If a pre-push report records CI pending, later closure
must be a dated follow-up or linked observed result, not a rewritten earlier pass.

## Authorization boundary

No real auth/profile/login/renewal operations, provider generations, hosted probes,
private skill/project reads for verification, implementation commits/pushes/merges
or publication. Preserve 31/50 used, 19 remaining. Any later live or Git-write
permission must come from the owner explicitly; remaining balance is not permission.
