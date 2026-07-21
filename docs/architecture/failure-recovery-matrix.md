# Wi v0.1 failure and recovery matrix

Status: canonical for Milestone 7

## Recovery ownership

- The per-session database is canonical for events, accepted commands, runs, provider steps, tool executions, approvals, and pending inputs.
- `SessionStoreManager` owns incomplete creation recovery, catalog discovery, and catalog reconstruction.
- `SessionActor` owns startup adoption of durable run and interaction state.
- `AgentRunLoop` resumes only work permitted by the durable tool ledger.
- `WiServer` owns bounded transport and runtime shutdown.

Recovery is idempotent. Every recovery mutation uses event identity plus projection compare-and-transition checks; a repeated restart either reuses the committed recovery event or observes the terminal projection.

## Crash matrix

| Failpoint | Exit | Durable result after restart |
|---|---:|---|
| `after_command_event_insert_before_commit` | 90 | Transaction rolls back. No user/run event or accepted-command row exists; same-ID retry is new work. |
| `after_command_commit_before_ack` | 91 | Accepted command and events replay. Same-ID retry returns the stored result with `duplicate: true`. |
| `after_event_commit_before_publish` | 92 | Event appears through replay; live publication is never required for durability. |
| `after_tool_requested_commit` | 93 | Existing requested pure call resumes through the same ledger row. |
| `after_tool_started_commit` | 94 | Existing started pure call is reconciled to retryable state and retried with an incremented attempt count; no second row is created. |
| `after_tool_result_commit_before_provider_continue` | 95 | Committed result is reused for provider continuation; the tool is not executed again. |
| `after_provider_text_commit` | 96 | Partial text remains visible; the streaming provider step and run become interrupted and staged calls are discarded. |
| `after_run_terminal_commit` | 97 | The completed terminal state and its one terminal event remain unchanged. |
| `after_session_create_before_catalog_ready` | 98 | Startup completes the known `creating` reservation from the session manifest. |
| `after_catalog_session_repair` | 99 | The durable repair marker remains set. Restart rescans all generated session paths and idempotently completes reconstruction. |
| `after_catalog_replacement_before_repair` | 100 | A newly created catalog schema and durable repair intent already committed; repeated restart rescans safely before any reconstructed row. Corrupt existing catalogs fail closed before this boundary. |

The process suite also covers a force kill while waiting for approval, repeated restart while approval/input remains pending, approval resolution committed immediately before process death, two consecutive crashes using the same publication failpoint, concurrent sessions reaching each workflow boundary in the wrong order, graceful shutdown during provider streaming, replay, and catalog observation, retained noncooperative replay and catalog-observation gates, a blocked storage request timing out during shutdown, partial catalog repair, catalog deletion, and corrupt or identity-mismatched discovered databases. Process test files use an explicitly selected single-thread Vitest pool and therefore run serially under the full workspace gate, readiness-sensitive fixture deadlines begin only after an explicit marker, and CI runs the complete process project on Linux.

## Test-only controls

Failpoints are a closed enum and cannot be selected by browser or provider data. Activation requires all of:

```text
NODE_ENV=test
WI_ALLOW_TEST_FAILPOINTS=1
WI_TEST_FAILPOINT=<closed inventory name>
```

Each configured name also requires exactly one compatible, protocol-validated selector shape:

```text
command transaction/ack:       WI_TEST_FAILPOINT_SESSION_ID + WI_TEST_FAILPOINT_COMMAND_ID
catalog session repair:         WI_TEST_FAILPOINT_SESSION_ID
publication/provider/tool/run:  WI_TEST_FAILPOINT_SESSION_ID + WI_TEST_FAILPOINT_COMMAND_ID + WI_TEST_FAILPOINT_RUN_ID
session creation:               WI_TEST_FAILPOINT_COMMAND_ID
catalog replacement:            WI_TEST_FAILPOINT_CATALOG_GLOBAL=1
```

