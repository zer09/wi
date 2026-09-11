# Local implementor prompt — Wi S2 s2.0

Paste the task below into a fresh Pi implementation conversation at the Wi root.
The prompt authorizes the specified offline work, not another planning exercise.
The planning PR's creation is not permission to merge implementation automatically.

```text
Implement Wi S2, contract s2.0, using:
- AGENTS.md
- docs/WI_PRODUCT_DIRECTION.md
- docs/slices/s2/CONTRACT.md
- docs/slices/s2/MATRIX.md

Read the accepted S1/MR evidence and current source first. Baseline is
94d86e0c9db62d9fec208a26f5b4bb2487bcb5fa (PR #2 merged).
Confirm actual HEAD/worktree and preserve my changes. Planning commits after
that baseline are expected. Historical reports' pre-commit/pending-CI wording
is not the current verdict; successful submitted S1 CI and merge are separate
evidence. S1 is accepted; do not repeat its organization work.

Implement the fixed S2 contract, not another architecture proposal:
- Reuse S1's source validation in a shared single-skill load operation.
- Add exactly one catalog-bound ordinary function tool named load_skill.
- Add the shared preparation/registry helper with the specified signatures.
- Make nonempty catalogs expose this loader through normal wi run without a
  new flag; global/project metadata remains automatic.
- Preserve explicit --use-skill and direct S1 prepare_run compatibility.
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
Raise a genuine contract contradiction rather than silently changing a public
contract, but choose ordinary private helpers without sending the design back.

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
Model choosing/following a skill live remains NOT RUN. Do not manufacture pass
counts or delete/skip protections. If a later authorized push occurs, inspect
all GitHub OS checks instead of treating local Linux as cross-platform proof.

Leave implementation changes uncommitted for review unless I separately grant
Git-write permission. End with an exact handoff: tested HEAD/worktree, changed
paths, matrix verdict, command results, review closure, limits and unchanged ledger.
```
