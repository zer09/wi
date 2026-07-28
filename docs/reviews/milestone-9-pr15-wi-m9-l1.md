# Milestone 9 PR #15 remediation — `WI-M9-L1`

Status: RESOLVED

Milestone 9 base: `e8fc2a30730025f3108cd41d8225876297ad8f90`

Reviewed PR head before correction: `32ef81dffabe7027a2d6e70363ebd47171456c4d`

Implementation commit: `73b39aeef3ee51e77869a8446776f9a2429a5201`

Implementation parent: `9e02db61d9b12e4c19d78e5c5bd64d834b3ab372`

Independent verification verdict: RESOLVED

This record covers the catalog-availability wording defect found by the independent remote review of PR #15.

## Finding validated

The finding was correct. `docs/architecture/v0.1-overview.md` said that the catalog database was “always available.” That was an availability guarantee contradicted by the canonical storage and recovery behavior:

- the catalog may be missing or stale;
- an existing catalog may be unavailable because it cannot be opened or validated;
- Wi preserves an unopenable existing catalog and fails startup closed;
- only the bounded documented repair path reconstructs a missing catalog;
- per-session databases, not the catalog projection, remain canonical for session state.

## Correction

The canonical overview now describes the catalog as the installation-wide rebuildable summary and location projection **when available**. It explicitly names missing, stale, and unavailable states, distinguishes fail-closed handling of an existing unopenable catalog from bounded missing-catalog reconstruction, and leaves the following canonical-session paragraph intact.

The wording agrees with:

- `docs/architecture/storage-model.md`;
- `docs/architecture/failure-boundaries.md`;
- `docs/architecture/failure-recovery-matrix.md`;
- `docs/reference/migrations.md`;
- `docs/troubleshooting.md`; and
- `docs/adr/0012-trusted-local-user-storage-boundary.md`.

It also matches the catalog worker and storage-manager implementation: validation uses disposable-copy and identity checks, existing unopenable evidence is preserved, startup fails closed, and reconstruction is bounded by configured discovery limits.

## Deliberately unchanged

- Catalog startup, repair, migration, and discovery behavior are unchanged.
- No catalog or session database is deleted, overwritten, automatically replaced, or destructively quarantined.
- Session databases remain canonical.
- The trusted local-user boundary in ADR-0012 is unchanged.
- No runtime source, schema, workflow, test, or other documentation changed in the implementation commit.
- The correction does not claim protection against hostile concurrent same-user mutation.

## Recurrence checklist

1. Do not describe a rebuildable catalog projection as permanently or “always” available.
2. Distinguish missing-catalog reconstruction from handling an existing unopenable catalog.
3. State that unopenable catalog evidence is preserved and startup fails closed.
4. Describe reconstruction as bounded and limited to the documented repair path.
5. Keep per-session databases canonical in architecture summaries.
6. Compare overview wording with storage model, failure matrix, migrations, troubleshooting, ADR-0012, and implementation before changing catalog claims.
7. Do not imply destructive automatic repair or broaden the trusted-user threat model.

## Validation evidence

Implementation validation:

```text
Markdown relative links: passed
pnpm lint:              passed
git diff --check:       passed
implementation scope:   1 documentation file, 1 insertion, 1 deletion
```

Independent verification confirmed:

```text
commit:          73b39aeef3ee51e77869a8446776f9a2429a5201
parent:          9e02db61d9b12e4c19d78e5c5bd64d834b3ab372
scope:           docs/architecture/v0.1-overview.md only
tracked tree:    clean
classification:  RESOLVED
```

The verifier compared the correction with canonical documentation and catalog startup/repair code, reran the 70-file tracked-Markdown relative-link validator and lint, and found no destructive-repair, availability, or threat-model overclaim. No repository or hosted state was changed during verification.

## Next gate

Run the read-only `protect-master` ruleset probe, complete local release matrix, and focused final acceptance from a clean detached worktree at the final local head. A fresh independent local PASS is required before pushing the correction chain to PR #15. Exact-head hosted CI, remote re-review, merge, post-merge attestation, and tag authorization remain later gates.
