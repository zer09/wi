# Milestone 7 release-gate remediation 19

Status: **IMPLEMENTED — fresh independent WI-M7-M1 verification pending**

Starting head: `9d6c0f42ed8d20394fbd04e81bdad0f1269eebbb` on `milestone-7-crash-recovery`.

Stable ID: `WI-M7-M1` — bounded IPC payload memory.

## Before-fix evidence

A retained real-child regression sent one multi-megabyte string, 64 individually valid aggregate-noise messages, a depth-80 object, a 5,000-element object graph, and a final small awaited control. At the starting head, all 68 complete objects fit under the 128/256 message-count caps and remained reachable from pending/history. The regression failed because no retained estimated-byte diagnostics existed; direct inspection also showed the oversized terminal marker in retained history.

Message-count caps alone therefore did not establish a process-harness memory boundary.

## Correction

- Every inbound object-IPC value is iteratively inspected with explicit limits: 64 KiB conservative retained-size estimate, depth 32, 4,096 nodes, 16,384 code units per string, 128 code units for the message type, and a 512-code-unit diagnostic preview.
- Pending retention is bounded independently by 128 messages and 256 KiB estimated aggregate. Historical retention is bounded by 256 messages and 512 KiB estimated aggregate.
- Valid retained messages carry their estimate so count or aggregate eviction updates exact retained totals. Pending eviction prefers unawaited noise, preserving a later small control already awaited by the harness.
- An oversized, malformed, deep, or node-heavy value is never retained in full. Pending drops it; history receives only a bounded synthetic summary containing safely available type, reason, observed estimate/node/depth counts, preview, streaming SHA-256, and whether the hash covered the complete value.
- Diagnostics retain exact monotonic total/rejected/oversized/drop counts and the latest bounded truncation summary. Timeout strings include bounded stdout/stderr and IPC summaries without the original oversized payload.
- Parent-to-child controls receive the same per-value preflight before `child.send()`.
- Existing stdout/stderr rings, streaming readiness matching, process-tree ownership, timeout policy, and descendant reclamation are unchanged.

## Exact guarantee

Node object IPC deserializes a child message before the JavaScript `message` callback. This correction bounds every reference retained by `RealServerProcess` and immediately rejects/releases an over-limit callback value, but it does not bound Node's pre-callback deserialization peak. Milestone 7 fixture children are trusted test code with a strict control protocol. If that boundary later admits untrusted children, object IPC must be replaced by a bounded framed pipe.

## Retained regression coverage

The real-child fixture proves:

- one oversized string is summarized without retaining its terminal marker;
- valid messages crossing both aggregate budgets are evicted within declared limits;
- depth and node excess produce distinct bounded summaries;
- a complete streamed hash is retained where feasible;
- a small awaited control arrives after discarded noise;
- timeout text remains bounded;
- prior stdout/stderr/readiness behavior remains unchanged;
- explicit cleanup reaps the fixture and descendant.

## Verification evidence

| Command/probe | Result |
|---|---|
| Real-child retained regression before production correction | Failed as expected; retained-byte diagnostics were absent and complete large objects remained reachable |
| Focused process-harness bounds file | 4 passed |
| `pnpm test:unit` | 41 files; 455 passed |
| `pnpm test:process` | 8 files; 91 passed |
| `pnpm check` | 67 files; 862 passed; no skips |
| `pnpm test:e2e` | 33 passed |
| Typecheck, build, package exports, lint, `git diff --check` | Passed |

No unhandled rejection or assertion failure occurred. The real-child regression reaped its descendant, existing split-readiness and stream-tail assertions remained unchanged, and the complete process project retained all crash/restart and process-owner cleanup behavior.

## Next action

Obtain a fresh verification-only WI-M7-M1 review. Do not begin WI-M7-M4, merge PR #13, or begin Milestone 8 until M1 is independently resolved.
