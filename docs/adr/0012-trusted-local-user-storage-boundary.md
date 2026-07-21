# ADR-0012: Treat the local operating-system user as trusted

Status: Accepted

Date: 2026-07-22

## Context

Wi is a local, single-user application. The Milestone 7 catalog review used an adversarial same-user process that repeatedly renamed `WI_HOME`, replaced database files, and substituted symlink ancestors during synchronous SQLite startup boundaries.

Pathname metadata checks can detect many substitutions but cannot eliminate every time-of-check/time-of-use or ABA race. SQLite opens WAL, SHM, journal, and temporary files through its VFS, sometimes lazily. Defending those operations against a hostile process with the same user permissions requires an OS-native, handle-relative guarded SQLite VFS or equivalent native storage component.

A process running as the same operating-system user can already read and modify Wi's private files and interfere with the Wi process. Adding a custom native VFS solely to resist that actor is disproportionate for the v0.1 local application.

## Decision

The local operating-system user and other processes running with that user's authority are trusted for Wi v0.1.

Wi does not claim to defend `WI_HOME` against an actively hostile concurrent same-user process that deliberately times path, ancestor, DB, WAL, or SHM substitution during startup or runtime.

Wi still must:

- fail closed on catalog corruption or uncertain storage classification;
- avoid automatic pathname-based quarantine, deletion, overwrite, or replacement of corrupt catalog/session evidence;
- reject static symlinks and noncanonical session paths at documented discovery/open boundaries;
- detect substitutions visible to existing pre/post identity checks;
- preserve canonical DB/WAL/SHM evidence during ordinary corrupt classification;
- keep startup errors bounded and redact canonical/probe paths;
- recover correctly from crashes, partial writes, missing catalogs, and non-adversarial filesystem failures.

The deterministic post-callback and ABA substitutions recorded in Milestone 7 remediation 17 are accepted residual risks under this trust boundary. They are not product-supported concurrency behavior and do not require a native VFS in v0.1.

## Consequences

Positive:

- the storage design matches Wi's actual local single-user deployment model;
- Milestone 7 can close without a bespoke cross-platform/native SQLite VFS;
- existing non-destructive corruption handling and realistic crash recovery remain required.

Negative:

- a malicious or compromised process running as the same user can redirect or mutate Wi storage;
- filesystem identity checks are defense-in-depth, not a security boundary against that actor;
- multi-user, sandbox-hostile, or remote deployment remains unsupported.

## Alternatives considered

### Guarded native SQLite VFS

Rejected for v0.1. It would need to pin directory identity and enforce handle-relative behavior for main databases, WAL, SHM, journals, temporary files, and missing-file creation. It would add native platform code and a significantly larger maintenance/security surface.

### Continue adding pathname checks

Rejected. Additional checks only move or narrow the race and repeat the H1 remediation cycle without closing the underlying invariant.

## Validation

- architecture and recovery documentation state the trusted-user boundary explicitly;
- review ledgers classify hostile same-user TOCTOU/ABA probes as accepted residual risk rather than silently claiming they are impossible;
- cumulative H1 regressions for ordinary corruption, static links, visible substitutions, evidence preservation, and bounded redacted errors remain required;
- remote or multi-user deployment stays explicitly excluded from v0.1.
