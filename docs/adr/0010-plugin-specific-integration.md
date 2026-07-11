# ADR-0010: Integrate plugins according to their purpose behind a common Wi contract

Status: Accepted, implementation deferred until the project-service milestone  
Date: 2026-07-11

## Context

Wi will use plugins and project services with different operational characteristics. A blanket rule that every plugin must run through the same mechanism would either weaken isolation or prevent efficient use of documented public library APIs.

The user's existing integrations illustrate two distinct patterns:

- CodeGraph works naturally as a project-scoped service using its public library API and shared index lifecycle.
- Context Mode works naturally as a lean selected-tool adapter with explicit project isolation.

## Decision

Standardize the Wi-facing contract, not every plugin's internal mechanism.

Every plugin/project service must integrate through common concepts:

- manifest and version
- explicit scope: global, project, or session
- tool definitions and runtime schemas
- permission/effect declarations
- cancellation and timeout behavior
- bounded progress/output events
- lifecycle start/stop/health
- diagnostic IDs and redacted logs
- run-time snapshot of plugin version and tool-schema hash

Allowed isolation mechanisms include:

```text
worker thread
child process
MCP/JSON-RPC service
trusted in-process adapter only when proven lightweight and safe
```

No plugin may perform uncontrolled blocking or CPU-heavy work on the main server event loop.

## CodeGraph direction

Use a project-scoped `CodeGraphProjectService`:

- public CodeGraph API only
- one shared service per canonical project root
- lazy open and synchronization
- deduplicate concurrent opens/syncs
- reopen if its on-disk database is replaced
- worker or isolated service execution
- focused Wi tool surface

All sessions for the same project may share that service.

## Context Mode direction

Use a project-isolated lean adapter:

- expose only selected tools needed by Wi
- validate with upstream schemas
- pass project context explicitly on every invocation
- avoid process-global project state crossing concurrent projects
- use one isolated worker/process per active project when necessary
- preserve upstream purpose: large-output execution/search rather than replacing all core tools

## Failure behavior

- plugin failure fails the affected tool call
- terminate/replace the affected worker or process when safe
- keep the Wi server and unrelated sessions alive
- never silently substitute a different plugin implementation
- hot upgrades apply only to later runs; active runs retain their version/schema snapshot

## Consequences

Positive:

- integrations stay aligned with upstream purpose
- efficient project-scoped services can be shared
- strong isolation remains available where needed
- future plugins may be implemented in any language

Negative:

- plugin supervisor supports more than one runtime style
- each integration requires an explicit design review
- trusted in-process use has a higher review burden

## Alternatives considered

### Force every plugin through MCP subprocesses

Rejected as a universal rule. MCP remains an option, but public library services may be more appropriate for some project-scoped integrations.

### Import all TypeScript plugins into the main process

Rejected because synchronous work, global state, crashes, and dependency conflicts could affect the web server.

### Expose every upstream tool automatically

Rejected. Wi exposes a deliberate allowlisted tool surface aligned with the plugin's purpose.

## First-slice boundary

No CodeGraph, Context Mode, MCP, or other plugin integration is implemented in the first vertical slice.

## Validation for the later plugin milestone

- project A plugin context cannot leak into project B
- shared CodeGraph service is reused only for the same canonical project
- plugin crash does not terminate Wi
- schema/version changes do not mutate active-run behavior
- plugin output and execution are bounded and cancellable
