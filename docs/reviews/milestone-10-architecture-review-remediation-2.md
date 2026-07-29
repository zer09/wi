# Milestone 10 architecture-review remediation 2

- **Status:** RESOLVED — INDEPENDENT FOLLOW-UP PASS
- **Review date:** 2026-07-29
- **Branch:** `plan/v0.2-openai-provider`
- **Base:** `1c0689896b27c046b8b9a392251f6885e715515a` (`v0.1.0-vertical-slice`)
- **Candidate form:** uncommitted Milestone 10 documentation overlay
- **Follow-up verdict:** PASS WITH REQUIRED FIXES — do not begin Milestone 11
- **Earlier record:** [Milestone 10 architecture-review remediation](milestone-10-architecture-review-remediation.md)

The follow-up review reused finding IDs from the first review for different findings. This record calls them **review round 2** findings so later audits do not conflate them with the resolved round 1 entries.

## Findings and corrections

The follow-up found no Critical issue. All four findings were valid and were corrected in architecture only.

| Round 2 finding | Correction | Canonical location |
|---|---|---|
| `WI-M10-H1` — file credential provisioning/staging was undefined | Added backend-local `CredentialProvisioner`, a private expiring staging root outside `WI_HOME`, opaque one-time claims, complete crash outcomes, terminal cleanup, and stable missing-stage failure. | Provider-connections architecture §§4.4 and 9.3; ADR-0014; Milestone 11 scope/tests |
| `WI-M10-H2` — environment identity was pinned after acceptance | Required acceptance to resolve and fingerprint the environment value before commit/acknowledgement, every request including the first to match it, and restart to interrupt because the fingerprint is nonpersisted. | Provider-connections architecture §§6.2 and 11; ADR-0014; Milestone 11 acceptance/tests |
| `WI-M10-M1` — existing unsafe credential modes had no repair path | Added no-follow descriptor validation, current-user/regular/single-link/identity checks, `fchmod(0600)`, required flush/revalidation, and fail-without-read controls. | Provider-connections architecture §§10.2 and 10.5; ADR-0014; Milestone 11 tests |
| `WI-M10-M2` — OAuth callback query secrets conflicted with the URL invariant | Narrowed the invariant only for provider-required OAuth parameters and required a dedicated no-store/no-referrer/no-external-content callback, immediate clean tombstone, no forwarding/persistence, and browser/network/history tests. | Provider-connections architecture §§5.1 and 5.3; ADR-0013; Milestone 13 gate/tests |

## Frozen provisioning correction

File API-key secret ingress is not a browser operation. A trusted local CLI or equivalent local administration entrypoint reads bounded bytes from masked stdin or a supplied file descriptor and invokes the backend-only provisioner. It never accepts the secret through browser HTTP/WebSocket, a URL, command-line arguments, or an environment value.

Before returning an opaque `provisioningRef`, the provisioner commits a complete staged envelope under:

```text
${XDG_STATE_HOME:-$HOME/.local/state}/wi/credential-staging/
```

The root is outside and non-overlapping with `WI_HOME` and completed credential storage and inherits the file backend's Linux-filesystem, `0700`/`0600`, containment, no-symlink, bounded-write, flush, redaction, and mount rules.

The catalog lifecycle operation claims one stage for one `commandId`. Unclaimed stages expire; claimed stages survive until terminal operation recovery. Final publication, terminal commit, and cleanup are independently resumable. Missing stage plus missing final envelope returns one stable typed failure and requires explicit restaging.

## Frozen environment-identity correction

Before run acknowledgement, an environment-backed selection must:

1. resolve a nonempty variable value;
2. create a keyed in-memory fingerprint lease;
3. durably record only the environment backend and nonsecret process epoch with the run snapshot;
4. commit the run; discard the lease if commit fails.

Every provider request, including the first, re-resolves and compares. A value replaced or removed after acceptance is never used. Backend restart cannot reconstruct the fingerprint, so recovery interrupts the accepted nonterminal run before provider work instead of resolving a potentially different identity.

## Frozen existing-file repair correction

A mode defect is repairable only after opening the generated contained final path with no-follow semantics and verifying on the descriptor that it is regular, owned by the Wi operating-system user, single-link, and identity-matching. Wi applies `fchmod(0600)`, flushes, and revalidates identity/type/owner/link count/mode before reading secret bytes.

Wrong ownership, links, substitution, nonregular identity, repair failure, or flush/revalidation failure is not repairable. Wi does not chmod or read that file and fails only the connection.

## Frozen OAuth callback correction

Wi prefers a provider response mode that keeps authorization codes out of query strings. If the provider requires URL parameters, only the dedicated loopback callback may receive them. The handler excludes its request target from logs, validates and consumes once, sets no-store/no-cache/no-referrer and restrictive CSP headers, and immediately redirects or replaces history with a clean expiring same-origin tombstone.

