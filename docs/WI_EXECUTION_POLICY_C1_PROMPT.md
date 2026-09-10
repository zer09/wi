# Local implementor prompt — Wi C1

Paste the block below into a fresh Pi implementor conversation in the existing
Wi checkout after checking out the documentation-plan branch. No new repository,
account or login is needed. The agent implements this contract; it does not plan
another architecture. Reading the PR alone does not start work.

```text
Implement Wi C1, contract c1.0, exactly as specified in
 docs/WI_EXECUTION_POLICY_C1.md and
 docs/WI_EXECUTION_POLICY_C1_MATRIX.md.
Read those files and AGENTS.md first. Confirm the actual HEAD and dirty worktree;
preserve user changes. The runtime baseline is
640b221b70dbb4d68704e6fa70d12f9533654cf5; later documentation commits are expected.
Read the current M3 verification and authentication reports as accepted history.

This is a correction to designer-imposed execution policy, not M4 or an M3 rewrite.
Normal runs must have no default global model-count quota, tool-execution quota,
or absolute deadline. Keep independently optional, explicitly requested budgets.
Do not replace4/8/120 with larger defaults, unlimited sentinels, presets or new
mandatory maxima. Handle the specified hidden batch/cache quotas using the fixed
resource-accounting contract; preserve validation and bounded storage.

The Pi/Codex source-report findings and precise Wi adaptations are already in the
contract. Do not redo the planning or silently change those decisions. Ordinary
private helper choices are yours; a genuine contradiction is a scoped blocker.

Execute the implementation sequence, first recording real baseline/regression
results, then applying focused code/test/doc repairs. Preserve provider neutrality,
M3 lifecycle/cancellation/sink semantics, effective-output validation, authentication,
transport rules and historical reports. No tool-timeout/progress API, shell, skills,
PTC/async execution, steering, retry/failover, compaction or GUI is in this task.

This authorizes source changes and OFFLINE verification only. Use synthetic auth
locations, pure tools, deterministic clocks and loopback providers. No real profile
reads/status, login, refresh, model requests, commits, pushes or publication.
Keep the generation ledger31/50 used19remaining. Do not run a live unbudgeted test.
Pi's authoring conversation is separate from project verification.

Complete every C1-00 through C1-21 row, obtain independent complete-diff review,
repair confirmed findings and rerun gates. Report actual commands/counts, migration
and resource behavior, unresolved limits and no-live status in
 docs/WI_EXECUTION_POLICY_C1_VERIFICATION.md and
 docs/wi-execution-policy-c1-verification.json.
Do not stop after a plan; implement and verify. Do not claim PASS for test source
that was not executed. Do not rewrite accepted M3 evidence to match the new policy.
Finish with the sanitized verification summary and leave implementation changes
uncommitted for review unless I separately authorize Git writes.
```
