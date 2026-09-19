# Current Wi slice register

Updated **September 20, 2026**. Accepted runtime baseline:
**76bb32fd04fd4737c0efcceaabc7d10387453147** (V1-B and native Windows withdrawal,
PR #9). [Platform authority](../PLATFORM_SUPPORT.md): retained native Linux/macOS
build/CI; Windows backend withdrawn. Historical reports and matrices retain their
original platform observations and planning states.

| Slice | Current status | Evidence/assignment |
|---|---|---|
| S2 model-selected main SKILL.md loading | Accepted/merged PR #3 | [Evidence](s2/VERIFICATION.md) |
| R1/NB-02 inherited repairs | Accepted/merged PR #4 | [Evidence](r1/VERIFICATION.md) |
| P1-A SQLite application sessions | Accepted/merged PR #5 | [Evidence](p1a/VERIFICATION.md) |
| P1-B1 actual runtime capture | Accepted/merged PR #6 | [Evidence](p1b1/VERIFICATION.md) |
| P1-B2 stored replay and B2-E01 joined closure | Accepted/merged PR #7,50f4dff | [Evidence](p1b2/VERIFICATION.md) |
| V1-A in-process execution owner | Accepted/merged PR #8,16d623a | [Evidence](v1a/VERIFICATION.md) |
| V1-B authenticated HTTP/API and history SSE | Accepted for retained scope/merged PR #9,76bb32f | [Original evidence](v1b/VERIFICATION.md), [JSON](v1b/verification.json), [platform follow-up](v1b/PLATFORM_FOLLOWUP.md), [API](v1b/API.md), [security](v1b/SECURITY.md) |
| G1 minimal browser conversation client | **Current documentation-only handoff, g1.0;32rows NOT RUN** | [Contract](g1/CONTRACT.md), [client protocol](g1/CLIENT_PROTOCOL.md), [matrix](g1/MATRIX.md), [validation](g1/VALIDATION.md), [fresh-agent prompt](g1/IMPLEMENTOR_PROMPT.md) |

Earlier gateway/auth/M3/C1/S1 history remains in the [documentation archive](../README.md).
Do not reimplement completed slices because an old matrix contains NOT RUN or an old
report predates storage/service work. Old source pins are evidence, not current HEAD.

## V1-B closure and platform evidence

Original V1-B source6e28cc3/reportheadf0adbdd retained38PASS/2PARTIAL/accepted=false.
The owner subsequently withdrew native Windows support and its V1B-03/V1B-33 proof
subcases; they are not retroactively passed. CI job removal, code/test cleanup and
current docs alignment were separate commits. Original frozen requirements/reports
remain untouched, with only platform applicability superseded by the dated policy.

Source-cleanup4edb2d7 passed push35458188836/PR35458191471 attempt1 on Linux/macOS.
Final reviewed head6805640 passed push35458920521/PR35458921748 attempt1 on both
retained OS, all six Cargo gates. Merge76bb32f has identical file tree. Earlier
Windows watchdogs and planner inventory failures remain recorded, not claimed fixed
by later green checks or by platform withdrawal. [PR #9 merge closure](https://github.com/zer09/wi/pull/9#issuecomment-5744102056).

The next fresh local agent must **independently audit Windows removal and current
docs alignment before GUI edits** (G1-00/G1-01). Scanner success alone is not full
semantic proof. Preserve Unix checks, portable APIs, historical evidence and
third-party target metadata. No new macOS managed-auth or live guarantee is implied.

## G1 boundary

G1 is a framework-free TypeScript page served as fixed embedded assets by the same
Rust HTTP service. No Node backend, runtime UI package, new Rust dependency or new
agent loop. It uses existing owner bearer/API/SSE with memory-only client credentials,
real durable receipts, explicit cancel/reconnect and safe text conversation rendering.
It remains unimplemented at this planning commit; local/browser/CI rows are NOT RUN.

Richer Markdown/editor/terminal, general coding tools, skill resources/scripts,
steering/queues, parallel tools, compaction/branching/search/import, additional providers,
per-device authentication and deployment remain separately scoped. No task auto-resumes
on reconnect or restart. No RunLimits, replacement budget or history-lifetime ceiling.
Ledger31/50used19remaining is unchanged and does not authorize live calls.
