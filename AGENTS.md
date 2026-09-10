# Wi: active task S1 — local workspace context and skills

Contract `s1.0`; accepted runtime baseline `b33ca4bb1cdf8ae58da8d83123b87956535d6a2c`.
This branch supplies a documentation-only implementation plan. Start runtime work
only when the user gives the implementor prompt. The designer has fixed the plan;
the implementor executes it, rather than commissioning another planning round.

Read in order:
1. `docs/WI_PRODUCT_DIRECTION.md`
2. `docs/WI_LOCAL_SKILLS_S1.md`
3. `docs/WI_LOCAL_SKILLS_S1_MATRIX.md`
4. `docs/WI_LOCAL_SKILLS_S1_PROMPT.md`

Implement shared Rust workspace/context preparation, always-discovered global
skill frontmatter plus project skill frontmatter when present, catalog listing,
and explicit skill activation. Remove HostedSkills/hosted_skills scaffolding from
active source/capability reporting. Do not add uploads, API-key fallback, or hosted
execution. The CLI is a caller of the library, not the future product architecture.

The service is for one owner using multiple devices. Browser disconnection does
not cancel service-owned work. Service restart stops active tasks; none restart or
resume automatically. Application sessions must persist. These are confirmed
future-service requirements, NOT authorization to implement storage or the server
in S1. Storage design is deferred and precedes service acceptance. Do not invent a
database, persistence interface, migration scheme, or background recovery worker.

C1 c1.1 is complete. Do not restore RunLimits, budgets, run timers, quotas, or the
withdrawn M4 timeout/progress proposal. Preserve M3/C1 orchestration, cancellation,
correlation, validation, result reuse, and accepted authentication/transport behavior.
A bounded implementation matrix does not impose a runtime work budget.

Authorized implementation work: this contract's source, test, and active-document
changes plus OFFLINE verification using synthetic workspaces, skills, credentials,
scripted providers, and loopback transports. No real credential/profile commands,
login, renewal experiments, provider requests, hosted API probes, commits, pushes,
merge, release, or publication. Normal trusted development dependency operations
follow the user's local permissions. Pi's authoring conversation is separate.
The generation ledger stays 31/50 used, 19 remaining, with zero new allocation.

Preserve existing user changes, historical reports/manifests, and accepted behavior.
Do not read the owner's actual global skill files or private projects for tests;
isolate HOME/XDG_CONFIG_HOME and use explicit temporary roots. Keep sensitive text
out of ordinary logs and reports. Observed test execution, source review, and live
evidence are different categories. Report blockers truthfully rather than weakening
validation or silently broadening scope. Private implementation details may vary;
public contract decisions require an explicit amendment if genuinely contradictory.

Older M3/C1/repair prompts and their historical permissions are not active task
instructions. Their evidence remains intact. New user instructions and higher-
priority environment rules take precedence.
