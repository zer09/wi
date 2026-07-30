# ADR-0014: Use a WSL-safe file CredentialStore by default

Status: Accepted

Date: 2026-07-29

## Context

Wi v0.2 needs backend-only API-key and OAuth credential persistence on openSUSE under WSL. A Linux Secret Service/keyring may depend on systemd, D-Bus, a session daemon, and unlock behavior that is not consistently available during interactive and noninteractive WSL startup.

Putting provider secrets in `WI_HOME` would also include them in Wi's documented stopped-home backup boundary. Encrypting a file with a key stored beside it would add complexity without changing the trusted-local-user threat model in ADR-0012.

The implemented v0.1 product has no provider credential persistence. This ADR governs planned Milestone 11 and later work.

## Decision

The subsystem is named `CredentialStore`, not `CredentialVault`, and exposes an interface equivalent to:

```ts
interface CredentialStore {
  put(ref: string, credential: StoredCredential): Promise<void>;
  get(ref: string): Promise<StoredCredential | null>;
  delete(ref: string): Promise<void>;
  listRefs(): Promise<readonly string[]>;
}
```

Backends are explicit:

```text
file          default for v0.2
environment   read-only API-key references
keyring       optional later/experimental
```

There is no initial `auto` backend and no silent fallback between backends.

The default file root is:

```text
${XDG_STATE_HOME:-$HOME/.local/state}/wi/credentials/
```

It remains on the WSL Linux filesystem by default, not `/mnt/c`, and must not overlap canonical `WI_HOME`. Custom roots must reject canonical `/mnt/<Windows-drive-letter>` paths, aliases into them, and Windows-backed DrvFS/9p mounts. Configuration fails closed unless required Linux ownership/mode, same-directory atomic rename, file-flush, and directory-flush semantics can be established; absolute-path syntax alone is insufficient. The managed root is mode `0700`; each connection has one backend-generated opaque file at mode `0600`.

The versioned bounded envelope binds secret material to a backend-generated random nonsecret `envelopeId`, connection, provider, auth mode, generation, nonsecret verified identity claim, and update time. Each completed replacement receives a new `envelopeId` that is not derived from credential bytes. The identity is explicitly `unverified` or contains an adapter-declared authoritative subject/account/project plus normalized workspace; it must agree with credential payload identity. It supports API-key or ChatGPT OAuth credentials. Provider-specific additions require a versioned validated schema and may not remove envelope-instance, identity-claim, or connection/generation binding.

File operations must use generated contained paths, reject symlink/non-regular/path-escape identities, serialize writes per connection, write an exclusive same-directory temporary file at restrictive mode, flush it, atomically rename, repair final mode, and flush the directory. A crash exposes the old complete or new complete envelope, never partial JSON. Deletion affects only one connection and is durably flushed.

File API keys are introduced only through a backend-local `CredentialProvisioner`, never a browser request, URL, command-line argument, or environment value. A trusted local entrypoint reads bounded secret bytes from masked stdin or a supplied file descriptor and atomically writes a versioned, expiring staged envelope under the separate private `${XDG_STATE_HOME:-$HOME/.local/state}/wi/credential-staging/` root, which cannot overlap `WI_HOME` or completed credential storage. It returns only an opaque one-time `provisioningRef`. A catalog lifecycle operation claims that reference once before publishing the final connection-bound envelope; claimed stages survive restart until the operation terminates, while unclaimed stages expire. Terminal cleanup is idempotent. A missing claimed stage and absent final file produce one stable failure and explicit restaging, never a guessed credential.

Because catalog metadata and files cannot share a transaction, every create, credential replace/relogin, logout, and delete uses a nonsecret catalog lifecycle operation keyed by `commandId` and content hash. It durably prepares the expected connection/lifecycle revision and target generation or tombstone before the file effect, then atomically commits metadata and the stable command result after observing the exact envelope or deletion. Restart resumes a prepared operation from old-complete, new-complete, or exact-absent evidence without incrementing twice. Mismatched or unowned files remain preserved and unavailable; they are never guessed, rebound, or automatically deleted.

Exactly one durable lifecycle-operation owner may exist per connection or reserved connection identity from prepare through file effect and terminal catalog commit. Create publication, replacement, relogin/reauthentication, same-generation refresh publication, disable, logout, delete, and future enable are mutually exclusive in that slot. Identical retries resume or return the owner; a different command receives one durable `operation_in_progress` result and is never queued automatically. Recovery terminalizes the owner before admitting another operation. Lifecycle revision increments once at prepare for identity/cutoff changes, or atomically for catalog-only disable/enable, but not for verified same-generation refresh; terminalization does not increment again. Alias, capability, and rate/health metadata have a separate revision and cannot overwrite lifecycle fields or close/reopen leases. Unprovable post-effect terminal state becomes `failed_after_effect` and explicitly `unavailable` with evidence preserved, never restored to `ready`.

