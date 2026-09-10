# Wi S1 — workspace context and local skills

Contract **s1.0**. Status: **PLAN ONLY; implementation and verification NOT RUN**.
Prepared 2026-09-11. Runtime baseline `b33ca4bb1cdf8ae58da8d83123b87956535d6a2c`.
Governing product decisions: [WI_PRODUCT_DIRECTION.md](WI_PRODUCT_DIRECTION.md).
Required acceptance: [WI_LOCAL_SKILLS_S1_MATRIX.md](WI_LOCAL_SKILLS_S1_MATRIX.md).
The implementor follows [WI_LOCAL_SKILLS_S1_PROMPT.md](WI_LOCAL_SKILLS_S1_PROMPT.md).

## 1. Outcome and scope

A caller can prepare a task for an explicitly resolved workspace. Wi loads the
root project instructions when present, discovers global skill frontmatter on
every preparation, includes project frontmatter when present, and loads bodies
only for explicitly selected skills. The shared Rust preparation result feeds the
existing run controller. A non-CLI caller receives the same behavior.

S1 also removes the unused HostedSkills/hosted_skills feature surface. It does not
implement uploads, API-key billing, hidden hosted fallbacks, a file/shell executor,
model-selected loading, persistence, a service, or a GUI. Global/project discovery
is automatic within the selected roots; full-body activation remains explicit.
Do not advertise a model loading tool that does not yet exist.

This planning PR changes documents only. Once assigned, the local implementation
task authorizes its specified code/tests/docs and OFFLINE checks. No actual user
skill-directory inspection, credential reads, auth/profile commands, logins,
refresh probes, provider generations, hosted API calls, commits/pushes/merges or
publication. Use synthetic temporary roots and existing trusted tooling. The
31/50 ledger stays unchanged. C1 remains closed; no run quotas/timers return.

## 2. Source basis versus Wi decisions

The Agent Skills specification defines YAML frontmatter plus a Markdown body in
SKILL.md, required name/description, optional metadata, and progressive disclosure
of metadata, instructions, and resources. Pi's pinned v0.85.1 skills documentation
shows both global/project discovery and explicit invocation; its loader tolerates
name/directory mismatches and supports more discovery sources than S1. The user's
Pi/Codex reports place resource/context preparation above provider execution.

These sources support the separation, not every policy below. Wi-specific choices
are the XDG path, scoped IDs, duplicate handling, root-only AGENTS.md, restricted
file traversal, prompt framing, and CLI spellings. They are stated explicitly to
avoid silently importing behavior from another harness or inventing a universal
compatibility claim. Required name/description length rules below come from the
format; do not turn optional recommendations on body length into runtime quotas.

References checked during planning:
- https://agentskills.io/specification
- https://github.com/earendil-works/pi/blob/v0.85.1/packages/coding-agent/docs/skills.md
- https://github.com/earendil-works/pi/blob/v0.85.1/packages/coding-agent/src/core/skills.ts
- https://developers.openai.com/api/docs/guides/tools-skills (hosted/local distinction only; no capability test)

Current Wi anchors: `src/provider.rs` already has SessionOptions.instructions;
`providers/openai_codex/state.rs` already puts it in the provider request;
`src/run_cli.rs` already calls the library controller. Build on those paths, not a
second prompt/model loop. Current managed store uses a Wi XDG directory; S1 must
not import or invoke its auth manager to resolve the unrelated skills directory.

## 3. Roots, trust, and discovery

### 3.1 Roots and environment ownership

The reusable API accepts an explicit existing absolute workspace root and an
explicit absolute global skills root. The library never calls current_dir(), reads
HOME/XDG_CONFIG_HOME, or changes the process working directory implicitly. Paths
are host-selected inputs, not model-supplied strings or future web-client authority.

CLI resolution only:
- `--workspace PATH` selects the workspace. If omitted, resolve the CLI's current
  directory once. Relative CLI paths resolve once against that directory.
