# Wi managed authentication: experimental login and renewal

Wi is the Cargo package, library, and binary at version 0.2.0. The provider ID
remains `openai-codex`. `Gateway` remains the provider-neutral routing type.
Repository paths and historical verification records retain their original names.

## Experimental status and trust model

`wi auth login --experimental` implements one Pi-compatible browser flow. This
user-selected experiment now also enables Pi-compatible renewal of Wi-owned profiles.
The public client registration is an undocumented compatibility choice, not a
claim of OpenAI approval, stable support, or account entitlement. A provider denial
stops the attempt. Real `auth refresh` and automatic preparation are implemented.
One explicit live renewal passed at `2026-09-08T21:23:21Z`; a fresh process
confirmed the persisted eligible profile and updated expiry. Automatic expiry-triggered
renewal and failure/rotation edge cases retain offline evidence.

The fixed configuration follows Pi source at `96617628e`,
`packages/ai/src/auth/oauth/openai-codex.ts`: the public client ID
`app_EMoamEEZ73f0CkXaXp7hrann`, `https://auth.openai.com/oauth/authorize` and
`https://auth.openai.com/oauth/token`, and `http://localhost:1455/auth/callback`.
Scopes are `openid profile email offline_access`. Wi uses authorization code,
PKCE S256, independent random state and verifier, `id_token_add_organizations=true`,
`codex_cli_simplified_flow=true`, `originator=wi`, and an honest `wi/0.2.0` user-agent.
There are no dynamic production endpoints, retries, redirects, device/manual-code
fallbacks, connector scopes, or ID-token-to-API-key exchanges.

Only the access token received directly from the fixed, certificate-checked HTTPS
token response supplies `https://api.openai.com/auth.chatgpt_account_id` and `exp`.
TLS authenticates the response source; local claim decoding does not verify a JWT
signature or establish trust in an arbitrary imported token. Missing or malformed
account/expiry claims fail. Access and refresh tokens must be nonempty; token type,
when present, must be `Bearer` (ASCII case-insensitive, without trimming).
`expires_in` must be a positive `u64` whose addition to the current Unix time does
not overflow. The earlier of that expiry and `exp` must pass the existing freshness
check, including its 30-second margin. Ordinary extra fields such as `id_token`
are ignored rather than stored. Only required profile data is persisted.

`browser_login.rs` owns browser login and the shared strict token-response parser.
The private `refresh.rs` adapter sends form-encoded `grant_type=refresh_token`,
`refresh_token`, and `client_id` to the same fixed TLS token endpoint, following
Pi's `openai-codex.ts:171-188` at the revision above. It requires the returned
complete token pair; it never reuses the old refresh token when one is omitted.
Both flows use the response trust model above. There is no arbitrary one-day
expiry cap. Renewal uses certificate validation, an honest Wi user-agent, no
proxy/redirect/retry, 10-second connect/read limits, and a 30-second total exchange
limit. Responses are bounded to 65536 bytes while reading, including chunked or
absent-length bodies. Errors expose static stage classes, not bodies, headers,
URLs, or credentials. Collected response bytes use `Zeroizing` storage.

Tests inject only literal loopback HTTP endpoints and temp stores under `cfg(test)`;
login tests also use harmless launchers. No production endpoint override exists.
The older `oauth_offline.rs` remains synthetic regression coverage; its fake
attestation is not used by either real exchange.

## CLI surface

- `wi auth login --provider openai-codex --account personal --experimental [--replace]`: experimental browser login.
- `wi auth list --provider openai-codex`: local metadata only.
- `wi auth status --provider openai-codex --account personal`: local metadata only.
- `wi auth refresh --provider openai-codex --account personal`: one explicit renewal, even when fresh; returns safe current metadata.
- `wi auth logout --provider openai-codex --account personal`: local deletion only.

Logout never revokes a remote credential or touches another application's store.
Login requires explicit replacement of an existing profile. Without `--experimental`,
it fails before path resolution, credential reads, listener creation, or browser launch.
Alias, Linux store safety, and existing-profile conflict checks precede browser launch.
Login returns only the local alias, expiry, and persisted/eligible flags.
Refresh returns current profile metadata: alias, expiry, enabled, logged-in, and
reauthentication flags. It never returns provider account IDs or tokens.

Linux `/usr/bin/xdg-open` must be installed and configured to open a browser. Wi
passes the URL as one argument without a shell and suppresses launcher output.
The launcher must exit successfully within 10 seconds. Wi has no Windows-shell
fallback, including under WSL. Use the private WSL Linux filesystem and configure
its Linux launcher before login. The browser must reach `localhost:1455`.
Wi binds `127.0.0.1:1455` before launch. An occupied port fails without cancelling
another listener or selecting another port. No raw URL is printed for manual use.
The browser and local process arguments necessarily contain the authorization URL;
do not capture these with tracing or process-monitor logs.

