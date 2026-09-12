# Local implementor assignment: R1 r1.0

Implement the fixed R1 consistency-repair contract. Read AGENTS.md and:

- docs/slices/r1/CONTRACT.md
- docs/slices/r1/MATRIX.md
- docs/slices/r1/VALIDATION.md
- the inherited A-01..A-05 record in docs/slices/s2/VERIFICATION.md

Accepted runtime baseline: 4eed18be8baaf43be886164d192021b2e2e5aa28.
Inspect actual HEAD, ancestry and the complete worktree; planning commits are
expected. Preserve all owner changes. S2 s2.1 is already accepted and merged.

The designer has fixed the decisions. Acknowledge the scope and proceed with
regressions, implementation, offline verification and independent full-diff review.
Do not return another architecture plan or stop after planning. Private helper
names and ordinary implementation details are yours; observable policy is not.

Repair ONLY these inherited findings:

1. A-01/A-02: share a small private multiline presentation filter across legacy
   generate/tool-demo and wi run. Keep LF/HT and non-control scalars, drop other
   controls. Keep the existing one-line diagnostic filter. Preserve raw prefix
   comparisons, ModelResponse/native data, JSON, labels and I/O propagation.
2. A-03: validate initial input, optional follow-up as its own one-item request,
   and actual SessionOptions before legacy generate's provider/auth/session open.
   An invalid follow-up must consume zero first requests. Keep valid semantics.
3. A-04: change only AuthExpired's display text to the contract's accurate
   owner-specific guidance. Leave GatewayError::code() and auth behavior unchanged.
4. A-05: reject empty required response identities in the shared codec before
   publication/settlement; preserve opaque nonempty IDs, valid terminal-only
   streams, empty text/deltas, recovery and proper unknown/terminal_received
   classification. Missing-MIME admission keeps its own existing error category.

Complete R1-00 through R1-19. Reproduce each finding with a failing behavior
assertion before its semantic fix, using minimal test seams through actual
production paths. Do not present helper-only expected JSON, compilation failures,
or old green suites as a demonstrated regression. Test both loopback transports
and the public run consumer, plus legacy CLI paths. Preserve platform-specific
fixture guards and warning-denied CI.

No new feature, framework, dependencies, runtime budgets, RunLimits, tool progress/
timeout API, provider reorganization, shell/files, hosted skills, storage, service,
GUI, retry/failover or authentication redesign. The final product requirements
remain recorded but are not part of this repair. If scope cannot satisfy an
assertion, report the exact conflict before broadening it.

Use only synthetic roots, credentials, tools and loopback servers. No real
credentials/private skills, auth/profile/login/refresh commands, provider calls,
smoke/live runner invocations or hosted probes. The ledger stays 31/50 used,
19 remaining. Build-tool cache access is distinct from account operations.

Run the matrix's six Cargo gates, uv verify gate, Node self-test, all three offline
examples and whitespace checks. Have an independent reviewer inspect the complete
accumulated diff and report drafts. Fix confirmed in-scope review issues and rerun
relevant checks. Report actual test counts and platform gaps, not target counts.

Create docs/slices/r1/VERIFICATION.md and docs/slices/r1/verification.json with
all 20 row IDs and five finding IDs, failing-before/passing-after evidence,
source/test links, commands, revision/worktree, reviews and zero-live accounting.
Update active behavior docs and links; preserve S2 and older evidence unchanged.

The owner has authorized the scoped local repair, not implementation Git writes.
Leave changes uncommitted unless the owner separately authorizes commit/push.
Do not merge, release or deploy. Subsequent exact-head CI and merge approval are
separate from the offline result. No next milestone starts automatically.
