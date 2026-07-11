# ADR-0009: Use a host-unrestricted filesystem policy for the personal installation

Status: Accepted, implementation deferred until real filesystem tools  
Date: 2026-07-11

## Context

The user deliberately asks coding agents to access files outside the current project directory. Treating the active project as a hard sandbox boundary would prevent legitimate personal workflows.

At the same time, exposing Wi's own API keys, OAuth tokens, browser-session secrets, and live internal databases to generic model tools would create unnecessary credential and integrity risk.

## Decision

The personal Wi installation uses:

```text
filesystem_policy = host_unrestricted
```

The active project root is:

- the default working directory
- the default context root
- the source of project instructions
- the project associated with project-scoped services

It is not a hard containment boundary.

Generic future tools may access other host paths when requested.

## Protected Wi internals

Generic model tools must not read or directly mutate:

- OpenAI API keys
- OAuth access/refresh tokens
- browser-session secrets
- credential-encryption keys
- temporary OAuth authorization material
- credential-vault storage
- live Wi catalog/session database files through generic file tools

Dedicated Wi APIs manage session export, backup, and maintenance.

This is a narrow protection for Wi's own trust root, not a general project sandbox.

## Observability

Every path-based tool records:

- requested path
- resolved absolute/canonical path
- working directory
- whether it is outside the active project
- pre/post hashes for mutations when applicable

The browser may display an outside-project indicator without blocking ordinary use.

## Destructive actions

Filesystem reach and approval policy are separate.

A trusted personal profile may allow ordinary reads, edits, and commands while still requiring confirmation for narrowly defined highly destructive operations.

`AGENTS.md` and model instructions guide behavior but are not treated as a security boundary.

## Consequences

Positive:

- preserves the user's existing cross-directory workflows
- project services still have a clear default scope
- avoids pretending a project-root check is a complete sandbox

Negative:

- a mistaken model action can affect broad host storage
- tool policy, logging, hashes, backups, and approvals become more important
- Wi must carefully isolate its own secrets and live state

## Alternatives considered

### Strict project-root sandbox

Rejected for the personal installation because it conflicts with deliberate outside-project tasks.

### Completely unrestricted access including Wi credentials

Rejected because model/tool access to the authentication trust root is unnecessary and dangerous.

## First-slice boundary

No real file-reading, file-writing, shell, or host-unrestricted tool is implemented in the first vertical slice. The ADR fixes the later policy so the foundation does not assume project-root confinement.

## Validation for the later tool milestone

- outside-project access succeeds when requested
- paths are canonicalized and recorded
- Wi credential paths are blocked
- generic tools cannot mutate live Wi databases
- stale-write/hash conflict checks operate across any host path
