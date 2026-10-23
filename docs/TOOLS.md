# Tools and workspace context

The available built-in tools are catalog-bound `load_skill` and optional `add_numbers`. No general file read/edit/write or shell executor is implemented.

## Context preparation

Library callers supply explicit workspace and global roots. The service uses configured roots. The diagnostic CLI resolves its global skill root from absolute XDG_CONFIG_HOME or HOME and its workspace from `--workspace` or the working directory.

Discovery includes valid global metadata and project metadata under `<workspace>/.agents/skills`. Scoped IDs such as `global:review` and `project:review` remain distinct. Neither silently overrides the other. `AGENTS.md` is loaded only from the selected workspace root during preparation, not recursively from ancestors or nested directories.

Unselected skill bodies are not added to the initial prompt. Explicit `--use-skill` selections include bodies immediately. A nonempty context-aware catalog automatically registers `load_skill`; an empty one does not.

Prepared context keeps the original task and caller instructions. Framed project/skill material is not promoted to higher-priority application instructions and cannot grant tool or credential authority. Discovery diagnostics and unavailable/unsafe sources remain explicit.

## Main skill loading

`load_skill` takes exactly `{ "id": "project:name" }` or a valid global scoped ID. Full-batch preflight checks authority, identities, definitions, schema, and arguments before any effect. Execution uses the captured catalog/source identity and revalidates metadata. Body-only changes can be observed by a new call under those checks; changed frontmatter is not silently accepted.

The result contains `id`, `frontmatter`, and `body`. It does not load referenced resources, execute scripts, follow URLs, install packages, or register more tools.

The existing 1 MiB file/input safeguards and 64 KiB serialized tool-result boundary apply at different stages. A selected body may fit initial context but exceed the tool's serialized result capacity. No truncated successful result is fabricated.

## Results, reuse, and history

`ToolFailed` serializes as `gateway_error`, not `tool_failed`. Oversized serialized output uses `tool_output_limit`. The real `is_error` flag is preserved separately; successful JSON containing an `error` key remains success.

Results are cached per run/call identity. Reusing the same call and arguments returns the recorded result without another load/effect. Changed arguments under that identity conflict. Separate runs have separate execution caches.

Provider replay and browser history consume saved original results. They do not reread a changed/deleted historical skill source. Current context preparation for a new task is separate from replay of an old result.

Tool execution remains sequential. Cancellation is cooperative and cannot roll back completed effects. There is no fixed total tool-call quota or whole-task deadline.

Sources: [`src/context`](../src/context), [`src/tools.rs`](../src/tools.rs), [`run_cli.rs`](../src/cli/run_cli.rs), and [architecture](ARCHITECTURE.md).