- Global skills: `$XDG_CONFIG_HOME/wi/skills` when XDG_CONFIG_HOME is nonempty and
  absolute; otherwise `$HOME/.config/wi/skills` when HOME is nonempty and absolute.
  A nonempty relative XDG_CONFIG_HOME is an error, not silently another root.
- Missing home/config information is an explicit preparation error. Tests supply
  isolated values. There is no global-disable flag or silent omission of a failed
  global root. The library can be called with explicit roots without environment.
- A nonexistent global or project skills directory means an empty scope; no
  directory is created. Existing unreadable/wrong-type roots are errors.
- Project skills: `<workspace>/.agents/skills` only. No upward Git/home traversal,
  `.pi`/`.codex` import, user-wide `.agents` scan, settings crawler, package loader,
  watcher, network lookup, installer, or database in S1.

The owner trusts the global root and explicitly opens the workspace. Selecting a
workspace permits reading its root AGENTS.md and the skill files under its named
skills root, not arbitrary repository data. Future service code must resolve an
authorized workspace ID to these host paths; never expose raw path loading as an
unauthenticated network operation. S1 itself adds no HTTP endpoint or auth UI.

### 3.2 Traversal

Resolve the trusted workspace/global roots once. If a caller-supplied root is a
symlink, canonicalize that root explicitly; it becomes the selected boundary.
Descendant symlinks, including `.agents`, skill-directory links, SKILL.md links,
and AGENTS.md links, are not followed. Diagnose skipped skill links. A linked
project root AGENTS.md is a preparation error rather than silently missing policy.
Use a deterministic iterative walk sorted by relative UTF-8 path. Do not recurse
below a directory containing SKILL.md, even when that file is malformed; it is a
skill package boundary. Ignore non-SKILL Markdown files and supporting resources.
Root-level SKILL.md is permitted if it passes normal metadata validation. No
arbitrary recursion-depth/skill-count quota is introduced.

Before reading, verify containment under the resolved root and regular-file type.
Use the project's existing platform facilities for no-follow/nonblocking final
opens where available so FIFOs/devices and last-component swaps are not read as
files. On platforms without equivalent checks, fail closed for known links/special
files and document the race limitation. Owner-controlled local roots are the trust
assumption; S1 is not a hostile-filesystem sandbox or hardlink-isolation boundary.
Do not claim that canonicalize-then-open alone eliminates TOCTOU. No generalized
filesystem security framework is requested.

An unreadable traversal directory is an error; a successfully located malformed
skill gets a diagnostic and is excluded. Valid unrelated entries still load.
This prevents silent partial discovery caused by inaccessible directory trees.
Diagnostics must be returned by the library and shown by the CLI before a run.

## 4. Catalog, frontmatter, identities, and loading

Each entry has `SkillId { scope, name }`, with scope Global or Project. Its external
spelling is `global:<name>` or `project:<name>`. The catalog preserves both entries
when a project and global skill share a name. There is no shadowing or silent
project override, because global metadata must always remain available.

Within one scope, duplicate names from different files make discovery fail with
an ambiguous-skill diagnostic; never select a winner by traversal order. Listing
and rendering order is global entries by name, then project entries by name.
CLI selection requires qualified IDs; no ambiguous short-name convenience mode.
Duplicate selections of the same ID activate it once at its first selection
position. Caller selection order is otherwise preserved.

Read frontmatter at the start of SKILL.md, with optional UTF-8 BOM and LF/CRLF
handling. Require opening and closing `---` delimiter lines. Metadata discovery
stops at the closing delimiter: do not parse, retain, send, or deliberately scan
all unselected bodies. Buffered I/O may read ahead internally; do not claim zero
physical body bytes were fetched. Read full content only for explicitly activated
entries. A body with no substantive instructions is invalid on activation.

Use a real YAML parser, not ad-hoc splitting of key/value lines. Permit quoted and
block strings, comments, and JSON-compatible scalar/sequence/mapping values for
unknown fields. Top-level keys must be unique strings. Reject multiple documents,
custom tags, merge keys, and aliases/anchors rather than expanding arbitrary YAML
objects. This is an explicit parsing subset, not full general YAML support.
One maintained YAML parser dependency and its necessary transitive dependencies
are allowed; choosing a compatible parser/version is an implementation detail,
not permission to add a templating/plugin framework. Lock and document the choice.

