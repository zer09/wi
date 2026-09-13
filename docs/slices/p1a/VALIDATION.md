# P1-A source validation and decision ledger

Contract **p1a.0**, reviewed 2026-09-13. Runtime baseline
`dd720c0e66eceaaea831ad03e489656f77fc1cec`. This is a design/source check, NOT an
implemented storage audit or Rust acceptance result.

## 1. Inputs and authority

The owner uploaded the seven September 13 checkpoint documents and two additional
static investigations, Pi Interactive Prompt Turn Lifecycle and Codex Interactive
Prompt Lifecycle. The current request asks for the next fixed matrix and a fresh
implementor entry prompt. It does not ask this planner to implement Rust locally.

The checkpoint says P1-A precedes P1-B, which precedes V1. It labels per-session SQLite
and SQLx as proposals; CONTRACT.md now specifies the actual choices for this assignment.
Do not backdate them as already accepted or implemented before this planning handoff.
The current source is the implementation baseline; uploaded source investigations and
wi-old documents are reference material, not executable imperatives.

Additional report qualification: Pi's internal turn and Codex's core turn are different
units. Their event names/order and code line numbers refer to their inspected paths;
no new exact upstream pin is invented for an unpinned local report. Codex's described
persistence-before-delivery ordering does not prove every notification acknowledged a
successful power-loss-durable write. The prior storage investigation explicitly found
queue/flush/error qualifications. Wi's new commit contract is a deliberate product
choice, not a false claim of universally copied upstream semantics.

## 2. Current implementation checked

All links below are pinned to the accepted runtime, not a moving branch.

