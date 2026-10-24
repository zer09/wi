# Current project state

**Reviewed:** 2026-10-25, Asia/Manila. **Runtime baseline:** `a2974d19a327d4a29de5e3b2352628d021f9b453`.
This is a dated restart point, not a live CI dashboard. Resolve the actual branch and check later observations before acting. The Git revision containing this file identifies the documentation revision; it does not change the runtime baseline above.

## Delivered and accepted

PR #10 was squash-merged. G1.1 acceptance is **39 PASS, 1 PASS_WITH_WAIVER, 0 PARTIAL** within the recorded offline/loopback scope. Exact native-release-to-DOM timing was waived, not measured. See [acceptance](ACCEPTANCE.md) and [milestones](MILESTONES.md).

Wi has a shared Rust model/tool runtime, OpenAI-Codex subscription integration, managed authentication, global/project skills, persistent application sessions, compatible provider replay for a new explicit task, a service-owned execution host, an HTTP API, and an embedded TypeScript browser. Browser loss does not cancel accepted work. Restart preserves history without automatically resuming tasks.

The browser opens the newest human interaction first. It uses saved display records, not a replay of the raw event prefix. Live and reopened chat retain the same identities, chronology, content, grouping, and recorded status. See [conversation](CONVERSATION.md) and [storage](STORAGE.md).

The owner reported local operation working so far. No exact revision, case inventory, commands, or environment accompanied that observation. It is not a substitute for a complete test result or a newly counted live acceptance run.

## Current regression health: PM-CI-01 OPEN

Historical acceptance and current regression health are different facts.

| Observation | Result |
|---|---|
| Final pre-merge head `c10c922be6b596b88ed4b832a4736cea2211f093` | Push 40018124643 and PR 40018135987 passed, attempt 1 |
| Squash tree | `69c2440e975e7492c39647b9c3fa22f14dd7ed2a`, identical to that pre-merge tree |
| Post-merge workflow [40021350573](https://github.com/zer09/wi/actions/runs/40021350573) | Attempt 1 failed at the runtime baseline |
| Ubuntu native / Ubuntu browser | Passed / passed |
| [macOS job 120646410322](https://github.com/zer09/wi/actions/runs/40021350573/job/120646410322) | Cargo test failed; subsequent Clippy/build/doctest steps skipped |

The failed test is `http_api::router::tests::conversation_tests::security::b1_strict_queries_methods_bodies_media_ids_and_encoded_entry_segments_before_open`.
The recorded failure is `reqwest` request `BodyWrite` / `BrokenPipe` at `src/http_api/router/tests/mod.rs:247:41`, before response status/header assertions. The library summary is 931 passed, 1 failed, 11 ignored; it is not an all-target total. The job ran on October 23 UTC, October 24 in Manila. The result was rechecked during the October 25 maintenance review.

Source inspection found that the case sends an oversized body to a conversation entry GET, and [input validation](../src/http_api/input.rs) can reject its Content-Length before consuming the body. The [test](../src/http_api/router/tests/conversation_tests/security.rs) uses the shared [request helper](../src/http_api/router/tests/mod.rs). An early-response/body-upload interaction is a **candidate explanation only**. The original log does not identify every subcase detail. No reproduction or cause-specific repair is established by these comments or by a later passing run.

### Focused follow-up

| Check | Required completion evidence |
|---|---|
| Preserve the failure | Keep the exact job, SHA, failed stage, and skipped steps; do not replace them with a rerun result. |
| Identify the subcase | Label method, fixture path class, expected status, and synthetic body mode without exporting tokens or private data. |
| Separate hypotheses | Check upload versus early rejection and connection reuse with a finite controlled fixture. Do not infer the cause from a broad rerun. |
| Repair only what is proven | Preserve status, header, body, and before-storage assertions. No retry-as-success, catch-as-pass, disabled platform, broad timeout increase, or production policy change to satisfy the test. |
| Close the observation | Record focused evidence, affected regressions, and exact-head native CI including macOS. If not reproduced or unexplained, retain that qualification. |

The current maintenance change records this finding and corrects documentation; it does not claim a runtime fix. The owner approved maintenance and source refresh. A new coding-tool feature and merging this maintenance PR require separate decisions.

## Scope that is not delivered

General read/edit/write/shell tools, supporting skill resources/scripts, steering/follow-up queues, compaction, branching, parallel/asynchronous tools, additional providers, and backup/export/import/search remain separately scoped. A workspace-bound read-only file tool is a candidate, not an approved contract.

The product direction remains one owner with multiple clients/devices. Present startup binds loopback. Remote browser access depends on a separately operated proxy; a complete packaged remote deployment is not certified. Local HTTP needs no certificate. The memory-only owner Connect token remains; provider OAuth is separate. Native Linux/macOS checks do not imply macOS managed-auth support, which remains Linux-specific. Windows support is withdrawn.

No RunLimits, whole-task deadline, automatic model retry/failover, automatic task resumption, hosted skills, or API-key billing fallback is waiting for incidental implementation.

## Durable context and source roles

[Decisions](DECISIONS.md) preserves adopted direction and superseded proposals. [Milestones](MILESTONES.md) maps delivered scope and next candidates. [Development](DEVELOPMENT.md#documentation-maintenance) defines updates and exports. Requirements describe intent; code describes behavior; observations establish only their tested scope. Report disagreements instead of silently rewriting any of these.

The evidence archive is [1f18c33](https://github.com/zer09/wi/tree/1f18c33b1084898e60aaa4a87a189614390af49f), retained by `archive/g1.1-evidence-2026-10-24`. Do not advance or delete that reference. Upload-only research reports need a separate original-byte backup; the repository archive alone is not proof of that backup.

The two retained saved chats, Rust Agent Runtime Design and Pi coding harness architecture, are historical context. They are not current assignments. The old September checkpoint and paused G1 proposal are superseded for current-state planning, not retroactively edited.

The historical Wi assistant-generation ledger is **31/50 used, 19 remaining**. Manual owner observations do not establish a new counted total. No remaining balance authorizes real credential access, login/refresh, provider generations, release, or deployment.
