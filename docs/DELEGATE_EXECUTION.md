# Delegate execution policy

## 1. Authority and prospective scope

Effective for **NEW wi assignments issued from October 11, 2026**, after owner approval. This is the current delegate execution policy linked by root AGENTS.md and the G1.1 implementor and validation documents.

This policy explicitly supersedes older all-command literal-prefix rules and permanently fatal harmless-diagnostic rules **prospectively only**. Old handoffs, failed checks and failed or BLOCKED roles remain historical unchanged. A corrected continuation does not promote a previous role or turn an earlier failed run into a pass.

Explicit user/project acceptance requirements and explicitly terminal procedural rules remain mandatory. Do not invent irrevocable harmless-procedure rules without owner authority. Standard delegation gates, role boundaries, attempt limits and final report requirements remain unchanged.

This policy changes execution procedure, not G1.1 product scope or acceptance. All 40 rows remain PARTIAL with accepted=false until separately supported acceptance. Ledger 31/50 used, 19 remaining is unchanged and is not permission for live work. Retain Linux/macOS support and the existing platform restrictions; do not restore native Windows support. No real credentials, private skills, auth commands, live provider generations, product proof replay, Git transitions or hosted writes are authorized here.

## 2. Parent-approved environment binding

The parent supplies the approved external JSON path, approved cwd and configured absolute Node24 executable. Native-read that JSON before controlled shell or gate execution. The parent-approved path is authority external to the helper; the helper validates shape, not approval. A different well-formed file is not automatically authorized.

The JSON must use valid UTF-8 source bytes. It must decode to a plain object with exactly these six own keys and well-formed Unicode, NUL-free string values. Reject lone surrogate escapes rather than replace them. Valid escaped surrogate pairs and literal U+FFFD are permitted:

| Key | Required value or shape |
|---|---|
| TMPDIR | Absolute path, preserved exactly |
| CARGO_TARGET_DIR | Absolute path, preserved exactly |
| RUSTFLAGS | One string, including spaces or an empty value, preserved exactly |
| GIT_OPTIONAL_LOCKS | Exactly `"0"` |
| NODE_OPTIONS | Exactly `""` |
| PATH | Nonempty ordered list of absolute components without empty components |

Do not normalize, reorder or deduplicate PATH. Do not split RUSTFLAGS into arguments. Inherit unrelated environment and task fixture variables, then override the six keys with the approved values. Do not hand-copy a six-value shell prefix or silently correct the approved JSON.

Canonical invocation, from the approved repository cwd:

`node -- scripts/agent_env.mjs --env-file <absolute-approved-json> -- <program> [args...]`

Example bootstrap with the configured absolute Node24 executable and NODE_OPTIONS empty:

```sh
NODE_OPTIONS='' /absolute/configured/node24 -- scripts/agent_env.mjs \
  --env-file /absolute/parent-approved/EXPECTED_ENV.json -- /absolute/program [args...]
```

The first `--` terminates Node CLI preprocessing. The second `--` separates launcher options from the target command. Both are required. Node24 can consume `--env-file` even after a script path without the first separator, bypassing helper validation and exposing raw diagnostics. A Node target that receives literal option-like arguments also needs its own Node CLI separator before its script path; the launcher does not rewrite target argv.

Controlled shells and gate runners use this binding. Existing recorders may load, verify and inherit the same JSON instead of nesting this launcher. Before an intended operation, record the effective six values and the binding to the parent-approved file. Preserve command argv, cwd, source revision/worktree, pre-run binding, process identity, terminal result, logs and cleanup evidence required by the assignment. Invalid or unknown environment proof is not PASS.

Native reads, CodeGraph and JavaScript file analysis need no shell prefix. These exemptions do not waive privacy, authorization or evidence rules. Explicit synthetic fixture-child isolation exceptions remain valid: authorized negative tests may use synthetic invalid environment files under approved TMPDIR and override fixture-child values. That coverage is not a real policy breach. Never substitute a fixture environment for a production gate's approved binding.

## 3. Launcher behavior and limits

`scripts/agent_env.mjs` is dependency-free Node24 ESM. It loads JSON once and validates invocation and environment before starting the target. Malformed CLI, malformed/missing/unreadable files and invalid values reject before target effects.

The launcher executes exactly one target with separate argv, no shell, inherited stdio and inherited cwd. It adds no timeout, retry or automatic correction. It preserves child exit status and signal termination. It forwards ordinary SIGINT, SIGTERM and SIGHUP to the direct child and removes temporary signal listeners at completion. A child may handle a forwarded signal and exit normally.

Existing gate recorders retain descendant identity, cleanup, source and evidence ownership. The launcher controls only its direct child. It is not an output scrubber or process sandbox; target output and inherited unrelated environment may contain sensitive data. Approval of a JSON path does not authorize its target command.

Own diagnostics are bounded fixed text. They contain no raw exception, stack, environment/file path, command argument, JSON excerpt or value:

- `agent_env: rejected before execution: invalid invocation.`
- `agent_env: rejected before execution: invalid approved environment.`
- `agent_env: rejected before execution: command could not start.`
- `agent_env: failure after child start: process control failed.`
- `agent_env: execution state unknown: process control failed.`

A proven pre-execution rejection returns status 2. Control failures after child start or with unknown execution state are not pre-execution rejection evidence. Numeric status alone does not prove that no operation occurred: a target can execute and exit 2. Retain diagnostics and identity/terminal evidence; do not infer authorization or nonexecution from a status number.

## 4. Correction, acceptance and stopping

| Observed condition | Required disposition |
|---|---|
| Recorded rejection before the intended operation | Inspect the concrete cause; correct within authority before a new focused check |
| Optional harmless helper/parser diagnostic alone | Disclose the correction or rejection; it does not invalidate otherwise completed work |
| Required verification remains failed/invalid | FAILED with `verification_failure`; do not waive the check |
| Policy prevents work before a breach | BLOCKED with `policy_restriction` |
| Actual unauthorized action, secret exposure, material breach or violation of an explicitly terminal procedural rule | FAILED with `policy_violation`; stop |

Do not blindly retry or repeat an unauthorized operation. Do not replay already-passing product proof, promote historical roles or waive required checks. Required failed/invalid checks remain failed/invalid evidence even when a later corrected run passes. Unknown execution state requires inspection, not an assumption that the target did nothing. If authority or required evidence is unavailable, use the applicable standard delegation blocker; an ordinary repairable test failure is not an assignment conflict.

Capture only authorized synthetic diagnostics. Sanitize sensitive data before saving or sharing. The launcher's fixed diagnostics do not sanitize child output, Node startup errors or external recorder errors.

## 5. Evidence and preservation

Give each verification exactly one finding excerpt plus relevant path/line evidence. Include enough evidence in that verification's report; do not require extraction from sibling full reports. Report commands, counts, environment-binding method, initial failures, corrections, preservation boundary, current worktree state, deferred scope and remaining risks. Distinguish source review, local execution, hosted CI and live evidence.

Preserve owner changes, staged index, HEAD and branch unless the assignment explicitly authorizes a transition. Use a finite read-only baseline comparison for tracked and nonignored untracked nonassigned content and file modes. State exclusions such as known volatile tool caches and owned temporary fixtures. An ignored-inclusive aggregate without per-file evidence does not prove every ignored file unchanged. Do not restore caches or intentionally edit ignored product/user artifacts. Incidental CodeGraph cache maintenance is not user-source mutation.

Clean up only owned fixture files and processes. Never reset, clean, stash, overwrite or revert owner work. No stage, commit, push, deployment, hosted write or new acceptance follows from completing tooling work.
