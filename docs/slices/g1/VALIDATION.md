# G1.1 planning validation and source map

Date: September29,2026. Classification: **source/design validation, not implementation acceptance**. PR #10 checkpoint inspected at `8f45dda2a2c168931735cf798560b8dfd02a1579`; accepted master is76bb32fd04fd4737c0efcceaabc7d10387453147. The revised planner commit changes documentation only. No G11 row is passed by this document.

## 1. Requested product basis

The uploaded G1_Design_Handoff_Human-Message-Anchored_Pagination.md defines a human message/run as the backward-navigation block, B-before-A rendering, viewport fill and separate oversized-block/content continuations. Later owner discussion explicitly adopts saved display records in addition to immutable events and requires identical live/history chronological chat. Its read-time reduction suggestion is consequently superseded, not misquoted as materialization.

The final access discussion permits a small existing authorization boundary if its cost stays small. This contract RETAINS the existing bearer mechanism without adding an authentication system. Earlier proposals to omit authorization or use a new browser session/cookie are not adopted. Loopback HTTP is the normal local path; HTTPS is not a local prerequisite.

The owner authorized updating PR #10's specifications and resuming local implementation. No runtime source edit, acceptance, merge, provider test or deployment was requested of this planning pass.

## 2. Actual producer/consumer map

All links in this section are interpreted against the checkpoint, not current moving master:
https://github.com/zer09/wi/tree/8f45dda2a2c168931735cf798560b8dfd02a1579

| Source | Actual reviewed behavior | g1.1 implication |
|---|---|---|
| docs/slices/g1/DESIGN_REVIEW.md | Rejects full-prefix product behavior and distinguishes failed Window B observation from a production defect. | Explicit supersession and replacement proof, not implementation blame. |
| web/src/client.ts::selectSession/startObservation | Loops history pages until complete before SSE. | Replace, do not merely reverse SQL ordering. |
| web/src/state.ts::applyEvent/reduceEvent | Requires consecutive raw event prefix, retains fingerprints and reconstructs runs/turns/responses/tools. | Remove browser domain reducer; keep only generic display/epoch state. |
| web/src/state.ts::responseSections/selectDisplay | Resolves provisional/authoritative content, fallback, tool state and chronological first_sequence ordering. | Move those rules into one server projector; same live/history encoder. |
| src/storage/session_v2.sql | events/runs/tool_results/commands/manifest, no persisted conversation body projection. | Explicit additive schema3 work is necessary for the adopted saved representation. |
| src/storage/run_store.rs::mutate/append | Receipt-first duplicate, actual event insertion and run/tool projection within BEGIN IMMEDIATE; final manifest/receipt commit. | Add affected display updates in this transaction. Never create a separate eventually consistent writer. |
| src/storage/session.rs::rename_transaction/open/connection | Owned session operations; lazy1->2 migration on explicit open; checks canonical/catalog identity. | Add2->3 to this path and metadata projection; preserve lifecycle/receipt/retirement. |
| src/storage/interruption.rs::reconcile | Inserts run.interrupted and updates run/manifest in one transaction for prior-instance unfinished work. | Display interruption must join that same transaction. No resumed execution. |
| src/storage/session_schema.rs::version/structure | Accepts1/2 and validates released canonical definitions/indexes. | Targeted3 support and projection checks; keep real old/future fixtures. |
| src/storage/migration.rs | Transactional1->2 table rebuild, setting restoration, owned cleanup and preservation checks. | Preserve existing step; additive2->3 needs its own tests and watermark. |
| src/http_api/router/runs.rs::raw_receipt/submit | Server already verifies actual method/input/selection and exact raw user text before returning receipt; checkpoint uses submit_exclusive. | Reuse for a read-only reconciliation endpoint. Remove duplicate browser storage-range proof, not server proof. |
| src/http_api/mod.rs | Existing token/boundary/assets modules and fixed server adapters. | Preserve one centralized bearer check and one fetch transport. No new auth module family. |
| src/http_api/config.rs | Actual listener validation rejects non-loopback; explicit config owns token path, roots/model/settings. | LocalHTTP is already supported. No certificate requirement or new no-auth/public-bind mode. |
| src/http_api/router/events.rs | Raw fixed-head pages then later canonical polling with250ms idle reads. | Keep compatibility; add distinct display route/cursor. Never change raw cursor semantics beneath old callers. |
| web/e2e/read-reconnect.spec.mjs and test-support/read-reconnect*.mjs | Attempts a selected native read/CDP byte-window gate with global instrumentation. | Retire exclusive prototype; prove application atomicity deterministically and browser recovery by latest rebase. |