Require:
- name: string, 1..64 ASCII lowercase letters/digits/hyphens, no leading/trailing
  or consecutive hyphens;
- description: nonblank string, at most 1024 Unicode scalar characters.
Preserve validated name and description exactly; do not normalize their contents.
A directory-name mismatch is a diagnostic, not exclusion, following the explicitly
chosen Pi-compatible behavior. Optional standard fields retain their defined
scalar/map shape; compatibility, if present, is a nonblank string of at most 500
characters. Optional metadata is a string-to-string map. Unknown fields remain
frontmatter data with no effect on tool authority, selection, or system behavior.

Retain all valid frontmatter in a JSON-compatible representation. Every valid
entry's frontmatter is supplied in the catalog context, not just selected entries.
Keys such as allowed-tools or a nonstandard disable-model-invocation do not grant
permissions, hide global entries, install dependencies, or change supported
features in S1. Return an informational diagnostic for unsupported behavioral
metadata; do not pretend to enforce it. Full feature parity with Pi/Codex is not
claimed. Values with embedded delimiters are data, escaped by the prompt composer.

A catalog holds metadata and private local source references, not unselected body
strings. Activation resolves an ID through that catalog, not an arbitrary path.
Re-read and validate the chosen file's metadata; if it no longer matches the
catalog, return context_changed and require a fresh discovery rather than combine
stale identity with new content. Body edits before activation can be picked up;
after preparation, the loaded bytes are fixed for the run. No mid-run filesystem
reads, polling, reloads, or provider session changes are added.

## 5. Shared Rust API and instruction composition

Add `pub mod context` (a single file or small private submodules is sufficient).
Use two reusable synchronous filesystem functions:

```rust
pub struct ContextRoots {
    pub workspace: std::path::PathBuf,
    pub global_skills: std::path::PathBuf,
}

pub fn discover(roots: ContextRoots) -> Result<SkillCatalog, ContextError>;

pub fn prepare_run(
    request: wi::run::RunRequest,
    catalog: &SkillCatalog,
    selected: &[SkillId],
    tools: &wi::tools::ToolRegistry,
) -> Result<PreparedRun, ContextError>;
```

Within the wi crate use crate:: paths. `SkillCatalog` exposes a read-only metadata
list plus diagnostics and retains private resolved roots/source references.
`PreparedRun` exposes the prepared RunRequest and a small provenance manifest of
which scoped IDs and project-instruction source were included. No new RunRequest
field, provider/session option, skill registry service, trait hierarchy, scheduler,
serialization of local handles, or application session ID is introduced.

The API reads only explicit roots. The async CLI calls the synchronous read/parse
work through one spawn_blocking preparation task; this is filesystem work, not a
detached model task. Tests call the library directly. An async future service can
use the same boundary. Public input DTOs intended to cross a service boundary must
not contain privileged host paths; that boundary is designed in V1, not here.

Root project instructions: `prepare_run` reads only `<workspace>/AGENTS.md` when
present. No ancestor, nested, override, global AGENTS, SYSTEM.md, or instruction
hierarchy is implemented. Regular UTF-8 text is included once; empty file has no
instruction effect. Existing but unsafe/unreadable/invalid text fails preparation.
This root-only rule is a stated S1 subset; later file-scope instructions require a
separate coding-tool requirement.

Effective input:
1. Keep the caller's task bytes unchanged as the task field.
2. Keep the caller's existing SessionOptions.instructions text unchanged as the
   prefix of the effective instructions. Do not replace it with a new generic Wi
   coding persona that advertises tools Wi does not have.
3. When project content, catalog entries, or selected skill bodies exist, append a
   short fixed framing instruction explaining the prepared user payload below.
   Its required meaning: the task is the user's request; project and skill entries
   are user-selected context, not permissions or executable configuration; only
   actual registered tools are available; catalog metadata does not imply a loader
   tool exists; in S1 only explicitly selected bodies are active. This is framing,
   not a prompt template language or security guarantee about model behavior.
