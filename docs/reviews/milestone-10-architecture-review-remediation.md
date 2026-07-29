# Milestone 10 architecture-review remediation

- **Status:** RESOLVED IN WORKING TREE
- **Review date:** 2026-07-29
- **Branch:** `plan/v0.2-openai-provider`
- **Base:** `1c0689896b27c046b8b9a392251f6885e715515a` (`v0.1.0-vertical-slice`)
- **Candidate form:** uncommitted Milestone 10 documentation overlay
- **Original verdict:** PASS WITH REQUIRED FIXES — do not begin Milestone 11
- **Follow-up:** [Milestone 10 architecture-review remediation 2](milestone-10-architecture-review-remediation-2.md) records the later provisioning, environment-lease, permission-repair, and OAuth callback corrections.

## Findings and corrections

The independent review found no Critical issue. All nine findings were valid architecture or documentation gaps and were corrected without adding implementation.

| Finding | Correction | Canonical location |
|---|---|---|
| `WI-M10-H1` — catalog/CredentialStore lifecycle had no cross-store crash/idempotency state machine | Added a nonsecret `commandId`-keyed prepared-to-terminal catalog operation, exact file-effect ordering, acknowledgement point, deterministic restart reconciliation, stable retry result, and orphan-evidence rule. | Provider-connections architecture §4.4; ADR-0014; Milestone 11 requirements/tests |
| `WI-M10-H2` — active-run disable/logout behavior was nondeterministic | Added one-request credential leases. A pre-cutoff request may settle and authorize its terminal tools, but no new request, refresh, or post-tool continuation may begin after the durable cutoff. | Provider-connections architecture §4.3; ADR-0013; Milestone 11 tests |
| `WI-M10-M1` — duplicate OAuth identity resolution was not atomic | Required one serialized catalog transaction over normalized provider/auth/subject-or-account/workspace identity and one winning `connectionId`. | Provider-connections architecture §3.3; ADR-0013; Milestones 11 and 13 |
| `WI-M10-M2` — custom roots could resolve to `/mnt/c`/DrvFS | Required canonical mount validation and rejection of Windows-drive paths, aliases, and Windows-backed DrvFS/9p mounts; absolute syntax alone is insufficient. | Provider-connections architecture §10.1; ADR-0014; Milestone 11 tests |
| `WI-M10-M3` — future browser/protocol operation inventory was incomplete | Added a schema-neutral inventory covering connection lifecycle, selection/defaults, capabilities/models, OAuth start/cancel/status/workspace selection, callback/device ownership, and reauthentication, with durable/read ownership. | Provider-connections architecture §16; Milestones 11 and 13 |
| `WI-M10-M4` — live-provider tests were not prohibited on untrusted PRs | Required live tests to stay disabled for forks and untrusted pull requests and to use only explicit trusted local or manually approved environments. | v0.2 plan §§8 and 17 |
| `WI-M10-L1` — repository instructions did not freeze M11 as no-network | Added an invariant prohibiting OpenAI requests, probes, OAuth exchange, and live discovery in M11. | `AGENTS.md`; Milestone 11 scope |
| `WI-M10-L2` — canonical v0.1 docs retained `credential-vault` terminology | Replaced it with truthful planned `CredentialStore` references while preserving that v0.1 implements no provider credential store. | Security, storage-model, failure-boundaries, and ADR-0009 docs |
| `WI-M10-L3` — Pi/pi-config access windows were implicit | Recorded the narrowest honest window: initial Wi research before 2026-07-29, exact day not retained, distinct from ledger recording date. Certainty levels were not upgraded. | Source snapshot ledger §2 and evidence limits |

## Frozen lifecycle correction

The cross-store operation has two durable catalog commit points around one exact per-connection file effect:

1. `prepared` reserves identity/connection/generation or tombstone, records the content hash, and closes new credential leases for a mutated existing connection;
2. the file backend publishes the exact target envelope or durably deletes the selected file;
3. a terminal catalog transaction verifies the observed result and commits connection metadata plus the stable command result;
4. browser acknowledgement occurs only after the terminal catalog commit.

Restart distinguishes old-complete, target-complete, and exact-absent evidence. It resumes only the owning operation, never increments twice, and preserves mismatched/unowned files rather than guessing or rebinding them.

## Frozen active-run correction

A lease is scoped to one provider request, not to an entire run or provider chain. A request issued before the durable lifecycle cutoff may settle under ADR-0007. If its valid terminal response contains a tool call, that tool may complete through the durable ledger. Any provider continuation after the tool result is a new request and is rejected. No lifecycle operation can switch the run to another connection.

## Deliberately unchanged

- Milestone 10 remains documentation-only.
- No production TypeScript, protocol schema, SQLite migration, browser UI, credential file, OAuth handler, OpenAI request, router, dependency, workflow, release marker, or tag changed.
- Concrete wire names and SQLite table layouts remain Milestone 11 implementation choices within the corrected architecture.
- The `prompts/` workflow artifacts remain untracked and outside the candidate.

## Regression map

- Cross-store state and lease boundary: `docs/architecture/v0.2-provider-connections.md`
- Multiple-account/atomic identity decision: `docs/adr/0013-multiple-provider-connections.md`
- Credential filesystem/lifecycle decision: `docs/adr/0014-wsl-file-credential-store.md`
- Milestone gates and required tests: `docs/plans/v0.2-openai-provider-integration.md`
- Agent implementation boundary: `AGENTS.md`
- Terminology and backup boundary: `docs/security.md`, `docs/architecture/storage-model.md`, `docs/architecture/failure-boundaries.md`, `docs/adr/0009-host-unrestricted-filesystem.md`
- Source certainty: `docs/reference/source-snapshots.md`

## Recurrence checklist

Before Milestone 11 begins or its architecture is amended, verify:

- [ ] Every catalog/CredentialStore lifecycle mutation has a nonsecret durable operation keyed by `commandId` and content hash.
- [ ] Crash recovery has one answer before/after catalog prepare, file publish/delete, terminal catalog commit, and acknowledgement.
- [ ] An identical retry returns one stable result and cannot increment a generation twice.
- [ ] A connection lifecycle cutoff prevents new provider requests, refreshes, and post-tool continuations while allowing only an already-issued request to settle.
- [ ] Authoritative duplicate identity is normalized and claimed atomically; same identity/workspace cannot create two connections.
- [ ] Same subject in distinct explicit workspaces remains representable as distinct connections.
- [ ] Credential roots reject `/mnt/c`, aliases, and unsupported Windows-backed mount semantics.
- [ ] Every planned browser operation has explicit backend/read ownership, idempotency, bounds, and secret-free payload rules before its schema is accepted.
- [ ] OAuth work remains backend-owned across browser disconnect.
- [ ] Milestone 11 remains deterministic and no-network.
- [ ] Live-provider credentials are never exposed to fork or untrusted-PR execution.
- [ ] Canonical docs use `CredentialStore` and preserve the truth that v0.1 has no provider credential persistence.
- [ ] Source access windows and certainty are stated independently; missing dates or SHAs are not invented.

## Validation evidence

Completed against the corrected working-tree candidate:

- architecture finding audit: all nine finding IDs recorded and all four canonical legacy-terminology locations corrected;
- local Markdown link validation: 80 files, every target resolved;
- `git diff --check`: pass;
- `pnpm check`: 74 files and 930 tests passed;
- lint and TypeScript checks: pass through `pnpm check`;
- production build and package exports: pass; 8 package entry points verified;
- candidate scope: documentation only; no staged paths and no `prompts/` path included.
