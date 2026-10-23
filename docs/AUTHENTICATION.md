# Authentication and access

Wi has two separate credential boundaries. A browser holds a Wi service owner token. The server holds provider credentials. One must never substitute for the other.

## Local service access

`OwnerToken` accepts a private regular file containing 64 lowercase hexadecimal characters and an optional LF. Startup stores a process-private HMAC verifier; file changes take effect after reloading/restarting the server.

Protected API requests supply the token in the Authorization header. Host/Origin validation is separate. The browser keeps the token only in page memory and clears connection state on Disconnect or authorization failure. It does not store the token in cookies, URLs, localStorage, sessionStorage, or IndexedDB.

Normal literal-loopback HTTP needs no certificate. The listener does not bind a public interface. A configured external HTTPS origin assumes a separately operated reverse proxy; Wi has no native TLS or deployment automation.

This is shared owner access, not user registration, per-device identity, individual revocation, or isolation from malicious local code that already has the owner's file/process access. Do not weaken API authentication merely because the public static page is reachable.

Sources: [`token.rs`](../src/http_api/token.rs), [`boundary.rs`](../src/http_api/boundary.rs), and [configuration](CONFIGURATION.md).

## OpenAI-Codex managed profiles

The current provider ID is `openai-codex`. Managed login/renewal is an experimental compatibility integration. Successful calls do not establish provider approval of the reused public OAuth registration, stable support, or universal model entitlement.

Managed persistence is Linux-specific and fails closed outside Linux. It stores plaintext versioned JSON at `$XDG_CONFIG_HOME/wi/auth/openai-codex.json`, otherwise `$HOME/.config/wi/auth/openai-codex.json`. Directories/files require private ownership and permissions. Stable locks, descriptor-relative safety checks, atomic replacement, sync operations, and rotation guards protect cooperating processes; they are not encryption or an OS keyring.

CLI operations:

```text
wi auth login --provider openai-codex --account personal --experimental
wi auth list --provider openai-codex
wi auth status --provider openai-codex --account personal
wi auth refresh --provider openai-codex --account personal
wi auth logout --provider openai-codex --account personal
```

Login/refresh contact the provider and are not offline test commands. Existing profiles require explicit `--replace` during login. Logout deletes local state; it does not revoke remote credentials.

The login implementation uses the Linux `/usr/bin/xdg-open` launcher and a loopback callback at port 1455. Configure the Linux launcher for WSL; no Windows-shell fallback exists. List/status are local metadata reads and do not refresh.

Selection occurs once per provider session: an explicit eligible alias, or uniform selection among eligible profiles. Account and login incarnation remain bound. A long-lived application conversation does not authorize automatic account failover.

## Renewal and replay

SSE can prepare/renew the same bound managed identity before another request. An established WebSocket retains handshake credentials and cannot renew in place; open a new session after expiry. Provider account changes reject before historical content is sent. No hidden model/account/transport fallback or generation retry is implemented.

Rotation guards conservatively require reauthentication after uncertain exchange or persistence. Cancellation of a waiter does not forcibly undo an owned credential rotation. Local claim decoding is not a generic JWT signature-validation service.

External Pi/Codex credential sources remain explicit, read-only diagnostic/library choices. They do not import credentials into Wi, refresh through Wi, or serve as an automatic fallback. `--account` belongs to managed authentication; managed auth does not accept an arbitrary `--auth-file`.

Sources: [`auth_cli.rs`](../src/cli/auth_cli.rs), [`src/providers/openai_codex`](../src/providers/openai_codex). Historical login/renewal and generation evidence is linked from [acceptance](ACCEPTANCE.md). Automatic expiry-renewal and opaque replay must not be relabelled live-certified from offline CI.