4. Use deterministic JSON encoding for one initial user payload with fixed keys:
   `task`, `project_instructions` (null or `{source:"project:AGENTS.md", text}`),
   `available_skills` (all scoped IDs and parsed frontmatter), and
   `active_skills` (selected IDs, frontmatter, and Markdown body in selection order).
   Use canonical/sorted mapping-key output; JSON escaping prevents file contents
   from syntactically closing a made-up wrapper. It does not solve prompt injection.
5. Do not put project/skill body text directly into the higher-priority instruction
   field. Do not send canonical host paths; only scoped IDs/relative source labels.
6. With no applicable project instructions, no skills, and no selections, return
   the original request prompt and instructions byte-for-byte (no empty wrapper).

All global entries and all project entries remain in the prepared catalog for
that run, whether or not bodies are selected. Do not duplicate the catalog before
every provider request; existing context continuation retains it, and SSE replay
already resends the original context. The same instructions value remains fixed
for the existing provider session. Do not edit OpenAI request-building semantics.

Validate the prepared task with existing validate_input and the effective
SessionOptions including the actual tools.definitions(), before any provider or
auth construction. Return request.options.tools empty as required by the run API.
No new file-size/skill-count/runtime-budget framework. Use existing MAX_INPUT_BYTES
for bounded frontmatter/file reads that feed a prompt, and validate the complete
rendered inputs with current byte rules. Oversized mandatory catalog/project or
selected content fails explicitly; no silent metadata/body/task truncation or
partial catalog. Metadata-only scanning must not reject an unselected large body
merely because the full file's length exceeds a prompt bound; bound the portion
actually consumed. Use checked lengths, finite traversal, and sensible buffer
handling; this is not a universal RSS guarantee.

Errors use a context-specific type with static categories such as invalid_root,
read_failed, invalid_frontmatter, duplicate_skill, unknown_skill, context_changed,
and input_too_large. Attach only scope/relative diagnostic labels, never file
contents, credentials, raw YAML error snippets, or canonical private paths to
ordinary Display/Debug. Catalog metadata and prepared inputs are sensitive data:
redact Debug for content-bearing types. Explicit list/JSON output is intentional
user data, not harmless telemetry. Do not log complete prepared requests.

## 6. CLI is a library caller

Extend only `wi run` with:
- `--workspace PATH`, optional CLI convenience, default resolved cwd;
- repeatable `--use-skill global:<name>` / `--use-skill project:<name>`.

Add `wi skills list [--workspace PATH] [--json]`. It calls discovery only: no
prompt run, provider construction, credential manager, tool execution, model call,
project-instruction loading, or body activation. Plain output lists ID/name and
description; JSON exposes metadata/relative source labels and diagnostics only,
not bodies or canonical paths. Malformed individual skills are listed as
excluded diagnostics while valid entries remain; fatal root/duplicate errors
exit nonzero. Escape/filter terminal control characters in plain diagnostics.

The default global root is always resolved/scanned in both operations. No flags
are needed merely to discover global/project metadata. `--use-skill` selects full
instructions, not whether a catalog exists. These operations do not create global
folders, config files, databases, or registration records.

For `wi run`, complete existing CLI validation plus discovery/preparation and final
size validation before calling the provider constructor. New context failures must
show zero provider/auth opens. Diagnostics go to stderr, not NDJSON stdout; run
output retains existing schema2 with nested provider schema1. No new run event,
CLI background task, or second tool loop. Skills do not mutate the chosen model,
auth source/profile, tool registry, or required-feature list. Existing generate,
tool-demo, smoke, auth, and capabilities command semantics remain except the
hosted-skill removal below.

No flag removes all global metadata, no raw-path skill activation option, no
automatic model-selected body load, and no network-capable resource resolver.
Those would exceed the chosen contract. A user can edit files or choose a different
workspace between invocations; this does not require a watcher.

## 7. Remove hosted-skill scaffolding

