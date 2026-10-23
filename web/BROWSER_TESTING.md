# Browser test operation

The browser acceptance gate targets Linux x64. Native Cargo CI retains Linux/macOS. This gate does not certify all browsers or restore native Windows support.

Use Node 24.x (CI uses 24.18.0), locked Playwright 1.58.2, and the separately pinned Chrome for Testing headless shell 157.0.8103.6, revision 1717349. There is no moving-channel or bundled-browser fallback. The active pin and provenance checks are in `test-support/browser-pin.mjs`.

The separate browser pin contains the completion-before-client-notification fix needed for the observed no-store streamed-response problem. Do not change the application reader/no-store policy to hide a browser defect. A new pin requires compatibility verification. Historical qualification is preserved through [acceptance](../docs/ACCEPTANCE.md).

## Environment and dependencies

Run from the repository root. Use synthetic credentials, skills, roots and loopback providers.

- `<approved-env.json>` supplies exactly `TMPDIR`, `CARGO_TARGET_DIR`, `RUSTFLAGS`, `GIT_OPTIONAL_LOCKS`, `NODE_OPTIONS`, and `PATH`.
- `RUSTFLAGS` is `--cfg a5b2_max01_biuto9e0`, `GIT_OPTIONAL_LOCKS` is `0`, and `NODE_OPTIONS` is empty.
- `<browser-cache>` is an absent path under an owned private scratch parent within the approved TMPDIR.
- `<suite-output>` is an absent path under a separate owned private parent, outside the repository, target and browser cache.
- Parents have mode 0700; paths are absolute/canonical. See the CI workflow's publisher for a working environment setup.

Install the locked packages when absent or mismatched:

```sh
node -- scripts/agent_env.mjs --env-file <approved-env.json> -- npm --prefix web ci
```

An `unzip` executable must be on the approved PATH. When needed, install browser system dependencies separately:

```sh
node -- scripts/agent_env.mjs --env-file <approved-env.json> -- node -- web/node_modules/@playwright/test/cli.js install-deps chromium
```

This installs system dependencies, not the pinned browser archive. Provision that archive:

```sh
node -- scripts/agent_env.mjs --env-file <approved-env.json> -- node -- web/scripts/prepare-browser.mjs --output <browser-cache>
```

The provisioner checks the generation-bound archive, hashes, ZIP structure, extracted inventory, ownership and modes. It publishes mode-0600 `binding.json`. Admission never downloads or silently adopts another browser/cache.

## Registration, preparation and execution

Supply `WI_BROWSER_BINDING` separately from the approved six and suite-generated fixture variables:

```sh
WI_BROWSER_BINDING=<browser-cache>/binding.json node -- scripts/agent_env.mjs --env-file <approved-env.json> -- node -- web/node_modules/@playwright/test/cli.js test --config=web/playwright.config.mjs --list
```

Listing validates registration only; it executes no browser case.

Prepare a fresh owned bundle:

```sh
WI_BROWSER_BINDING=<browser-cache>/binding.json node -- scripts/agent_env.mjs --env-file <approved-env.json> -- node -- web/scripts/prepare-browser-suite.mjs --output <suite-output>
```

Launch that bundle once:

```sh
WI_BROWSER_BINDING=<browser-cache>/binding.json node -- scripts/agent_env.mjs --env-file <approved-env.json> -- node -- web/scripts/launch-browser-suite.mjs --bundle <suite-output>/control/suite-ready.json
```

The launcher revalidates source, fixture and browser identities before dispatch and after completion. A consumed bundle cannot be reused. Changed inputs require new preparation. Missing or substituted receipts reject rather than selecting another browser.

The current suite has 90 cases in 35 files, one worker, zero retries, a 900-second suite watchdog and a default 60-second case watchdog. These test controls are not agent task deadlines. No hidden filter or retry supplies acceptance. Keep initial failures and diagnose them before a new execution.

## Assets, CI and records

`npm --prefix web run typecheck`, `npm --prefix web test`, and `npm --prefix web run verify:assets` are separate checks. The Ubuntu workflow runs npm-ci, system dependencies, private environment provisioning, pinned-browser provisioning, those checks, preparation and guarded launch.

Private preparation and launch records contain the available detailed observations. Public hosted step success alone does not establish a case count or universal cleanup. Keep source/revision/environment bindings and attribution.

No live provider, private skill, login or refresh operation is part of this gate. Dependency/browser downloads are development traffic. Browser provisioning alone is not a runtime pass.
