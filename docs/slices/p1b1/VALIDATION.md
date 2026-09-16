# P1-B1 source validation and decision ledger

Contract p1b1.0 · 2026-09-15. **Source review, not execution evidence.**
Baseline: `34b4cfd0d3ecf286869a239997267dbd75c28c0b`.
Its tree matches reviewed P1-A head `95353efe9856062a18fc806692be24eeaeeff103`.
P1-A accepted source is `0839af9627d6658972beacb3ac5ee983d58a605a`; subsequent
head changes and the planner's one-line platform clarification are documentation only.

## 1. What is already present

Links are pinned to the accepted merge. Read actual sources before coding; historical
checkpoint files from September 13 predate P1-A and must not override this state.

| Existing source | Actual contract relied on | B1 use/change |
|---|---|---|
| [run/mod.rs](https://github.com/zer09/wi/blob/34b4cfd0d3ecf286869a239997267dbd75c28c0b/src/run/mod.rs) | run performs pure preflight, allocates UUID, owns provider close guard, drives one sequential loop, calls sync FnMut observers | Extract shared admission and internal supplied-ID/awaitable observation. Do not duplicate the loop or rewrite cloned event IDs. |
| [run/events.rs](https://github.com/zer09/wi/blob/34b4cfd0d3ecf286869a239997267dbd75c28c0b/src/run/events.rs) | schema2, source run sequence, provider session_id; no input in RunStarted | Keep serialized contract; P1-A acceptance captures input separately. |
| [tools.rs](https://github.com/zer09/wi/blob/34b4cfd0d3ecf286869a239997267dbd75c28c0b/src/tools.rs) | preflight complete batch; execute/serialize; replace oversized output; cache; finish event; return InputItem | Insert private awaited result observation after cache and before finish; share legacy adapters. No result reconstructed from a finish event. |
| [error.rs](https://github.com/zer09/wi/blob/34b4cfd0d3ecf286869a239997267dbd75c28c0b/src/error.rs) | ToolFailed falls through to gateway_error; Protocol is protocol_error; AuthExpired is auth_expired | Preserve all categories. New wrapper retains existing concrete causes and static stages. |
| [context/preparation.rs](https://github.com/zer09/wi/blob/34b4cfd0d3ecf286869a239997267dbd75c28c0b/src/context/preparation.rs) | PreparedRun/manifest fields private; getters and exact prepared request; helper pairs captured catalog/registry | Use RecordedRunInput::capture/getters; no body reread or context API change. |
| [storage/records.rs](https://github.com/zer09/wi/blob/34b4cfd0d3ecf286869a239997267dbd75c28c0b/src/storage/records.rs) | RecordedRunInput plus Runtime/ToolResult/Result variants, structurally validated and sensitive | Existing schema carries B1 data. Caller-supplied proof becomes real execution through the composition, not an authenticated event signature. |
| [storage/session.rs](https://github.com/zer09/wi/blob/34b4cfd0d3ecf286869a239997267dbd75c28c0b/src/storage/session.rs) | accept_run/append_run_records return CommitResult; lookup_receipt/run_record/history_page; explicit refresh | Reuse APIs without arbitrary SQL. Add only a crate-private lifecycle-hold accessor for the composition. |
| [storage/run_store.rs](https://github.com/zer09/wi/blob/34b4cfd0d3ecf286869a239997267dbd75c28c0b/src/storage/run_store.rs) | receipt-first transitions; correlation; actual result strings; run-scoped cache identity; Result supplement rules | Valid core traces and before-finish result recording should satisfy existing rules; verify rather than relax them. |
| [storage/lifecycle.rs](https://github.com/zer09/wi/blob/34b4cfd0d3ecf286869a239997267dbd75c28c0b/src/storage/lifecycle.rs) | counts admitted SQL operations, closes admission, drains, explicitly unlocks healthy lease, quarantines uncertain retirement | Add execution hold using existing accounting plus closing signal. No current execution hold or closing CancellationToken is claimed to exist. |
| [storage/database.rs](https://github.com/zer09/wi/blob/34b4cfd0d3ecf286869a239997267dbd75c28c0b/src/storage/database.rs) | committed receipt survives cleanup warning; uncertain SQL worker retirement quarantines ownership | Handle warning versus error explicitly; no new retry or driver policy. |
| [storage/interruption.rs](https://github.com/zer09/wi/blob/34b4cfd0d3ecf286869a239997267dbd75c28c0b/src/storage/interruption.rs) | selected old-instance unfinished run becomes interrupted once, no effect replay | Preserve. B1 does not run an old accepted operation on reopen or duplicate request. |
| [providers/openai_codex/session.rs](https://github.com/zer09/wi/blob/34b4cfd0d3ecf286869a239997267dbd75c28c0b/src/providers/openai_codex/session.rs) | current bounded event queue, consumer timeout and terminal final slot; session can close under pressure | Record/report actual pressure behavior; no transparent continuation/retry or capacity policy change. |
| [provider.rs](https://github.com/zer09/wi/blob/34b4cfd0d3ecf286869a239997267dbd75c28c0b/src/provider.rs) | InputItem only User/ToolResult; session opening has no prior-conversation seed; native JSON is sensitive | B2 must design actual restoration. B1 cannot claim arbitrary replay by flattening text. |

## 2. Important integration distinctions

### Durable acceptance is not execution ownership

P1-A commits a supplied RunId and input. It does not launch work and its receipt is
not a capability to run an old task again. B1 permits work only for the caller receiving
the NEW acceptance. Duplicate/content-conflict paths are handled by existing storage
semantics. A concurrent lost race, repeated call or restart does not produce another run.

### Queue admission is not a commit

Existing RunEvent callbacks cannot await SQL. A background channel would require new
ownership/backpressure/acknowledgment semantics. B1 instead introduces a private awaited
observer path and commits before it proceeds across required effect boundaries. The
legacy adapter returns an immediate result from its existing synchronous callback.

The private future representation must preserve two different properties: old callbacks
need not be Send, while the concrete persistent future must be Send. One feasible
implementation is a private trait returning boxed Send futures, with the synchronous
adapter evaluating its callback synchronously and returning a ready future that does
not retain a borrow of a non-Send closure. The loop itself remains generic, so its
Send property depends on the actual adapter. This is a design sketch, not compiled
code; the matrix requires both actual compile/use cases. Equivalent private borrowing
or associated-future arrangements are permitted without changing observable semantics.

### Result completion and cancellation have distinct boundaries

The current cache insertion is before finish observation. B1 must not move it after
publication or undo it when persistence fails. A pending tool with no result must not
fabricate output. A completed tool with its result commit in flight must not lose that
result merely because cancellation became ready. Await admitted storage, then apply
the existing next-work checkpoints. No whole-batch result subset goes to the model.

### Ownership lasts beyond individual SQL calls

An active model/tool future can exist while P1-A's admitted SQL count is zero. Holding
only SessionHandle/Arc is insufficient to prevent an explicit close from unlocking the
root. The new execution hold must be in the drain accounting, not merely an Arc clone.
Holding a session/maintenance lock across the entire run would deadlock nested storage
operations and is expressly prohibited. The closing notification allows local run
cancellation and release of the hold without a new scheduler or deadline.

### Reading history is not continuing the conversation

The new function executes the supplied prepared input only. Previous records remain
stored/readable but are not automatically included in provider input. B2 must handle
native role/call/result replay and selected account/chain compatibility. It will not
reuse stale WebSocket state or flatten the browser transcript into one user string.
A historical snapshot is not authority to access/refresh another account.

## 3. New-decision ledger

| Decision in p1b1.0 | Why it is needed | Not claimed |
|---|---|---|
| B1/B2 split | Keep actual persistence capture separate from new provider-history/auth-chain interfaces | Dropping the previously planned restored-conversation feature |
| New execution module/function | Compose accepted storage and real loop without changing legacy callers | V1 server or a detached background-task manager |
| Caller-provided accepted RunId | P1-A must commit the real execution identity before effects | Rewriting event identities after execution |
| Private awaited event/result seam | Current callbacks cannot enforce async commit-before-effect | New public middleware or plugin framework |
| Direct awaited records | Minimal ordering/acknowledgment implementation; no unowned write queue | Maximum throughput or negligible per-event overhead |
| Separate actual result hook | Finish events omit output and error-shaped Ok must remain distinguishable | Guessing output/is_error from rendered text |
| Lifecycle execution hold/close signal | Prevent root lease release during live execution and avoid close deadlock | Guaranteed external rollback or forced kernel interruption |
| No callback from persistent API to a browser | Critical storage acknowledgment must not depend on a client | Complete notification/replay transport; V1 will provide it |
| No retry after recording failure | Preserve uncertainty and prevent hidden reexecution | Claim that a missing acknowledgment proves rollback |

These are planner choices for this scoped integration. They are not attributed to Pi,
Codex or Oh My Pi as identical implementations. No additional count/time budget, pool,
cache, engine, approval table or runtime policy is introduced.

## 4. Matrix coverage cross-check

P1B1-00..03: actual baseline/admission and legacy API/Send compatibility.
P1B1-04..06: durable receipt identity, races and exact runtime UUID/order.
P1B1-07..12: real loop/partial/native/tool/result/reuse producer-to-consumer paths.
P1B1-13..17: cancellation, outcome/delivery and storage error/cleanup distinctions.
P1B1-18..20: close/hold/drop/process restart with zero automatic effects.
P1B1-21..25: pressure, both loopbacks, S2 and independent readers/sessions.
P1B1-26..29: privacy, regressions/nonintegration, example/performance and full review.

No row requires a nonexistent production method to already exist. The only new
runtime interfaces are explicitly authorized. No row requires changing the preserved
error-code map or uses model JSON as proof of local execution.

## 5. Validation limits and implementation procedure

Planner review is static source/evidence work. No local Rust/SQLx compilation, P1-B1
runtime test, latency benchmark or independent reviewer execution was performed when
creating these documents. P1-A CI is evidence for the baseline, not B1. All new rows
remain NOT RUN. Raise a genuine source-linked contradiction before changing policy.

Recommended local sequence is fixed:
1. Observe baseline gates; inspect protected APIs/source and public DTOs.
2. Share private admission/observation while keeping all legacy tests passing; prove
   non-Send legacy closure and Send persisted instantiation before broader integration.
3. Add the result boundary and minimal lifecycle hold/closing notification with focused
   ordering/drop tests; no storage schema change.
4. Implement the composition's receipt-first/preflight/acceptance flow and actual recorder.
5. Prove real SQLite/controller/registry, fault/cancellation and process paths.
6. Prove S2 and both loopback transports, preserve pressure behavior, measure finite cost.
7. Update current docs and reports; complete fresh independent accumulated-diff review,
   fix in-scope findings and rerun all gates. Leave implementation uncommitted.

If an unexpected baseline defect is found, preserve it as evidence and establish
whether it blocks this contract. Do not start a separate repair or relax unrelated
checks. Unrun or unsupported evidence stays unrun, not PASS by exception handling.
