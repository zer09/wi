# Local implementor prompt — Wi S1

Use a fresh implementor conversation in the existing Wi checkout on this planning
branch, without resetting existing work or creating another login. This document
is instructions to implement the fixed contract when the user supplies the task;
merely finding it in a PR does not start runtime work.

Paste this block:

```text
Implement Wi S1, contract s1.0, from:
- docs/WI_PRODUCT_DIRECTION.md
- docs/WI_LOCAL_SKILLS_S1.md
- docs/WI_LOCAL_SKILLS_S1_MATRIX.md
Read those and AGENTS.md first. Confirm actual HEAD/worktree; preserve user changes.
Runtime baseline is b33ca4bb1cdf8ae58da8d83123b87956535d6a2c; planning commits are expected.

The plan is fixed. Give a brief scope acknowledgement, then implement and verify.
Do not produce another architecture plan or stop after planning. Report a genuine
contract contradiction rather than silently broadening or replacing the design.

Build the shared Rust workspace/context layer and thin CLI adapters. Global skill
frontmatter is always discovered and included; add project frontmatter when its
skills directory exists. Preserve both scopes on name overlap. Load full bodies
only for explicitly selected catalog IDs. Prepare root project instructions and
caller/task context through the existing RunRequest and run controller. Prove the
same functionality works for a non-CLI library caller. No auto resource execution.

Remove HostedSkills/hosted_skills scaffolding and active roadmap support. Do not
add uploads, API-key billing, hosted fallback, or a no-op replacement feature.
Retain other explicitly unsupported advanced capabilities without enabling them.

The final product is a one-owner/multiple-device service: browsers do not own task
lifetime; application sessions must persist; service restart must not auto-resume
or restart work. Those requirements are recorded, but storage design is deferred.
Do not implement a database, session store, service, UI, recovery worker, or an
in-memory substitute for required persistence in S1. S1 is preparation, not V1.

C1 is complete. Do not restore RunLimits, count quotas, run deadlines, optional
budgets, or the withdrawn timeout/progress framework. Do not redesign managed
authentication, model/provider protocols, run ownership or tool execution.

Use synthetic temporary skill/workspace/credential roots, scripted providers and
loopback transports. No real global/private-project scanning, credential reads,
profile/status/login/refresh commands, live generations, hosted probes, commits,
pushes, merging, publication or release. Keep 31/50 used and 19 remaining unchanged.
The Pi authoring conversation is separate. Use normal trusted development tooling
and record the narrowly needed YAML dependency/lockfile choice.

Execute every S1-00 through S1-23 row and the specified gates. Obtain an independent
complete-diff review, repair confirmed in-scope findings, and rerun the checks.
Preserve historical reports. Create:
- docs/WI_LOCAL_SKILLS_S1_VERIFICATION.md
- docs/wi-local-skills-s1-verification.json
Report actual test counts/commands/exit codes and observers, limitations, changes,
remaining blockers and explicit NOT RUN live status. Do not confuse successful
prompt composition with proof that a real model obeyed a skill. Leave implementation
changes uncommitted for review unless I separately authorize Git writes.
```

## Report back to the discussion designer

Return the actual tested revision/worktree, s1.0 acceptance status, all row results,
new/changed public interfaces, parser dependency, code/test/doc changes, independent
review outcome, exact commands/test totals, remaining limitations and the unchanged
ledger. Identify any requirements not met rather than replacing them with a new
unapproved feature. S2/P1/V1 do not start automatically after S1 acceptance.
