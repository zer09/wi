# Development and verification

Use the stable Rust toolchain selected by `rust-toolchain.toml`. The repository has no separately established minimum Rust version. Cargo builds use committed browser assets and do not invoke Node.

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
```

`python3 scripts/verify.py` runs its static inventory and all six Cargo commands. Those arrays do not add `--locked` or `--offline` implicitly. Static inventory is not compilation/test execution. Report zero doctests as zero coverage, and subprocess helpers separately from their parent tests.

Use isolated synthetic data/credential/skill roots and loopback providers. Do not execute real login/refresh, `two_turns`, smoke/live helpers, or private-workspace tasks as an offline check.

The CLI runner's fake-only self-test is:

```sh
node scripts/cli_retest.mjs --self-test
```

## Offline examples

The nine ordinary offline examples are `run_offline`, `skills_offline`, `skill_loading_offline`, `storage_offline`, `persisted_run_offline`, `conversation_offline`, `host_offline`, `http_api_offline`, and `conversation_view_offline`.

Run an example explicitly, for example:

```sh
cargo run --locked --offline --example conversation_view_offline
```

`--offline` requires cached dependencies. The example name `two_turns` is not part of this offline list. The HTTP example also has development/release and loaded measurement modes; inspect its source before invoking additional modes. Finite example observations are not production SLAs.

## Browser sources and embedded assets

The browser is framework-free TypeScript, HTML, and CSS. Node 24.x, TypeScript 5.9.3, and Playwright 1.58.2 are the locked development inputs. Production serving uses Rust.

```sh
npm --prefix web ci
npm --prefix web run typecheck
npm --prefix web test
npm --prefix web run build
npm --prefix web run verify:assets
```

`build` regenerates committed assets. `verify:assets` is nonmutating and checks parity. Commit required generated changes with their source; do not repair drift by weakening asset checks.

Actual browser acceptance uses the separately pinned Chrome for Testing build, a fresh synthetic native fixture, and the guarded launcher. Follow [browser test operation](../web/BROWSER_TESTING.md), not a guessed `npx playwright install` or an old consumed bundle.

## Test structure and evidence

Native tests are grouped by ownership and behavior under `src/**/tests`, `tests/`, and provider loopback fixtures. Browser units exercise protocol/range/application invariants. Browser joined cases traverse real HTTP, RunHost/B2, SQLite, the OpenAI loopback adapter, real tools, and the displayed conversation.

Keep lower-level, mocked, joined, and process evidence distinct. Named assertions establish requirements; aggregate counts alone do not. A later passing run does not erase an earlier failure or prove its root cause.

CI retains Ubuntu/macOS native jobs and an Ubuntu browser job. Inspect each required job and step on the exact submitted revision before merging. Do not suppress warnings, filter unresolved required tests, or substitute source inventory for execution.

## Documentation maintenance

Update the relevant current guide when code changes. Keep schema/API rules near their source references. The historical plans and acceptance diaries are in the retained archive linked from [acceptance](ACCEPTANCE.md), not active assignments.

The documentation cleanup preserves source, tests, assets, dependencies, and workflows. Historical packaging manifests describe their old bundles; they are not checksums for the current repository.