Search actual source/callers before edits. Remove Feature::HostedSkills, its string
mapping `hosted_skills`, the OpenAiCodexProvider advanced report entry, and dependent
active fixtures/tests/help/declarations. The current surface is unsupported
scaffolding, not a working uploader. If an unexpected upload path is found, report
it and remove only hosted-skill-specific code after confirming its callers.

A formerly serialized required feature `hosted_skills` must now reject as an unknown
variant before provider/auth work. Do not silently ignore it, map it to local
skills, leave a no-op compatibility alias, add a warning-only fallback, or create
another hosted/API-key provider. Note the focused API/config compatibility change.
Keep provider event schema1 and run schema2; removing an unsupported feature option
is not justification to rewrite unrelated event formats. Other requested future
features remain explicitly unsupported; generic unknown-item retention stays.

Active roadmap docs say hosted skills are out of scope by user choice. Preserve
historical mentions and reports without rewriting past statements. Do not add
Wi local skills to the provider capability enum: this feature belongs above all
providers, not to OpenAI's hosted API support.

## 8. Implementation work packages and gates

A. Record HEAD/worktree, inspect source/test surfaces, and run isolated baseline
   gates. Current reported comparison: 260 Rust tests, 152 Node self-tests.
B. Add library roots/discovery/catalog parsing and deterministic tests. Do not read
   actual user globals or projects; fixture roots are explicit.
C. Add activation, root-project context, framing, final validation, and independent
   provider tests. Keep pipeline preparation outside run/mod.rs.
D. Add thin CLI commands/options, default-path resolution, cancellation-safe caller
   integration, and an offline example using temporary skill/project files.
E. Remove hosted-specific scaffolding and update active docs/help. Preserve C1,
   auth, transport, consistency/recovery, test oracles and historical evidence.
F. Execute every matrix row; obtain independent complete-diff review, fix confirmed
   in-scope findings, rerun affected and full gates, and write new S1 reports.
   A real contract contradiction is a blocker to report, not a license to redesign.

Expected paths: new src/context.rs or src/context/*, src/lib.rs exports,
src/run_cli.rs and new skills CLI adapter, src/main.rs routing, focused tests,
examples/skills_offline.rs, Cargo.toml/lock for a justified parser, active docs.
src/provider.rs and providers/openai_codex/mod.rs change only for hosted-feature
removal. No auth/storage/provider-wire/codec/run-controller/tool-executor changes
except unavoidable test adaptation for the removed enum variant. New context code
may call existing validation; it must not weaken its thresholds or semantics.

Run the six Cargo gates, uv run scripts/verify.py, the Node self-tests, both existing
and new offline examples, and git diff --check. Isolate HOME/XDG_CONFIG_HOME and
CODEX_HOME while preserving trusted Cargo/Rustup caches. No real profile status
command or live generation belongs to an offline gate. Keep original tests; update
expectations only for the named API removal or new automatic context preparation.
Explicitly isolate CLI fixtures so the owner's real globals cannot affect tests.
No fixed new test-count target, no live test, no background implementation promise.

Create docs/WI_LOCAL_SKILLS_S1_VERIFICATION.md and
 docs/wi-local-skills-s1-verification.json after observed verification. Required
fields and evidence matrix are in the matrix document. Mark incomplete work as
partial/blocked; baseline passes are not new evidence. Stop after the report and
leave implementation uncommitted unless the user separately authorizes Git writes.

## 9. Deferred requirements remain visible

S2 implements model-selected skill loading and any approved resource reads. The
metadata catalog here is its input, not an already working loader. S1 skills can
provide instruction-only workflows using supplied task data and existing tools;
references to missing executors do not make those executors available.

P1 separately designs persistent application sessions/history. V1 follows that
contract: one owner/multiple devices; browser disconnect is not cancellation;
service restart does not auto-resume/restart work. No storage implementation or
persistent-session claim is made by S1's transient context snapshot. See the
product-direction document for requirements; do not introduce a speculative store
trait or pretend the current ProviderSession is a saved user session.
