# Milestone 9 independent-review remediation

- **Status:** AWAITING INDEPENDENT VERIFICATION
- **Review date:** 2026-07-28
- **Branch:** `milestone-9-final-acceptance`
- **Base:** `e8fc2a30730025f3108cd41d8225876297ad8f90`
- **Candidate form:** uncommitted Milestone 9 working-tree overlay
- **Follow-up:** [Milestone 9 independent-review remediation 2](milestone-9-independent-review-remediation-2.md) records bounded E2E diagnostics, credential-based export auditing, and the remaining hosted release gates.

## Findings validated

The independent review verdict `PASS WITH REQUIRED FIXES — do not tag` was materially correct.

| Finding | Classification | Resolution |
|---|---|---|
| Final acceptance directly forced a `4409` disconnect instead of overflowing a production queue | Valid, release-blocking | Corrected in the acceptance fixture and scenario |
| No immutable candidate SHA or candidate CI | Valid process gate | Pending an explicit commit/push/PR boundary after local remediation and independent verification |
| Catalog-corruption troubleshooting implied `WI_CATALOG_REPAIR=1` could repair an unopenable catalog | Valid | Corrected in troubleshooting and migration operations |
| The 1,000-operation tool-ledger property timed out under aggregate resource contention | Valid stability risk | Kept full coverage and raised that test's aggregate-safe timeout from 120 to 180 seconds; the aggregate rerun exposed and corrected two smaller pre-existing load ceilings |
| Current topology diagrams showed deferred plugin/project-service boundaries and classified fake components as workers | Valid | Corrected to the implemented in-process fake provider/tool topology and SQLite-only worker boundary |
| README placed root `logs/` and `tmp/` inside session directories | Valid | Corrected and clarified stdout diagnostics |

No Critical finding or production behavior defect was established.

## Production slow-consumer correction

The final acceptance scenario now uses the production replay-overflow path rather than `disconnectActiveConnections()`:

1. the restartable fixture starts the real gateway with a test-specific `replayLiveEvents: 1` limit;
2. the browser opens session A while the real `afterHistoricalRead` boundary is blocked;
3. a second authenticated WebSocket submits a slow run, producing more committed live events than the replay backlog permits;
4. production `ReplaySubscriptionError("replay.subscriber_overflow")` handling closes the browser socket with code `4409` and reason `slow consumer`;
5. the test records and asserts the actual browser close event;
6. the replay gate is released and the browser reconnects;
7. gateway snapshots prove the old subscription was cleaned up and exactly one active session subscription remains;
8. after the provider completes, a fresh browser page and the reconnected page reconstruct identical complete UI state.

The IPC controls only arm/release the existing replay hook, report production connection snapshots, and configure the existing public gateway limit. They do not invoke the gateway's direct disconnect helper for this acceptance step.

## Catalog-only listing evidence

Recovery candidates are deliberately conservative. A completed tool session can remain an over-inclusive startup candidate, and an equal-head catalog observation must not clear that marker because doing so could lose crash recovery for a concurrent canonical write.

The acceptance test therefore creates one idle catalog sentinel through the real `SessionStoreManager`. After restart it proves:

- sessions A and B are present in the catalog;
- the sentinel's physical session database exists;
- catalog listing does not open the sentinel session database.

This demonstrates bounded catalog listing without changing crash-safe recovery semantics or assuming that every completed tool history is excluded from startup inspection.

## Catalog corruption operations

Documentation now distinguishes three cases:

- a healthy or stale catalog may be explicitly reconciled;
- a missing or deliberately relocated catalog may be reconstructed with `WI_CATALOG_REPAIR=1`;
- an existing catalog that SQLite cannot open is preserved and startup fails closed.

For the third case, the stopped operator must back up all of `WI_HOME`, including catalog WAL/SHM sidecars, then restore a known-good catalog or deliberately relocate the catalog and sidecars outside `WI_HOME` before entering the missing-catalog reconstruction path. The only copy of corrupt evidence must not be deleted.

## Aggregate test stability

The durable tool-ledger property still executes one shrinkable 1,000-operation history against real SQLite workers. Its timeout is now 180 seconds because it competes with the integration, process, and other property SQLite workloads during `pnpm check`. No operation count, assertion, arbitrary, shrink behavior, or suite concurrency was weakened.

The first aggregate remediation run showed that the same machine-level contention could also push two existing tests past thresholds chosen for isolated execution:

- the 1,002-row bounded bootstrap/recovery-candidate integration test exceeded Vitest's 5-second default by 188 ms;
- the 30-case production agent-loop model reached its 60-second timeout.

Those specific tests now have 15-second and 120-second budgets respectively. Their row count, generated run count, assertions, real worker usage, and project concurrency remain unchanged. Focused reruns completed in 0.97 seconds and 9.71 seconds; the subsequent aggregate gate passed all 927 tests.

## Topology and storage documentation

