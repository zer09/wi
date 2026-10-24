# Working on Wi

Read [README.md](README.md), [docs/PROJECT_STATE.md](docs/PROJECT_STATE.md), and [docs/README.md](docs/README.md). Use the implemented code and current reference guides, not historical implementor prompts, as the starting point. The owner supplies the scope for each new task. [docs/DECISIONS.md](docs/DECISIONS.md) preserves adopted requirements and withdrawn proposals.

## Boundaries to preserve

- One shared Rust controller owns execution. HTTP and the browser are adapters, not another agent loop.
- Durable acceptance follows a commit. Dispatch, acceptance, execution, persistence, and observation are distinct outcomes.
- Browser disconnect is not cancellation. Service restart never automatically resumes model or tool work.
- Canonical history is immutable. Derived display records update in the same session transaction. Live and reopened chat use one display interpretation.
- Provider-native replay is separate from browser history. Browsing must not execute providers or tools.
- Keep actual tool-result bytes and is_error; successful error-shaped JSON is not an execution failure.
- Do not restore RunLimits, run-wide quotas, whole-task deadlines, hidden retries/failover, or lifetime-history deletion policies.
- OpenAI-Codex is the current provider. Do not add hosted skills, API-key fallback, providers, tools, or authentication modes without an approved scope.
- Native targets are Linux/macOS. Managed credentials remain Linux-specific. Do not restore Windows-only code.

## Changes and checks

Preserve existing tracked and untracked work. Inspect the actual branch and base before editing. Update the relevant reference guide when behavior changes. Do not manufacture test evidence or change production semantics merely to satisfy stale prose.

Use [development checks](docs/DEVELOPMENT.md) and [browser test operation](web/BROWSER_TESTING.md). Use synthetic roots, skills, credentials, and loopbacks. Do not run live examples, login/refresh commands, private skill reads, or provider generations without explicit permission. The historical live ledger is 31/50 used; the unused balance is not authorization.

Report source inspection separately from executed local checks and hosted CI. Retain failing observations and their actual revision. Review the complete affected diff, including generated assets. After an authorized push, inspect required checks on the exact head before merge. Check post-merge results separately; acceptance does not imply perpetual green CI.

The old matrices, investigation diaries, and handoffs are retained in the [evidence archive](docs/ACCEPTANCE.md#historical-evidence). They are not active assignments. Do not recreate that diary collection in AGENTS.md. Keep current instructions short and code-oriented.
