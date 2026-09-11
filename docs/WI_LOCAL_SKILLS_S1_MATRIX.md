# Wi S1 acceptance matrix

Contract **s1.0**. Baseline `b33ca4bb1cdf8ae58da8d83123b87956535d6a2c`.
**PLAN ONLY: all S1-00 through S1-23 rows are NOT RUN.**
Follow [the contract](WI_LOCAL_SKILLS_S1.md) and
[confirmed product direction](WI_PRODUCT_DIRECTION.md). Bounded means a fixed
implementation scope, not task/tool count limits or time budgets.

## Test basis

Use temporary synthetic roots G (global) and W (workspace), separate from actual
HOME/config/project data. Preserve trusted developer toolchain caches while
isolating HOME, XDG_CONFIG_HOME, and CODEX_HOME for CLI tests. A future server can
call the same library with explicit roots; prove this without a CLI subprocess.

Suggested fixed fixture set:
- G/review/SKILL.md with name review and distinctive global frontmatter/body.
- G/format/SKILL.md with another instruction-only skill.
- W/.agents/skills/review/SKILL.md with the same name but project-specific data.
- W/AGENTS.md with distinctive project instructions.
- A second W2 with different project metadata and no shared mutable context.
- Package resources containing canary strings in references/scripts/assets; none
  should be read or executed by S1, even when referenced in a selected body.
- Malformed, duplicate-within-scope, symlink, special-file, BOM/CRLF, non-UTF-8,
  large-unselected-body, and delimiter-like strings as negative fixtures.
- A scripted provider that records exact instructions/input, uses non-OpenAI native
  data, and performs an ordinary add_numbers/result/final-answer cycle.
- Actual OpenAI adapter loopback WS/SSE cases with synthetic credentials and short
  fixed outputs. Existing provider request deadlines are not changed for tests.

Global/project bodies must be distinguishable from descriptions so tests cannot
pass by accidentally sending whole files. All synthetic scripts are inert canaries;
no shell/tool executor is added or used to verify a skill reference. Skill files
can include suspicious strings to test framing, but do not run their instructions.

## Required rows