The login deadline is 180 seconds; code exchange is limited to 30 seconds, with
10-second connection/read bounds. Launcher cancellation kills and reaps the child.
Callbacks are limited to 8192 bytes and token responses to 65536 bytes.
Only `GET /auth/callback` with exactly one `Host: localhost:1455`, matching state,
and one nonempty code is accepted. Optional `iss` must equal `https://auth.openai.com`.
Matching-state OAuth denial returns a static failure without exchange; error
descriptions are discarded. Duplicate recognized parameters and malformed parameters
fail. Unrecognized parameters are ignored after key/value decoding validates percent
escapes, UTF-8, and the absence of control characters.
The callback listener is consumed once, so queued callbacks cannot exchange twice.

Generation, tool-demo, and the existing smoke helper accept `--auth-source gateway`
and optional `--account personal`. Without an account, each session open uniformly
selects one eligible profile. Selection uses rejection sampling, not modulo-biased
randomness. Eligibility requires an enabled login that does not require reauth;
expired access remains eligible when refresh credentials exist. A missing or
ineligible manual choice fails without fallback. No quota or usage request occurs.

The CLI prints the validated local alias on stderr, outside the event JSON stream.
It does not print provider account IDs. The alias contains only ASCII letters,
digits, hyphens, and underscores, with a maximum length of 64.

`pi` and `codex` remain explicitly selected, read-only file sources. They reject
`--account`. Managed auth rejects `--auth-file`; aliases cannot inject paths.
There is no migration, credential copying, ambient source search, or API-key fallback.
`auth-check` remains the external-source snapshot check; use `auth status` for Wi.

## Expiry guidance (R1)

`AuthExpired` displays exactly:

> login expired or expires within 30 seconds; renew Wi-managed credentials through Wi, or external credentials through Codex/Pi; then open a new provider session; established WebSockets cannot renew in place

This replaces inaccurate guidance that denied Wi-managed rotation. The exported
code remains `auth_expired`; the 30-second freshness margin, credential selection,
renewal, persistence and transport behavior are unchanged. The message performs no
auth operation. Managed renewal belongs to Wi; external renewal belongs to the
selected Codex/Pi owner. Established WebSockets still require a new session.

Legacy `generate` now validates initial input, any supplied follow-up separately,
and actual options before constructing provider/auth objects. Invalid operations
therefore perform no credential lookup or first generation. This ordering change
does not alter authentication implementations or add context preparation.

R1 is offline accepted in commit `88b76c5`. The
[R1 report](slices/r1/VERIFICATION.md) records synthetic freshness/display and
actual loopback RequestFailed regressions, not new live auth evidence. The repeated
complete-diff review passed; `accepted=true`. The NB-02 follow-up changes only
legacy diagnostic presentation. Exact-head cross-platform CI is NOT
RUN. No real credential reads or auth commands ran for R1 or the follow-up.

## File protection

The managed store is `$XDG_CONFIG_HOME/wi/auth/openai-codex.json`, otherwise
`$HOME/.config/wi/auth/openai-codex.json`. It is plaintext versioned JSON containing
multiple independent named profiles. Use a private Linux filesystem, including
the WSL home filesystem, not a Windows-mounted credential directory.

Managed directories require mode 0700. Credential and stable lock files require
0600 and the current effective owner. Existing unsafe permissions are rejected,
not repaired. Descriptor-relative operations reject symlinks in every component;
regular credential files must have one hard link. Read-only list, status, and
selection treat a missing tree or safe private directory without both document
and lock as empty, without creating files. An existing document without its
stable lock is unsafe. Parsing and serialized updates
are limited to 1 MiB. Updates write a private exclusive temporary file, sync the
file, atomically rename it, then sync the directory. A stable advisory file lock
serializes cooperating processes. Updates reread under that lock and preserve
unrelated profiles. Processes with sufficient OS access can still read or alter
plaintext credentials. Protect the configuration directory's ancestors too.

Managed persistence explicitly fails closed outside Linux. Unix modes do not
claim Windows ACL protection. Existing external file readers retain their prior
platform behavior. No keyring, database, or unused config.toml settings are added.

## Binding, renewal, and cancellation

`AuthManager` selects and prepares a profile. `ManagedCredentials::load()` returns
a read-only snapshot and never selects, refreshes, or writes. The separate
`CredentialSource::prepare_submission()` hook defaults to a no-op for external
sources. A provider reused for several sessions selects separately for each open.

The bound source pins the alias, provider account, and unique login incarnation.
Refresh changes tokens, not identity. Replacing or deleting a profile cannot make
an SSE reload consume a different login, even under the same alias and account.
An established WebSocket retains its original handshake and checks snapshot
expiry before each submission. It does not reload or renew mid-session. A new
session is required after WS expiry. SSE may prepare the same selected profile
before the next request, including tool-result delivery.

Explicit refresh forces one exchange for the selected eligible profile. Automatic
preparation exchanges only when expiry is within the 30-second freshness margin.
Concurrent automatic waiters reread under the lock and reuse a completed rotation.
List, status, and load never contact the token endpoint, even for expired profiles.

