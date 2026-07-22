# Milestone 7 release-gate remediation 19

Status: **ESTIMATOR FOLLOW-UP IMPLEMENTED — fresh independent WI-M7-M1 verification pending**

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

## Independent verification of `e6c406e`

Verdict: **PARTIALLY RESOLVED**.

The verifier confirmed that complete rejected values were no longer reachable, all structural/protocol summaries were bounded, awaited controls and outbound preflight worked, diagnostics stayed bounded, cleanup remained deterministic, and the trusted-child post-deserialization limitation was documented honestly. Two findings remained:

- `WI-M7-M1-V1` (medium): raw UTF-8 string/key charging did not include JSON-required escaping or complete numeric encodings. Thirty-one accepted NUL-heavy messages retained 3,053,286 serialized bytes while history reported a 517,717-byte estimate below its 524,288-byte cap.
- `WI-M7-M1-V2` (low): committed regressions used favorable ASCII payloads and omitted key-heavy objects, invalid/overlong types, outbound rejection, and deterministic all-awaited overload coverage.

## Estimator follow-up correction

- String values and object keys now use an allocation-bounded exact UTF-8 JSON encoded-length scan, including quotes, control escapes, quote/backslash escapes, surrogate pairs, and lone-surrogate escapes.
- Numbers and booleans charge their complete JSON encodings in addition to the existing per-node structural allowance. Existing per-node and per-key allowances remain conservative for commas, colons, braces, brackets, and the outer retained-history array.
- A unit regression sends NUL-heavy values/keys and maximum-width numbers, then requires the complete retained-history JSON byte length to be no greater than its charged estimate.
- The real-child regression now sends NUL-heavy aggregate traffic, key-heavy and array-heavy objects, a nested overlong string, an encoded-byte overflow, and invalid plus overlong types. It requires retained-history JSON bytes to be no greater than the reported estimate and checks each summary classification.
- A real-child outbound-control regression proves normal string/object controls arrive while oversized, deep, node-heavy, and cyclic controls reject before child receipt.
- Deterministic unit regressions prove unawaited traffic is evicted before an awaited control and that impossible all-awaited overload still enforces the aggregate by sacrificing the oldest awaited entry.

Test-first evidence reproduced V1 before the estimator correction: the unit regression retained 1,561,726 serialized bytes against a 274,646-byte estimate, and the real-child regression retained 1,786,942 serialized bytes against a 521,818-byte estimate. Both pass after the correction.

## Follow-up verification evidence

| Command/probe | Result |
|---|---|
| Escape-heavy/unit regression before estimator correction | Failed as expected: 1,561,726 serialized bytes exceeded the 274,646-byte charge |
| Escape-heavy/real-child regression before estimator correction | Failed as expected: 1,786,942 serialized bytes exceeded the 521,818-byte charge |
| Focused `bounded-ipc` unit file | 3 passed |
| Focused process-harness bounds file | 5 passed |
| `pnpm test:unit` | 42 files; 458 passed |
| `pnpm test:process` | 8 files; 92 passed |
| `pnpm check` | 68 files; 866 passed; no skips |
| `pnpm test:e2e` | 33 passed |
| Typecheck, build, package exports, lint, `git diff --check` | Passed |

No unhandled rejection or assertion failure occurred. Focused and full process runs reaped every fixture descendant and watchdog.

## Next action

Obtain a fresh verification-only WI-M7-M1 review. Do not begin WI-M7-M4, merge PR #13, or begin Milestone 8 until M1 is independently resolved.