Unknown names, missing gates, malformed IDs, missing selector fields, extra selector fields, conflicting selector kinds, and a session selector for a catalog-global boundary are rejected before startup. Browser commands and provider output cannot create or change the environment-owned selector. Boundary fields must match every configured selector field before the one-shot is consumed; an unrelated session reaching the same named boundary first remains alive. The storage worker independently requires both `NODE_ENV=test` and `WI_ALLOW_TEST_FAILPOINTS=1`; setting its ordinary test-operation option is insufficient. A triggered failpoint logs `test_failpoint_triggered` with `testOnly: true`, then exits with its documented deterministic code. The pre-commit worker failpoint is added only to the matching command transaction, so SQLite rolls it back; the matching failed request then terminates the server process with code 90.

## Startup catalog scanner

Normal startup reads the catalog only. It does not enumerate or open session databases.

The bounded scanner runs only when:

1. the catalog was newly created or missing; or
2. explicit repair mode is requested with `WI_CATALOG_REPAIR=1`.

Before opening an existing canonical catalog read-write, the catalog worker copies the database and any WAL/SHM sidecars to a private probe directory. SQLite recovery, `quick_check`, and migration validation run only on that disposable copy; pre/post source-directory and file identities must remain equal. A two-phase manager/worker handshake permits a deterministic substitution check after validation. The final open acquires a `fileMustExist` SQLite handle and synchronously rechecks the prepared directory and DB/WAL/SHM path identities before the first project-issued PRAGMA or query. These checks are defense-in-depth for ordinary failures and visible substitutions, not a handle-relative security boundary against a hostile same-user process. Missing-catalog bootstrap reserves an empty canonical file with final-component no-follow and no-overwrite creation; parent components are trusted under ADR-0012. Startup filesystem diagnostics use fixed bounded messages that disclose neither `WI_HOME` nor probe paths. If the ordinary copy probe fails, Wi preserves the canonical files unopened and unchanged and fails startup. Node exposes no cross-platform handle-relative, no-follow, no-overwrite move, so Wi does not attempt automatic quarantine or replacement. With Wi stopped, an operator may restore the catalog or deliberately relocate it outside Wi; a later missing-catalog startup can rebuild session-index rows.

A fresh catalog commits its singleton `catalog_repair_state` in the same migration transaction that makes the catalog usable. Explicit repair of a healthy catalog sets `explicit` in place; an existing unopenable catalog is preserved and startup fails closed. The marker is removed only after every discovered record and recoverable creation command has been reconciled or classified and every catalog row absent from the bounded scan has been classified: `ready` becomes `missing`, while an existing `missing` or intentionally quarantined `unavailable` state is preserved. A process crash therefore leaves a durable continuation trigger; restart rescans and idempotently reconciles already-written rows instead of mistaking the partially rebuilt catalog for healthy.

The scanner runs inside the session storage worker boundary, sequentially in v0.1, with a configurable hard maximum of 1,000 session records by default and 10,000 maximum. Directory handles stream entries rather than materializing whole directories. The first pass returns only a sorted, bounded inventory of canonical session IDs and entry counts. Database-derived records are then returned through independently bounded pages. The catalog complement likewise reads lightweight session status/provenance pages and writes missing classifications in batches of at most 1,000; the complete discovered-ID inventory never crosses the catalog worker-RPC boundary, including at 10,000 maximum-length session IDs. Worker-originated discovery error codes are capped at 128 UTF-16 units and messages at 4,096 units before serialization; the receiving schema independently enforces both limits. Across pages, the manager retains only creation-command ownership plus constant-size non-valid classifications (`kind` and unsupported schema version when applicable), never messages or full records. The reconciliation pass rereads bounded pages. A supported record can always occupy a page by itself, so cumulative valid titles, payloads, or malformed-database diagnostics cannot make an installation permanently exceed one worker response or accumulate proportionally sized main-thread records. Total prefix/session entries are separately capped at `min(40,000, sessionLimit * 8 + 256)`, so malformed trees cannot bypass the record limit and consume unbounded worker memory or time. It traverses only:

```text
$WI_HOME/sessions/<derived-two-character-prefix>/<valid-session-id>/session.sqlite3
```

