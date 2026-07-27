# Property and fuzz testing

Status: Milestone 8 release-gate documentation

## Profiles

| Command | Purpose | Default budget |
|---|---|---:|
| `pnpm test:property` | Deterministic PR profile: 1,000 runs for each stateless core property and one 1,000-operation history for each durable core model | 1,000 runs/operations maximum |
| `pnpm test:fuzz` | Time-bounded local fuzz profile | 60 seconds |
| `pnpm test:fuzz:extended` | Manual/nightly extended profile | 10 minutes |

The timed profiles divide each round across nine Milestone 8 properties in
`tests/property/milestone8-hardening.test.ts` and `tests/property/milestone8-durable-models.test.ts`. Each round also
runs the focused production-backed `SessionActor`, replay-subscription, restart, event-store, command, and agent-loop
companion families. The runner repeats deterministic seed rounds until measured fuzz wall time reaches the requested
budget. It caps each round's shared fast-check interruption budget at 45 seconds so timed properties report before the
Vitest worker RPC deadline. A complete round can exceed 45 seconds because durable histories and fixed-run companions
finish their current work; the profile duration remains a minimum budget rather than an end-to-end deadline.
Each core durable property generates one fixed-length history of 1,000 operations. Every initial execution and shrink
candidate gets a fresh real-SQLite setup, so a `WI_FC_PATH` recreates every prerequisite operation instead of reusing
mutated state. Shrinking is capped at one candidate: this bounds a near-operation-1,000 failure to at most two complete
history executions before artifact writing. Fixed process and browser crash-window regressions remain outside the
timed loop.

## Nightly seed selection

Scheduled nightly runs do not reuse a fixed starting seed. `scripts/select-nightly-fuzz-seed.mjs` hashes the recorded
GitHub Actions run ID and run attempt into the fast-check range `1..2147483647`. The same recorded identity produces the
same seed, while distinct scheduled runs produce different deterministic starting seeds. The selector uses no secret,
clock read, or random source.

Manual `workflow_dispatch` accepts an optional decimal seed in the same range. A supplied valid seed is used exactly;
an invalid value fails in the selector step before dependency installation or fuzz execution. A dispatch without a seed
uses the same recorded-run derivation as a schedule.

The selector prints the chosen seed and its recorded run identity, writes it to one workflow output, and only that output
is passed to `run-fuzz.mjs` as `WI_FC_SEED`. The runner prints the starting seed again, then retains its existing
one-by-one deterministic seed rotation for later rounds. Failure artifacts record the exact failing round seed and emit
that seed in their reproduction command.

## Overrides and reproduction

- `WI_FC_SEED=<1..2147483647>` selects the fast-check seed. The default is `737373`; later rounds wrap within that range.
- `WI_FC_PATH=<fast-check path>` selects a minimized counterexample path.
- `WI_FC_NUM_RUNS=<1..1000>` overrides normal deterministic property runs and the meaningful operation count in each
  durable history. Durable properties still execute one self-contained history so path replay remains exact. The shared
  support module rejects invalid or excessive values before importing suites can construct arbitraries or enter
  predicates that create SQLite homes, workers, or failure artifacts.
- `WI_FUZZ_DURATION_MS=<1000..86400000>` overrides a timed profile's minimum measured execution duration. A normal
  fast-check time interruption is a clean stop and does not create a counterexample artifact.
- `pnpm test:fuzz -- --duration=60s` is the equivalent command-line form; `ms`, `s`, and `m` units are accepted. Other
  arguments after the optional pnpm `--` are passed to Vitest, so `-t "test title"` selects one property correctly.

The run-count maximum is deliberately the 1,000-run/operation release profile. A durable operation performs real SQLite
work and retains a generated history in memory, so larger values multiply both worker time and shrink-replay cost.
Use rotating seeds in the timed profiles for additional breadth instead of constructing oversized deterministic runs or
durable arrays.

