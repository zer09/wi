# Configuration and local startup

Sources: [`ConfigFile`](../src/http_api/config.rs), [`wi serve`](../src/cli/serve_cli.rs), and [`OwnerToken`](../src/http_api/token.rs).

## Build and prerequisites

```sh
cargo build --release --locked
```

Use the repository's stable Rust toolchain. The executable embeds committed browser assets; Node is not a runtime requirement. The packaged managed-auth startup path requires Linux. macOS native CI does not establish managed-auth support.

Choose an existing project directory, a private data root, an absolute global skills root, and a model/profile available to your account. A missing global skills directory is allowed. Configured workspaces must exist and resolve to directories.

## Create the separate Wi owner token

The file must contain exactly 64 lowercase hexadecimal characters, optionally followed by one LF. It must be an absolute-path regular file with safe Unix permissions. The server loads the verifier once; replacing the file takes effect on restart.

This example creates a new token and refuses to overwrite one:

```sh
install -d -m 700 "$HOME/.config/wi"
python3 - <<'PY'
import os, pathlib, secrets
path = pathlib.Path.home() / '.config/wi/owner-token'
fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
with os.fdopen(fd, 'w') as output:
    output.write(secrets.token_hex(32) + '\n')
PY
```

This is a service-access secret, not an OpenAI credential. Do not put it in URLs, configuration JSON, source control, or logs.

## Service JSON

All fields below are required. Unknown fields are rejected. Replace example paths, model, and profile before use; the model value is deliberately a placeholder.

```json
{
  "schema_version": 1,
  "listen": "127.0.0.1:4312",
  "public_origin": "http://127.0.0.1:4312",
  "data_root": "/home/you/.local/share/wi",
  "client_token_file": "/home/you/.config/wi/owner-token",
  "global_skills_root": "/home/you/.config/wi/skills",
  "workspaces": ["/home/you/projects/example"],
  "model": "YOUR_AVAILABLE_MODEL",
  "instructions": "You are a helpful assistant.",
  "provider_transport": "websocket",
  "account": "personal",
  "enable_add_numbers": false
}
```

| Setting | Implemented rule |
|---|---|
| `listen` | Literal loopback socket address. No public-interface listener. |
| `public_origin` | Exact browser origin. Local HTTP requires a literal loopback IP, not `localhost`; HTTPS origins support a separately operated proxy. No credentials, query, fragment, or application path. |
| `data_root`, `client_token_file`, `global_skills_root` | Absolute paths. Shell variables and `~` are not expanded by JSON parsing. |
| `workspaces` | Nonempty list, canonicalized and deduplicated at startup. Clients select exact published values. |
| `model`, `instructions` | Current server-controlled provider options. The browser does not choose arbitrary options. |
| `provider_transport` | `websocket` or `sse`; no automatic fallback. |
| `account` | Managed profile alias, or explicit JSON `null` for normal eligible-profile selection. Use an explicit profile for predictable continuation identity. |
| `enable_add_numbers` | Exposes only the arithmetic diagnostic tool. It does not enable file or shell execution. |

The startup adapter selects `openai-codex` with Wi-managed authentication. External Pi/Codex credential readers are separate diagnostic/library paths, not service configuration options. Configuration parsing does not test account entitlement.

## Start and connect

```sh
./target/release/wi serve --config /absolute/path/to/wi-service.json
```

Readiness is reported on stderr as `api.listening <address>`. Open the configured origin and paste the owner token into Connect. Normal loopback HTTP needs no certificate or reverse proxy. The token remains in page memory only, so a full reload requires Connect again.

New sessions use a configured workspace. New tasks prepare current project instructions and skill metadata. Existing history can remain readable when a workspace disappears, but new preparation cannot assume the missing workspace exists.

SIGINT or SIGTERM stops admission, requests cancellation, drains owned work while storage remains writable, and then closes storage. `api.shutdown_closed` means orderly storage closure; `api.shutdown_incomplete` is not proof of rollback. Browser closure is not server shutdown or task cancellation.

## Operational limits

Do not share SQLite files across machines or start independent owners on the same data root. The root lease is exclusive. One service may have several browser clients and independent conversations.

There is no native TLS server, device-management system, automatic model retry, or automatic task restart. See [authentication](AUTHENTICATION.md), [storage](STORAGE.md), and [platforms](PLATFORM_SUPPORT.md).
