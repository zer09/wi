# G1 design review: latest activity and backward history

Date: **September 28, 2026 (Asia/Manila)**. Status: **DECISION REQUIRED**.
Implementation is paused at checkpoint
**a89aeb49929929901e3613cc9bd3f450f3719f33** on draft PR #10.

## 1. Owner requirement

When a browser selects a session, refreshes, or reconnects after losing its local
page state, it must:

1. show the latest canonical conversation activity first;
2. attach live observation without a gap;
3. request older conversation only when the reader scrolls upward; and
4. avoid replaying the session from its first event merely to render the latest view.

A browser that temporarily disconnects may be behind the server and another active
browser. Recovery must converge to the current canonical server state. The product
must not impose full-history download and reduction as the normal route to current
activity.

## 2. Conflict in contract g1.0

`CLIENT_PROTOCOL.md` currently requires selection and full reload to reset the event
cursor to `sid:0`, fetch ascending fixed-head history pages through captured head `H`,
and only then attach SSE after `H`. Matrix G1-12 requires that model. The implemented
client follows it.

This produces the following behavior:

- initial selection downloads and reduces the entire raw event prefix;
- browser refresh repeats that full replay;
- full Reload repeats that full replay;
- explicit observation reconnect alone resumes after the last applied live cursor.

This behavior is correct against contract g1.0 but incorrect against the owner
requirement above. The accepted plan therefore cannot authorize further G1 work.

## 3. Why reversing the raw event query is not enough

The stored history endpoint exposes ordered reducer events. Many later events depend
on earlier identity and state:

- a response delta depends on its prior accepted run and response item;
- a tool result depends on prior function intent and tool start;
- a terminal run depends on prior acceptance and lifecycle events;
- provisional output may be replaced by an authoritative snapshot;
- reducer sequence and duplicate rules depend on a contiguous applied prefix.

A page beginning in the middle of those events may be impossible to reduce correctly.
Changing `ORDER BY sequence` to descending, then reversing each page in the browser,
does not create a self-contained conversation page.

The server must expose a canonical, page-local representation for historical display,
or an equivalent checkpoint that supplies all state required to reduce a suffix.

## 4. Recommended model

Use two separate positions with different jobs.

### 4.1 Latest conversation snapshot

Add a server-projected read that returns a self-contained latest conversation window.
The response should include:

- canonical session metadata;
- a bounded newest conversation window in display order;
- complete state for every included response/tool/run item;
- a stable boundary for requesting the immediately older window;
- captured event head `H` for live observation;
- whether older display history exists; and
- enough identity/provenance to validate every nested item.

The browser renders this page directly after strict runtime validation. It must not
need raw events before the page boundary.

### 4.2 Backward history cursor

Use an opaque or typed server cursor that means "the page immediately older than the
oldest canonical item currently displayed." It is not the live SSE cursor.

A backward page must:

- be self-contained;
- preserve canonical display order;
- contain no overlap, or define idempotent overlap explicitly;
- remain stable under concurrent newer writes;
- reject stale/incompatible cursor use with a specified safe response; and
- state when no older page remains.

Prefer a fixed captured-history boundary for one upward-scroll traversal so concurrent
new events do not shift older-page membership.

### 4.3 Live observation cursor

Keep a separate event cursor for SSE. After receiving latest snapshot head `H`, the
browser opens `/events?after=<session:H>` and applies only events newer than that
snapshot.

The server must make the snapshot-plus-SSE boundary gap-free:

1. capture canonical snapshot and head `H` together;
2. return both in one consistent read;
3. attach live SSE after `H`; and
4. replay any events committed after `H` before continuing live delivery.

The browser advances this live cursor only after full validation and reducer success.
This cursor must not control backward scrolling.

### 4.4 Recovery

For a live stream failure while the page remains intact, the planner must choose one
of these explicit policies:

- **incremental observation recovery:** reconnect SSE after the last applied live
  cursor and retain the displayed snapshot/history; or
- **canonical latest rebase:** fetch a new latest snapshot, reconcile or replace the
  live portion, and attach after its new head.

Incremental recovery is efficient but keeps G1-20's delivery-window complexity.
Canonical rebase is simpler to reason about but needs deterministic replacement and
scroll-position rules. Either policy can coexist with lazy backward history. The
contract must not conflate this choice with loading all history from sequence zero.

For browser refresh or a new browser, local derived state does not exist. Fetch the
latest canonical window rather than trying to resume a page-memory cursor.

