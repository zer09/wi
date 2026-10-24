# Milestones and remaining scope

This register describes delivered capabilities. It does not authorize a new feature or live test. For the dated baseline, active maintenance, and current regression health, read [PROJECT_STATE.md](PROJECT_STATE.md). Historical acceptance is not a perpetual green-CI claim.

## Completed foundation

| Milestone | Delivered scope | Closure reference |
|---|---|---|
| Gateway and managed auth | OpenAI-Codex WS/SSE, validation/recovery, named managed profiles and experimental renewal | Historical reports in the evidence archive |
| M3 | Shared sequential model/tool controller | Retained controller; original limits superseded by C1 |
| C1 | Complete RunLimits removal | PR #1 |
| S1 | Workspace instructions, global/project skill metadata and explicit activation | PR #2 |
| S2 | Model-selected main-SKILL loading | PR #3 |
| R1 / NB-02 | Presentation, preflight, expiry guidance and response-identity repairs | PR #4 |
| P1-A | Per-session SQLite, catalog, receipts, queries, ownership and recovery | PR #5 |
| P1-B1 | Actual awaited runtime/tool-result persistence | PR #6 |
| P1-B2 | Compatible provider-native history for a new explicit task | PR #7 |
| V1-A | Service-owned task lifetime, passive clients and orderly shutdown | PR #8 |
| V1-B | Authenticated loopback HTTP commands and committed observation | PR #9; native Windows subsequently withdrawn in that PR |
| G1.1 | Human-anchored latest-first browser, saved display records, schema 3, display SSE and reconciliation | PR #10, squash a2974d1; 39 PASS plus one measurement waiver |

Exact G1.1 evidence and later observations are linked from [acceptance](ACCEPTANCE.md). Package version 0.2.0 is not a released/deployed-product claim. September checkpoints that call P1/V1/GUI unimplemented describe an earlier baseline.

## Requirement-to-implementation trace

| Owner direction | Implemented boundary and evidence entry point | Remaining qualification |
|---|---|---|
| Shared Rust harness; browser is a client | src/service/, src/execution/, src/run/; V1-A/V1-B acceptance | Ordinary CLI persistence is separate. |
| Durable sessions, rename, embedded storage | src/storage/; P1-A/P1-B1 acceptance; [storage](STORAGE.md) | Device failure/power-loss certification and backup utility are not delivered. |
| New explicit task uses prior context without restarting old work | src/execution/replay/ and provider replay; P1-B2 joined evidence | Requires compatible identity and supported closed exchanges. |
| Browser closure is not cancellation; no automatic restart | src/service/, src/http_api/serve.rs; lifecycle/process tests | Cooperative cancellation cannot undo completed effects. |
| Normal chat opens latest human interaction, live/history agree | src/storage/conversation/, src/http_api/router/conversation.rs, web/src/; G11-13/29/34 and assertion index | Large blocks/content page explicitly. Exact release-to-DOM timing is waived. |
| One owner, multiple devices | Multiple observers and separately authenticated commands | Listener stays loopback; packaged remote deployment remains unverified. |
| Small scope without artificial whole-task budgets | C1 deletion and workload regressions | Existing request/history/result/display capacities still apply. |

See [decisions](DECISIONS.md) for rationale and withdrawn proposals. The [archived requirements and assertions](https://github.com/zer09/wi/tree/1f18c33b1084898e60aaa4a87a189614390af49f/docs/slices/g1) are historical evidence, not a new assignment.

## Current maintenance before another feature

On 2026-10-25, the owner approved documentation/source refresh and repository corrections through a new PR. PM-CI-01 remains open: the post-merge macOS request failed with BrokenPipe before response assertions. Ubuntu native and browser jobs passed. Record the diagnosis and later checks in [PROJECT_STATE.md](PROJECT_STATE.md); do not reopen all 40 accepted G11 rows or call an unexplained failure fixed.

## What the product can do now

A local owner can open the embedded browser, create/select persistent conversations, submit explicit tasks, observe committed output, load older content on demand, reconnect, and request cancellation. The service survives loss of an observer; history survives process restart without automatically resuming tasks.

The current toolset is main-skill instruction loading plus optional diagnostic arithmetic. The full general-purpose coding workflow is not implemented yet.

## Candidate next task, not an approved contract

A narrowly scoped, workspace-bound read-only file tool is the proposed next capability. It would let the agent inspect project source through the existing registry, persistence, and browser display without shell execution or file mutation.

Before implementation, its contract must define path authority, symlink/special-file policy, UTF-8/binary handling, line/content pagination, exact error/results, cancellation, and the existing serialized result capacity. No tool name, schema, new quota, or approval framework is authorized by this paragraph.

## Deferred work

General read/edit/write/shell tools, supporting skill resources/scripts, steering/follow-up queues, parallel/asynchronous tools, compaction, branching/forking, additional providers, dynamic plugins/subagents, approvals, backup/export/import/search, recent-activity catalog ordering, and richer UI remain separately scoped.

Hosted skills/API-key billing fallback and the universal run-timeout/budget framework are withdrawn. Ordinary wi run persistence is separate from the persistent service. These are not automatic next tasks.

The historical live ledger remains 31/50 used, 19 remaining. Remaining balance is not permission to run live generations or credential operations.
