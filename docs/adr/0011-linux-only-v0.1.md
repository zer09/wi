# ADR-0011: Support Linux only in Wi v0.1

Status: Accepted

Date: 2026-07-22

## Context

Wi v0.1 is a local browser-based coding-agent harness for one operating-system user. Milestone 7 added native Windows process-tree ownership, directory-junction tests, and a required Windows process CI job even though the original Milestone 7 deliverables did not require Windows and the intended installation runs on Linux.

Maintaining two process-ownership implementations adds a Win32 FFI dependency, preload protocol, Job Object lifecycle, platform-specific exit semantics, native CI, and duplicate path-link test branches. This work does not improve the intended Linux installation and complicates recovery changes.

## Decision

Wi v0.1 supports Linux only.

- The production server entry point fails before constructing storage workers when `process.platform !== "linux"`.
- Process-tree ownership uses detached Linux process groups plus the inherited owner-pipe watchdog.
- Filesystem containment tests use Linux directory symlinks.
- CI runs checks, process tests, and browser E2E on Linux.
- Windows Job Object code, Windows preload code, Windows-only fixtures/tests, the Koffi dependency, and the required `windows-process` CI job are removed.

Supporting Windows or macOS later requires a new ADR, a security review of the expanded platform boundary, and a dedicated implementation/release gate. It must not be inferred from Node.js portability alone.

## Consequences

Positive:

- one production and test process-ownership model;
- no Win32 FFI dependency or Job Object lifecycle;
- fewer platform-conditioned tests and exit shapes;
- Linux recovery behavior receives the complete release-gate focus.

Negative:

- the Wi v0.1 server intentionally refuses to start on Windows and macOS;
- prior Windows support and CI evidence no longer describe the supported product;
- restoring Windows support later requires explicit design, implementation, and native CI work.

## Validation

- server configuration unit tests accept Linux and reject Windows/macOS;
- the complete Linux process suite covers graceful signals, forced termination, owner death, direct-leader exit, descendant reclamation, and symlink containment;
- CI's aggregate required job depends on Linux checks and Linux browser E2E only;
- dependency tests and the lockfile contain no Koffi production/test-support dependency.
