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

New slice documents use `docs/slices/<slice>/`. S2 planning files now exist below.
P1 and V1 storage/service documents are not yet created by this planning change.

## Active implementation handoff — S2 (plan only)

S1 and its merge-readiness repair were merged in PR #2 at `94d86e0` after the
submitted repair's Ubuntu/macOS/Windows workflows passed. The next contract is
model-selected main SKILL.md loading; it is not implemented by the planning PR.

- [S2 contract](slices/s2/CONTRACT.md): Fixed s2.0 library/tool/context behavior,
  scope, read timing, errors, output boundaries and authorized implementation.
- [S2 matrix](slices/s2/MATRIX.md): S2-00 through S2-23, initially NOT RUN,
  offline gates and requirements for the later implementation reports.
- [S2 implementor prompt](slices/s2/IMPLEMENTOR_PROMPT.md): Concrete offline
  task prompt; no provider traffic, Git writes or deferred-feature authority.

The future S2 reports will be `slices/s2/VERIFICATION.md` and
`slices/s2/verification.json`; they do not exist yet and are not acceptance evidence.

## Current product direction

- [WI_PRODUCT_DIRECTION.md](WI_PRODUCT_DIRECTION.md): Current requirements,
  confirmed product decisions, and S1/S2/P1/V1 slice boundaries.

## Active architecture and event documentation

- [ARCHITECTURE.md](ARCHITECTURE.md): Current module ownership, workspace context,
  authentication, transport, tools, and run-controller behavior.
- [EVENTS.md](EVENTS.md): Current provider and run event schemas, correlation,
  output validation, cancellation, and delivery semantics.
- [WI_AUTH.md](WI_AUTH.md): Current managed authentication, experimental login and
  renewal, external credential sources, and documented trust limits.

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
  Machine-readable C1.1 checks, matrix results, and review evidence.
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