The current v0.1 topology now shows:

- deterministic fake provider and safe built-in tool executor in the main Node.js process;
- catalog and fixed session pools as the current SQLite worker boundary;
- plugins, project-service supervisors, real tool child processes, and their isolation boundaries as deferred.

The README now places `logs/` and `tmp/` at `WI_HOME` root and states that current production diagnostics are structured stdout records.

## Deliberately unchanged

- No OpenAI, ChatGPT/Codex OAuth, `codex app-server`, real host tool, plugin, or remote-hosting work was added.
- No production queue, replay, storage, provider, or tool implementation was changed.
- The direct fixture disconnect helper remains for tests that intentionally exercise generic reconnection; the final Milestone 9 slow-consumer step no longer uses it.
- The CI workflow and stable `CI / required` aggregator were not changed.
- No commit, push, PR, tag, or release was created by this remediation step.

## Candidate identity closure

The immutable-identity finding remains a required next process boundary, not a reason to manufacture a local tag. After this remediation receives independent local verification:

1. commit only the Milestone 9 candidate and this remediation record;
2. exclude `prompts/` and `Wi_M8_PR14_Remediation_Handoff/`;
3. push/open the normal PR;
4. require `CI / required` on the exact candidate SHA;
5. tag only after Milestone 9 review and hosted CI pass.

Suggested post-review marker command, not yet authorized for execution:

```sh
git tag -a v0.1.0-vertical-slice -m "Wi v0.1.0 vertical slice"
```

## Regression map

- Production replay-backlog overflow and close evidence: `tests/e2e/milestone9-final-acceptance.spec.ts`
- Test-specific replay capacity, replay gate, and connection evidence: `tests/e2e/fixtures/server-process.mjs`, `tests/e2e/fixtures/restartable-server.ts`
- Aggregate timeout budgets without reduced workloads: `tests/property/milestone8-durable-models.test.ts`, `tests/property/milestone4-agent-loop-model.test.ts`, `tests/integration/milestone5-server.test.ts`
- Catalog recovery instructions: `docs/troubleshooting.md`, `docs/reference/migrations.md`
- Current runtime topology: `docs/architecture/v0.1-overview.md`, `docs/architecture/diagrams.md`
- Storage layout and diagnostics: `README.md`
- Acceptance coverage statement: `docs/testing/strategy.md`

## Recurrence checklist

- [ ] A test claiming slow-consumer coverage reaches production queue/replay overflow; it does not call a direct disconnect helper.
- [ ] The browser-observed close code is `4409` and reason is `slow consumer`.
- [ ] Subscription cleanup is observed before exact replay/UI-state comparison.
- [ ] Catalog-only tests do not assume conservative recovery candidates are immediately cleared.
- [ ] `WI_CATALOG_REPAIR=1` is never described as overwriting an existing unopenable catalog.
- [ ] Current diagrams do not present deferred plugins, project services, or real tool workers as implemented.
- [ ] `$WI_HOME/logs` and `$WI_HOME/tmp` remain root-level paths in every layout example.
- [ ] Heavy tests retain their full operation/row/generated-case counts when timeout budgets change.
- [ ] The 1,000-operation durable ledger model remains intact and passes under aggregate load.
- [ ] Release/tag instructions remain blocked until an exact committed SHA passes `CI / required`.

## Validation evidence

Completed during remediation:

- focused ESLint over changed E2E/property files: pass;
- `pnpm typecheck`: pass;
- focused durable tool-ledger property: 1 passed, 2 skipped; 1,000 operations retained;
- focused Milestone 9 Playwright acceptance after correction: 1 passed in 8.1 seconds;
- production close assertion: browser observed `{ code: 4409, reason: "slow consumer" }`;
- post-reconnect gateway assertion: exactly one active session subscription;
- exact reconstructed UI comparison against a fresh page: pass;
- full Playwright suite: 34 passed in 55.8 seconds;
- focused bounded-bootstrap integration test: 1 passed, 85 skipped, in 0.97 seconds;
- focused production agent-loop property: 1 passed in 9.71 seconds;
- first aggregate remediation run: failed only the two newly identified pre-existing 5-second/60-second load ceilings; the tool-ledger property did not fail;
- aggregate rerun after narrow timeout corrections: 74 files and 927 tests passed in 222.34 seconds, followed by build and package-export verification;
- full local Markdown link check: pass;
- source hygiene scan: no focused/skipped tests or TODO/FIXME markers in remediation paths;
- artifact scan: no SQLite databases, WAL/SHM files, E2E logs, or fuzz artifacts retained;
- detached `e8fc2a3` overlay: frozen install passed, `pnpm check` passed 74 files/927 tests in 251.42 seconds, and focused acceptance passed in 9.1 seconds;
- local 60-second fuzz profile: 8 files/36 tests passed at seed 737373, with 72,986 ms measured elapsed time.