| ID | Requirement and concrete acceptance assertion | Status |
|---|---|---|
| S1-00 | Record actual HEAD/dirty worktree and isolated baseline results. Preserve accepted C1/auth/M3 reports and ledger. Review permitted changes before execution; no real globals, credential files or provider traffic. | NOT RUN |
| S1-01 | Library discovery/preparation operates on explicit roots with no current_dir, environment, CLI, OpenAI, or auth-manager dependency. Simultaneous independent callers cannot change process cwd or cross-contaminate catalogs. | NOT RUN |
| S1-02 | CLI always resolves the global root using absolute XDG_CONFIG_HOME/wi/skills or HOME/.config/wi/skills. Project root is the selected workspace/.agents/skills. Missing directories are empty scopes; invalid environment/roots fail rather than silently drop global metadata. Explicit library roots work with no HOME. | NOT RUN |
| S1-03 | With no activation flag, every valid G entry's frontmatter is in prepared context. A workspace with project skills adds all valid project entries; a workspace without them still receives globals. No global override, implicit disable flag, or model-specific discovery. | NOT RUN |
| S1-04 | Discovery visits only the selected skill roots deterministically. It stops below SKILL.md package roots; it does not scan ancestors, parent Git roots, Pi/Codex/home stores, arbitrary Markdown, resources, URLs, or package manifests. No files/directories are created. | NOT RUN |
| S1-05 | Scoped IDs preserve global:review and project:review together in listing and model catalog. Within-scope duplicates fail explicitly; traversal order never chooses a winner. Sorting is globals-by-name then projects-by-name. | NOT RUN |
| S1-06 | YAML parser handles normal quoted/block strings, comments, Unicode descriptions, BOM, LF/CRLF and delimiter lines. Missing/invalid required fields, duplicate keys, unsupported tags/merge/alias constructs, malformed delimiters and invalid frontmatter UTF-8 are rejected with sanitized diagnostics. Standard length/name validation is distinguished from arbitrary body recommendations. | NOT RUN |
| S1-07 | Optional/unknown JSON-compatible frontmatter is retained as data. Unsupported allowed-tools/disable-model-invocation-style settings produce a diagnostic without granting tools, hiding a global entry, or altering activation. Directory/name mismatch warns without discarding an otherwise valid skill. | NOT RUN |
| S1-08 | Discovery does not parse/retain/send unselected bodies. A large or non-UTF-8 unselected body after a valid frontmatter delimiter does not invalidate metadata-only discovery. The selected version must be regular UTF-8 with nonempty substantive instructions and fit existing input validation. Buffered read-ahead is not misreported as zero bytes fetched. | NOT RUN |
| S1-09 | Malformed individual skill files are excluded with visible diagnostics while valid entries remain; unreadable traversal roots/directories and ambiguous identities fail preparation. No YAML/body contents, credentials, or canonical private paths appear in ordinary diagnostics. | NOT RUN |
| S1-10 | Descendant symlinks, linked package manifests, out-of-root candidates, FIFOs/devices and invalid files are not read as skills. A selected root may canonicalize deliberately; no hidden traversal beyond it. Tests cover normal files and applicable platform checks. Document TOCTOU/hardlink/trusted-owner limitations rather than claim a sandbox. | NOT RUN |
| S1-11 | Explicit qualified selection loads the exact catalog entries. Unknown/bare/path-like IDs reject. Repeated identical selections activate once at the first position; different selected IDs preserve caller order, including equal names across scopes. No selection changes tools, provider, account or auth mode. | NOT RUN |
| S1-12 | Root-only AGENTS.md is read in prepare_run, not skills list. Ancestor/nested/global instruction files are not loaded. Missing/empty is benign; unsafe/unreadable/non-UTF-8 root instructions reject before provider construction. Root source is project:AGENTS.md, not an absolute host path. | NOT RUN |
| S1-13 | Composer preserves the original task and instruction prefix. Prepared JSON contains fixed task/project_instructions/available_skills/active_skills fields, all catalog frontmatter and only selected bodies. Deterministic key/order encoding and escaping prevent structural delimiter break-out. Project/skill bodies are not promoted into system instructions; framing grants no authority and advertises no nonexistent loader. | NOT RUN |
| S1-14 | With no context sources or selections, original prompt/instructions are byte-identical. With context, existing full-input and tools-inclusive options validation runs before provider/auth construction. Oversize catalog/project/selected content produces an explicit local error: no truncation, new count quota, optional budget, or changed provider limit. | NOT RUN |
| S1-15 | Activation detects changed frontmatter relative to the catalog. After preparation, modifying selected files does not mutate a running request or trigger filesystem reads. A subsequent discovery/preparation sees changes. Prepared data does not leak into unrelated workspaces or later runs. | NOT RUN |
| S1-16 | SKILL references to scripts, attachments, resources, URLs, dependency installation or unavailable tools cause no additional reads, process/network actions, registration or capability changes. Reject or report actual unavailable selection, not a fictitious successful resource execution. | NOT RUN |
| S1-17 | An external synthetic provider receives prepared inputs through wi::run::run, with exact task/catalog/body/caller-instruction assertions and ordinary tool continuation. It uses no OpenAI-native keys. No additional request is made to load an explicitly selected local skill. | NOT RUN |
| S1-18 | Actual loopback WS retains same-session parent/delta continuation and unchanged effective instructions; actual loopback SSE retains exact initial prepared context through native-history replay. Global/project metadata and selected body appear at the intended initial position, not repeatedly injected each turn. No auth/wire/codec policy change. | NOT RUN |
| S1-19 | wi skills list is local metadata-only; plain/JSON output exposes no bodies or canonical paths and surfaces diagnostics. wi run uses the same discover/prepare functions with --workspace and --use-skill, then the existing controller. CLI validation/context failures show zero provider/auth constructors. Plain text filters control characters; run NDJSON schema stays unchanged. | NOT RUN |
| S1-20 | HostedSkills enum/mapping/provider entries and dependent active tests/declarations are removed, not left disabled or aliased to local skills. Deserialization of hosted_skills required-feature input fails before work. Other unsupported features and generic native-item preservation remain. No upload, key creation, API billing fallback or capability test occurs. | NOT RUN |
| S1-21 | C1 removal regressions, run cancellation/sink/correlation, authority/preflight/result-reuse, response recovery/uncertainty, and existing authentication tests pass unchanged except named hosted-enum adaptation. No RunLimits, timers, quotas, service, database, watcher, extra executor or feature framework appears. | NOT RUN |
| S1-22 | Existing run_offline and new skills_offline examples terminate through finite scripted work with no credentials/provider network. Document actual inferred-versus-observed evidence. Future service requirements are recorded accurately: one owner/multiple devices, disconnect is not cancel, persistent sessions, restart does not resume tasks; none claimed implemented by S1. | NOT RUN |
| S1-23 | All verification gates pass after focused fixes; independent complete-diff review closes actionable in-scope findings. README/architecture/events/help and new reports agree with s1.0, historical evidence stays intact, each row has actual test/command evidence, no live PASS or commit/push is claimed. | NOT RUN |

