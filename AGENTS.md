# Wi: active R1 consistency-repair handoff

Contract **r1.0**, runtime baseline
`4eed18be8baaf43be886164d192021b2e2e5aa28` (S2 merged in PR #3).
This planning commit changes documentation only; R1 repairs are NOT RUN.
The owner requested the five inherited repairs and a fixed implementor assignment.

Read in order:
1. `docs/slices/r1/CONTRACT.md`
2. `docs/slices/r1/MATRIX.md`
3. `docs/slices/r1/VALIDATION.md`
4. `docs/slices/r1/IMPLEMENTOR_PROMPT.md`
5. Current source/docs and A-01..A-05 in `docs/slices/s2/VERIFICATION.md`.

Execute the contract rather than replanning. Scope is plain presentation A-01/A-02,
legacy generate preflight A-03, AuthExpired wording A-04, and nonempty response
identity A-05. Prove each with focused failing-before/passing-after regressions.
Use the real CLI/provider/registry consumers, not parallel test-only algorithms.

R1 authorizes narrow source/tests/current-doc changes after the owner supplies the
prompt. It overrides the prior statement that these five repairs were unassigned.
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

Complete R1-00..R1-19, obtain independent accumulated-diff review and produce
`docs/slices/r1/VERIFICATION.md` and `docs/slices/r1/verification.json`. Current
claims must cite observed results; preserve older reports unchanged. A new genuine
contract conflict needs its source chain, not an unauthorized behavior change.
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
execution. All R1 acceptance rows begin NOT RUN. No complete-security claim follows.

A-01..A-05 remain open until their authorized regressions/fixes demonstrate closure.
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