After complete catalog loss, surviving file envelopes are not auto-imported. The validated backend must complete a bounded closed scan epoch over the whole managed root before issuing any authenticated safe candidate metadata or expiring opaque `recoveryRef`; cap exhaustion/root change yields no references, and duplicate connection/authoritative-identity claims are ineligible. A reference is process/scan-epoch bound and intentionally expires across restart before claim; presenting it then durably returns `recovery_ref_expired`, while a new scan and command are required. Before prepare the backend repeats the complete scan and revalidates the exact internal credential reference, `envelopeId`, and envelope-bound subject/account/project/workspace identity. An explicit `commandId`/content-hash operation claims once, reserves an unavailable row, and restores only the envelope's original `connectionId` and generation after authoritative uniqueness checks; `unverified` identity remains distinct only by connection ID. Lifecycle revision restarts at 1 for the rebuilt catalog epoch; pre-loss nonterminal provider work is interrupted rather than implicitly resumed. Conflicts and malformed/changed/already-claimed evidence fail closed and remain preserved. A post-claim source change terminalizes an unavailable recovery tombstone and consumes the claim; the next supported transition is normal explicit replacement/reauthentication, not reinterpretation of changed evidence. Prepared/file-observed/terminal/acknowledgement crashes and identical retries have one stable result. No credential-derived hash is persisted.

The browser never writes the complete recovery command or `recoveryRef` to its persistent command journal. Before send it stores only bounded safe reconciliation metadata: command ID, recovery operation kind, nonclaiming recovery epoch/expiry, and expected nonsecret display fields. Command ingress synchronously registers in a bounded epoch admission coordinator, then a first catalog transaction stores the canonical hash and safe phase `validating` before the complete pre-prepare scan; it claims no credential. A bounded authenticated non-mutating status read by command ID/kind/epoch returns admission/open-epoch/`validating` pending state, safe `prepared`/`file_observed` pending state, final `not_accepted` only after epoch closure plus drained ingress, or the original terminal result. Restart from `validating` terminalizes `recovery_ref_expired`. Wrong method/epoch or safe-metadata mismatch conflicts. The read cannot accept content, claim evidence, resume work, or return/infer a reference. Epoch closure rejects later reference admission, so `not_accepted` proves the old command cannot later prepare. This preserves durable command content-hash conflict semantics while allowing lost-ack/reload reconciliation without persisting the reference.

Environment references have the form `env:NAME`. Wi persists only the validated variable name and never exposes its value to the browser. Before acknowledging a run, acceptance resolves a nonempty value and establishes an in-memory keyed fingerprint lease; every request, including the first, re-resolves and must match it. Missing or changed values fail the pinned run before another credential is used and never trigger fallback. The durable run records only the backend and a nonsecret process epoch. Because restart cannot reproduce the nonpersisted fingerprint, recovery interrupts an accepted nonterminal environment-backed run before provider work. OAuth cannot use this read-only backend.

The file store is plaintext protected by Linux ownership and modes. Wi will not claim it is encrypted and will not add application encryption whose key is stored beside it.

## Alternatives

### Keyring as mandatory default

Rejected for v0.2 because openSUSE WSL interactive/noninteractive availability is not established. Keyring remains an explicit optional spike.

### Implicit `auto` backend

Rejected because silent keyring-to-file fallback obscures where secrets live and changes restart behavior.

### Store credentials in catalog/session SQLite or `WI_HOME`

Rejected because it violates secret separation and would silently include credentials in stopped-home backup/export.

### One shared credential JSON file

Rejected because independent replacement/deletion would rewrite unrelated credentials and enlarge corruption/locking scope.

### Application encryption with adjacent key

Rejected because an actor able to read the file can read the adjacent key; the extra key lifecycle adds failure modes without useful protection under ADR-0012.

## Consequences

Positive:

- predictable noninteractive WSL restart;
- auditable secret location and POSIX modes;
- independent atomic updates/deletion per connection;
- credentials remain outside catalog/session history and `WI_HOME` backups;
- future keyring support can implement the same interface.

Negative:

- credentials are plaintext to the trusted operating-system user;
- permission, containment, crash-consistency, and redaction code require extensive tests;
- environment-backed active chains have conservative restart limitations;
- users choosing a mounted/custom state path must satisfy explicit safety checks.

## Security/failure implications

