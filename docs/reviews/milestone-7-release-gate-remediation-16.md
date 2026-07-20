# Milestone 7 release-gate remediation 16

Status: **REMEDIATED LOCALLY — Windows CI rerun pending**

PR: [#13 — Milestone 7: crash recovery and release gate](https://github.com/zer09/wi/pull/13)

Failed CI run: [29783949274](https://github.com/zer09/wi/actions/runs/29783949274), commit `03dd8ea38fbf55ea5b8e9c53212b7b12942daa21`.

## Failure

The required `windows-process` job failed while `checks` and `e2e` passed. The process project completed with 6 files failing, 1 passing, 33 tests failing, and 42 passing. The aggregate `required` job then failed as designed.

Every affected suite failed while loading `packages/test-support/src/windows-process-job.ts`:

```text
Error: Duplicate type name 'HANDLE'
```

The first Windows process file could register the named Koffi `HANDLE` and Job Object structures. Vitest then evaluated the module again for another isolated test file in the same process. Koffi's named-type registry is process-global, so the second `koffi.pointer("HANDLE", ...)` registration threw before fixture startup. Fixing only `HANDLE` would have exposed the same defect in the next named structure.

## Remediation

- Replaced the named `HANDLE` registration with an anonymous opaque-pointer descriptor.
- Replaced all named Job Object structure registrations with anonymous structure descriptors.
- Replaced C-prototype strings that depended on those global names with descriptor-based `kernel32.func("__stdcall", name, result, arguments)` declarations.
- Preserved the existing Win32 ABI shapes, output direction for `QueryInformationJobObject`, input pointer for `SetInformationJobObject`, UTF-16 names, and stdcall convention.
- Added a Windows-only process regression that imports the Job Object module, resets Vitest's module registry, and imports it again. The old implementation fails this exact sequence with the observed duplicate-type error.

No architecture policy or ADR changed. This is an FFI module-lifecycle correction.

## Verification

| Check | Result |
|---|---|
| `pnpm --filter @wi/test-support typecheck` | Passed |
| Root TypeScript check | Passed |
| Focused ESLint | Passed |
| `@wi/test-support` unit command | Passed |
| Full `pnpm check` | Passed: 64 files; 816 passed and 2 Windows-only skipped; lint, typecheck, tests, build, and package-export verification passed in 142.88s |
| `git diff --check` | Passed |
| Cleanup inspection | Passed; no matching fixture/server/browser process, temporary process home, or port 4317 listener |
| Required `windows-process` CI | Pending after explicit commit/push |

## First Windows rerun follow-up

Commit `9469190eb6caeb46e18be140240e0f614a743567` removed the duplicate-type failure. In CI run [29785463293](https://github.com/zer09/wi/actions/runs/29785463293):

- the explicit anonymous-binding reload regression passed;
- Windows improved from 33 failures to 2, with 74 tests passing;
- `checks` and `e2e` passed;
- both remaining failures reported `Windows process tree cleanup requires Job Object ownership` from `FixtureProcessRunner` timeout cleanup.

The timeout callback could complete `terminateProcessTree`, remove successful Job Object ownership, and delete the child from the runner before `run()` reached its unconditional `finally` cleanup. The second cleanup then treated the already-clean tree as an ownership failure. `FixtureProcessRunner.terminate` now returns immediately when a child has already been removed after successful cleanup, while retaining children after failed cleanup so `terminateAll` can still retry them.

The follow-up remains unstaged and uncommitted. `prompts/` remains untracked and excluded.
