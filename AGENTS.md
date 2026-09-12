# Wi: R1 offline-accepted closure handoff

Contract **r1.0**, runtime baseline
`4eed18be8baaf43be886164d192021b2e2e5aa28` (S2 merged in PR #3).
R1 A-01..A-05 are locally implemented and offline accepted in the uncommitted,
unstaged worktree on planning HEAD `b714ecac3825b1397274e5d252232a793fff726d`.
No R1 implementation commit exists. Status is **OFFLINE_ACCEPTED**,
**accepted=true**. The repeated complete-diff review passed with no actionable
findings. Exact-head cross-platform CI is **NOT RUN**, not part of local evidence.

Read in order:
1. `docs/slices/r1/CONTRACT.md`
2. `docs/slices/r1/MATRIX.md`
3. `docs/slices/r1/VALIDATION.md`
4. `docs/slices/r1/IMPLEMENTOR_PROMPT.md`
5. `docs/slices/r1/VERIFICATION.md` and `docs/slices/r1/verification.json`.
6. Current source/docs and the historical A-01..A-05 record in
   `docs/slices/s2/VERIFICATION.md`.

Preserve the implemented repairs and their regressions. Plain answers retain LF/HT
but drop other controls; diagnostics remain one-line. Legacy generate validates
initial input, supplied follow-up and options before provider/auth construction.
AuthExpired gives owner-specific renewal guidance. The shared decoder rejects
empty response identities; missing-MIME SSE retains its earlier admission category.
The reports map observed red/green evidence through actual CLI/provider/run paths.

The owner authorized the scoped local R1 repairs, not another plan or later feature.
It does NOT authorize changes to GatewayError::code(), ToolFailed/gateway_error,
S2 behavior, auth implementations, public APIs/event schemas, provider policies,
dependencies, CI weakening, or unrelated cleanup. The AuthExpired display attribute
is the only production error.rs edit; its exported code remains auth_expired.

Use synthetic roots/credentials and offline/loopback checks only. No real private
skill/project inputs, auth/profile/login/refresh commands, provider traffic, hosted
probes, implementation commits/pushes/merges, release or deployment without separate
owner authorization. Do not reset/clean/stash or overwrite user work. Leave the
implementation uncommitted for review unless new owner instructions permit writes.
Ledger unchanged: **31/50 used, 19 remaining**. Balance is not authorization.

No runtime quotas/deadlines/RunLimits, optional budget replacement, progress API,
shell/file executor, storage, service, GUI, retry/failover or new feature framework.
Private writer/open seams and an identity helper are sufficient; do not restructure
other modules. The prior S2 implementation instructions are historical.

The [verification report](docs/slices/r1/VERIFICATION.md) and
[machine report](docs/slices/r1/verification.json) record R1-00..R1-19 PASS.
Local final code gates passed: 421 Rust tests, 152 Node self-tests, inventory
127/408/25 and three offline examples. Two complete-diff review rounds examined
code, tests, docs and reports. The repeated round passed with no actionable
findings. Do not mark CI complete without exact-head submitted evidence.
Preserve older reports and plan-time wording unchanged. A new genuine contract
conflict needs its source chain, not an unauthorized behavior change.
Higher-priority rules and new owner directions prevail.

## Accepted baseline and continuing project boundaries

S2 s2.1 is implemented and offline accepted: implementation `97ad00c`, audit
reports `48e23b5`, documentation closure `c186211`, merge `4eed18b`. Its main-file
load_skill tool, initial catalog/body preparation, direct S1 no-loader API and
provider-neutral run/registry ownership must remain intact. Read current README,
ARCHITECTURE, EVENTS, WI_AUTH and the S2 evidence before claiming a behavior change.

The S2 contract/matrix/prompts preserve their original phase. They are not orders
to repeat completed work or perform old live tests. Its reported local 374 Rust
and 152 Node passes, and exact-head cross-platform CI, are separate from new R1
execution. R1 planning records retain their initial NOT RUN statuses; the new
reports describe local execution and offline acceptance. No complete-security
claim follows.

A-01..A-05 have local offline PASS evidence and R1-19 review closure.
Other source-audit notes, including the older Node diagnostic classification, are
not extra repair assignments. Document any new finding and keep it out of the
patch unless a source-linked in-scope dependency is resolved by the contract.

C1 deletion remains complete. Preserve cooperative cancellation, correlation,
full-batch authority/argument checks, result caching and ordering, validated
recovery/provenance, execution-versus-delivery semantics, managed/external auth
ownership and both transport paths. Production-provider reorganization is deferred.

The final product is a one-owner multi-device service. Browser disconnect does
not cancel service-owned work. Application sessions persist; service restart stops
tasks without automatic replay/resumption. P1 storage design precedes V1 service
acceptance, but neither begins here. Hosted skills/uploads are excluded. No database,
permission manager, replay engine or generic tool is implied by this repair.

Pi authoring traffic is distinct from Wi verification. Report source inspection,
executed tests, CI and live behavior separately. Preserve the repository's current
organization and historical evidence. Future work needs an explicit requirement.
