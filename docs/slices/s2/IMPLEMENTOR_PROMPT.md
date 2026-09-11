# Local implementor prompt — Wi S2 s2.1

Paste the task below into the Pi implementation conversation at the Wi root.
An existing stopped conversation may resume after reading the amendment; a new
conversation is optional. Do not rerun a blocked assignment against s2.0.
The prompt authorizes the specified offline work, not another planning exercise.
The planning PR's creation is not permission to merge implementation automatically.

```text
Resume/implement Wi S2, contract s2.1, using:
- AGENTS.md
- docs/WI_PRODUCT_DIRECTION.md
- docs/slices/s2/CONTRACT.md
- docs/slices/s2/MATRIX.md
- docs/slices/s2/VALIDATION.md

Read the accepted S1/MR evidence and current source first. Baseline is
94d86e0c9db62d9fec208a26f5b4bb2487bcb5fa (PR #2 merged).
Confirm actual HEAD/worktree and preserve my changes. Planning commits after
that baseline are expected. Historical reports' pre-commit/pending-CI wording
is not the current verdict; successful submitted S1 CI and merge are separate
evidence. S1 is accepted; do not repeat its organization work.

The previous assignment_conflict was valid. The designer corrected the docs,
not the production error mapping. GatewayError::ToolFailed still becomes
{"error":{"code":"gateway_error"}} through the existing registry, with
is_error=true on ToolExecutionFinished. Do not edit src/error.rs, introduce a
tool_failed category, weaken existing assertions, or return Ok(error-shaped JSON).
Keep malformed-ID preflight errors distinct from executed file-read errors.
Keep a >1 MiB load failure distinct from a >64 KiB serialized tool-output failure.
Read the exact cache/observer ordering and S1 preparation-order clarification.
The 24 row IDs, API signatures and feature scope are unchanged.

Implement the fixed S2 contract, not another architecture proposal:
- Reuse S1's source validation in a shared single-skill load operation.
- Add exactly one catalog-bound ordinary function tool named load_skill.
- Add the shared preparation/registry helper with the specified signatures.
- Make nonempty catalogs expose this loader through normal wi run without a
  new flag; global/project metadata remains automatic.
- Preserve explicit --use-skill and direct S1 prepare_run compatibility,
  including validation precedence and CLI diagnostics on preparation failure.
- Return main SKILL.md instructions as an ordinary correlated tool result;
  keep the run controller and provider protocols unaware of skill semantics.

Only catalog IDs may be selected, not model paths. Preflight is pure and checks
the entire batch. Revalidate metadata at each new file load. Reuse the existing
per-call result cache; do not add an activation state machine or body cache.
Use current filesystem, input and tool-output protections; do not truncate a
large body into a fake success or widen guards to make tests green.

No generic file/reference reader, scripts, shell, network executor, hosted
skills, uploads, search/PTC/async calls, steering, storage/service/GUI, provider
reorganization, dependencies, RunLimits or new quota/deadline framework.
The only approved on-demand resource is the main catalog SKILL.md. State that
limitation plainly in docs and reports.

Proceed with baseline verification, focused implementation and regressions,
both loopback transports, an independent scripted-provider example, all required
gates and fresh independent complete-diff review. Do not stop after planning.
Retain and attribute prior baseline-only observations accurately; they are not
S2 acceptance. Raise any remaining genuine contradiction rather than silently
changing a public contract; ordinary private helpers are implementation choices.

Use temporary synthetic workspaces, skills and credential roots only. No real
credential reads, profile/auth/login/refresh commands, private owner skill/project
reads for verification, live model requests, hosted probes, commits, pushes,
merges or publication. Pi authoring traffic is separate. Ledger remains
31/50 used, 19 remaining; no new allocation. Keep production observers secret-safe.

Create actual reports at:
- docs/slices/s2/VERIFICATION.md
- docs/slices/s2/verification.json

Account for every S2-00..S2-23 row with actual evidence, source versus execution
attribution, test totals, failures/fixes, review findings and remaining limits.
Use contract s2.1 in both reports. Model choosing/following a skill live remains
NOT RUN. Do not manufacture pass counts or delete/skip protections. If a later
authorized push occurs, inspect all GitHub OS checks instead of treating local
Linux as cross-platform proof.

Leave implementation changes uncommitted for review unless I separately grant
Git-write permission. End with an exact handoff: tested HEAD/worktree, changed
paths, matrix verdict, command results, review closure, limits and unchanged ledger.
```