Discovery is read-only, non-migrating, and bounded before returning database-derived fields. Lazy opens and discovery require exact generated paths, non-symlink components, sessions-root realpath containment, and pre/post file identity checks. Linux directory symlinks, invalid IDs, wrong prefixes, non-files, and realpaths outside the generated sessions root are never followed. The process scanner probe creates a Linux directory symlink and verifies it remains untouched and absent from the recovered catalog. Valid manifests reconstruct session-index data and semantically verified v4 creation provenance reconstructs accepted `session.create` command rows. Verification requires the exact `{ sessionId }` result, a payload hash matching the normalized manifest-backed creation command, and event identity plus acceptance time matching the canonical sequence-1 `session.created` event and manifest. Discovery accepts every title and user-message payload within the normal durable-event capacity; reconstructed update time, 200-character message preview, and run state use the same latest-event-sequence rules as normal catalog observation. Explicit repair compares against the current catalog row and reports a session repaired only after the canonical replacement is applied. Valid, corrupt, unsupported, oversized, file-missing, and directory-missing classifications all repair stale catalog paths to the strict generated path. Non-valid classifications preserve existing catalog-only metadata while changing only canonical path, fault status, observed newer schema version when applicable, and recovery-candidate state.

Structural corruption or identity mismatch creates an `unavailable` row and preserves the session directory at its canonical path. Wi does not use a pathname-based session-directory rename: Node has no cross-platform handle-relative rename, and another same-user process could otherwise swap an ancestor after discovery. Catalog schema version 5 still reads explicit `quarantined` provenance written by earlier binaries, but current repairs do not create new quarantine provenance. A newer unsupported session schema likewise creates an `unavailable` row and is preserved at its canonical path for a compatible future Wi version. A catalog-known missing database file or entirely absent generated session directory changes only that row's status to `missing`; its catalog-only metadata and any remaining directory are preserved. This includes a formerly unsupported or oversized database that was deliberately preserved but was later deleted. An explicitly quarantined row remains `unavailable` when its generated path is absent. Busy, permission, descriptor, full-disk, I/O, and resource failures retain the repair marker without quarantine. Corrupt, unsupported, or missing databases do not block healthy discoveries.

The generated layout makes a valid session ID unique, so filesystem enumeration order cannot choose between competing canonical paths. A valid session ID under the wrong prefix is noncanonical input: discovery ignores it without opening, following, or mutating it. Only a database at its exact generated path can become a discovery claimant; a canonical-path manifest identity mismatch is marked unavailable and preserved in place. If multiple otherwise valid canonical databases claim the same creation command ID, every ambiguous claimant is marked unavailable and preserved while independent sessions continue reconstruction. A discovered claimant that conflicts with an existing catalog command is likewise isolated before its catalog session row can be reconciled as ready.

`unavailable` and `missing` are authoritative storage-boundary states. Normal session open, every client read/recovery, direct command acceptance, and direct append recheck the catalog before session-worker use; rejection closes any retained lazy database handle. A stale server/router precheck cannot authorize later actor construction or mutation. Generic reconciliation is ready-only and cannot promote a non-ready row, even when given a matching stale inspection. Only the internal validated-repair operation used by the complete bounded scanner can restore `ready`, after all discovery and provenance checks pass. That operation is held in module closure rather than a runtime-visible client field or symbol. The manager's worker pool and each client's pool/hooks use JavaScript private fields, and the normal storage package entry point exports no worker-pool or client constructor. Internal test access is explicitly `NODE_ENV=test` gated and is not a package export. Catalog and session databases remain separately transactional; no cross-database transaction is introduced.

## Catalog and project limitations

A session manifest reconstructs its session ID, title, timestamps, schema version, and optional project ID reference. It does **not** reconstruct project names, canonical paths, realpaths, or project configuration. After total catalog loss, a recovered session retains its project ID reference, but the project must be explicitly re-registered before project metadata or future project services can be used. Wi never guesses a project path.

Explicit repair accepts only the boolean `WI_CATALOG_REPAIR=1`; no browser command or environment value supplies an arbitrary filesystem path. Normal session creation and discovery share the same default 1,000-session installation limit. `WI_SESSION_DISCOVERY_LIMIT` can raise both boundaries to at most 10,000 for an intentional larger local installation or repair. A database file above the 256 MiB discovery budget is a permanent per-session `unavailable` classification: it is preserved in place, does not quarantine healthy data, and does not retain installation-wide repair intent.

