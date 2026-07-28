# Milestone 9 independent-review remediation 2

- **Status:** RESOLVED AT IMMUTABLE-CANDIDATE REVIEW
- **Review date:** 2026-07-28
- **Branch:** `milestone-9-final-acceptance`
- **Base:** `e8fc2a30730025f3108cd41d8225876297ad8f90`
- **Reviewed candidate at the first follow-up:** uncommitted 26-file overlay, reviewer digest `e819812ee4a03aedb334814301ddc72433a82974918d7d00780ee4ca0e8c55b6`
- **Candidate form at the second follow-up:** uncommitted 31-file overlay; the earlier reviewer digest is retained only as historical identity
- **Immutable implementation candidate verified later:** `328866ac236d8054072eb33821afe2effd037f68`

## Findings validated

The follow-up independent verdict `PASS WITH REQUIRED FIXES — do not tag` was materially correct.

| Finding | Classification | Resolution |
|---|---|---|
| No immutable candidate SHA or candidate CI | Valid release-process gate | Immutable local candidate and detached proof later completed at `328866ac`; exact-candidate hosted CI remains a post-push gate |
| E2E fixture output and unmatched IPC retention were unbounded | Valid test-harness and documentation defect | Corrected by reusing the existing bounded test-support collectors |
| Session-export secret assertion did not use a secret that could establish the intended credential boundary | Valid low-severity oracle weakness | Corrected with the actual HttpOnly browser credential plus independent storage/export/artifact scans |
| Classic branch-protection `404` was interpreted as absence of all branch enforcement | Invalid inference, corrected by follow-up review | Active repository ruleset `protect-master` applies to the default branch and strictly requires `required` |

No production runtime defect or accepted-ADR contradiction was established.

## Bounded E2E diagnostics and IPC

Both E2E process fixtures previously concatenated every stdout/stderr chunk and retained every unmatched child IPC message for the life of the child. This contradicted the test-strategy claim that fixture diagnostics were bounded.

The fixtures now reuse `@wi/test-support` instead of introducing a second bounds implementation:

- `BoundedProcessOutput` retains a 64 KiB tail for each output stream while tracking the complete-stream digest and byte count;
- `BoundedIpcRetention` validates and snapshots child messages, retaining at most 128 pending messages/256 KiB and 256 history messages/512 KiB;
- the new `takeWhere` operation lets request-ID and predicate-based E2E waits consume the existing bounded pending queue;
- fixture consumers receive a detached ordinary structured clone, preserving normal array methods without exposing retention-owned values;
- timeout and early-exit errors include only the bounded stdout/stderr tails.

The production server, gateway, storage, and browser protocol are unchanged. This is test-support and E2E-fixture hardening only.

## Credential-based export and artifact audit

The prior audit inserted `AUDIT_MILESTONE9_SECRET` only into a logger record. That was useful for logger redaction but did not make the session-export assertion a strong credential-leak oracle.

The acceptance scenario now keeps that logger-redaction probe and separately obtains the actual HttpOnly credential from Playwright's privileged browser context. The raw credential is never printed. Boolean assertions prove it is absent from:

1. `document.cookie` and all retained local/session storage keys and values;
2. IndexedDB database names (the accepted boundary has no browser database);
3. catalog summaries and canonical session event exports;
4. structured server logs and retained tool-execution evidence.

The child security-audit control requires at least one non-empty credential and returns booleans only. Assertion failures therefore do not echo the credential into test output.

## Candidate identity and branch enforcement

At this remediation step, the candidate had no immutable Git identity and the reviewed overlay digest became historical as soon as the overlay changed. Later verification established immutable implementation candidate `328866ac236d8054072eb33821afe2effd037f68`; the overlay digest must not be presented as that candidate identity.

The read-only GitHub probe

```sh
gh api repos/zer09/wi/branches/master/protection --silent
```

returned `HTTP 404: Branch not protected`. That endpoint reports only classic branch protection and does not report repository rulesets. A separate read-only query of ruleset `protect-master` (`18834509`) confirmed active enforcement on `~DEFAULT_BRANCH`: pull requests are required, status context `required` is strict, and no bypass actor exists. The workflow's `CI / required` aggregator is therefore repository-enforced.

Local identity closure later completed as follows:

1. committed exactly 31 intended Milestone 9 files as `328866ac`;
2. excluded `prompts/` and `Wi_M8_PR14_Remediation_Handoff/`;
3. passed frozen install, `pnpm check`, package-export verification, and focused acceptance from a detached worktree at that exact commit;
4. received an independent exact-candidate local review.

The remaining hosted boundaries are explicit push/PR authorization, hosted `CI / required` on the pushed candidate, verification that `protect-master` still enforces the required context before merge, merge identity/post-merge CI, and separate tag authorization. No commit, push, PR, branch rule, tag, or release was created by this historical remediation step itself.

## Deliberately unchanged

