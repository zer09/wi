# Browser test operation

The browser gate targets Linux x64. Native Cargo CI still runs its six gates on Linux and macOS. This browser gate does not certify macOS browsers or restore native Windows support.

Use Node 24 and the locked Playwright SDK 1.58.2. The browser is the separately pinned Chrome for Testing headless shell 157.0.8103.6, revision 1717349. The SDK's bundled Chromium registry remains unchanged. There is no bundled-browser fallback or moving browser channel.

## Why the browser is pinned separately

[Chromium CL8508456](https://chromium.googlesource.com/chromium/src/+/62473ad0f747e245e514c93e741bb8e168a2a207) fixes fully read fetch bodies being reported as cancelled, with lost DevTools response data. This affects the no-store streamed-response pattern used by browser observers. The exact157.0.8103.6 tag contains the fix: the loader records the terminal result before notifying its client.

The fixed browser is selected independently of the unchanged Playwright SDK. The application reader and no-store policy are not changed to avoid the bug. Do not assume a newer SDK bundles a fixed browser; verify the replacement build and compatibility before an owner-approved pin change.

[C93 verification](../docs/slices/g1/VERIFICATION_G1_1.md#c93-fixed-browser-and-current-head-verification) records the eight-trial qualification and original89-case pass at source1b8b50c. The [current assessment](../docs/slices/g1/VERIFICATION_G1_1.md#current-merge-readiness) adds the joined before-B skill-source mutation case and a local90-case pass. Both hosted workflows also pass at submitted e61c881, including pinned provisioning, preparation and guarded launch. Hosted case counts remain unavailable; the local90 count is not substituted. Earlier d757646 success retains its scope, and each later pushed head needs its own CI. These results are not general SDK compatibility or merge authorization.

## Provision the browser

Run commands from the repository root. The placeholders below represent caller-provisioned, absolute canonical paths:

- `<approved-env.json>` contains exactly the approved six values: `TMPDIR`, `CARGO_TARGET_DIR`, `RUSTFLAGS`, `GIT_OPTIONAL_LOCKS`, `NODE_OPTIONS` and `PATH`.
- `<browser-cache>` is a new, absent directory under an owned private scratch parent inside the approved `TMPDIR`.
- `<suite-output>` is a new, absent directory under a separate owned private parent. It must not overlap the repository, Cargo target, or browser cache.

The parents must have mode 0700. The approved environment file does not contain browser or fixture variables.

Before provisioning, use Node 24 and install the locked web dependencies, including the Playwright SDK. If dependencies are absent or do not match `web/package-lock.json`, ordinarily run:

```sh
node -- scripts/agent_env.mjs --env-file <approved-env.json> -- npm --prefix web ci
```

Correctly installed locked dependencies need no forced reinstall. The provisioner reads the installed `playwright-core` SDK version before downloading; it does not install npm packages.

Install an `unzip` executable on the approved `PATH` before provisioning. The provisioner invokes `unzip` only after downloading the archive. Do not assume Playwright's system-dependency installer supplies it.

Install Playwright system dependencies separately, when required:

```sh
node -- scripts/agent_env.mjs --env-file <approved-env.json> -- node -- web/node_modules/@playwright/test/cli.js install-deps chromium
```

This installs browser system dependencies, not npm packages or the pinned browser archive. Provision the fixed browser separately:

```sh
node -- scripts/agent_env.mjs --env-file <approved-env.json> -- node -- web/scripts/prepare-browser.mjs --output <browser-cache>
```

The provisioner downloads only the generation-bound pinned archive. It checks archive digests, bounded ZIP structure, extracted inventory, ownership and modes. It publishes an owned mode-0600 `<browser-cache>/binding.json` receipt. Downloads and system dependencies are development traffic, not product compatibility evidence.

The cache is rebuildable scratch. Do not retain browser binaries as evidence. Record the source commit, lockfile, commands and toolchain instead. Admission never downloads, repairs, adopts an unknown cache, or silently selects another browser.

## Register, prepare and launch

Supply `WI_BROWSER_BINDING` explicitly to each command that needs a browser. The input is separate from the approved six and the eight suite-generated fixture variables. It must identify the same unchanged receipt and package throughout preparation and launch.

Registration validates browser readiness without launching a browser or preparing a native fixture:

```sh
WI_BROWSER_BINDING=<browser-cache>/binding.json node -- scripts/agent_env.mjs --env-file <approved-env.json> -- node -- web/node_modules/@playwright/test/cli.js test --config=web/playwright.config.mjs --list
```

A separately authorized real suite preparation builds the current native test fixture and publishes private preparation data:

```sh
WI_BROWSER_BINDING=<browser-cache>/binding.json node -- scripts/agent_env.mjs --env-file <approved-env.json> -- node -- web/scripts/prepare-browser-suite.mjs --output <suite-output>
```

Launch that bundle once, only when execution is authorized:

```sh
WI_BROWSER_BINDING=<browser-cache>/binding.json node -- scripts/agent_env.mjs --env-file <approved-env.json> -- node -- web/scripts/launch-browser-suite.mjs --bundle <suite-output>/control/suite-ready.json
```

The launcher revalidates the captured browser provenance, native fixture and runtime inputs before consuming its execution guard and OUTER control. It rechecks before dispatch and after completion. The child receives the exact captured browser input beside the original eight generated values. Missing, stale or substituted receipts, changed packages and dangerous SDK environment overrides reject. `PLAYWRIGHT_NO_COPY_PROMPT` remains permitted and unchanged.

The full suite contains 90 cases in 35 files, one worker, zero retries, a 900-second suite limit and the default 60-second case limit. The added `skill-history-replay.spec.mjs` case verifies actual original tool-result replay after an owned source change before explicit task B; the existing native and post-completion skill cases remain. A consumed bundle or failed case is not permission for an automatic retry. Keep failed records and owned partials. Private provenance does not appear in public CLI diagnostics.

## CI and safety

The Ubuntu browser job runs `npm ci` before Playwright system-dependency installation, without downloading obsolete bundled Chromium. Its private publisher creates the approved six-value file and separate browser output controls. The pinned provisioner runs through `agent_env.mjs` before browser gates. Preparation and guarded launch receive `WI_BROWSER_BINDING` through step environment values, not `GITHUB_ENV` or raw fixture publication.

Use synthetic credentials, roots and scripted providers only. This procedure adds no authentication mode, reader change, no-store exception, policy waiver, live provider permission, acceptance or deployment authority. Browser provisioning alone does not prove runtime compatibility. Local execution, hosted execution and native platform results remain separate evidence.
