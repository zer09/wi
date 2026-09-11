# Wi: active planning handoff S2 — model-selected local skill loading

Contract `s2.1`; accepted runtime baseline:
`94d86e0c9db62d9fec208a26f5b4bb2487bcb5fa` (PR #2 merged).
This branch changes documentation only. Runtime implementation begins when the
owner supplies the implementor prompt. Execute the fixed contract and matrix;
do not replace them with another architecture-planning assignment.

Read:
1. `docs/WI_PRODUCT_DIRECTION.md`
2. `docs/slices/s2/CONTRACT.md`
3. `docs/slices/s2/MATRIX.md`
4. `docs/slices/s2/IMPLEMENTOR_PROMPT.md`
5. `docs/slices/s2/VALIDATION.md` and the accepted S1 evidence/current source.

s2.1 corrects a designer error in s2.0. Keep GatewayError::ToolFailed mapped by
existing GatewayError::code() to gateway_error. Do not add a tool_failed category,
change src/error.rs, fabricate Ok error JSON, or rewrite existing regression
expectations. The reported assignment_conflict was correct, not an implementation
failure. Read the corrected failure-stage and cache/event distinctions before
resuming; the feature scope and 24 matrix IDs are unchanged.

S2 adds one local function tool, `load_skill`, bound to an already discovered
SkillCatalog. It returns that entry's main SKILL.md instructions through the
existing ToolRegistry and provider continuation. Global/project metadata remains
automatic. Normal context-aware wi run exposes the tool when the catalog is
nonempty; no new enable flag or private planning model is required. Explicit
--use-skill continues to work. The shared library supplies this functionality;
the CLI is a thin caller, not the final product architecture.

Do not add a generic file reader, reference/script execution, hosted skills,
uploads, provider-native search, PTC, async tools, steering, a permission manager,
new resource-budget framework, skill-body cache, or runtime limits. Reuse existing
file validation, result serialization limits, execution authority and call-result
cache. Ordinary resource files beyond SKILL.md remain a later explicitly scoped
capability. Production-provider restructuring remains DEFERRED.

C1 deletion remains complete: no RunLimits, count quotas, whole-run timers, optional
replacement budgets, or the withdrawn M4 timeout/progress proposal. Preserve run
ownership, cancellation, correlation, validated recovery, result ordering/reuse,
authentication and WebSocket/SSE continuation.

The final product is a one-owner multi-device service. Browser disconnect is not
cancellation. Application sessions persist; service restart stops tasks without
automatic replay/resumption. These requirements do not authorize storage, P1, V1,
a server, or GUI work in S2. Do not invent a database or session-store interface.

Authorized implementation: scoped source/tests/current-doc changes and OFFLINE
verification after the owner gives the prompt. Use temporary synthetic workspace,
skill and credential roots, independent scripted providers and loopback servers.
No real credentials, profile/auth/login/renewal commands, private skill/project
reads for tests, provider generations, hosted probes, commits, pushes, merges,
releases, or publication. Normal trusted build tooling follows local permissions.
Pi's authoring conversation is separate from Wi test traffic. Ledger unchanged:
31/50 used, 19 remaining; remaining balance is not authorization.

Preserve user changes and all historical evidence. Keep current organization;
make only necessary additions and small shared-helper refactors. Use the new S2
report paths. Report actual executions separately from source inspection and
model-adherence claims. Ask for an amendment only on a genuine contract conflict,
not to delegate the design back to the implementor. Older task prompts and budgets
are historical, not active. Higher-priority rules and new owner directions prevail.
