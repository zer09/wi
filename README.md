# Wi

Wi is a Rust agent runtime with an embedded browser conversation client. The Rust service owns model and tool execution, persistent sessions, and conversation views. The TypeScript browser sends commands and displays server-produced state.

The current provider is `openai-codex`. Wi uses subscription credentials, not an API-key billing fallback. Managed authentication is experimental and Linux-specific. Linux and macOS have native offline CI; that is not a claim of managed-auth support on macOS. Native Windows backend support is withdrawn.

## Run locally

Build with the repository's stable Rust toolchain:

```sh
cargo build --release --locked
```

Node is not required to build or run the Rust application. Browser assets are committed and embedded. Node is needed when changing or testing the browser source.

Follow [configuration and startup](docs/CONFIGURATION.md) to provision the separate Wi owner token, select an existing workspace and managed provider profile, and write the service JSON. Then run:

```sh
./target/release/wi serve --config /absolute/path/to/wi-service.json
```

Open the configured literal-loopback address, such as `http://127.0.0.1:4312`. Paste the Wi owner token into **Connect**. This is not the provider OAuth token. Local operation requires no HTTPS certificate or reverse proxy.

A full page refresh clears the memory-only owner token and requires Connect again. Closing the page does not cancel accepted work. Cancel is an explicit action. Restarting Wi preserves history but does not resume old tasks.

## Implemented behavior

- Create, list, open, and rename persistent conversations.
- Submit explicit tasks with durable acceptance receipts and observe committed output.
- Open at the newest human-message interaction; load older content as the initial viewport needs it, then on upward navigation.
- Preserve chronological live/history display through shared saved display records.
- Continue a compatible stored conversation with a new explicit task and provider-native history.
- Discover global/project skill metadata and load a selected main `SKILL.md` through the ordinary tool loop.

The built-in executable tools are `load_skill` when a catalog exists and optional `add_numbers` for diagnostics. Wi does not yet provide general file read/edit/write or shell tools. It is a working conversation/runtime foundation, not a complete coding toolset.

## Documentation

Start at the [documentation index](docs/README.md). It covers configuration, architecture, HTTP and conversation protocols, storage, authentication, tools, and development. [Milestones](docs/MILESTONES.md) separates completed work from proposals. [Acceptance and evidence archive](docs/ACCEPTANCE.md) records the G1.1 result and its limits.

## Other entry points

`wi run` is a nonpersistent diagnostic adapter over the shared controller. It does not use the service's application-session store. `wi auth`, `wi skills`, `wi generate`, and the diagnostic helpers remain available; inspect each command's `--help` before use. Authentication and live generation commands are not offline verification commands.

No run-wide model/tool quotas, whole-task deadline, automatic generation retry/failover, or automatic task resumption is implemented. Input, transport, tool-result, and display-page safeguards still apply. See [architecture](docs/ARCHITECTURE.md).

Wi is MIT licensed. The package remains version `0.2.0`; this repository milestone is not a published release.