Checked source blob identities for later comparison:
- run_store.rs:929a9fa444d8b70c4b1bb2009856241231c78558
- session.rs:c8c252bbe67168b6352632016627f2558400b89b
- session_schema.rs:b62b380151421bd432454fceb67d0398d40fe859
- session_v2.sql:d3e78a9facfb351b9dc52474cf58b02c68648328
- interruption.rs:4e74a86d47e759a59981a8ce6dbc025cdf540de7
- migration.rs:ef24184e891537e0d6bebe727ba266fd03913bec
- web/src/state.ts:d324caad342f67ea9a938755e2f306a563277b70
- router/runs.rs:a0934a1dffc633419c36e2d89b9b13fe9359d087
- http_api/config.rs:6bb7672491de760f3b0c6e1d078595fdea3923af

This is a targeted source review of the relevant boundaries, not a full audit of all203 checkpoint paths. The local final review must inspect the complete accumulated diff.

## 3. Explicit changes versus preserved behavior

New: shared saved display model, session3 projection tables/chunking/migration, indexed conversation APIs, changed-entity SSE cursor, read-only task reconciliation, human-block viewport rules, canonical latest rebase, thin display store, revised test levels.
Preserved: canonical event/receipt bytes and immutability; B2 replay selection/native account binding; provider request capacities; authority/whole-batch validation; ToolFailed->gateway_error; actual tool output/is_error; current host ownership/cancellation/shutdown; catalog1; raw HTTP routes/API1; Linux/macOS support; no RunLimits.

None of the new interfaces is claimed to exist in the checkpoint. RUST_API.md explicitly authorizes the required storage read surface. Exact Rust internal names beyond those interfaces can follow current organization. A small input preview or display page is not a provider prompt, and projection output must never be used as B2 input.

## 4. Planning checks actually performed

Inspected PR metadata/head, changed-file inventory, checkpoint decision packet, core storage transaction/migration/interruption paths, browser reducer/loading and current documentation. Existing user research was read as supplied, not treated as a new upstream benchmark.

A local Python sqlite3 **3.46.1** smoke check executed the proposed five-table DDL against minimal synthetic events/runs tables, verified the8192-byte chunk constraint, traversed100 same-sequence entries with a key tie-break in13-row pages without omission/duplicates, and confirmed EXPLAIN uses conversation_entries_order for the backward tuple lookup. This establishes draft SQL syntax/selected constraints and a small keyset illustration ONLY. It is not full Wi-schema compatibility, SQLx execution, a changed-entity moving-row proof, a benchmark, migration/crash acceptance or any G11 PASS.

Rust/Cargo were unavailable in this planner runtime. A direct container Git clone could not resolve github.com; repository reads/writes used the connected GitHub tool. No compilation, runtime suite, Node/browser acceptance, real credential read, provider request or new independent local-agent review is claimed.

Primary reference checks on September29:
- https://sqlite.org/lang_transaction.html : explicit transactions and rollback semantics.
- https://sqlite.org/isolation.html : matching data/head requires one actual read snapshot.
- https://sqlite.org/rowvalue.html : indexed keyset scrolling, not deep OFFSET.
- https://html.spec.whatwg.org/multipage/server-sent-events.html : standard framing and native EventSource interface/reconnect behavior.
These support mechanisms, not the correctness or performance of unimplemented Wi code.

## 5. Documentation drift observed

The checkpoint slice register/index correctly records a pause but also retains earlier planning-only/unimplemented statements. The architecture overview still says V1-B is unimplemented; its event introduction retains unqualified R1 exact-head NOT RUN despite later closure. The new current indexes/overviews separate accepted master, partial checkpoint, historical evidence and unimplemented g1.1. Detailed old overviews remain available at the immutable checkpoint URL. Historical verification and handoffs are not rewritten.

Root README's links continue through the current documentation index. Its accepted-runtime schema2 descriptions remain current UNTIL local implementation changes schema3; the final implementor must update runtime documentation/examples/help at G11-39, not claim schema3 exists in this planning commit. The immutable source/prompt archive is linked from DISPOSITION.md.

## 6. Review hazards to avoid

- No vague 'one block' assertion while fetching all blocks or one unbounded JSON blob.
- No32KiB preview created by first reading a whole giant body.
- No category-based sorting or final-answer duplicate on history reload.
- No raw full-prefix reducer moved from browser to every HTTP GET.
- No display watermark update outside the event transaction.
- No watermark advancement past unreturned entities sharing one sequence.
- No mutation/resume side effects hidden in observation reconnect.
- No browser proof requiring undocumented CDP scheduling or global monkeypatches.
- No token removal, cookies or access mode inferred from old alternatives.
- No forged accepted=true, review identity, source equivalence or platform evidence.

Genuine blockers require exact producer/consumer evidence and a scoped correction. The local implementor executes this specification; it is not asked to invent a second architecture plan.
