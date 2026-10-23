# Milestones and remaining scope

This register describes delivered capabilities. It does not authorize a new implementation task or live test.

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
| G1.1 | Human-anchored latest-first browser, saved display records, schema 3, display SSE and reconciliation | PR #10; 39 PASS plus one measurement waiver |

Exact G1.1 evidence, source boundaries, and the PR merge record are linked from [acceptance](ACCEPTANCE.md). Package version 0.2.0 is not a claim of a released/deployed product. Earlier research checkpoints that call P1/V1/GUI unimplemented are historical.

## What the product can do now

A local owner can open the embedded browser, create/select persistent conversations, submit explicit tasks, observe committed output, load older content on demand, reconnect, and request cancellation. The service survives loss of an observer; history survives process restart without automatically resuming tasks.

The current toolset is main-skill instruction loading plus optional diagnostic arithmetic. The full general-purpose coding workflow is not implemented yet.

## Candidate next task, not an approved contract

A narrowly scoped, workspace-bound read-only file tool is the proposed next useful capability. It would let the agent inspect project source through the existing registry, persistence, and browser display without first introducing shell execution or file mutation.

Before implementation, its contract must define path authority, symlink/special-file policy, UTF-8/binary handling, line/content pagination, exact error/results, cancellation, and how it stays within the existing serialized result capacity. No tool name, schema, new quota, or approval framework is authorized by this paragraph.

## Deferred work

General read/edit/write/shell tools, supporting skill resources/scripts, steering/follow-up queues, parallel/asynchronous tools, compaction, branching/forking, additional providers, dynamic plugins/subagents, approvals, backup/export/import/search, recent-activity catalog ordering, and richer UI remain separately scoped.

Hosted skills/API-key billing fallback and the universal run-timeout/budget framework are withdrawn, not waiting for automatic implementation. Ordinary `wi run` persistence is also separate from the already persistent service.

The historical live ledger remains 31/50 used, 19 remaining. Remaining balance is not permission to run live generations or credential operations.
