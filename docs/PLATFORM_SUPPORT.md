# Current native-platform support

Owner decision: **September 20, 2026 (Asia/Manila)**. Applies prospectively to PR #9
and later work. This is a support-policy change, not an assertion that past Windows
verification passed or that all Linux/macOS functionality has live certification.

## Supported scope

Wi retains **Linux and macOS native builds and Cargo CI**. Native Windows backend
support and its CI job are withdrawn. The service's current signal implementation
uses Unix SIGINT/SIGTERM. First-party Windows reparse-point checks, Win32 final-open
flags, console-signal handling, Windows-only tests and child-launch compatibility
branches have been removed. Their Unix/portable counterparts remain.

A Windows browser may still access an authorized Wi service hosted on a supported
system. The browser OS is not the backend target. A Linux executable in WSL on its
private Linux filesystem is still a Linux execution; this does not certify Windows
mounted filesystems, native Windows binaries, new launchers or different auth paths.
Other native targets have no claimed support or CI certification.

Managed authentication keeps its accepted **Linux-specific private file-store**
implementation. macOS build/loopback success does not add a macOS managed-login or
renewal implementation, provider approval, or live entitlement. Public library
callers still inject their already-supported gateway. Do not solve an auth limitation
by silently choosing an external credential source, account, provider or billing mode.

## Preservation, not rewritten history

The original V1-B reports retain 38 PASS/2 PARTIAL and accepted=false at their tested
source. Only the native Windows subcases of V1B-03 and V1B-33 are now **withdrawn**.
Their remaining assertions still apply. Old Windows jobs, failures, partial rows,
source hashes and review stages remain historical observations. They are not the
current supported-platform list.

This dated policy supersedes Windows-support language in earlier general-reference
pages and frozen contracts, including prior filesystem/reparse/console descriptions.
Current README, V1-B API/security guidance and AGENTS point here. No old schema,
receipt, event, security or execution rule is superseded except the specified native
platform applicability. An archival source path can describe deleted platform code.

## Repository boundaries

Do not purge transitive `windows-*` packages or target metadata from Cargo.lock:
those are dependency-resolution facts, not first-party Windows support. Do not remove
portable standard-library code merely because it also works on Windows, negative
path-validation fixtures, `.windows()` slice iteration or synthetic environment
poisoning that prevents ambient credential reads. Do remove genuine first-party
Windows execution branches and Windows-only scripts/tests when found.

The existing CI must continue to run format, all-target check, all-target test,
warning-denied Clippy, build and doctests on **both Ubuntu and macOS**. No assertion,
Unix safety check or non-Windows job is weakened to obtain a pass. Native-support
withdrawal does not add a runtime quota, deadline, fallback or feature flag.

## Required independent follow-through

`tests/platform_support.rs` is a regression inventory of common first-party platform
markers and scripts; it scans src/tests/examples/scripts, not the dependency lock or
archived documents. It is not a compiler, security audit or complete semantic proof.
The next fresh local implementor must run it and manually inspect the entire removal
diff, remaining platform handling and current documentation. Preserve Linux/macOS
behavior and report any residual compatibility branch or documentation contradiction.

See [PR #9 platform follow-up](slices/v1b/PLATFORM_FOLLOWUP.md) for source revisions,
observed CI, historical failures and review limits. Real credentials, live provider
calls, release and deployment are not authorized by this policy.
