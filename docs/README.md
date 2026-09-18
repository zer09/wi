# Wi documentation

Start here for current documentation and the records of completed work.

The [top-level README](../README.md), `docs/ARCHITECTURE.md`, `docs/EVENTS.md`,
and `docs/WI_AUTH.md` describe current implemented behavior.
`docs/WI_PRODUCT_DIRECTION.md` is the current requirements and slice-boundary
record, not an implementation report.

Contracts, matrices, prompts, reports, handoffs, templates, and packaging/source
records preserve state or evidence from when authored. Historical prompts do not
authorize new work. Plan-time `PLAN ONLY` and `NOT RUN` text in completed contract
records remains historical. Later verification reports establish completion
within their stated scope and evidence limits. Tested revisions, worktree states,
ledgers, and unrun checks describe each record's own stage, not the current HEAD.

New slice documents use `docs/slices/<slice>/`. P1-A storage is accepted and merged
at `34b4cfd`. P1-B1 runtime capture is accepted and merged in PR #6 at `6fe0a53`.
P1-B2 plus B2-E01 joined acceptance is accepted and merged in PR #7 at `50f4dff`.
Its reviewed head `e25279a` passed push35227116004 attempt3 and PR35227120456 attempt1
on Ubuntu/macOS/Windows. Earlier watchdog failures remain in the evidence; a passing
rerun is not proof they were fixed. [Merge closure](https://github.com/zer09/wi/pull/7#issuecomment-5716447572)
records the exact review, attempts and scope.

## Accepted: V1-A service-owned execution

Contract **v1a.0**, baseline `50f4dffe5d912615014edc46cf1bf1e1b68e6857`.
Status: **ACCEPTED; complete; accepted=true; hosted CI PASS** at implementation head
`fad3855db70ff4151a5c27ec3f64d04fa9097cbb`. Exact-head push run **35320097103** and
pull-request run **35320100396** passed all six Cargo steps on Ubuntu/macOS/Windows.
V1A-00..28 are complete with local evidence; V1A-29 is PASS with no blockers.
During acceptance preparation, PR #8 was observed open and draft, not merged.
The recorded runs prove only the implementation revision above. Current PR-head merge
checks are external GitHub merge-readiness evidence, separate from this fixed
implementation evidence.

The additive in-process `wi::service::RunHost` owns tracked B2 execution independently
of client, ticket and waiter lifetimes. Actual committed acceptance is observable before
completion, cancellation explicitly identifies the application session and run, and
owner shutdown drains work before closing storage. Construction or reopen does not start
old work. This reuses B2 rather than adding another model/tool loop.

- [V1-A verification](slices/v1a/VERIFICATION.md) and
  [machine report](slices/v1a/verification.json): Local and exact-head hosted evidence,
  all 30 row dispositions, complete-diff reviews, historical pre-commit fingerprints,
  failure history, measurements and limits. Hosted Cargo checks are not live/provider proof.
- [`host_offline`](../examples/host_offline.rs): Public host APIs with synthetic SQLite,
  S2 skill loading, real tools, dropped observers, explicit replay and orderly shutdown.
- [V1-A contract](slices/v1a/CONTRACT.md), [API](slices/v1a/API.md),
  [matrix](slices/v1a/MATRIX.md), [validation](slices/v1a/VALIDATION.md), and
  [implementor prompt](slices/v1a/IMPLEMENTOR_PROMPT.md): Frozen planning records. Their
  `PLAN ONLY` and `NOT RUN` text describes the state when authored, not the current result.

V1-B remains deferred. It will separately cover network commands, client authentication,
browser-safe protocol and reconnect/subscription behavior. GUI and ordinary CLI
persistence also remain unimplemented. Existing session/history read APIs remain canonical.

## Current implementation: P1-B2 stored conversation submissions

Contract **p1b2.0** adds `wi::execution::run_in_session` and storage-only
`prepare_session_replay`. A new explicit task uses canonical history at a fixed head:
stored prepared prompts, authoritative native/effective responses and exact correlated
results. The shared controller retains B1 recording and ownership semantics.

Session database schema 2 adds `run.history.selected` and `run.provider.bound`, with
lazy transactional schema-1 migration on explicit open. Old history and receipts remain
unchanged. Catalog schema stays 1; stored envelopes stay 1 and runtime/provider schemas
stay 2/1. Legacy schema-1 history remains readable but lacks replay provenance; migration
never assigns it to the current account.

Replay needs selected, bound, closed exchanges and complete actual results. Normal
terminal history can contribute without a final-result append when `RunFinished` and
canonical exchanges agree. Empty-run exclusion needs the actual zero-attempt result.
Complete process-interrupted exchanges may inform a new task; incomplete, uncertain,
active or unbound history is rejected without repair, truncation or automatic resumption.
A fresh WebSocket sends the selected conversation's history without an old parent ID;
that history is empty for the first task in a new application session. SSE retains native
history. The actual opened account must match before installation or generation.

- [P1-B2 contract](slices/p1b2/CONTRACT.md), [schema](slices/p1b2/SCHEMA.md) and
  [matrix](slices/p1b2/MATRIX.md): Frozen requirements and plan-time statuses.
- [P1-B2 validation](slices/p1b2/VALIDATION.md) and
  [implementor prompt](slices/p1b2/IMPLEMENTOR_PROMPT.md): Historical planning handoff.
- [P1-B2 verification](slices/p1b2/VERIFICATION.md) and
  [machine report](slices/p1b2/verification.json): Local and exact-head hosted evidence
  for the source and evidence revisions, including B2-E01 joined closure; live opaque
  portability is not established.
- [conversation_offline](../examples/conversation_offline.rs): Public APIs, actual tools,
  stored skill content and an explicit new task after reopen; no credentials or network.

Ordinary `wi run` remains nonpersistent, with no normal CLI session commands. B2 alone
did not add service ownership, but V1-A now composes B2 under the in-process `RunHost`.
Service authentication, browser protocol and GUI remain unimplemented. Neither B2 nor
V1-A adds automatic task resumption or retries.

## Accepted and merged: P1-B1 actual runtime capture

Contract **p1b1.0**, baseline `34b4cfd0d3ecf286869a239997267dbd75c28c0b`.
The matrix preserves all 30 original NOT RUN statuses as planning text, not current
test evidence. `wi::execution::run_persisted` records only the explicitly supplied
prepared input incrementally. It commits acceptance before provider work, awaits actual
runtime/tool-result records, preserves separate execution versus recording outcomes,
and holds storage ownership during execution. It uses the shared controller, not a
second loop. This does not claim restored-conversation model context or a running service.

- [P1-B1 contract](slices/p1b1/CONTRACT.md): Fixed API, shared-loop integration,
  acceptance/effect/commit ordering, failure/close behavior and explicit B1/B2 split.
- [P1-B1 matrix](slices/p1b1/MATRIX.md): Thirty real producer-to-consumer cases,
  loopback/process tests, gates, performance evidence and report requirements.
- [P1-B1 source validation](slices/p1b1/VALIDATION.md): Existing interfaces versus
  authorized changes, source pins, decision ledger and static-review limits.
- [P1-B1 implementor prompt](slices/p1b1/IMPLEMENTOR_PROMPT.md): Historical local
  assignment, not authorization to execute completed work.
- [P1-B1 verification](slices/p1b1/VERIFICATION.md) and
  [machine report](slices/p1b1/verification.json): Local validation, independent review
  and exact-head Ubuntu/macOS/Windows CI. PR #6 merged at `6fe0a53`.

The [public offline example](../examples/persisted_run_offline.rs) uses real context
preparation, a finite in-process provider, AddNumbers and SQLite under a synthetic root.
It independently reads committed partial text and exact tool bytes before scripted
provider continuation admission, then proves exact reopen without provider/tool work.
Run `cargo run --offline --locked --example
persisted_run_offline`, or add `--release`. The [top-level measurement notes](../README.md#incremental-supplied-input-capture-p1-b1)
define finite latency samples, the counted operation window and post-close size limits.
Catalog refresh is explicit. The caller retains and awaits the execution future.

B1 remains supplied-input capture, not restored-history execution. B2 supplies new
explicit tasks with compatible provider/account-bound native history. V1-A now owns
those executions independently of readers through the in-process `RunHost`. Ordinary
CLI persistence, V1-B networking/browser/GUI, and automatic task resumption/retry remain
unimplemented.

## Current acceptance: P1-A storage only

Contract **p1a.0**, runtime baseline `dd720c0` (R1/NB-02 merged). The shared
`wi::storage` library uses minimal SQLx 0.9.0 SQLite/Tokio features, per-session
canonical SQLite databases and a session catalog. It provides receipts, typed
history/projections, short cursor reads, explicit catalog refresh/repair and lazy
prior-instance interruption without execution. Ordinary `wi run` remains unchanged.
P1A-00..P1A-31 PASS. The local gates and final complete-diff review passed. The first
macOS-only Unix-socket fixture failure was fixed. A later macOS run exposed delayed
lease release when another process held a duplicate descriptor; explicit healthy
unlock and its regression fixed that race. Exact-head Ubuntu/macOS/Windows push and
PR workflows passed at `0839af9`. The frozen plan's NOT RUN headings remain historical,
not current evidence.

PR #5 subsequently merged at `34b4cfd`. Planner correction `95353ef` changed only
P1A-04's stale platform limitation; its push run 34935741002 and PR run 34935743731
passed all six Cargo steps on all three operating systems before the expected-head
merge. [Merge closure](https://github.com/zer09/wi/pull/5#issuecomment-5675695793)
records the source review, exact CI and retained limits without rewriting old results.

- [P1-A contract](slices/p1a/CONTRACT.md): Exact storage-only scope, API, ownership,
  creation, acknowledgments, catalog refresh/repair and restart semantics.
- [P1-A schema](slices/p1a/SCHEMA.md): First catalog/session DDL and source-aligned
  record/projection contracts; not a claim of an installed database.
- [P1-A matrix](slices/p1a/MATRIX.md): P1A-00..P1A-31, real SQLite/process oracles,
  regression gates, performance observations and future report requirements.
- [P1-A validation](slices/p1a/VALIDATION.md): Checkpoint/new local report intake,
  current Rust source mapping, driver references and planning-validation limits.
- [P1-A implementor prompt](slices/p1a/IMPLEMENTOR_PROMPT.md): Fresh local agent
  assignment; implementation/offline tests only, no independent replanning or Git/live work.

- [P1-A verification report](slices/p1a/VERIFICATION.md): All 32 row dispositions,
  actual local commands/counts, process/fault evidence, performance and review history.
- [P1-A machine report](slices/p1a/verification.json): Matching structured evidence,
  dirty-worktree history, review and submitted-CI results, platform limits and unchanged ledger.

P1-A acceptance did not include runtime capture. Accepted B1 supplies that boundary;
accepted B2 adds stored-history submissions. Ordinary `wi run` persistence, service
authentication, browser protocol and GUI remain NOT IMPLEMENTED (V1).
P1-A, B1 and B2 have exact-head Ubuntu, macOS and Windows evidence.
Windows symlink privilege, caller-owned ACLs and same-user TOCTOU remain explicit limits.

## Historical-citation errata (2026-09-12 UTC)

These citation corrections leave the four historical report files unchanged.

- C1: `src/run/events.rs:35-59` should read `src/run/events.rs:35-58`
  in `docs/WI_EXECUTION_POLICY_C1_VERIFICATION.md:110,150` and evidence `E01`
  in `docs/wi-execution-policy-c1-verification.json`.
- S2: `.github/workflows/ci.yml:1-24` should read `.github/workflows/ci.yml:1-23`
  in `docs/slices/s2/VERIFICATION.md:263` and the `ci` observations in
  `docs/slices/s2/verification.json`.

Both behavioral claims remain correct: `RunEvent` has four lifecycle kinds and
two wrappers; CI configures Ubuntu, Windows and macOS with all six Cargo gates.

## Offline-accepted and merged repair: R1

S2 merged in PR #3 at `4eed18b`. R1 contract **r1.0** repairs inherited A-01..A-05:
plain terminal rendering, multiline preservation, legacy input preflight, one
expiry message, and empty response identity. The repairs are implemented in commit
`88b76c50756255193d0b681da748ed96ceec9f74`. Status is **OFFLINE_ACCEPTED**,
**accepted=true**. Local R1 gates passed with 421 Rust tests, 152 Node self-tests
and all three offline examples. The repeated complete-diff review passed with no
actionable findings. A small follow-up closes NB-02 and passes 422 Rust tests.
The committed reports describe the pre-push stage. Subsequent submitted-head CI and
merge closure are recorded in [PR #4](https://github.com/zer09/wi/pull/4): final head
`a4ee1db`, merge `dd720c0`. R1 adds no feature or runtime budget and does not reopen
S2 or managed authentication. These earlier results are not P1-A execution evidence.
- [R1 contract](slices/r1/CONTRACT.md): Exact fixes, compatibility boundaries,
  allowed edits, implementation sequence and authorization.
- [R1 matrix](slices/r1/MATRIX.md): R1-00..R1-19, all initially NOT RUN;
  failing-before/passing-after evidence, offline gates and report structure.
- [R1 source validation](slices/r1/VALIDATION.md): Pinned source-to-contract map,
  actual codes/order and explicit limits of planning review, not test results.
- [R1 implementor prompt](slices/r1/IMPLEMENTOR_PROMPT.md): Execute the fixed
  scoped repair, offline verification and independent review; no Git/live work
  without separate authorization.

- [R1 verification report](slices/r1/VERIFICATION.md): Actual local evidence and
  attributed red/green, increment-review and final-review history; A-01..A-05 and
  R1-00..R1-19 PASS.
- [R1 machine verification report](slices/r1/verification.json): Commands, counts,
  worktree, offline acceptance, pending CI, zero-live accounting and unchanged
  31/50 ledger.

The R1 plan records and S2 reports retain their original phase and findings
byte-for-byte. Later evidence is recorded here, not retroactively in those files.

## Completed offline implementation: S2

S1 and its merge-readiness repair were merged in PR #2 at `94d86e0` after the
submitted repair's Ubuntu/macOS/Windows workflows passed. Current source adds
model-selected main `SKILL.md` loading through the shared preparation helper,
registry and public controller. Normal `wi run` exposes `load_skill` automatically
for nonempty catalogs; explicit `--use-skill` remains available. Supporting files
and scripts are not read or executed. The S2 reports record passing local offline
gates and three passing independent accumulated reviews. S2 is offline accepted.
Live model selection/adherence is NOT RUN.

- [S2 contract](slices/s2/CONTRACT.md): Fixed s2.1 library/tool/context behavior,
  scope, read timing, errors, output boundaries and authorized implementation.
- [S2 matrix](slices/s2/MATRIX.md): S2-00 through S2-23, initially NOT RUN,
  offline gates and requirements for the later implementation reports.
- [S2 implementor prompt](slices/s2/IMPLEMENTOR_PROMPT.md): Concrete offline
  task prompt; no provider traffic, Git writes or deferred-feature authority.
- [S2 documentation validation](slices/s2/VALIDATION.md): Source-based correction
  of the s2.0 error-category conflict and review of all 24 requirements. Not a
  Rust test run or S2 acceptance. Existing ToolFailed serializes as gateway_error.

- [S2 verification report](slices/s2/VERIFICATION.md): Actual local offline execution,
  24-row evidence mapping, attributed increment reviews, and three passing independent
  accumulated reviews. Status is OFFLINE_ACCEPTED.
- [S2 machine verification report](slices/s2/verification.json): Structured command,
  matrix, environment, review and authorization evidence; accepted=true.
  Neither report claims current submitted-revision CI success, native macOS/Windows
  execution, or live model adherence.

## Current product direction

- [WI_PRODUCT_DIRECTION.md](WI_PRODUCT_DIRECTION.md): Current requirements,
  confirmed product decisions, and S1/S2/P1/V1 slice boundaries.

## Active architecture and event documentation

- [ARCHITECTURE.md](ARCHITECTURE.md): Current module ownership, workspace context,
  catalog-bound main-file loading, read timing, result reuse, authentication,
  transport, tools and run-controller behavior.
- [EVENTS.md](EVENTS.md): Current provider and run event schemas, initial manifest
  semantics, preflight versus executed errors, output boundaries, cancellation
  and delivery semantics.
- [WI_AUTH.md](WI_AUTH.md): Current managed authentication, experimental login and
  renewal, external credential sources, and documented trust limits.

## Offline examples

- [skills_offline.rs](../examples/skills_offline.rs): Explicit initial body selection
  through the compatible no-loader `prepare_run` API.
- [skill_loading_offline.rs](../examples/skill_loading_offline.rs): Discovery,
  `prepare_run_with_skill_loading`, returned registry and `wi::run::run` with a
  separate scripted provider. Asserts absent initial bodies, one real load, exact
  follow-up body and final fixture text. Uses temporary synthetic roots without
  ambient context/auth configuration, credentials or provider networking.
  Run with `cargo run --example skill_loading_offline`; this is not live model evidence.

- [storage_offline.rs](../examples/storage_offline.rs): Synthetic context capture,
  supplied run DTOs, real registry output, create/rename/receipts, explicit refresh,
  listing/history and close/reopen. Three finite latency samples include connection
  costs; no provider requests, runtime integration or power-loss claim.
  Run with `cargo run --example storage_offline`.

- [conversation_offline.rs](../examples/conversation_offline.rs): Two explicit tasks
  through `run_in_session`, with native/effective history, real tool results and stored
  skill bodies across close/reopen. Run with `cargo run --example conversation_offline`.

## Completed contracts and matrices

- [WI_AUTH_MATRIX.md](WI_AUTH_MATRIX.md): Completed naming and managed-auth matrix
  with recorded offline and bounded live results.
- [WI_RUN_CONTROLLER.md](WI_RUN_CONTROLLER.md): Completed M3 run-controller
  contract; its run-limit policy was removed by C1.1.
- [WI_RUN_MATRIX.md](WI_RUN_MATRIX.md): Acceptance requirements for completed M3,
  including historical run-limit checks.
- [WI_RUN_IMPLEMENTOR_PROMPT.md](WI_RUN_IMPLEMENTOR_PROMPT.md): Historical offline
  execution prompt for M3.
- [WI_EXECUTION_POLICY_C1.md](WI_EXECUTION_POLICY_C1.md): Completed C1.1 contract
  for deleting RunLimits and whole-run count/time policy.
- [WI_EXECUTION_POLICY_C1_MATRIX.md](WI_EXECUTION_POLICY_C1_MATRIX.md): Acceptance
  requirements for the completed C1.1 removal.
- [WI_EXECUTION_POLICY_C1_PROMPT.md](WI_EXECUTION_POLICY_C1_PROMPT.md): Historical
  offline execution prompt for C1.1.
- [WI_LOCAL_SKILLS_S1.md](WI_LOCAL_SKILLS_S1.md): Completed S1 workspace context
  and local-skills contract, including explicit activation and hosted-placeholder removal.
- [WI_LOCAL_SKILLS_S1_MATRIX.md](WI_LOCAL_SKILLS_S1_MATRIX.md): Acceptance
  requirements for completed S1 discovery, preparation, CLI behavior, and non-regression.
- [WI_LOCAL_SKILLS_S1_PROMPT.md](WI_LOCAL_SKILLS_S1_PROMPT.md): Historical offline
  execution prompt for S1.

## Verification reports

- [COMBINED_DESIGN_REPORT.md](COMBINED_DESIGN_REPORT.md): Historical summary of
  gateway repairs, managed authentication, and their verification evidence.
- [LOCAL_VERIFICATION.md](LOCAL_VERIFICATION.md): Historical local repair and
  managed-auth results, including failed attempts and later passes.
- [local-verification.json](local-verification.json): Machine-readable local
  repair and managed-auth evidence, historical follow-ups, and ledger.
- [VERIFICATION.md](VERIFICATION.md): Original uncompiled source-delivery report,
  not the later repair result.
- [verification-status.json](verification-status.json): Machine-readable status
  of the original unverified source delivery.
- [WI_RUN_VERIFICATION.md](WI_RUN_VERIFICATION.md): M3 offline acceptance and
  separately authorized post-M3 WebSocket/SSE verification.
- [wi-run-verification.json](wi-run-verification.json): Machine-readable M3
  acceptance, matrix results, and post-M3 live evidence.
- [WI_EXECUTION_POLICY_C1_VERIFICATION.md](WI_EXECUTION_POLICY_C1_VERIFICATION.md):
  C1.1 offline acceptance, run-limit removal, retained constraints, and review evidence.
- [wi-execution-policy-c1-verification.json](wi-execution-policy-c1-verification.json):
  Machine-readable C1.1 checks, matrix results, and evidence attribution.
- [WI_LOCAL_SKILLS_S1_VERIFICATION.md](WI_LOCAL_SKILLS_S1_VERIFICATION.md): S1
  offline acceptance, preparation and activation evidence, reviews, and trust limits.
- [wi-local-skills-s1-verification.json](wi-local-skills-s1-verification.json):
  Machine-readable S1 acceptance, checks, matrix results, and evidence attribution.

## Historical design material

- [LOCAL_AGENT_HANDOFF.md](LOCAL_AGENT_HANDOFF.md): Original v0.2.0 context and
  repair/verification handoff, not current task instructions.
- [REVIEW_CHECKLIST.md](REVIEW_CHECKLIST.md): Original v0.2.0 review agenda and
  regression targets, not verified findings.
- [WI_DESIGN_SCOPE_AUDIT.md](WI_DESIGN_SCOPE_AUDIT.md): Historical review of
  RunLimits provenance and the C1.1 removal decision.

## Templates, packaging evidence, and source records

- [build-attempt.txt](build-attempt.txt): Original blocked build-gate output from
  the environment without Cargo.
- [LOCAL_VERIFICATION_TEMPLATE.md](LOCAL_VERIFICATION_TEMPLATE.md): Historical
  Markdown report template; placeholders are not evidence.
- [local-verification.template.json](local-verification.template.json): Historical
  JSON report template, not executed verification evidence.
- [PACKAGING_AUDIT.md](PACKAGING_AUDIT.md): Historical ZIP integrity and document
  inclusion audit, not runtime verification.
- [packaging-audit.json](packaging-audit.json): Machine-readable evidence for the
  original packaging audit.
- [original-v0.2.0-files.json](original-v0.2.0-files.json): Original archive hash
  and 35-file checksum inventory, not a current-tree manifest.
- [SOURCES.md](SOURCES.md): Dated protocol, compatibility, and Rust library
  references for the original source milestone.