The duration is a minimum fuzz-execution budget, not a process deadline. Build, collection, worker startup, cleanup, and
fixed-run companion properties add wall-clock overhead. Very short budgets can therefore overshoot materially; use the
60-second and 10-minute defaults for release evidence.

A failure prints the suite and test, seed, minimized path, discovered command/session/run/call identifiers, artifact
path, and an exact single-test reproduction command. Example:

```text
WI_FC_SEED=737373 WI_FC_PATH=12:4:0 pnpm exec vitest run \
  --workspace vitest.workspace.ts --project property \
  tests/property/milestone8-hardening.test.ts \
  -t "never routes generated invalid raw frames and logs only bounded fingerprints"
```

## Counterexample artifacts

Failures write mode-`0600` JSON files below `.artifacts/fuzz/`; overwriting an existing artifact repairs its mode. A
property-project setup reporter covers ordinary `fc.assert` companion suites, while the Milestone 8 core helper covers
its `fc.check` suites. The directory is ignored by Git and uploaded only when the nightly workflow fails; the workflow
explicitly enables hidden-file upload because `.artifacts` is dot-prefixed. Each artifact contains:

- schema version, profile, suite, and test;
- seed and minimized path;
- a bounded structural counterexample preview and SHA-256 digest;
- bounded generated identifiers;
- run and shrink counts;
- the exact reproduction command.

Generators are bounded and contain synthetic values only. Raw application data, credentials, cookies, provider
payloads, and environment values are never included. The minimized seed/path remains authoritative if a structural
preview is truncated.

## Coverage map

- **Protocol:** bounded JSON trees, arbitrary and malformed bytes, binary frames, UTF-8, exact/over-limit valid JSON
  strings, depth/size boundaries, unusual Unicode/null/surrogates, and generated strict-schema mutations across
  versions, kinds, IDs, command methods, method-specific parameters, extra keys, and resume entries. Real
  `BrowserConnection` routing isolation verifies that invalid envelopes never route and logs remain bounded.
- **Command idempotency:** one reproducible 1,000-operation tab/lost-ack/reconnect history against real session and
  catalog SQLite command storage, including overlapping same-ID session requests, plus full session-creation and
  restart companions.
- **Event store:** one reproducible 1,000-operation real-SQLite append/replay/rollback/catalog-lag/reconcile/equal-head
  history, plus ambiguous-commit, immutability, and restart companions. Expected complete events are constructed from
  generated requests—not append responses—and compare sequence, ID, type, timestamp, and payload across replay and
  reconciliation.
- **Actor:** the timed companion suite drives the real `SessionActor` through generated
  submit/queue/cancel/outcome/approval/input/subscriber/recovery histories. Fixed integration tests own simultaneous
  approval/input race windows.
- **Replay/live:** `preserves replay/live equivalence across generated race boundaries` and `merges replay and
  concurrently published live events into exact database order` compare every delivered event field with independently
  generated multi-family committed events. `duplicates produce the independently modeled browser state` and `replay
  and reconnect grouping produces the independently modeled browser state` compare the production reducer with an
  independently constructed complete browser projection. Retained mutation coverage changes event ID, type, timestamp,
  and payload without changing sequence and requires the complete-event oracle and reducer integrity checks to reject
  every mutation; cursor, duplicate, disconnect, gap, and conflict coverage remains active.
- **Tool ledger:** one reproducible 1,000-operation durable SQLite history invokes production recovery for started
  pure and non-idempotent effects, then verifies identity stability and transition rejection. Production agent-loop and process
  companions cover promotion, execution, approval, cancellation, crash, and restart boundaries.
- **Scheduler:** generated provider/tool capacities, FIFO order, queued cancellation, success/failure, and exact
  permit restoration.

The standard `pnpm check`, process suite, and Playwright E2E suite remain mandatory. The timed fuzz profiles add
breadth; they do not replace fixed crash-window or browser regressions.
