# Wi v0.1 test strategy

Wi treats acceptance as evidence across multiple fault boundaries, not merely compilation. Tests use deterministic clocks/IDs where behavior depends on ordering, real SQLite workers for persistence claims, real child processes for crash claims, and Chromium for browser ownership/replay claims.

## Test layers

| Layer | Command | Primary evidence |
|---|---|---|
| Static architecture/preflight | included by `pnpm test` / `pnpm check` | Node/platform rules, dependency boundaries, workflow wiring |
| Unit | `pnpm test:unit` | schemas, reducers, state transitions, hashing, queues, redaction |
| Integration | `pnpm test:integration` | package boundaries, real storage workers, actor/run loop, HTTP/WebSocket server |
| Property | `pnpm test:property` | generated command, replay, event-store, tool-ledger, scheduler, protocol invariants |
| Process/crash | `pnpm test:process` | real process death/restart, commit windows, migration/repair, shutdown ownership |
| Browser E2E | `pnpm test:e2e` | disposable tabs, reconnect, replay, approvals, browser security, final acceptance |
| Timed fuzz | `pnpm test:fuzz -- --duration=60s` | rotating seeded production-backed model families and bounded artifacts |
| Aggregate | `pnpm check` | lint, typecheck, all Vitest projects, build, package exports |

## Mandatory invariant failures

Regression coverage must fail if:

- an event is published before its transaction commits;
- a duplicate command creates a duplicate run;
- a duplicate tool call creates a second effect;
- a staged tool executes before provider terminal completion;
- tab/WebSocket closure cancels backend work;
- replay misses a committed event or accepts conflicting event identity/content;
- a terminal run/tool state regresses;
- update/delete mutates canonical event history;
- detailed errors expose raw secrets or unbounded untrusted text;
- one session fault unnecessarily fails another session or the whole installation.

## Final acceptance

`tests/e2e/milestone9-final-acceptance.spec.ts` automates the first-slice acceptance history with:

- one temporary `WI_HOME`;
- two sessions and concurrent provider/tool work;
- two browser tabs converging on one session;
- every tab closing while a run continues;
- exact replay after reopening;
- approval persistence across a real backend restart;
- exactly-once guarded tool execution;
- exact command-ID replay with no new events/run;
- incomplete provider tool-call output with zero execution;
- production replay-backlog overflow, slow-consumer close (`4409`, `slow consumer`), subscription cleanup, and exact UI reconstruction after reconnect;
- distinct physical session databases;
- catalog listing while a completed session database remains unopened after restart;
- rejected event update/delete operations;
- bounded log/session-fixture secret audit.

The test fixture enables storage test operations only under `NODE_ENV=test`. It records tool starts in the temporary home so execution evidence survives the backend restart, and removes the entire home and browser context in `finally` cleanup.

## CI

`.github/workflows/ci.yml` preserves the stable required check:

```text
CI / required
```

`required` uses `if: always()` and succeeds only when both `checks` and `e2e` succeeded. `checks` includes deterministic property and process suites. E2E installs Chromium and automatically includes the final acceptance spec. Extended fuzz remains isolated in `.github/workflows/nightly-fuzz.yml` so a ten-minute profile does not inflate every pull request.

Workflows have read-only repository permissions and do not use `pull_request_target` or repository secrets.

## Fuzz reproduction

See [fuzzing.md](fuzzing.md) for profiles, seed/path overrides, duration semantics, mode-0600 counterexample artifacts, hidden GitHub artifact upload, and exact single-test reproduction commands.

Release evidence uses a clean 60-second local profile after every intentional failure probe has been removed. Nightly runs derive reproducible diverse seeds from recorded GitHub run identity; manual dispatch may provide an exact seed.

## Failure diagnostics

A failed property artifact records:

- suite/test/profile;
- exact seed and minimized path;
- bounded counterexample preview and SHA-256;
- bounded discovered command/session/run/call IDs;
- run/shrink counts;
- shell-quoted exact reproduction command.

Process and E2E harnesses use the shared test-support bounds: each stdout/stderr tail retains at most 64 KiB, pending IPC retains at most 128 messages/256 KiB, and diagnostic IPC history retains at most 256 messages/512 KiB. Oversized or excess fixture messages are not retained indefinitely. Cleanup then terminates descendants and removes temporary homes. Browser traces are disabled because they can retain the HttpOnly bootstrap cookie.

## Release command matrix

Run individually so each boundary has explicit evidence:

```sh
pnpm lint
pnpm typecheck
pnpm test:unit
pnpm test:integration
pnpm test:property
pnpm test:process
pnpm test:e2e
pnpm build
pnpm test:fuzz -- --duration=60s
pnpm check
```

Then repeat frozen install, `pnpm check`, and the focused final acceptance test in a clean detached worktree when practical. A green working-tree run alone does not prove clean-checkout completeness.