The tombstone contains only safe bounded status keyed by `loginId`, loads no external content, registers no service worker, and never forwards callback parameters. Duplicate callbacks resolve from backend attempt state, not browser-retained data.

## Deliberately unchanged

- Milestone 10 remains documentation-only.
- No production TypeScript, protocol schema, SQLite migration, browser UI, credential file, OAuth handler, OpenAI request, dependency, workflow, release marker, or tag changed.
- Concrete CLI spelling, wire envelopes, and SQLite table names remain implementation choices within the frozen boundaries.
- `prompts/` remains untracked and outside the candidate.

## Regression map

- Provisioning, environment leases, file repair, callback containment: `docs/architecture/v0.2-provider-connections.md`
- OAuth callback policy: `docs/adr/0013-multiple-provider-connections.md`
- Credential storage/provisioning/repair/environment decision: `docs/adr/0014-wsl-file-credential-store.md`
- Milestone gates and acceptance matrices: `docs/plans/v0.2-openai-provider-integration.md`
- Agent implementation boundaries: `AGENTS.md`

## Recurrence checklist

Before Milestone 11 begins:

- [ ] File credential secret ingress is backend-local and never uses browser payloads, URLs, argv, or environment variables.
- [ ] A complete staged envelope is durable before any `provisioningRef` is returned.
- [ ] Staging root containment, modes, filesystem semantics, bounds, flushes, expiry, and redaction match completed credential safety.
- [ ] A stage is claimed by one lifecycle operation/`commandId`; identical retry resumes and conflicting reuse fails.
- [ ] Every crash boundary from stage write through stage cleanup has one stable result and no secret leak.
- [ ] Environment value is resolved/fingerprinted before run commit and acknowledgement.
- [ ] Replacement/disappearance before first or later request fails without using the new value or falling back.
- [ ] Restart interrupts accepted nonterminal environment-backed runs before provider work.
- [ ] Existing unsafe mode is repaired only after no-follow descriptor identity/owner/type/link validation and before secret read.
- [ ] Repair is flushed and revalidated; unsafe identity or failed repair is never read or chmodded.

Before Milestone 13 begins:

- [ ] Provider-supported non-query OAuth response mode is preferred.
- [ ] Any required callback query is accepted only by the dedicated endpoint and excluded from logs/diagnostics.
- [ ] Callback responses enforce no-store/no-cache/no-referrer and no external content.
- [ ] Browser history is immediately replaced/redirected to a clean expiring tombstone.
- [ ] Tests prove no callback secret remains in history, referrers, storage, service workers, logs, diagnostics, or forwarded network requests.

## Validation evidence

Completed against the corrected working-tree candidate:

- round-2 architecture audit: all four corrections present in architecture, ADRs, plan, and recurrence record;
- stale/conflicting wording audit: no first-use environment pin, fail-only permission wording, browser secret-ingress ambiguity, or log-only callback policy remains;
- local Markdown link validation: 81 files, every target resolved;
- `git diff --check`: pass;
- `pnpm check`: 74 files and 930 tests passed;
- lint and TypeScript checks: pass through `pnpm check`;
- production build and package exports: pass; 8 package entry points verified;
- candidate scope: documentation only; no staged paths and no `prompts/` path included.

## Independent closure review

A later independent working-tree review examined the candidate after both remediation rounds and returned **PASS — safe to begin Milestone 11**.

- **Finding:** none; no Critical, High, Medium, or Low architecture issue remained.
- **Correction:** none to canonical architecture, ADRs, plan, source ledger, security boundary, or milestone order. Changing an accepted decision without a finding would add churn rather than reduce risk.
- **Candidate identity:** uncommitted documentation overlay on `1c0689896b27c046b8b9a392251f6885e715515a`; release tag `v0.1.0-vertical-slice` remained unchanged.
- **Scope:** 8 modified and 10 new documentation files; no production, schema, protocol, UI, dependency, workflow, credential, provider, routing, tool, plugin, or release change.
- **Validation accepted by the review:** lint, typecheck, 467 unit tests, 262 integration tests, 58 property tests, 108 process tests, 34 Playwright tests, build with 8 package entry points, `pnpm check` with 74 files/930 tests, candidate whitespace checks, and 81-file Markdown link validation all passed.

### Recurrence rule

The round 1 and round 2 findings remain closed by the canonical corrections and checklists above. A future review must not re-report their pre-correction wording or obsolete line references as a current defect. Reopening one requires a concrete contradiction in the current canonical documents, a newly demonstrated unsafe trace, or implementation evidence that violates the frozen decision. Administrative commit/staging remains separate, and every `prompts/` path must stay outside the candidate.
