# ADR-0013: Support multiple provider connections with explicit account selection

Status: Accepted

Date: 2026-07-29

## Context

ADR-0005 defines separate direct adapters for OpenAI Platform API keys and ChatGPT/Codex OAuth, but Wi must also support more than one account/project/workspace inside the same provider and authentication mode.

Treating one provider as one mutable login would make a second login overwrite the first, couple refresh/logout across accounts, and make billing identity ambiguous. Automatic selection would add account, capability, limit, cache, and billing policy before operational evidence exists.

The implemented v0.1 product still has only the deterministic fake provider. This ADR governs planned v0.2 implementation.

## Decision

Wi will model a provider connection as a stable nonsecret `connectionId` plus:

```text
providerId and authMode
display alias
opaque credentialRef and credentialGeneration
known subject/account/workspace/plan identity
lifecycle status
connection-specific capabilitiesVersion
creation/update timestamps
```

Secrets remain in `CredentialStore`, never in catalog/session SQLite.

Wi will support multiple simultaneous connections for one provider/auth mode. A second ChatGPT login does not overwrite or log out the first. Refresh, disable, logout, reauthentication, and deletion are independent per connection.

When authoritative identity is known, OAuth uniqueness is based on provider/auth plus stable subject-or-account and normalized workspace. After authentication, one serialized catalog transaction claims that tuple and resolves the target `connectionId` before completed credential publication. Concurrent completion for the same tuple returns one winning connection instead of committing duplicates; the same subject in two explicit workspaces remains distinct. When identity is not authoritative, Wi keeps connections distinct and does not guess from aliases or email-shaped labels.

Every OAuth attempt has an independent `loginId`, OAuth state, PKCE material, requested alias/provider/auth mode, expiry, flow state, and one-time completion. Concurrent callback/device attempts cannot cross-complete. Restart-relevant attempt secrets are planned to use a bounded temporary credential-subsystem store outside `WI_HOME`.

Wi prefers OAuth response modes that keep authorization codes out of URL queries. When the provider requires callback query parameters, that provider-protocol URL is a narrow exception to the no-secret-URL rule: a dedicated loopback endpoint must apply no-store/no-referrer/no-external-content policy, exclude the request target from logs, consume the parameters once, and immediately replace/redirect browser history to a clean expiring status tombstone. It never forwards or persists the raw callback URL/query.

Provider-connection rows are nonsecret installation configuration in the catalog, analogous to project registration metadata; they are not canonical session history. Session-index reconstruction remains manifest-backed. Complete catalog loss preserves credential files but does not auto-import or rebind them: provider connections require explicit re-registration/recovery with verified envelope identity. Historical run snapshots remain canonical and intelligible.

The active selection policy through Milestone 14 is explicit:

```ts
type ProviderSelectionPolicy = {
  kind: "explicit";
  connectionId: string;
};
```

Each session stores a default connection/model for future runs. Every accepted run durably snapshots its selected connection, generation, credential backend and environment process epoch when applicable, provider/auth/account/workspace, model, capabilities, prompt/tool/reasoning/transport, and provider-chain identity before acknowledgement. Changing a session default never mutates an active run.

Each provider request acquires a one-request lease bound to the connection, credential generation, and lifecycle revision. A request issued before a committed disable/logout/delete cutoff may settle, including ledgered tools from its accepted terminal response, but no new request, refresh, or post-tool continuation may begin afterward. The next provider boundary fails explicitly on the pinned connection and never switches accounts.

## Alternatives

### One mutable connection per provider

Rejected because it prevents simultaneous accounts and makes login/refresh/logout destructive to unrelated work.

### Deduplicate by alias or email label

Rejected because aliases are user-controlled and provider labels may be nonauthoritative or ambiguous across workspaces.

### Automatic least-loaded or round-robin selection initially

Rejected because it can silently change account, billing, capabilities, and cache/continuation identity. ADR-0016 defines the later telemetry gate.

### Store provider credentials in catalog/session databases

Rejected because those databases are canonical history/index stores with different backup/export and browser-facing boundaries.

## Consequences

Positive:

- simultaneous personal/work accounts and projects are first-class;
- account/workspace/billing identity remains visible and durable;
- one connection's refresh/logout cannot mutate another;
- run identity is stable across browser disconnect and session-default changes;
- explicit selection is predictable and testable.

Negative:

- connection lifecycle and duplicate-login resolution require durable metadata;
- OAuth attempts and workspace selection need explicit state machines;
- historical runs must retain nonsecret snapshots after connection deletion;
- users must deliberately change connections when one reaches a limit.

## Security/failure implications

- Wi never writes API keys, tokens, PKCE verifiers, authorization/device codes, or raw callbacks to browser, catalog, or session storage. Provider-required OAuth state/code URL parameters may transit only the dedicated callback endpoint and must be immediately stripped under the architecture's no-store/no-referrer rules.
- A callback state mismatch fails only that callback and does not consume another attempt.
- Duplicate callbacks are one-time/idempotent and cannot write a second credential.
- Simultaneous same-identity completions atomically resolve one `connectionId`; each lifecycle command can reserve or increment its generation only once.
- Credential replacement increments only the matched connection's generation; same-identity token refresh may retain generation under the verified rules in the architecture.
- Disabled, unavailable, rate-limited, or reauthentication-required connections fail explicitly. Wi never selects another connection.
- Deleting a connection cannot rewrite historical canonical events or mutate another connection.
- Catalog loss cannot cause orphan credential files to be guessed, rebound, or deleted automatically.

## Validation requirements

- A and B can be connected simultaneously and used by concurrent sessions.
- Refresh, disable, logout, delete, and relogin A leave B unchanged.
- Relogin A increments only A's generation.
- Simultaneous duplicate A/workspace A logins return one atomically claimed connection without an identity copy; same subject/different workspace remains distinct.
- One subject can explicitly bind two workspaces as separate connections.
- Two OAuth attempts, denial, cancellation, expiry, restart, duplicate callback, state mismatch, and workspace selection have deterministic isolated outcomes.
- Callback tests inspect redirects, history, referrers, browser storage/service workers, logs, diagnostics, and network requests and prove query secrets are neither retained nor forwarded.
- Session default A to B during run A leaves run A pinned and makes only the next run select B.
- Disable/logout before a request, during streaming, after provider completion, after a tool result, and before continuation obey the one-request lease cutoff without fallback.
- A selected limited/unavailable connection reports itself and never falls back.
- Property tests cover identity normalization, duplicate resolution, lifecycle idempotency, and generation isolation.

## Implementation milestone

- Milestone 11: connection catalog, explicit selection, defaults, and run snapshots without OpenAI network calls.
- Milestone 13: multi-account OAuth, workspace identity, refresh, and reauthentication.
- Milestone 10 records architecture only.
