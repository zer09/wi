# Development and verification

[Delegate execution policy](DELEGATE_EXECUTION.md) documents the retained launcher and controlled verification procedure.

Use the stable Rust toolchain selected by rust-toolchain.toml. The repository has no separately established minimum Rust version. Cargo builds use committed browser assets and do not invoke Node.

## Native checks

```sh
cargo fmt --all -- --check
cargo check --all-targets
cargo test --all-targets
cargo clippy --all-targets -- -D warnings
cargo build --all-targets
cargo test --doc
cargo test --test platform_support
python3 scripts/verify.py --static-only
python3 -m unittest discover -s scripts -p test_check_references.py
python3 scripts/check_references.py
```

`python3 scripts/verify.py` runs its static inventory and all six Cargo commands. Those arrays do not add --locked or --offline implicitly. Static inventory is not compilation/test execution. Report zero doctests as zero coverage, and subprocess helpers separately from their parent tests.

Use isolated synthetic data/credential/skill roots and loopback providers. Do not execute real login/refresh, two_turns, smoke/live helpers, or private-workspace tasks as an offline check.

The CLI runner's fake-only self-test is:

```sh
node scripts/cli_retest.mjs --self-test
```

The delegate launcher has a separate root-script suite. `npm --prefix web test` does not run it. With Node 24 and an absolute, owned `TMPDIR`, run the entire suite without a name filter:

```sh
node --test -- scripts/agent_env.test.mjs
```

Use the [Delegate execution policy](DELEGATE_EXECUTION.md) for controlled environment binding. CI runs this suite through its existing approved-environment launcher; fixture children use synthetic environments. No policy test should depend on a removed implementation prompt or a historical acceptance status.

## Offline examples

The nine ordinary offline examples are run_offline, skills_offline, skill_loading_offline, storage_offline, persisted_run_offline, conversation_offline, host_offline, http_api_offline, and conversation_view_offline.

Run an example explicitly, for example:

```sh
cargo run --locked --offline --example conversation_view_offline
```

--offline requires cached dependencies. The example name two_turns is not part of this offline list. The HTTP example also has development/release and loaded measurement modes; inspect its source before invoking additional modes. Finite example observations are not production SLAs.

## Browser sources and embedded assets

The browser is framework-free TypeScript, HTML, and CSS. Node 24.x, TypeScript 5.9.3, and Playwright 1.58.2 are the locked development inputs. Production serving uses Rust.

```sh
npm --prefix web ci
npm --prefix web run typecheck
npm --prefix web test
npm --prefix web run build
npm --prefix web run verify:assets
```

build regenerates committed assets. verify:assets is nonmutating and checks parity. Commit required generated changes with their source; do not repair drift by weakening asset checks.

Actual browser acceptance uses the separately pinned Chrome for Testing build, a fresh synthetic native fixture, and the guarded launcher. Follow [browser test operation](../web/BROWSER_TESTING.md), not a guessed npx playwright install or an old consumed bundle.

## Test structure and evidence

Native tests are grouped by ownership and behavior under src/**/tests, tests/, and provider loopback fixtures. Browser units exercise protocol/range/application invariants. Browser joined cases traverse real HTTP, RunHost/B2, SQLite, the OpenAI loopback adapter, real tools, and the displayed conversation.

Keep lower-level, mocked, joined, and process evidence distinct. Named assertions establish requirements; aggregate counts alone do not. A later passing run does not erase an earlier failure or prove its root cause.

CI retains Ubuntu/macOS native jobs and an Ubuntu browser job. Inspect each required job and step on the exact submitted revision before merging. Inspect the post-merge run separately. Do not suppress warnings, filter unresolved required tests, or substitute source inventory for execution. Keep historical acceptance distinct from current regression health in [PROJECT_STATE.md](PROJECT_STATE.md).

## CI scheduling

The [workflow](../.github/workflows/ci.yml) runs for pull requests with the default `opened`, `synchronize`, and `reopened` activities, and for pushes to `master` only. It does not check tag pushes or feature-branch pushes without a pull request.

New revisions cancel superseded runs for the same pull request. Different pull requests remain independent. Each `master` push has a unique concurrency group, so newer pushes neither cancel running verification nor displace queued verification.

This scheduling cleanup does not repair the observed test failures or change the current-health qualifications.

## Documentation maintenance

Update the relevant current guide when code changes. Keep schema/API rules near their source references. Historical plans and acceptance diaries remain in the [archive](ACCEPTANCE.md#historical-evidence), not active assignments.

Maintain only one current restart point, [PROJECT_STATE.md](PROJECT_STATE.md), and one [decision register](DECISIONS.md). Extend [MILESTONES.md](MILESTONES.md), not a competing roadmap. Trace owner intent to the adopted contract, actual producer/consumer paths, named assertions, observed evidence, accepted revision, and remaining scope. A discrepancy is a finding, not permission to silently change a requirement.

At closure, update the applicable guide, milestone disposition, current health, and acceptance reference. Record exact tested/submitted/merged revisions separately. Retain failures, waivers, untested platforms, and uncertainty. Update active assignment and PR wording so completed work is not presented as pending. Do not create another increment-diary collection in AGENTS.md.

Before removing or moving documentation, search source includes, scripts, fixtures, and relative links. The schema regression includes the exact SQL block in STORAGE.md; preserve that dependency and all assertions. Historical packaging manifests describe their old bundles, not current repository checksums.

### Reference audit scope

`python3 scripts/check_references.py` reads every tracked text file from the current checkout. It checks local Markdown links and heading fragments, explicit reference-link definitions, concrete code-formatted source paths, literal document paths in source, Rust include macros, and static relative JavaScript/TypeScript imports and module URLs. A TypeScript `.js` import may resolve to its tracked `.ts` source. It fails on missing targets and missing tracked input files; tests and fixtures are not blanket-excluded.

The check is offline. External URLs, dynamically assembled paths, runtime-created fixture paths, and arbitrary application routes are not proven by this scan. Two exact module URL targets are classified as generated inputs: the Cargo-built CLI and the npm-installed TypeScript compiler. Their build/install and behavioral checks remain required. Do not add broad directory exclusions to hide a missing source file. The check's synthetic tests prove missing-target detection and valid-reference handling.

The documentation cleanup left an active launcher suite reading deleted policy/assignment files. The retained execution policy is now maintained here; the link checks target AGENTS, this guide, and the docs index. Only obsolete assignment/status assertions changed. Launcher behavior checks remain intact. The archived implementation prompts remain historical rather than being recreated as current instructions.

### Project-source exports

Export a small dated context pack: read-first, current state, decisions, milestone/next-work register, current architecture summary, research reference, and source/workflow index. Include repository paths, exact source revisions, export date, document class, and superseded-source mapping. A synthesis must be labelled as a synthesis, not a byte-identical repository export. An unmerged documentation PR must remain labelled unmerged.

Keep the two saved architecture chats as historical context. Preserve all other unique attached originals in a separately named backup before removing them from active Project sources. Use distinct names for different files with the same original title. Verify copied bytes and record hashes; hashes verify preservation, not the truth of old reports.

Upload only the designated current-context Markdown files, not backup folders, old prompts, or whole process archives. Project uploads do not update automatically when GitHub changes. Refresh them after a material accepted milestone or policy change, and re-resolve repository HEAD before planning code changes. Keep new research date/pin/evidence qualifications rather than silently updating upstream claims from memory.
