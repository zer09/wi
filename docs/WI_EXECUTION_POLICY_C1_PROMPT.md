# Local implementor prompt — delete RunLimits

Use a fresh Pi conversation in the existing checkout of PR #1's documentation branch. No new repository, account, or login. This prompt is a fixed implementation assignment, not another design task.

```text
Implement Wi C1 contract c1.1 from docs/WI_EXECUTION_POLICY_C1.md and
 docs/WI_EXECUTION_POLICY_C1_MATRIX.md. Read AGENTS.md and
 docs/WI_DESIGN_SCOPE_AUDIT.md first. Inspect actual HEAD/worktree and preserve
 user changes. Runtime baseline is 640b221b70dbb4d68704e6fa70d12f9533654cf5;
 later documentation commits are expected.

DELETE RunLimits completely. Remove its request field, exports, serialization,
 CLI flags, validation, quota/deadline branches, limit outcomes, and policy-only
 tests. Do not keep optional limits, disabled settings, a renamed Budget type,
 empty wrappers, presets, unlimited sentinels, or compatibility shims.
 The c1.0 optional-budget plan and its cache-reservation design are superseded.

Remove the legacy eight-call batch and 128-entry cache demonstration gates as
 specified. Preserve call identity/result reuse, full-batch validation, existing
 input/payload protections, and run isolation. Do not replace the removed gates
 with a new cache-budget/reservation/eviction framework.

Preserve accepted M3 orchestration, cancellation, events, provider neutrality,
 recovery, and authentication. Test supervision stays outside the product.
 Tool-specific timing stays in the tool; do not add timeout/progress APIs.

Execute the specified source/test/doc changes and all C1-00 through C1-17 rows.
 The plan is fixed: do not stop to produce another plan or expand the feature set.
 Report a genuine contradiction instead of silently changing the contract.
 Obtain an independent complete-diff review and fix confirmed in-scope findings.

OFFLINE work only. No real credential reads/profile commands/login/refresh,
 provider generations, implementation commits/pushes/publication, or additional
 feature work. Use synthetic data, cooperative fake tools, controlled clocks,
 and loopback servers. Keep the ledger 31/50 used,19 remaining. Pi's authoring
 conversation is separate from Wi verification traffic.

Write docs/WI_EXECUTION_POLICY_C1_VERIFICATION.md and
 docs/wi-execution-policy-c1-verification.json with actual commands/results,
 deleted APIs/branches, every matrix row, changed test counts, remaining
 constraints, and review evidence. Record additional questionable features;
 do not silently remove unrelated safeguards or claim a whole-repository audit.
 Preserve historical reports. Leave implementation changes uncommitted for review
 unless I separately authorize Git writes.
```
