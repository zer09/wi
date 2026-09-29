# Wi: G1.1 resume assignment

Updated September29,2026. Accepted master is76bb32fd04fd4737c0efcceaabc7d10387453147. PR #10 contains an unaccepted implementation checkpoint8f45dda2a2c168931735cf798560b8dfd02a1579. The owner approved replacing the rejected history design and resuming local implementation under **g1.1**. This is not G1 acceptance or merge authorization.

## Read first

Read docs/slices/g1/CONTRACT.md, SCHEMA.md, RUST_API.md, CLIENT_PROTOCOL.md, SECURITY.md, MATRIX.md, DISPOSITION.md, VALIDATION.md and IMPLEMENTOR_PROMPT.md. Then read the historical VERIFICATION.md/verification.json/DESIGN_REVIEW.md and current applicable source/platform documents. Old pause/continuation handoffs and g1.0 prompts remain historical; their blocked full-prefix/Window B requirements are superseded by g1.1.

## Fixed result

Latest human interaction B renders before asking for A. Initial viewport filling asks for one earlier content/segment/block at a time until filled/end; later reads require upward intent. The server maintains ordered display rows alongside immutable canonical events in the same SQLite transaction. Live and reopened chat use the same representation and chronological layout. No one-giant-row interaction, category regrouping, browser agent-event reconstruction or warm raw-history replay.

Implement additive session schema3 and existing-session backfill, typed display reads, self-contained display HTTP/SSE, server task reconciliation and a small browser display store. Separate backscroll/content cursors from live state. Matching snapshot H precedes live observation; reconnect explicitly obtains latest canonical state. Old raw endpoints and B2 provider context remain unchanged. Retain one existing bearer check and memory-only Connect; normal local loopback HTTP needs no HTTPS/proxy. Do not add/remove authentication modes.

## Execution discipline

Inspect actual HEAD/ancestry/staged/unstaged/untracked files. Preserve owner work; no reset/clean/force checkout/unsolicited stash. Reuse checkpoint work and fixtures where valid. Follow the specified phases, implement and test; do not return a second architecture plan. Report an actual source/contract conflict with exact evidence before policy changes.

G11-00..G11-39 are the NEW40 requirements, all initially NOT RUN. Old checkpoint dispositions are not new passes. Preserve exact old reports/handoffs and their failed tests. New evidence paths are docs/slices/g1/VERIFICATION_G1_1.md and verification-g1.1.json.

Delete/replace the browser full-prefix loop, history.complete gate, raw fingerprints/domain reducer and browser receipt-range proof. Retire the exclusive Window B/CDP/global-monkeypatch prototype after replacement coverage is present; do not silently filter a required failing test. Keep framing/identity/privacy/epoch coverage and real joined producer tests. Tests use the matrix's appropriate S/H/C/B/J/P level; not every rare SQL invariant needs browser fault machinery.

Preserve the prior independent Windows-removal audit and verify new work doesn't restore Windows support. Native Linux/macOS six Cargo gates remain; add required Ubuntu browser job. No credential-isolation canary/portable API/transitive lockfile deletion by keyword. Existing managed-auth live evidence remains Linux-specific.

Keep one RunHost/B2/controller/registry/provider loop, actual tool-result bytes/is_error, uncertain commits, cleanup warnings, quarantine and drain-before-storage-close. No RunLimits/replacement budgets, task deadlines/quotas, lifetime history caps, deletion, automatic model/tool resume or retries, extra providers/tools, hosted billing, Node backend, new dependencies, cookie/device login, deployment or unrelated restructuring.

Use only synthetic roots, skills, owner/provider credentials and loopback/scripted providers. No real credentials/private skills/auth commands/live generations. Ledger31/50 used19remaining is unchanged and not permission. Normal build/browser downloads are development traffic.

Run all required native/offline/browser gates and measurements; three fresh final complete-diff reviewers inspect original master->checkpoint->new work, including generated/untracked files and test dispositions. Distinguish source review, local execution, hosted CI and live evidence. Preserve initial failures. Do not invent review/counts/acceptance. Final documentation describes actual implemented behavior, not plan text as fact.

Local changes stay uncommitted until separate owner commit/push authorization. No merge/release/deployment/new milestone automatically follows. The planner's documentation commits on PR #10 do not authorize local Git writes.
