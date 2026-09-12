# Wi: repository guidance after S2 implementation

S2 contract `s2.1` is implemented and offline accepted. The implementation is in
`97ad00c109040edaf212fc141c34d307bc64442a`; the consistency-audit reports were
submitted in `48e23b5330ba6aa69be0bf02a4aab6c8d7226426`. The accepted S1 base was
`94d86e0c9db62d9fec208a26f5b4bb2487bcb5fa` (PR #2). Check the actual HEAD/worktree
before making changes. This is no longer a documentation-only planning branch.

Read current behavior and evidence first:
1. `docs/WI_PRODUCT_DIRECTION.md`
2. `docs/ARCHITECTURE.md` and `docs/EVENTS.md`
3. `docs/slices/s2/VERIFICATION.md` and `docs/slices/s2/verification.json`
4. `docs/slices/s2/CONTRACT.md`, `MATRIX.md`, and `VALIDATION.md` in that directory.

The S2 contract and matrix remain the acceptance specification. Their planning
status and the original `IMPLEMENTOR_PROMPT.md` are preserved phase records, not
an instruction to reimplement completed work. Verification reports retain their
pre-push observations; later submission/CI/merge evidence belongs to the PR and
Git history. Do not rewrite historical observations as though later checks had
already happened. Local 374-test/152-self-test evidence and submitted-head CI are
separate observations, not live model-selection or adherence proof.

s2.1 corrected a designer error in s2.0. `GatewayError::ToolFailed` still maps
through `GatewayError::code()` to `gateway_error`. Do not introduce `tool_failed`,
fabricate Ok error-shaped JSON, or change regression expectations to match the
superseded plan. Preserve the preflight/execution and cache/event distinctions.

S2 exposes one local function tool, `load_skill`, bound to the already discovered
SkillCatalog. It returns the selected entry's main SKILL.md instructions through
the existing registry and continuation. Global/project metadata remains automatic;
normal context-aware `wi run` exposes the tool for nonempty catalogs. Explicit
`--use-skill` and the direct S1 no-loader preparation API remain supported. The
shared library owns this behavior; the CLI is a thin caller, not the final product.

Inherited audit findings A-01 through A-05 remain OPEN and are documented in the
S2 verification report. S2 neither introduced nor fixed them. Repairs require a
separately approved scope and focused regressions; do not mark them resolved from
passing S2 tests. Production-provider restructuring also remains DEFERRED.

Do not add generic file/resource/script execution, hosted skills/uploads,
provider-native search, PTC, async tools, steering, permissions, skill-body caching,
or a replacement resource-budget framework without a new approved requirement.
C1 deletion remains complete: no RunLimits, count quotas, whole-run timers,
optional replacement budgets, or the withdrawn M4 timeout/progress proposal.
Preserve existing validation, cancellation, correlation, output provenance,
result ordering/reuse, event-delivery semantics, authentication and transports.

The final product is a one-owner multi-device service. Browser disconnect is not
cancellation. Application sessions persist; service restart stops tasks without
automatic replay/resumption. These recorded requirements do not themselves
start P1 storage or V1 service/UI implementation. Do not invent a database or
session-store interface without its approved design.

No new implementation, live validation, credential access, auth/profile/login/
renewal operation, private workspace/skill test, or release/deployment follows
automatically from S2 acceptance. Git writes and merge actions follow the owner's
explicit current authorization, not an old implementor prompt. Verification work
uses synthetic roots, scripted providers and loopback services unless separately
authorized otherwise. Trusted build tooling follows local permissions.

Pi authoring traffic is separate from Wi verification. The generation ledger is
unchanged at 31/50 used, 19 remaining; remaining balance is not authorization.
Preserve user work and the current organization. Report source inspection,
executed tests, hosted CI and live behavior separately. Flag an actual contract
conflict rather than silently changing semantics. Higher-priority rules and new
owner instructions prevail over historical task instructions.