## Verification commands and isolation

Run and record actual results for:

```text
cargo fmt --all -- --check
cargo check --all-targets
cargo test --all-targets
cargo clippy --all-targets -- -D warnings
cargo build --all-targets
cargo test --doc
uv run scripts/verify.py
node scripts/cli_retest.mjs --self-test
cargo run --example run_offline
cargo run --example skills_offline
git diff --check
```

Use the installed toolchain and trusted caches; dependency downloads are development
network activity, not model requests. If a parser dependency needs fetching, record
it and the resolved version/lockfile change. No broad upgrades or unrelated installs.
Do not hard-code private paths from old reports. Isolate credential and skill roots
in tests; maintain Linux/macOS/Windows gates as applicable without claiming unrun
platforms. All tests use finite scripts/barriers; external test watchdogs are not
runtime policy. No target count of new tests. Report existing 260/152 comparison
versus actual totals, ignored/filtered/platform-excluded cases and doctest count.

## Required new verification reports

Create only after observed work:
- `docs/WI_LOCAL_SKILLS_S1_VERIFICATION.md`
- `docs/wi-local-skills-s1-verification.json`

Markdown report sections: tested revision/worktree and environment; scope; baseline
and actual fixes; each S1 row with test names/assertions/results; commands and exit
codes; parser dependency and compatibility choices; instruction/catalog/body
provenance; security/trust limitations; independent review findings/resolutions;
changed files; user-repeatable local commands; remaining deferred work; live status.

JSON report must include these keys (initial values below are a template, NOT
preclaimed results):

```json
{
  "schema_version": 1,
  "contract": "s1.0",
  "runtime_baseline": "b33ca4bb1cdf8ae58da8d83123b87956535d6a2c",
  "tested_revision": null,
  "worktree_state": null,
  "status": "NOT_RUN",
  "accepted": false,
  "environment": {},
  "commands": [],
  "matrix": [],
  "findings_and_fixes": [],
  "review": {"status": "NOT_RUN", "findings": []},
  "rust_tests": {"passed": null, "failed": null, "ignored": null},
  "node_self_tests": {"passed": null, "live_started": false},
  "changed_files": [],
  "retained_constraints": [],
  "live": {"authorized": false, "generations": 0, "credential_operations": 0},
  "ledger": {"used": 31, "cap": 50, "remaining": 19, "changed": false},
  "service_and_storage_implemented": false
}
```

The matrix array must contain every ID S1-00..S1-23 with status, observed tests,
assertions and blockers. A commit SHA does not include later uncommitted edits;
record that distinction. Never claim a runtime command was executed merely because
a delegated report or test source names it: attribute the observer and separate
source inspection from execution evidence. Do not retain actual owner skill text,
private paths, provider profiles, or auth material in the reports.

Acceptance is OFFLINE ACCEPTED only after all required rows and independent review
pass. Partial results stay partial; no automatic live phase. Historical gateway,
auth, M3/C1 and RL evidence does not become S1 evidence. The ledger stays 31/50.
A later task must separately authorize S2, persistence design, service work or UI.
