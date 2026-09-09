# M3 implementor handoff — implement the fixed matrix, do not replan

A fresh local Pi/Astra conversation is recommended. Keep the existing repository,
configuration and authentication; do not create a new login or reset the worktree.
After the documentation PR is checked out or merged, start Pi at the Wi repository
root and paste the following. This prompt activates offline implementation only.

---

Implement Wi milestone M3 from the committed specification. You are the local
implementor, not the architect for another planning pass.

Read in this order:
1. AGENTS.md's M3 task routing.
2. docs/WI_RUN_CONTROLLER.md (contract m3.1).
3. docs/WI_RUN_MATRIX.md (M3-00 through M3-26).
4. docs/WI_RUN_VERIFICATION.md and docs/wi-run-verification.json (NOT RUN scaffolds).
5. docs/COMBINED_DESIGN_REPORT.md, the current sections of docs/LOCAL_VERIFICATION.md
   and docs/local-verification.json, docs/WI_AUTH.md and docs/EVENTS.md.
6. The source and tests identified by the contract.

The accepted runtime baseline is 2d9008b125c8a67dbc6977fe07fd65442cac7f9a. Inspect
the actual HEAD and git status; preserve newer/user changes. The planning commit
changes docs only. Historical 86-test/live-failure fields and old live permissions
are not the current task. Gateway/auth are complete within their documented scope.

Proceed with the specified implementation sequence: baseline evidence; move the
CLI-only consistency guard into the OpenAI adapter before settlement; shared tool
preflight/fresh per-run cache; reusable bounded library controller and four run/turn
lifecycle events; independent fake-provider tests; thin wi run command and loopback
transport tests; final gates; independent offline review; completed M3 reports.
Use the exact defaults, caps, event/termination semantics, callback design, CLI
surface, and acceptance oracles in the contract. Do not return another proposal
or stop after planning. A brief orientation/progress note is enough; then implement.

You may choose private helper names and ordinary code structure that do not change
the contract. For a genuine incompatible requirement, report the specific clause,
evidence and smallest adjustment, pause only that part, and continue independent
offline work. Do not silently weaken tests, broaden scope or redesign the API.

Authorization: modify source/tests/current docs inside the declared scope and run
offline verification. Zero real credential reads, profile checks, browser logins,
refreshes or provider generations from the project. Use synthetic stores, pure
tools and loopback servers. Normal dependency tooling follows local permissions.
No commits, pushes, publication or merge without separate user authorization.
Do not execute old handoff/live scripts; the generation ledger stays 27/40 used,
13 remaining, with zero allocated to M3. Pi's authoring conversation is separate.

Preserve all auth/session-binding/renewal, transport, recovery, admission, and
existing exact smoke protections. Do not add GUI/server, shell/file tools, another
provider, persistence, parallel execution, steering, skills, search, PTC, async
calling, account failover, retries or fallback. Do not invoke Pi/Codex to replace
Wi's native runtime. Only add_numbers is available to the new CLI when opted in.

Complete every required matrix row or record a precise FAIL/BLOCKED/NOT RUN with
evidence. Run the six Cargo gates, Node runner self-tests, offline example and diff
check. Count actual results; do not copy baseline counts into new PASS fields.
Have a separate reviewer inspect the diff and failure traces; unavailable review
is BLOCKED, not invented. The observer/future-drop limitations remain explicit.

Update only the new docs/WI_RUN_VERIFICATION.md and docs/wi-run-verification.json
for M3 results; update active usage/event docs for actual behavior, while preserving
historical reports and ledgers. The final response must state the implementation
HEAD/worktree, fixes, per-row evidence, actual test counts, reviewer outcome,
remaining blockers and reproducible offline commands. The strongest allowed
verdict is OFFLINE ACCEPTED; LIVE NOT AUTHORIZED / NOT RUN. Stop there.
