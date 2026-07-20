# Milestone 7 release-gate remediation 12

Status: **READY FOR WINDOWS CI VALIDATION — all executable local gates passed**

Review target: `dd932c9c774aa9c28c68f7aff66690a5b2c526f3` plus the unstaged Milestone 7 worktree and remediations 1–11.

This ledger independently validates the twelfth local Milestone 7 release-gate review and records the resulting remediation. It supersedes any conflicting readiness claim in earlier Milestone 7 remediation ledgers. No accepted ADR was changed.

## Findings and resolutions

| Finding | Validation | Resolution and regression evidence |
|---|---|---|
| Process suite is not actually Windows-portable | **Confirmed, Medium.** The run-loop timeout probe required POSIX `{ code: null, signal: "SIGKILL" }`, although Windows force cleanup uses `TerminateJobObject(..., 1)` and reports `{ code: 1, signal: null }`. The catalog scanner probe skipped its directory-link case on Windows. The required CI graph ran all tests only on Ubuntu. | The timeout probe now keeps the common readiness/output and reaping assertions while requiring the native forced-exit result for each platform. The scanner probe creates a POSIX directory symlink or Windows directory junction, requires that it never enters the recovered catalog, and verifies that the untouched link remains. `.github/workflows/ci.yml` now has a required `windows-process` job that installs the pinned Node/pnpm toolchain and runs the complete `pnpm test:process` project on `windows-latest`; the aggregate `required` job fails unless it succeeds. |
| Graceful-signal delivery errors are swallowed | **Confirmed, Low.** `RealServerProcess.signal()` started `signalProcessTree()` without returning its promise and discarded rejection, hiding authenticated Windows IPC delivery failure behind a later process-exit timeout. | `RealServerProcess.signal()` now returns `Promise<void>` and directly propagates signaling failure. Every process-test caller awaits SIGTERM or SIGKILL delivery before waiting for child exit, so the originating Job Object, process-group, or authenticated IPC error is reported at the action boundary. Cleanup escalation remains independently owned by `terminate()`. |

## Design decisions

- Forced exits are not normalized into fake POSIX semantics. Tests assert `SIGKILL` on POSIX and Job Object exit code `1` on Windows.
- The scanner uses Node's native `symlink(..., "junction")` form on Windows. Directory junctions are reparse points and do not require the elevated symbolic-link privilege normally unavailable to hosted CI accounts.
- The same scanner scenario runs on both operating systems instead of adding a Windows-only duplicate. Catalog absence plus retained-link assertions prove that the generated-path scanner did not follow or mutate the link.
- Windows coverage is a separate required process job rather than expanding the full checks or browser matrix. This gives the platform-dependent Job Object, IPC signal, junction, crash, restart, and cleanup paths direct coverage while keeping unrelated unit/integration/E2E duplication out of the bounded v0.1 gate.
- Signal delivery and exit remain separate awaited operations. A successful `signal()` means the operating-system signal/control request was delivered, not that the process exited; `waitForExit()` retains its own bounded deadline.
- No production runtime, storage schema, protocol, provider, tool, or browser behavior changed.

## Updated coverage

- platform-native expected exit after an ignored fixture deadline;
- Windows directory-junction scanner containment through the existing catalog-reconstruction process probe;
- surfaced graceful/force signal-delivery failures at every `RealServerProcess` call site;
- required complete process-suite execution on `windows-latest`.

## Verification

| Command | Result |
|---|---|
| Build test dependencies, root TypeScript check, and focused ESLint | Passed |
| Focused process-harness, run-loop, force-stop, and Milestone 7 suites | 4 files, 49 tests passed in 60.35s |
| Linux `pnpm test:process` | 7 files, 72 tests passed in 64.43s |
| `pnpm check` | 64 files, 814 tests passed in 103.48s; lint, typecheck, tests, build, and package-export verification passed |
| `pnpm test:e2e` | 33 tests passed in 52.9s |
| `git diff --check` | Passed after final documentation update |
| Cleanup inspection | Passed; no matching fixture/server/browser process, temporary Milestone 7/E2E/process/storage/force-stop home, or port 4317 listener |
| Hosted `windows-latest` `pnpm test:process` | **Pending; cannot be executed on this Linux host. Release readiness remains conditional on this newly required CI job passing.** |

The workflow was manually inspected after editing. No YAML parser or `actionlint` executable is installed on this host; GitHub Actions is the authoritative workflow-schema validation boundary.

Changes remain unstaged and uncommitted. `prompts/` remains a local workflow artifact and was not modified by this remediation.
