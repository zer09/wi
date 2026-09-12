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

New slice documents use `docs/slices/<slice>/`. S2's governing contract and
implementation handoff are below. P1/V1 storage and service design remain deferred.

## Offline-accepted repair: R1

S2 merged in PR #3 at `4eed18b`. R1 contract **r1.0** repairs inherited A-01..A-05:
plain terminal rendering, multiline preservation, legacy input preflight, one
expiry message, and empty response identity. The repairs are implemented in commit
`88b76c50756255193d0b681da748ed96ceec9f74`. Status is **OFFLINE_ACCEPTED**,
**accepted=true**. Local R1 gates passed with 421 Rust tests, 152 Node self-tests
and all three offline examples. The repeated complete-diff review passed with no
actionable findings. A small follow-up closes NB-02 and passes 422 Rust tests. Exact-head cross-platform CI is **NOT RUN**. R1 adds no feature or runtime
budget and does not reopen S2 or managed authentication.

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