Renewal holds the cross-process lock through the exchange and atomic
persistence. It rereads after acquiring the lock. Before exchange it creates and
syncs an empty, nonsecret `.rotation-<alias>-<incarnation>` guard, then syncs the
directory. Reads treat that guard as authoritative reauthentication state even
when the JSON says otherwise. Failure, ambiguous exchange, timeout, or failed
rotated-token persistence leaves the guard, including a directory-sync failure
after rename. Such an error does not prove disk rollback: rotated JSON can be
visible but remains ineligible through a fresh manager.

The rotation commits only after the complete rotated JSON and directory sync
succeed. Guard removal and its directory sync are best-effort cleanup after that
commit; cleanup failure does not return a failed-rotation result. A retained or
crash-restored guard can conservatively require login despite a successful commit.
It cannot expose the old refresh token because the new document is already
durable. Replacement and logout clean only the removed incarnation's
guard after their document commit; leftover guards do not affect new incarnations
or other profiles. This is not a general recovery journal.
The real renewal exchange uses the same transport-authenticated response model as
experimental login. Local `jwt_hints` decoding is not signature verification.
The manager independently rejects account changes and preserves the incarnation.

An owned blocking worker completes the bounded exchange and persistence even when
a session cancels its waiting future. A process crash cannot preserve an unpersisted
new token, but the earlier durable guard prevents blind reuse after restart.
No automatic generation retries, account failover, reconnect replay, or background
refresh scheduler is added. Lock acquisition and blocking filesystem operations
have no new time bound; the 30-second limit applies to the token exchange.

Login uses the same stable lock and atomic persistence path. It checks conflicts
again under lock, creates a new incarnation, and guards only that candidate before
writing. A post-rename failure leaves the candidate ineligible. Failures before
replacement do not disable the old profile. Unrelated profiles remain intact.
The browser success page is sent only after durable commit. A disconnected browser
does not turn an already committed login into a reported persistence failure.
Guard cleanup failure can conservatively report `persisted=true, eligible=false`.
Login lock acquisition waits at most one second. The absolute deadline is checked
before commit. Once filesystem commit starts, the worker completes it rather than
reporting a timeout with an unknown persistence result. Blocking kernel filesystem
operations cannot be forcibly bounded by the async deadline.

## Remaining acceptance work

One parent-run experimental browser login passed on local Linux at
`2026-09-08T20:09:22Z`. Wi persisted an eligible profile; a fresh metadata-only
status command confirmed logged_in=true and requires_reauthentication=false.
This is observed login evidence, separate from the synthetic tests. A second
profile login passed at `2026-09-08T21:36:47Z`. Fresh Wi status confirmed both
profiles logged in without reauthentication. A reviewed read-only metadata checker
confirmed distinct provider accounts and login incarnations without displaying
identifiers or tokens. W1 managed-auth WebSocket text subsequently passed with
gpt-6-astra and wi-experiment at `2026-09-08T21:45:23Z`; this does not establish
other-profile model access or the remaining generation cases.
The real renewal adapter also has offline loopback/temp-store evidence for form
encoding, request count, bounds, sanitized failures, identity/expiry validation,
explicit rotation, concurrent automatic preparation, cancellation, and restart
guards. Existing synthetic storage and WS/SSE regressions remain applicable.
L1 explicit live renewal passed once at `2026-09-08T21:23:21Z`, without retry or
generation. A fresh status process confirmed the same local profile remained
logged in without reauthentication and had the same updated expiry as the refresh
result. Identity preservation is enforced by the reviewed manager; provider IDs
and tokens were not exposed. Other-profile preservation remains synthetic evidence.
L0 two-account login, L1 explicit renewal, W1 WebSocket text and W2 continuation
are complete. W2 randomly selected wi-experiment and verified same-socket reuse,
prior-response linkage and correct remembered text at `2026-09-08T21:50:25Z`.
W3 also passed at `2026-09-08T21:54:09Z`, randomly selecting wi-secondary for the
same-WebSocket add_numbers(17,25) round trip, correlated result and final42.
Model access is now observed on both profiles for these bounded cases.
S1 SSE text passed on explicit wi-secondary at `2026-09-08T21:57:38Z`.
The existing strict SSE prolog check admitted HTTP 200 with missing Content-Type.
S2 SSE continuation passed at `2026-09-08T22:01:09Z`, randomly selecting
wi-experiment. Native replay and both expected answers passed; no opaque items
were emitted, so live opaque replay remains untested.
S3 SSE add_numbers(17,25) passed at `2026-09-08T22:05:23Z`, randomly selecting
wi-experiment. One correlated execution/result, native replay and final42 passed.
L0, L1 and all W1-W3/S1-S3 cases are complete on local Linux. No further live test
is planned. The [combined design-conversation report](COMBINED_DESIGN_REPORT.md)
is complete and includes the evidence boundaries and remaining limits. Existing Pi/Codex credential
files remain read-only and are not consulted by managed login or renewal.
The parent-owned matrix and verification reports remain the authority for acceptance
and the generation ledger.