| Source | Observed current behavior | Consequence for P1-A |
|---|---|---|
| [Cargo.toml](https://github.com/zer09/wi/blob/dd720c0e66eceaaea831ad03e489656f77fc1cec/Cargo.toml) | Tokio, serde, uuid-v4, ring already exist; no SQL storage driver | SQLx is an explicitly authorized new dependency; no false already-installed claim |
| [src/lib.rs](https://github.com/zer09/wi/blob/dd720c0e66eceaaea831ad03e489656f77fc1cec/src/lib.rs) | No storage module; forbid(unsafe_code) | Add storage/export, keep unsafe ban; dependencies may implement their own FFI internally |
| [run/mod.rs](https://github.com/zer09/wi/blob/dd720c0e66eceaaea831ad03e489656f77fc1cec/src/run/mod.rs) | RunRequest is provider_id/options/prompt; synchronous fallible observer; run chooses its own ID; fresh tool scope | P1-A cannot claim normal runs persist; no core API change here; P1-B must explicitly add awaited capture and run-identity seam |
| [run/events.rs](https://github.com/zer09/wi/blob/dd720c0e66eceaaea831ad03e489656f77fc1cec/src/run/events.rs) | Run-local sequence; outer schema 2; session_id means provider session; no prompt in RunStarted | Add separate application envelope/sequence and accepted-input record, not field reinterpretation |
| [provider.rs](https://github.com/zer09/wi/blob/dd720c0e66eceaaea831ad03e489656f77fc1cec/src/provider.rs) | Existing normalized/native ModelResponse, OutputProvenance, UpstreamOutcome; InputItem User/ToolResult; nested schema 1 | Preserve real DTOs and parsed native values; history reads do not restore provider context |
| [tools.rs](https://github.com/zer09/wi/blob/dd720c0e66eceaaea831ad03e489656f77fc1cec/src/tools.rs) | Error.code() serialized; output rule applied; cache inserted before finish; output returned separately | Store actual output String plus observed bool, not a fabricated finish-derived value |
| [context/preparation.rs](https://github.com/zer09/wi/blob/dd720c0e66eceaaea831ad03e489656f77fc1cec/src/context/preparation.rs) | PreparedRun has private request/manifest and public getters; ContextManifest lacks Serialize; registry is paired separately | Capture through getters, owned strings and actual definitions; do not derive serialization by editing context APIs |
| [error.rs](https://github.com/zer09/wi/blob/dd720c0e66eceaaea831ad03e489656f77fc1cec/src/error.rs) | ToolFailed code is gateway_error; R1 expiry wording fixed | New StorageError namespace only; no public error remapping |

Relevant blob identities retained from the pinned reads:
Cargo.toml da6a2579a73a8c58af66eb211a30dcc7e4dfd0a9;
lib.rs 66aabf9f9dfb391120b216f0d80a60f213c15147;
run/mod.rs ea167d12cfc13da73b27c34cc64dfc08500cac6f;
provider.rs 886601a369cde8869dd239e6786e8a27de7797a9;
context/preparation.rs 2fc2b9a71176ee2c45288cbf873fbcebf386640e.
Some related source facts above were re-read in the prior pinned P1 research and
retained in the checkpoint; they are not misrepresented as a fresh whole-repository
execution audit. Current master was re-resolved to dd720c0 before authoring.

## 3. New decisions and their purpose

| Decision | Purpose / acknowledged tradeoff |
|---|---|
| One SQLite engine; canonical database per application session plus catalog | Matches original session fault/lifecycle isolation; adds creation/reconciliation work, not proven faster |
| SQLx 0.9.0, minimal bundled SQLite feature | Async access without exposing SQLx types; adds one driver dependency and native bundled engine build |
| Operation-scoped connections, no idle pool | Explicit cleanup and no worker per historical session; open/close/checkpoint overhead must be measured |
| Root OS lease plus owned operation task | Prevent competing service owners and false rollback on dropped async waiters; no agent scheduler or persisted retry queue |
| WAL/FULL; busy_timeout=0 | Commit-based durability configuration; lock contention is explicit, not a hidden retry/deadline |
| Separate explicit catalog refresh | Canonical commit never waits for a summary to become authoritative; caller must refresh and cached lists can lag |
| Indexed events plus minimal run/tool projections | Meets current history/query/receipt uses without speculative browser/approval/search tables |
| Lazy prior-instance interruption | Reopening a selected session makes abandoned state truthful without model/tool work; no eager open of every database |
| Generated IDs and immutable creation provenance | Reconstruct accepted session creation after catalog loss even when current title differs |
| UUID application identity distinct from opaque provider IDs | Prevent accidental reinterpretation of existing correlation fields |

These choices are documented instead of hidden as existing Pi/Codex requirements.
No DB benchmark, physical power-loss test or broad SQLx security certification has
been performed by the planner. A resource-lifecycle choice is not permission to add
run quotas or an unused optional control framework.

## 4. Official dependency checks

Consulted during this handoff:

- [SQLx 0.9.0 manifest](https://docs.rs/crate/sqlx/latest/source/Cargo.toml.orig):
  Rust >=1.94; runtime-tokio exists; sqlite-bundled selects the engine without the
  larger sqlite feature's extra extension/deserialization functionality.
- [SQLite driver](https://docs.rs/sqlx/latest/sqlx/sqlite/): bundled native engine;
  libsqlite3-sys resolution needs actual lockfile and runtime version verification.
- [SqliteConnection](https://docs.rs/sqlx/latest/sqlx/sqlite/struct.SqliteConnection.html):
  background SQLite worker; explicit close can report errors; Drop is not the same
  as an awaited close result.
- [Connection](https://docs.rs/sqlx/latest/sqlx/trait.Connection.html): begin_with
  supports a static BEGIN IMMEDIATE statement and returns a tracked transaction.
- [ConnectOptions](https://docs.rs/sqlx/latest/sqlx/trait.ConnectOptions.html):
  disable_statement_logging is available; pass bound data, not interpolated SQL.
- [std File](https://doc.rust-lang.org/std/fs/struct.File.html): OS-backed try_lock;
  the lock is not a file's mere existence or a stale PID marker.
- [SQLite WAL](https://sqlite.org/wal.html) and [PRAGMAs](https://sqlite.org/pragma.html):
  FULL versus NORMAL, per-database writer, checkpoint/read interaction, WAL/SHM
  persistence, and lack of all-files ATTACH atomicity in WAL mode.
- [WAL-reset fix](https://sqlite.org/releaselog/3_51_3.html): basis for the engine
  floor, not an assertion that 3.51.3 is today's latest SQLite.

These web pages are mutable; the dependency is fixed to SQLx 0.9.0 and the implementor
records its actual resolved engine. No need for an OpenAI API key or provider request.

## 5. Cross-document checks and evidence limits

CONTRACT/SCHEMA/MATRIX/PROMPT share p1a.0, dd720c0, 32 rows, SQLite-only storage and
P1-A-only scope. SQL DDL syntax and representative event immutability/one-unfinished-run
constraints were smoke-checked using container Python SQLite 3.46.1. That engine is
BELOW the required implementation floor; this is only draft SQL syntax/constraint
evidence, not bundled-driver, Rust compilation, migration, concurrency, crash,
durability, security or P1-A acceptance evidence. Cargo is unavailable here.

Fresh implementor review must check the entire plan before semantic edits, especially:
- current Result/ToolResult error and delivery fields, not assumed enum spellings;
- source runtime sequence versus durable session sequence;
- no ContextManifest serde assumption;
- operation IDs and original creation title/provenance during catalog reconstruction;
- no lost-WAL immutable read shortcut;
- source failure versus known rollback versus COMMIT uncertainty;
- completed execution without final observer delivery;
- metadata refresh failure is not failure of an earlier successful commit;
- old store instance recovery never means a second handle/browser cancels a current run.

The 32 rows are new requirements, not previously passing checkpoint rows. Historical
R1 422/152 and earlier CI are baseline evidence only. Any conflict must identify the
exact producer, consumer and required behavior; never make production code agree
with a mistaken statement by changing unrelated public contracts.

## 6. Boundary to P1-B and V1

P1-B still needs its own fixed contract after P1-A acceptance. It must integrate
awaited accepted-input/partial-output/tool-intent/serialized-result commits, actual
run ID selection, explicit new tasks using valid stored provider history, account
boundaries and independent subscribers. Saving events alone is not that integration.

The newly uploaded Codex report describes execution beginning on completed tool items
before whole-response completion. Wi's accepted terminal-gated full-batch authority
is deliberately different and is NOT changed by this storage assignment.

V1 remains the one-owner, multi-device service. Browser loss never cancels work;
service restart never auto-resumes tasks. Storage WAL recovery, pending storage
transaction completion and catalog repair are not agent execution. No browser
transport, client authentication, queue, approval or GUI implementation follows
from this handoff automatically.
