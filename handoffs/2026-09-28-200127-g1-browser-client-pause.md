# Handoff: G1 browser client paused for history redesign

## Handoff Metadata

- Created: 2026-09-28 20:01:27 +0800
- Updated: 2026-09-28 20:14 +0800
- Project: `/home/gc/projects/wi`
- Branch: `docs/g1-browser-conversation-client`
- Accepted runtime baseline: `76bb32fd04fd4737c0efcceaabc7d10387453147`
- Implementation checkpoint: `a89aeb49929929901e3613cc9bd3f450f3719f33`
- Documentation checkpoint: `f7a1ab5` (`docs: pause G1 for history design review [skip ci]`)
- Target PR: draft PR #10, `https://github.com/zer09/wi/pull/10`
- Overall status: `PAUSED_DESIGN_REVIEW`, `accepted=false`

## Goal

Preserve the current G1 browser-client implementation and evidence, stop further
feature work, and return the history-loading architecture to the planner/designer.
The owner requires initial session display at the latest activity with older history
loaded only when scrolling upward. Contract g1.0 instead requires full ascending replay
from `sid:0` through captured head `H` before SSE attaches.

## Completed

### Implementation checkpoint

Commit `a89aeb4` checkpoints 189 source/test files with 36,607 additions and 33
deletions. It contains the framework-free TypeScript client, six generated assets,
Rust asset serving and exact public boundary, strict DTO/SSE validation, reducer and
command lifecycle, safe DOM, joined browser fixtures, test-only fault seams, and
accumulated G1-00 through G1-20 work.

The checkpoint includes the incomplete G1-20 read-reconnect prototype. It is preserved
as partial owner work and is not acceptance evidence.

### Documentation checkpoint

Commit `f7a1ab5` adds:

- `docs/slices/g1/VERIFICATION.md`
- `docs/slices/g1/verification.json`
- `docs/slices/g1/DESIGN_REVIEW.md`

It also marks `CONTRACT.md`, `CLIENT_PROTOCOL.md`, `MATRIX.md`, `VALIDATION.md`, and
`IMPLEMENTOR_PROMPT.md` as historical/paused without rewriting their original
requirements. `AGENTS.md`, `docs/README.md`, and `docs/slices/README.md` now point to
the paused status.

Current matrix classification is:

- 15 `PASS_LOCAL_REVIEWED`
- 14 `PARTIAL`
- 2 `BLOCKED_DESIGN`: G1-12 and G1-20
- 1 `NOT_RUN`: G1-26

These are checkpoint dispositions, not acceptance scores.

### Final local checks before checkpoint

All completed successfully on the full implementation tree:

- `cargo fmt --all -- --check`
- `cargo check --locked --offline --all-targets`
- `cargo test --locked --offline --all-targets`
- `cargo clippy --locked --offline --all-targets -- -D warnings`
- `cargo build --locked --offline --all-targets`
- `cargo test --locked --offline --doc`
- `cargo test --locked --offline --test platform_support`
- `npm --prefix web run typecheck`
- `npm --prefix web run verify:assets`
- `npm --prefix web test`: 466 passing
- `env -u NODE_OPTIONS npm --prefix web run test:e2e -- --workers=1 --grep-invert
  "joined read reconnect"`: 26 passing in 4.2 minutes
- `git diff --check`

The excluded G1-20 scenario remains a retained failure. Do not report it as skipped
without explaining the two failed Window B mechanisms.

## Key Decisions

### Stop implementation

The owner explicitly paused implementation because the history issue may indicate
other planner assumptions that need review. Do not select another G1 increment.

### Latest-first product requirement

A browser selection or refresh must start with the latest canonical activity, not the
oldest event. Older history loads only on upward scroll. A new or refreshed browser
must not replay the entire raw event log before showing current activity.

### Separate history and live positions

The recommended redesign uses:

1. a server-projected, self-contained latest conversation window;
2. a backward-history cursor for older canonical pages; and
3. a separate live event cursor/head for gap-free SSE after the snapshot.

Do not implement this by reversing the current raw event SQL. Midstream reducer events
can lack the earlier acceptance/run/item context required for valid reduction.

### Shared owner token

The service has no registration or browser login. It uses one separately provisioned
shared owner bearer token. Every browser with the token has owner access to the same
sessions. This is intentional current behavior, not per-browser isolation.

### G1-20 observability

The manual browser SSE parser is standard UTF-8 JSON SSE over authenticated fetch.
EventSource is unsuitable because it cannot set the bearer header or provide the
required reconnect control.

Window B asks for proof that one selected complete frame reached Chromium but had not
yet been read/applied by JavaScript. Both attempted mechanisms failed to expose that
state in pinned Chromium:

- debugger-wide pause with CDP network inspection;
- approved asynchronous gate before the selected native `reader.read()`.

Both runs saw zero future identity-bearing `Network.dataReceived` evidence while held.
This is an evidence limitation, not a demonstrated production defect. The larger
history redesign may also remove or change this acceptance requirement.

## Retained Limitations

- G1 is not accepted and no row is promoted to hosted/cross-platform acceptance.
- G1-20 Window B and Window C are incomplete.
- G1-26 restart/reopen is not run.
- G1-11 context framing has two independent reviews, not the originally requested
  third review.
- G1-17 through G1-21 and G1-24 retain bounded-scenario gaps listed in
  `VERIFICATION.md`.
- `verify.py`, CLI self-test, and all eight examples were not freshly rerun after the
  final accumulated changes.
- No final three independent complete-diff reviews exist.
- No G1 browser CI, native macOS checkpoint run, live-provider run, deployment,
  release, or merge exists.
- Prior failures and review corrections are retained in `VERIFICATION.md`; do not
  rewrite the checkpoint as a clean first-pass implementation.

## Git and CI

The owner explicitly authorized commit, push to PR #10, and a PR comment, but required
that CI not trigger. Repository `.github/workflows/ci.yml` triggers on both `push` and
`pull_request` and has no path or explicit skip filter. Both checkpoint commits use
GitHub's supported `[skip ci]` commit directive.

Expected consequence: PR required checks can show Pending at the new head until a
later non-skipped commit runs CI. This is acceptable for the paused draft and must not
be mistaken for a completed check.

Do not amend the two checkpoint commits. Do not push another commit without checking
that it also cannot trigger CI.

## Next Steps

1. Planner/designer reads `docs/slices/g1/DESIGN_REVIEW.md`.
2. Resolve the 12 decisions listed there, especially conversation page unit, canonical
   projection, backward cursor, snapshot/SSE boundary, and reconnect policy.
3. Issue a revised contract, recommended as g1.1, with concrete request/response
   examples and revised matrix rows.
4. Decide which checkpoint code/tests remain valid, must be adapted, or should be
   retired.
5. Only after owner approval, resume implementation in bounded increments.
6. Before eventual acceptance, run the missing complete gates, browser CI, and three
   fresh complete-diff reviews against the revised contract.

## Read First on Resume

1. `AGENTS.md`
2. `docs/slices/g1/VERIFICATION.md`
3. `docs/slices/g1/verification.json`
4. `docs/slices/g1/DESIGN_REVIEW.md`
5. The historical `CONTRACT.md`, `CLIENT_PROTOCOL.md`, and `MATRIX.md`
6. This handoff

## Working Tree Expectation

After reconciliation, the branch contains four checkpoint commits above the prior
planning head: implementation, documentation, this handoff, and preservation of the
two original continuation handoff inputs. No file should remain modified or untracked.