- No new logging package, E2E process supervisor, browser database scanner, or export subsystem was created.
- Browser traces remain disabled because they can retain the HttpOnly credential.
- The existing deterministic fake provider and safe built-in tools remain the complete v0.1 provider/tool scope.
- Existing timeout-only aggregate stability corrections remain unchanged.
- Repository policy was not mutated implicitly from a local code-review request.

## Regression map

- Shared bounded output and IPC retention: `packages/test-support/src/process-harness.ts`, `packages/test-support/src/bounded-ipc.ts`
- Predicate consumption regression: `packages/test-support/src/bounded-ipc.test.ts`
- Bounded E2E fixtures: `tests/e2e/fixtures/wi-test.ts`, `tests/e2e/fixtures/restartable-server.ts`
- Credential/export audit: `tests/e2e/fixtures/server-process.mjs`, `tests/e2e/milestone9-final-acceptance.spec.ts`
- Documented limits and release gates: `docs/testing/strategy.md`, `docs/release-candidate-checklist.md`

## Recurrence checklist

- [ ] E2E fixtures never concatenate unbounded child stdout or stderr.
- [ ] Unmatched fixture IPC is bounded by both message count and estimated bytes.
- [ ] Predicate/request-ID waits consume the bounded queue rather than retaining a second unbounded array.
- [ ] Diagnostic errors include tails and digests, not complete unbounded output.
- [ ] A secret-export assertion uses an actual non-session secret or credential, not only a logger-only sentinel.
- [ ] Browser credential tests return booleans and never interpolate the raw credential into assertion messages.
- [ ] Catalog/session exports and retained fixture artifacts are scanned independently.
- [ ] An overlay digest is not treated as an immutable candidate SHA after the overlay changes.
- [ ] `CI / required` enforcement is either repository-configured or explicitly recorded as procedural.
- [ ] Historical remediation records time-scope overlay and pending-gate statements instead of presenting them as current after closure.
- [ ] No tag is created before exact-SHA hosted CI and identity verification.

## Validation evidence

Completed during remediation:

- read-only GitHub probes: classic branch protection is absent, while active repository ruleset `protect-master` applies to the default branch and strictly requires `required` with no bypass actor;
- focused ESLint over test-support and E2E changes: pass;
- complete TypeScript typecheck: pass after replacing browser DOM globals with the repository's typed `globalThis` pattern;
- bounded IPC unit suite: 10 tests passed;
- focused Milestone 9 acceptance: passed in 8.0 seconds;
- actual HttpOnly credential found through Playwright's privileged context;
- browser-visible storage, catalog/session export, and retained-artifact credential scans: pass;
- logger-only redaction sentinel scan: pass;
- full Playwright suite: 34 tests passed;
- aggregate `pnpm check`: 74 files/928 tests passed in 220.42 seconds, followed by build and verification of all 8 package entry points;
- `git diff --check`, Markdown link validation, and retained-artifact scan: pass.

The later immutable-candidate review completed the detached-tree proof at `328866ac`: frozen install passed, `pnpm check` passed 74 files/928 tests with all 8 package exports verified, and focused acceptance passed in 8.4 seconds.

## Historical-state wording correction

An independent exact-candidate review found that both Milestone 9 remediation records still used present-tense phrases such as “current candidate,” “still has no immutable identity,” and “remaining local gate” after commit `328866ac` and its detached proof existed. The underlying historical actions were accurate, but the framing was misleading.

The records now:

- label uncommitted overlays and pending actions as state **at the relevant remediation/review step**;
- record `328866ac` as the later immutable implementation candidate;
- distinguish completed local identity/detached verification from still-pending hosted CI, merge, and tag boundaries;
- preserve the fact that the remediation steps themselves did not perform unauthorized Git or hosted writes.

This time-scoped wording avoids rewriting history while preventing old release-gate language from being mistaken for current status.

## Independent verification follow-up

The next independent local review examined the corrected 31-file overlay and returned `PASS WITH REQUIRED FIXES — do not tag`:

- all required local commands passed, including 34 browser tests, the 60-second fuzz profile, and `pnpm check` with 74 files/928 tests;
- the final acceptance scenario passed independently and exercised production replay-backlog overflow, durable restart, idempotency, partial-call safety, storage isolation, append-only triggers, and credential absence;
- bounded diagnostics and credential-based export assertions were accepted as corrected;
- no production, architecture, security, documentation, or coverage defect remained;
- at that review time, no immutable Milestone 9 candidate or exact-candidate hosted CI existed yet.

The review also found the ruleset distinction documented above. The classic protection endpoint's `404` is accurate but insufficient evidence for overall protection. Repository ruleset `protect-master` is the authoritative enforcement mechanism.

### Remaining gate after immutable-candidate review

No local candidate-identity gate remains: independent verification accepted commit `328866ac`, its 31-file scope, exclusions, and detached proof. Push, PR creation, exact-candidate hosted CI, merge, and tagging remain separate explicit hosted/version-control actions.