## Startup actor adoption

A catalog recovery candidate is set before a session can commit a nonterminal run transition. It is cleared only after a canonical session observation proves no nonterminal run remains; laggable catalog summaries are not authoritative. After storage repair, the runtime acquires and releases candidate actors without browser activity. Catalog candidates are fetched and adopted in cursor pages of at most 1,000 IDs; neither the catalog client nor the main runtime materializes the complete candidate set. Runtime startup has one memoized lifecycle and checks server-owned closing state before and after every page request and at each adoption boundary. If shutdown wins, further enumeration and adoption stop, and close-induced storage or actor failures are treated as startup cancellation rather than an independent startup failure. This preserves ordinary lazy opening for noncandidates. Legacy catalog rows are conservatively candidates once after migration.

## Provider and tool recovery

- Streaming provider steps become `interrupted`; committed text remains and no provider output is invented.
- Staged calls belonging to a nonterminal provider response become non-executable.
- Pending approvals and inputs remain pending. Restored work stays dormant until the durable response transition commits.
- Requested pure calls may resume.
- Started pure calls reconcile and retry through the same ledger row.
- Completed tool results are reused.
- A started non-idempotent effect with no provable result becomes `outcome_unknown` and is never retried automatically.
- Completed runs remain terminal and receive no second terminal event.

## Graceful bounded shutdown

Shutdown proceeds in this order:

1. mark the HTTP/WebSocket server closing and stop upgrades and new commands;
2. begin bounded HTTP listener drain;
3. close browser WebSockets and subscription/replay queues;
4. stop actor admission and cancel/drain active provider and tool tasks under actor deadlines;
5. shut down scheduler admission and drain held permits;
6. stop new storage commits, drain active operations and bounded catalog observations;
7. close session workers, then the catalog worker;
8. exit after logging completion or an aggregated bounded-shutdown diagnostic.

HTTP sockets, rejected upgrades, WebSockets, actor cancellation, scheduler drain, catalog observation drain, and worker close all have finite deadlines. A timed-out component is isolated or force-closed where a hard boundary exists, its diagnostic is recorded, and later shutdown phases continue. A fully force-closed HTTP/WebSocket transport timeout is successful fault-domain isolation and may still complete shutdown with exit zero; an unresolved internal phase or failed transport isolation is aggregated into `server_shutdown_diagnostic` and exits nonzero. In-process provider/tool work that ignores cancellation has no safe smaller isolation boundary in v0.1, so Wi exits nonzero without falsely terminalizing the run; restart recovery conservatively handles its durable nonterminal state. The process suite sends real SIGTERM during both provider and pure-tool execution on Linux. For the pure tool, fail-closed process exit leaves one started ledger row; restart reconciles and completes that same row at attempt 2 without an `outcome_unknown` event. Process fixtures use detached Linux process groups, bounded waits, escalation, verified group disappearance, and only then temporary-home deletion. Harness stdout and stderr diagnostics are fixed 64-KiB byte tails with exact total-byte counts, truncation flags, and streaming SHA-256 hashes; readiness matching uses a streaming marker capped at 4 KiB and never scans retained output. Real-server pending IPC is capped at 128 messages and historical IPC diagnostics at 256 messages, with separate truncation state. Crossing a diagnostic cap does not kill the child; timeout and verified tree cleanup remain authoritative. Generic fixture runners retain and verify that boundary after every leader close, including a normal zero exit, before removing the fixture from cleanup tracking. On Linux, a test-support watchdog installs an inherited owner-pipe EOF watcher before a preload gate releases fixture code. The watchdog owns the registered detached process-group identity across direct-leader exit, reclaims that group if the harness owner dies, and is released only after normal or explicit cleanup; setup failure never releases fixture code unmanaged. A nested owner-death process probe verifies that Linux owner-pipe EOF reclaims both the fixture leader and descendant before ordinary outer-harness cleanup begins. There is no leader-only fallback that can claim unverified cleanup. Noncooperative replay disconnects are isolated cleanly without waiting for the retained hook; a noncooperative catalog observation exhausts the shared deadline, exits nonzero with a shutdown diagnostic, and remains recoverable on restart.