## 5. Product decisions required

The planner/designer must specify these points before implementation resumes:

1. **Conversation unit:** Is backward pagination by turn, response, run, or projected
   display entry? Avoid splitting one logical exchange across pages unless the page
   contains a complete continuation representation.
2. **Initial size:** Define the bounded latest window by logical units and optional
   byte cap. A count of raw events is not a stable UX measure.
3. **Projection authority:** Define whether the new endpoint returns existing public
   DTOs, a new conversation-page DTO, or a checkpoint plus existing DTOs.
4. **Boundary semantics:** Define the backward cursor, fixed-history snapshot scope,
   expiry/staleness behavior, and concurrent-write behavior.
5. **Live reconciliation:** Define how events after `H` update or replace items already
   in the latest page without duplicate answers, tools, or terminal metadata.
6. **Reconnect policy:** Choose incremental observation recovery or canonical latest
   rebase, including behavior for an event no longer available from the requested
   cursor.
7. **Scroll behavior:** Define trigger threshold, prepend anchoring, loading/error/end
   states, and whether Reload preserves or resets scroll position.
8. **Open sessions:** Define whether session catalog ordering reflects current activity
   and how another browser's updates reorder the list.
9. **Retention:** Define behavior if older history has been pruned. Retention itself
   remains outside G1 unless explicitly added.
10. **Performance bounds:** Replace the old full-prefix long-history target with latest
    snapshot latency, first-render payload, one backward-page cost, prepend stability,
    and live-update latency.
11. **Error and privacy behavior:** Keep flat safe errors, bearer protection, same-origin
    fetch, memory-only token, and no private data in artifacts.
12. **Migration:** Decide whether the old `/events?after=` history use remains only an
    event/debug API, changes incompatibly, or is supplemented by a new endpoint.

## 6. Matrix changes required

At minimum, revise:

- **G1-07/G1-08:** session selection and refresh begin at latest activity;
- **G1-12:** replace forward replay from `sid:0` with latest snapshot plus backward
  pagination and gap-free SSE attachment;
- **G1-14:** distinguish backward-history cursor validation from live event cursor;
- **G1-15:** redefine full Reload against the latest canonical snapshot;
- **G1-20:** decide whether exact incremental reconnect windows remain required after
  the recovery policy is chosen;
- **G1-21:** define two-browser convergence when one browser has only a latest window;
- **G1-27:** add upward-scroll loading, prepend anchor, end, and retry UX;
- **G1-28:** replace full-history replay measurements with latest-page and backward-page
  measurements;
- **G1-30/G1-31:** require joined acceptance and reports against the revised contract.

Existing tests for safe assets, auth, DTO validation, commands, tools, cancellation,
presentation, and most lifecycle behavior remain useful. Fixed-head/full-reload and
read-reconnect tests require reassessment rather than mechanical preservation.

## 7. Additional risks found during implementation

The owner asked whether other design issues might be hidden. These points need explicit
planner confirmation:

- The shared owner bearer is not browser registration or login. Every browser with the
  token has the same owner authority and can see the same sessions.
- The current client uses manual fetch-based standard SSE because native EventSource
  cannot carry the owner bearer header or provide the required reconnect controls.
- G1-20 Window B is not currently observable in pinned Chromium without more invasive
  instrumentation. This is a test-proof limitation, not a demonstrated production bug.
- The current matrix often requires joined proof for every rare storage/provider case.
  Some cases need test-only fault seams. The planner should distinguish acceptance
  requirements from lower-level invariant coverage when browser-level injection adds
  more machinery than product behavior.
- Existing public history is an event log, not a conversation-read model. Treating one
  endpoint as both reducer replay and user-facing pagination created the main conflict.
- Multiple browsers are same-owner observers, not isolated tenants. A stale browser can
  temporarily display older state; the UI must label observation status and converge
  explicitly.

## 8. Recommended next planning deliverable

Produce contract **g1.1** before more code changes. It should include:

1. a concrete latest-page request and response example;
2. a concrete backward-page request and response example;
3. the snapshot-head/SSE handshake;
4. reducer/projection replacement rules;
5. reconnect and refresh state diagrams;
6. revised G1 matrix rows and performance targets; and
7. a migration disposition for the checkpoint implementation and tests.

Do not resume implementation by simply reversing SQL ordering or weakening the current
G1-20 assertion. Both would hide the underlying contract problem.
