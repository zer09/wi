# Milestone 10 PR #16 remote-review remediation

- **Status:** RESOLVED — LOCAL PASS; AWAITING COMMIT, EXACT-HEAD CI, AND REMOTE RE-REVIEW
- **Review date:** 2026-07-29
- **PR:** [#16 — docs: freeze v0.2 provider architecture](https://github.com/zer09/wi/pull/16)
- **Reviewed head:** `afd9290d280ff205536b241408f7dcfce3b069d1`
- **Base:** `1c0689896b27c046b8b9a392251f6885e715515a` (`v0.1.0-vertical-slice`)
- **Remote verdict:** REQUEST CHANGES
- **Earlier records:** [round 1](milestone-10-architecture-review-remediation.md), [round 2](milestone-10-architecture-review-remediation-2.md)

This record uses the remote PR review identity when referring to `WI-M10-H1`, `WI-M10-M1`, and `WI-M10-M2`. Earlier reviews reused those labels for different findings; their separate records remain historical evidence.

## Findings and corrections

| PR #16 finding | Correction | Canonical locations |
|---|---|---|
| `WI-M10-H1` — conflicting lifecycle commands could race across a prepared cross-store operation | Added one durable per-connection lifecycle owner spanning catalog prepare, file effect, and terminal catalog commit; monotonic lifecycle revision semantics; disjoint metadata revisions; stable `operation_in_progress`; recovery-before-next-operation; `failed_after_effect`; and six frozen precedence traces. | Provider-connections architecture §§4.4–4.5 and §17; ADR-0013; ADR-0014; Milestone 11 requirements/tests; `AGENTS.md` |
| `WI-M10-M1` — complete-catalog-loss credential recovery was not operationally specified | Added complete bounded root scans, envelope-bound nonsecret identity and `envelopeId`, safe candidate metadata, process/scan-bound opaque `recoveryRef`, explicit exact claim, original connection/generation restoration, fail-closed conflicts, recovery tombstones, deterministic crash outcomes, operation inventory, leakage rules, and acceptance rows. | Provider-connections architecture §§3.2, 9.2, 9.4, 16–17; ADR-0013; ADR-0014; Milestone 11 requirements/tests and credential matrix; security; `AGENTS.md` |
| `WI-M10-M2` — OAuth callback authorization was not composed with localhost Host/Origin/cookie policy | Bound callback/tombstone routes to strict exact-loopback single-Host validation and bounded parsing, while explicitly making attempt state/PKCE/redirect identity—not WebSocket Origin or browser cookie—the completion authority. Added restart, duplicate, Host, Origin, cookie, and containment tests. | Provider-connections architecture §§5.3, 16–17; ADR-0013; Milestone 13 constraints/gate; security; `AGENTS.md` |

## Frozen `WI-M10-H1` lifecycle decision

A connection or reserved connection identity has exactly one durable lifecycle-operation owner from prepare through terminal catalog commit. Create publication, replacement, relogin/reauthentication, same-generation refresh publication, disable, logout, delete, and future enable are mutually exclusive.

- Identical `commandId` and content resumes or returns the owner.
- Conflicting content under the same ID is a command conflict.
- A different lifecycle command receives one durable `operation_in_progress` result and is never queued or executed automatically.
- Recovery terminalizes the owner before another lifecycle operation starts.
- Lifecycle revision increments once at a credential/administrative cutoff; terminalization does not increment it again.
- Rename, capabilities, and rate/health telemetry use disjoint metadata revisions and cannot alter owner, generation, cutoff, or lease state.
- Unprovable post-effect terminal state becomes unavailable `failed_after_effect` with evidence preserved; it never returns to `ready` by guesswork.

| Required interleaving | Stable result |
|---|---|
| replace + disable | Disable receives `operation_in_progress`; a later new disable cannot be superseded by the completed replace. |
| replace + logout | Logout receives `operation_in_progress`; replacement terminalizes before a new logout may remove the credential. |
| delete + reauthenticate | Reauthentication receives `operation_in_progress`; delete/tombstone reconciliation prevents resurrection. |
| refresh + logout | The current owner finishes first; refresh cannot alter administrative state, and logout ownership blocks refresh publication. |
| two distinct replacements | Only the owner reserves generation and performs the file effect; the second result never executes later automatically. |
| rename/capability/rate update | Only disjoint metadata changes; lifecycle ownership and leases are unchanged. |

## Frozen `WI-M10-M1` catalog-loss recovery decision

Complete catalog loss never imports credentials automatically.

1. The file backend completes a bounded closed scan epoch over the entire managed root before issuing references. Cap exhaustion, root change, or duplicates produce no claimable references.
2. A valid unique envelope exposes only safe metadata and a process/scan-epoch-bound opaque `recoveryRef`, never a path, generated filename, secret, internal credential reference, or credential-derived hash.
3. Before prepare, restart invalidates the reference; presenting it returns stable `recovery_ref_expired`, and a new scan/new command are required.
4. An explicit idempotent operation repeats the complete scan, revalidates exact file identity and `envelopeId`, and claims one exact internal reference once.
5. Recovery restores the envelope's original `connectionId` and generation. Lifecycle revision starts at 1 for the rebuilt catalog epoch; pre-loss nonterminal provider work is interrupted rather than implicitly resumed.
6. Authoritative subject/account/project/workspace identity conflicts fail closed. Explicitly unverified identity remains distinct only by original connection ID and is never guessed.
7. Changed post-claim evidence leaves an unavailable original-identity recovery tombstone and consumes the claim. The next transition is normal explicit replacement/reauthentication, not reinterpretation of changed evidence.
8. Prepared, file-observed, terminal, and acknowledgement crashes return one stable result without a duplicate row or claim.

A recovery reference is permitted only in its bounded authenticated candidate response and matching selection command. Tests prove it is absent from unrelated payloads and persistent browser state, while generated filenames, internal references, credential-derived hashes, paths, and secrets are absent from browser, URL, log, diagnostic, trace, fixture, and export evidence.

## Frozen `WI-M10-M2` callback decision

The OAuth callback and clean tombstone retain Wi's exact `127.0.0.1` listener and strict exactly-one matching `Host` policy. Missing, duplicate, malformed, forwarded, wrong-port, and non-loopback Host are rejected before callback parsing.

WebSocket Origin validation is not callback authorization. Top-level provider navigation may omit Origin or carry a cross-site provider Origin; neither grants authority or CORS access. A Wi browser cookie is not required, and a present, missing, stale, or unrelated cookie cannot authorize/reject completion or establish/rotate browser authentication.

Only the exact unexpired attempt, `loginId`, one-time state, backend PKCE verifier, registered redirect URI/method/response mode, and provider response authorize completion. Query/form targets, headers, fields, body, content type/charset, parser work, and duplicate fields are bounded. Restart relies on the external attempt store. No-store/no-cache/no-referrer/no-external-content and clean-history guarantees remain mandatory.

## Independent verification evidence

Fresh read-only Pi sessions, separate from the editing session, reviewed each atomic correction:

- `WI-M10-H1`: **RESOLVED** — exclusive owner, revision semantics, stable conflicts, recovery ordering, metadata isolation, all six traces, and crash tests were complete.
- `WI-M10-M1`: initial reviews returned **PARTIALLY RESOLVED** and identified authoritative-identity, truncated-scan, post-claim transition, leakage-test, pre-claim restart, permitted-reference, project-identity, and acceptance-matrix ambiguities. Each was corrected. Final classification: **RESOLVED**.
- `WI-M10-M2`: **RESOLVED** — Host, Origin, cookie, completion authority, parser bounds, restart, tombstone, and Milestone 13 tests were consistent.

## Recurrence checklist

Before Milestone 11 begins:

- [ ] One lifecycle owner spans prepare/file/terminal and recovery resolves it before another mutation.
- [ ] Conflicting commands have stable non-queued results; lifecycle and metadata revisions remain disjoint.
- [ ] Every required lifecycle interleaving/crash boundary proves one owner, generation, result, and no resurrection.
- [ ] Catalog-loss discovery completes the whole bounded root scan before issuing any claimable reference.
- [ ] Recovery restores exact original connection/generation and checks envelope-bound authoritative identity without guessing unverified identity.
- [ ] Stale, arbitrary, duplicate, changed, malformed, conflicting, and already-claimed evidence has one fail-closed result and remains preserved.
- [ ] Recovery references and internal file identities obey their exact permitted/excluded evidence boundaries.
- [ ] The complete credential acceptance matrix is implemented, including pre-claim restart and post-claim tombstone transitions.

Before Milestone 13 begins:

- [ ] Callback and tombstone inherit exact-loopback single-Host validation before parsing.
- [ ] Origin and Wi browser cookie are not OAuth completion authority and grant no CORS/browser credential.
- [ ] Attempt state, PKCE, expiry, `loginId`, and exact redirect method/URI/mode authorize one completion across restart.
- [ ] Host, Origin, cookie, parser/field/body, duplicate, restart, and containment matrices all pass.

## Deliberately unchanged

```text
Documentation and ADR only
No production implementation
No new dependency
No OpenAI request
No OAuth code
No credential file
No automatic routing
No real tool or plugin
```

No protocol schema, SQLite schema/migration, browser UI, workflow, release marker, or tag changed. `prompts/` and the local remediation handoff directory remain outside the candidate.

## Final validation evidence

Completed against the corrected working-tree candidate:

- atomic correction verification: `WI-M10-H1` **RESOLVED**, `WI-M10-M1` **RESOLVED** after verifier-raised ambiguities were corrected, and `WI-M10-M2` **RESOLVED**;
- independent complete local architecture review: all 45 adversarial traces deterministic; no Critical, High, Medium, or Low finding; **PASS — safe to push for CI and remote re-review**;
- `git diff --check`: pass;
- Markdown links: 82 files, all local targets resolved;
- `pnpm lint`: pass;
- `pnpm typecheck`: pass;
- `pnpm test:unit`: 42 files, 467 tests passed;
- `pnpm test:integration`: 6 files, 262 tests passed;
- `WI_FC_SEED=737373 pnpm test:property`: 13 files, 58 tests passed;
- `pnpm test:process`: 9 files, 108 tests passed;
- `pnpm test:e2e`: 34 tests passed;
- `pnpm build`: pass, 8 workspace package entry points verified;
- `pnpm check`: 74 files, 930 tests passed;
- candidate scope: 8 modified tracked documentation/instruction files plus this new remediation record; no staged path, production file, dependency, workflow, `prompts/`, or handoff file;
- release marker: `v0.1.0-vertical-slice` remains an annotated tag dereferencing to base `1c0689896b27c046b8b9a392251f6885e715515a`; no v0.2 tag exists.

This is local evidence only. The remediation commit still requires exact-head `checks`, `e2e`, and `required`, followed by fresh independent remote approval before merge or Milestone 11.