- Root/file modes are exactly `0700`/`0600`; unsafe replacement and safely repairable existing-file modes are repaired before secret read.
- `/mnt/c`, canonical Windows-drive aliases, and Windows-backed mounts are rejected even when they are syntactically absolute Linux paths.
- Browser/provider data cannot supply paths or filenames.
- An existing final file is opened no-follow and verified by descriptor as regular, current-user-owned, single-link, and identity-matching before `fchmod(0600)`; it is flushed and revalidated before secret read. Symlinks, wrong ownership, extra links, substitution, repair failure, path escape, non-regular files, envelope mismatch, oversized files, and invalid schemas fail closed without reading.
- API keys, access/refresh tokens, OAuth state/codes, callback queries, and credential values are redacted and excluded from browser, SQLite, logs, diagnostics, tests, and exports.
- Credential-root overlap with `WI_HOME` is a startup/configuration error.
- A missing or changed environment variable before first or later request fails only the pre-acknowledgement-pinned run and never triggers fallback.
- Credential-subsystem initialization failure is process-fatal only when safe secret handling cannot be guaranteed; a single corrupt connection remains the smaller fault domain when it can be isolated.
- The filesystem checks are defense in depth, not protection from a hostile concurrent same-user race excluded by ADR-0012.

## Validation requirements

- Verify root `0700`, file `0600`, and repair-before-read of unsafe replacement and existing owned-file modes, including flush and post-repair identity/mode checks.
- Reject symlinked managed paths, path traversal, external realpaths, non-regular files, arbitrary catalog/browser paths, and identity/generation mismatch.
- Kill before/after staging commit, catalog prepare/claim, file publish/delete, terminal catalog commit, acknowledgement, and stage cleanup; resend the same `commandId` and prove one stable result and generation.
- Prove full prepared-to-terminal per-connection ownership, monotonic lifecycle revisions, stable identical/conflicting command results, recovery-before-next-operation, and independent deletion.
- Interleave replace/disable, replace/logout, delete/reauthenticate, refresh/logout, and two distinct replacements across every file/terminal/acknowledgement crash boundary; prove no resurrection, duplicate generation, or cross-connection mutation.
- Prove rename/capability/rate metadata uses disjoint revisions and cannot alter lifecycle ownership, administrative cutoff, or credential-lease availability.
- Bound envelope/file/directory enumeration and malformed input.
- After complete catalog loss, enumerate several valid envelopes as safe metadata plus opaque one-time recovery references; explicitly restore each exact original connection/generation without paths, secrets, guessing, or auto-import.
- Test same aliases/different identities, authoritative versus unverified envelope identity, original connection-ID conflicts, duplicate authoritative OAuth identity, duplicate envelopes beyond a page boundary, incomplete/truncated/changing scans, malformed/mismatched provider/auth/generation/`envelopeId`, arbitrary refs, and already-claimed evidence; preserve every rejected file.
- Kill before claim and prove a process-bound stale reference commits stable `recovery_ref_expired`; kill after claim, file observation, terminal commit, and acknowledgement and prove in-memory retry or safe status reconciliation returns one result while conflicting recovery never creates a duplicate row or claim.
- Lose acknowledgement during pre-admission ingress, `validating` scan, after prepare, and after terminal commit; reload/close/reopen and prove only safe reconciliation metadata persisted, status returns pending/not-accepted/original result, and no second claim, row, generation, or credential effect occurs.
- Race status against pre-prepare scan completion; prove open epoch/registered ingress cannot return final absence, `not_accepted` requires closed epoch plus drained ingress and cannot be followed by prepare, same-ID changed epoch/metadata conflicts, claimed evidence cannot be reclaimed, and repeated bounded authenticated reads are reference-free and non-mutating.
- Scan browser/bootstrap/WebSocket, catalog/session databases, logs, diagnostics, exports, and fixtures for synthetic secret values; separately seed generated-filename, internal-reference, recovery-reference, and credential-derived-hash canaries. A recovery reference may appear only in its bounded authenticated candidate response and in-memory matching selection command; prove it and the complete command are absent from persistent browser storage/history and unrelated payloads, and prove every canary is absent from URL/log/diagnostic/trace/fixture/export evidence.
- Prove a stopped `WI_HOME` backup excludes the credential root.
- Prove noninteractive openSUSE WSL/Linux restart with the file backend and reject `/mnt/c`, aliases, and unsupported mount semantics.
- Prove environment acceptance-to-first-request and later-request replacement/disappearance behavior, process-restart interruption, browser exclusion, OAuth rejection, and no fallback.
- Before accepting keyring, test openSUSE WSL, systemd/D-Bus, interactive/noninteractive startup, locked/unavailable state, refresh updates, logout/delete, restart, export exclusion, and redacted diagnostics.

## Implementation milestone

- Milestone 11: file and environment backends.
- Optional keyring support requires a later explicit spike and is not a v0.2 release blocker.
- Milestone 10 records architecture only and writes no credential files.
