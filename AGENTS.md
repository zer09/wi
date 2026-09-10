# Wi: active task C1 — delete the run-limit feature

Contract `c1.1`; runtime baseline `640b221b70dbb4d68704e6fa70d12f9533654cf5`.
The user explicitly rejected retaining RunLimits as optional configuration.
This contract supersedes c1.0 completely. The prior M4 timeout/progress proposal
is withdrawn. Do not implement either superseded design.

Read, in order:
1. `docs/WI_EXECUTION_POLICY_C1.md`
2. `docs/WI_EXECUTION_POLICY_C1_MATRIX.md`
3. `docs/WI_DESIGN_SCOPE_AUDIT.md`
4. `docs/WI_EXECUTION_POLICY_C1_PROMPT.md`

Implement only when the user supplies the task prompt. This planning PR itself
changes documentation, not runtime. The local task is full removal of RunLimits
and its dependent API/CLI/control flow, not another architecture-planning pass.
No optional/no-op/renamed budget framework or replacement resource-budget feature.
Preserve completed M3 orchestration, cancellation, validation, and authentication.

Authorized local implementation scope is the contract's source/tests/docs and
OFFLINE verification. No real credential access, auth/profile commands, provider
generations, commits, pushes, or publication. Synthetic credentials, pure tools,
controlled clocks, and loopback tests are allowed. Existing trusted development
tooling follows the user's local permissions. Pi authoring traffic is separate.
The ledger remains 31/50 used,19 remaining; remaining balance is not authorization.

Preserve user changes; never reset/clean/overwrite unrelated work. Keep historical
verification reports and manifests unchanged. M3's planning files and old repair
handoffs document prior tasks; their limits, test permissions, and prompts are not
active instructions. Their full versions remain in Git history and their own files.
Use only the new C1 report paths. Distinguish observed evidence from source review.
Do not claim everything else is necessary or that a whole-repository audit occurred.
New explicit user instructions and higher-priority environment rules take precedence.
