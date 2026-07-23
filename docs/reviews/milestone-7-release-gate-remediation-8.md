# Milestone 7 release-gate remediation 8

Status: **READY FOR INDEPENDENT REVIEW — implementation and automated gates passed**

Review target: `dd932c9c774aa9c28c68f7aff66690a5b2c526f3` plus the unstaged Milestone 7 worktree and remediations 1–7.

This ledger independently validates the eighth local Milestone 7 release-gate review and records the resulting remediation. It supersedes any conflicting readiness claim in earlier Milestone 7 remediation ledgers. No accepted ADR was changed.

## Finding and resolution

| Finding | Validation | Resolution and regression evidence |
|---|---|---|
| Scanner accumulates potentially gigabytes of error records on the main thread | **Confirmed, High.** `toStorageError()` intentionally preserves source diagnostics, discovery copied those diagnostics into non-valid records without field bounds, and page size limited only one RPC response. The manager then retained every complete first-pass non-valid record until the second pass. At the declared 10,000-session ceiling, aggregate retained diagnostic text was therefore not bounded by the page budget and contradicted the documented compact-pass guarantee. | Discovery now truncates worker-originated error codes to 128 UTF-16 units and messages to 4,096 units before serialization. The receiving Zod schema independently enforces those limits. The first pass retains only `{ kind }` or `{ kind: "unsupported", schemaVersion }`, keyed by the already-bounded session ID; messages, codes, and full records remain page-scoped. A deterministic regression constructs the declared maximum 10,000 corrupt classifications with maximum-size diagnostics, passes each through the exact production retention function, and proves the retained representation contains no diagnostic string and serializes below 1 MB. |

## Design decisions

- `toStorageError()` remains the general in-worker classifier and may retain detailed local diagnostics for non-discovery callers. The trust-boundary truncation belongs where discovery converts an arbitrary worker error into a cross-thread record.
- Error codes are bounded as well as messages so every non-valid record field has a declared scalar limit before RPC serialization.
- Truncation preserves the beginning of the diagnostic and appends an ellipsis. Discovery diagnostics are classification aids, not canonical state.
- The manager needs only the first-pass fault kind and, for a newer unsupported database, its observed schema version. Retaining codes or messages cannot affect reconciliation behavior.
- The compact first-pass classification remains authoritative when the second read changes state, preventing a newly valid second-pass record from bypassing provenance conflict preflight.
- The regression is structural rather than a flaky heap-delta assertion: it tests the exact production compactor at the maximum supported session cardinality and maximum serialized diagnostic length.

## Added regression coverage

- exact truncation of oversized discovery diagnostics to the declared maximum;
- aggregate retention for 10,000 corrupt-session classifications;
- proof that maximum-size diagnostic text is absent from retained manager state;
- proof that the complete maximum-cardinality retained representation serializes below 1 MB.

## Verification

| Command | Result |
|---|---|
| Storage package typecheck | Passed |
| Focused changed-file ESLint | Passed |
| Focused bounded-retention unit tests | 1 file, 2 tests passed |
| Milestone 7 process suite | 36 tests passed |
| Storage integration suite | 59 tests passed |
| Combined affected suites | 3 files, 97 tests passed in 56.30s |
| `pnpm check` | 64 files, 804 tests passed; lint, typecheck, all unit/integration/property/process tests, build, and package-export verification passed |
| `pnpm test:e2e` | 33 tests passed in 51.3s |
| `git diff --check` | Passed after final documentation update |
| Cleanup inspection | Passed; no matching fixture/server/browser process, temporary Milestone 7/E2E/process home, port 4317 listener, or accessible Wi test-home WAL/SHM sidecar |

Changes remain unstaged and uncommitted. `prompts/` remains a local workflow artifact and was not modified by this remediation.
