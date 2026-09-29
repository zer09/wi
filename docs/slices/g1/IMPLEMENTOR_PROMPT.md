# Local implementor assignment: G1.1

Implement contract **g1.1** on PR #10, branch `docs/g1-browser-conversation-client`.
Accepted master: `76bb32fd04fd4737c0efcceaabc7d10387453147`.
Preserved unaccepted checkpoint: `8f45dda2a2c168931735cf798560b8dfd02a1579`.
The latest documentation commit is the resume-plan revision; inspect actual HEAD and record it. Do not confuse it with the tested runtime source.

## Read before edits

Read root AGENTS.md, then these files in docs/slices/g1:
1. CONTRACT.md
2. SCHEMA.md and RUST_API.md
3. CLIENT_PROTOCOL.md and SECURITY.md
4. MATRIX.md
5. DISPOSITION.md
6. VALIDATION.md
7. historical VERIFICATION.md, verification.json and DESIGN_REVIEW.md

Read applicable existing V1-B API/security, storage/source code and platform policy. Old paused handoffs and g1.0 instructions are historical. This new owner-approved contract resolves the pause. Do not run the old full-prefix or Window B assignment.

## Preserve the actual checkpoint

Inspect HEAD/ancestry and all staged, unstaged and untracked work. Preserve owner changes; no reset, clean, forced checkout or unsolicited stash. Verify the existing platform audit/USERPROFILE cleanup and retained Unix behavior. Use the current Node24 and locked TS5.9.3/Playwright1.58.2 tooling; no new dependencies. G1 already has a substantial partial implementation. Reuse valid assets, transport, security, commands, fixtures and rendering; do not restart from an empty project.

The design and40-row matrix are fixed. Implement and verify them rather than returning another architecture plan. If a specific statement conflicts with actual code, report exact producer/consumer evidence before changing scope.

## Implement in four phases

A. Add shared server display interpretation, session3 saved projection tables, text chunks, one-time existing-session upgrade and indexed reads. Integrate display updates in the SAME transactions as canonical events/receipts. No background projector or warm history reconstruction. No single growing JSON row per human interaction.

B. Add the specified display page/content/SSE routes and server read-only task reconciliation. Snapshot and head are one consistent read. Changed-entity cursors include the same-sequence tie-break. Keep existing raw routes and mutation semantics compatible. Retain one centralized bearer check; local HTTP needs no HTTPS/proxy. Do not add/remove authentication modes.

C. Replace browser raw-event/domain reconstruction with a thin display store. Show newest human interaction B before requesting A. Fill only unused initial viewport space one older request at a time; later loading requires upward intent. Keep separate previous-block, within-block, content and live positions. Maintain normal chronological layout and stable anchors. Live and reopened chat must have identical IDs/order/grouping/content/status at the same committed H. Use server decisions for finalization/tool outcomes. Explicit reconnect gets a new latest snapshot; never resubmit work.

D. Complete G11-00 through G11-39 with the indicated proof level, all regression/build/browser gates and three final independent complete-diff reviews. Review the complete master->checkpoint->current diff, including generated/untracked files and test removal inventory.

## Required removal and retention

Delete/replace the browser full-prefix history loop, history.complete gate, raw event fingerprints, provider/tool state machine and storage receipt-range proof. Move authoritative/provisional interpretation to the shared projector. Preserve generic SSE parsing, safe wire checks, epochs, text DOM and pending exact command identity.

Retire the Window B native-network/CDP prototype and exclusively dependent helpers from active suites. Preserve the checkpoint's failed experiments in Git/reports. Do not claim Window B PASS. Test frame/application atomicity at deterministic function boundaries and real browser recovery by latest-state rebase. No global browser monkeypatch framework or final grep-invert workaround.

Preserve canonical events/receipts, B2 provider replay/account semantics, actual tool result bytes/is_error, current error categories, execution ownership/cancellation/drain, Linux/macOS support and C1's full RunLimits deletion. Session3 is explicitly authorized; catalog1/stored1/runtime2/provider1 and existing API1 semantics stay. A display projection is never used as provider context.

## Evidence and stopping rule

Create, from observed work only:
- docs/slices/g1/VERIFICATION_G1_1.md
- docs/slices/g1/verification-g1.1.json

Do not overwrite the g1.0 reports, design packet or handoffs. Record40 unique rows, actual tests/commands/observers, source/worktree revisions, migration/preservation checks, old-test disposition, failures/fixes, measurements and limits. Count unique tests honestly. Query-plan/planner checks are not Rust/browser acceptance.

Run the matrix's six Cargo gates, platform_support, verify.py, Node CLI self-tests, eight retained examples, new conversation_view_offline, retained HTTP release/loaded samples, npmci/typecheck/nonmutating asset check/unit tests and actual Chromium suite. Add the Ubuntu browser CI job without weakening native Linux/macOS jobs. Exact submitted-head CI follows an owner-authorized push; no [skip ci] closure or silent exclusion of required tests.

Use real SQLite and actual producer-to-consumer paths. Joined rows use actual browser actions -> actual HTTP -> RunHost/B2 -> SQLite -> actual OpenAI loopback -> real tools -> display SSE/HTTP -> DOM. Mocked browser APIs plus old provider tests are not sufficient. Rare SQL/parser faults use their specified lower-level proofs, not invasive browser-internal timing experiments.

Synthetic temp roots, skills, owner/provider credentials and loopback/scripted providers only. No real credentials/private skills, login/status/profile/refresh commands or live provider requests. Ledger stays31/50used19remaining. Normal build downloads are allowed; they are not model tests.

No RunLimits/budgets/task deadlines/history caps/deletion, task/model/tool retries, automatic resume, new providers/tools, hosted skills/billing, compaction, framework/engine, Node server, native Windows restoration, cookie/device login, deployment or unrelated cleanup.

Leave implementation uncommitted for owner review unless the owner separately authorizes commit/push. Do not merge, release, deploy or start another milestone. Final acceptance requires all40 rows, current documentation reflecting implemented behavior, retained evidence and actual review/CI, not merely source completion.
