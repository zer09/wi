# Milestone 7 release-gate remediation 25

Status: IMPLEMENTED — PENDING INDEPENDENT VERIFICATION

Finding: `WI-M7-M1-F2` — inbound process-IPC retention exposed mutable internal message and diagnostic references.

## Remote review identity

The third independent remote review examined PR #13 at:

```text
base:             dd932c9c774aa9c28c68f7aff66690a5b2c526f3
head:             96ad7d4689d69294adcc406482e9fea431198533
prospective merge: 1a631221a99bde39cffaf46ad54e07fa915863e7
CI run:           29994318727
verdict:          REQUEST CHANGES
```

Every previously open Milestone 7 finding remained resolved. The review opened one Medium-severity release-gate defect: an accepted child-IPC object was measured and then retained by reference; `take()`, `history`, and `snapshot().latestTruncation` exposed internal retained references that callers could mutate after accounting.

## Before-fix evidence

Retained tests against `96ad7d4` reproduced all three aliases:

- mutating the nested object returned by `take()` rewrote the message still held in history without changing retained-byte counters;
- mutating a message returned by `history` changed the next history read;
- mutating `latestTruncation` from one diagnostics snapshot changed the next diagnostics snapshot.

The unit reproducer failed 2 of 8 tests before correction. A real child also supplied the nested waiter object and bounded truncation evidence used by the process regression.

## Correction

`BoundedIpcRetention` now owns one bounded plain-data snapshot for every accepted callback value. Pending/history byte accounting uses the exact snapshot retained internally rather than the callback object. `take()` and `history` return fresh copies through the same depth/node/string/encoded-byte-bounded snapshotter, and diagnostics return a copy of the scalar bounded truncation record.

The copy operation is not unbounded recursion: it reuses the existing maximum depth 32, 4,096-node, 16,384-string-unit, and 64-KiB estimated-message limits. Node object IPC still deserializes before the receive callback, so the documented trusted-child pre-deserialization limitation is unchanged.

## Retained regressions

The correction adds deterministic coverage for:

- source callback mutation after acceptance;
- mutation of nested objects and null-prototype array snapshots returned by `take()`;
- mutation of nested objects and arrays returned by `history`;
- mutation of `latestTruncation` returned by diagnostics;
- unchanged internal history, counters, and canonical truncation evidence after every attempt;
- actual retained JSON bytes remaining at or below the recorded estimate;
- the same waiter/history/diagnostics checks through a real child and `RealServerProcess.waitForMessage()`.

All earlier M1/M1-F1 payload, aggregate, eviction, non-finite, proxy, accessor, array, timeout, readiness, descendant, and cleanup regressions retain their prior meaning.

## Validation

```text
pnpm install --frozen-lockfile: already up to date
focused bounded-ipc unit:       9/9 passed
focused real-child alias:       1/1 passed
complete process-harness bounds: 6/6 passed
unit:                           464/464 passed
integration:                    262/262 passed
property (WI_FC_SEED=737373):   36/36 passed
process:                        108/108 passed
build/package exports:          8 entry points verified
E2E:                            33/33 passed
pnpm check:                     69 files, 891/891 passed, no skips
lint/typecheck/git diff check:  passed
```

Independent verification remains required before push or merge.
