# Wi product direction — confirmed decisions and slice boundaries

Prepared 2026-09-11. This is a requirements record, not an implementation report.
Runtime baseline at preparation: `b33ca4bb1cdf8ae58da8d83123b87956535d6a2c` (C1 merged).
Current implementation note: V1-A provides the in-process execution owner and is
locally complete; `accepted=false`, exact-head hosted CI NOT RUN. V1-B network,
client-authentication and browser protocol work remains future scope.

## 1. Product and ownership

Wi is a headless Rust coding-harness backend intended to run as a service. A web
GUI is a client of that service. The CLI remains a development/diagnostic client;
no future API handler should launch `wi` or Pi/Codex as a subprocess to do the
library's work. Providers remain compiled-in trait implementations. Authentication
is the accepted Wi-managed OpenAI-Codex subscription integration, with explicit
external sources retained; no silent Platform API billing fallback.

```text
Web GUI / another authorized client
               |
        Wi network adapter                 future V1-B
               |
   In-process execution owner              V1-A
               |
 Workspace and context preparation         S1 / S2
               |
        Existing run controller             accepted M3 + C1
         |                 |
   Provider gateway    Local tool executor
         |
  OpenAI-Codex subscription
```

A reusable library boundary is required throughout. The service may be one Rust
process with modules; no additional web/proxy microservice is implied.

## 2. Decisions supplied by the user

### Local skills

There are global and project skills. Global frontmatter is always discovered and
included in prepared run context. If the chosen project contains its skill root,
that frontmatter is included too. A project does not replace the global catalog.
Full skill instructions are loaded only for activation; discovering metadata is
not permission to execute files, register tools, or upload bundles.

S1 uses a Wi-owned global directory and the project's `.agents/skills` directory.
Both remain identifiable when names overlap. The exact paths, collision behavior,
and preparation semantics are specified in the S1 contract. These details are
Wi design choices, not claims of complete Pi/Codex format/discovery parity.

Hosted OpenAI skills are excluded from the current product. The user chose a
subscription-only path and does not want an API-billed upload integration. Remove
active HostedSkills capability placeholders rather than retain a disabled future
engine. Local instructions still travel to the chosen model as prompt content;
local does not mean offline inference. Do not claim that this decision establishes
what every future account or endpoint can support.

### Clients and task lifetime

The first network service is **one owner, multiple devices**, not independent
multi-user tenancy. Authorized browsers/devices can inspect and control the same
owner's sessions and tasks. Service-client authentication is separate from
provider OAuth. Its mechanism is not designed in S1.

Closing a tab, disconnecting, or switching devices is not cancellation. The
service owns admitted work independently of any individual HTTP/WebSocket/SSE
client. A failed client subscription must not be wired directly to the current
run observer in a way that stops the run. Explicit user cancellation is separate.
A new authorized client must be able to retrieve stored state/history and then
observe ongoing work without duplicate presentation or lost ordering. Exact API,
subscription, cursor, and storage guarantees belong to the later contracts.

### Service restart and storage

**Application sessions always persist in storage.** P1-A implements the shared
SQLite store with per-session databases, a catalog, commit receipts and schema
migration rules. P1-B1 records actual execution; P1-B2 restores validated stored
context for a new explicit task. These slices are complete and merged. Retention
and deletion policy remain deferred; ordinary CLI persistence is not implemented.

**Service restart does not resume or restart any task automatically.** Previously
active tasks must not trigger provider submissions, tool calls, retries, or replay
when Wi starts. Stored records remain available; unfinished work is represented
truthfully as interrupted/stopped due to restart, not fabricated completion or
proof that external side effects were undone. Existing storage recovery records
interruption without starting work. Continuing work later requires a new explicit
user action; no automatic replay of an unfinished tool is implied.

V1-A graceful shutdown cancels and drains owned tasks before closing storage.
Unexpected process loss cannot undo remote or already completed effects. No detached
executor capable of surviving the service should be introduced without a separate
lifecycle design.

The existing transport `ProviderSession` is an in-memory connection/context handle,
not a persistent application session. Application sessions now use P1-A storage;
transport and run IDs do not replace stored session identity. S1 remains pre-run
preparation, not an in-memory-only substitute for persistent application sessions.

## 3. Slice map

| Slice | Scope | State / dependency |
|---|---|---|
| Gateway + Wi authentication | Provider protocol, subscription profiles/login/renewal and ordinary tool cycle | Accepted within historical evidence limits; do not redesign. |
| M3 + C1 | Reusable run/turn orchestration with no RunLimits feature | Accepted baseline; retain cancellation and validation. |
| S1 | Workspace resolution, base/project instruction composition, global-plus-project skill metadata, explicit activation, hosted-placeholder removal | Completed and merged in PR #2. |
| S2 | Model-selected main `SKILL.md` loading using the local catalog | Offline accepted; live model selection/adherence NOT RUN. Supporting files and scripts remain deferred. |
| P1-A | Shared SQLite application-session store, catalog, receipts and history | Completed, accepted and merged. Retention/deletion policy remains deferred. |
| P1-B1 | Actual runtime capture through the shared execution path | Completed, accepted and merged in PR #6. |
| P1-B2 | Validated stored-context replay for a new explicit task | Completed, accepted and merged in PR #7, including B2-E01. No automatic task resumption. |
| V1-A | In-process execution owner using the shared core and persistent sessions | Locally complete; `accepted=false`; exact-head hosted CI NOT RUN. Client/ticket Drop does not cancel. |
| V1-B | One-owner multi-device network service, client authentication and browser protocol | Future scope; not implemented. Uses V1-A; GUI follows the service API. |
| Later explicitly agreed slices | Actual coding tools, skill references/scripts where authorized, steering, search/PTC/async tools, UI | Not authorized by this document. |
| H1 hosted skills | Hosted upload/version/execution integration | Removed from the active roadmap, not left as an implementation dependency. |

Completed S1/S2/P1 work does not authorize V1-B or other later slices. Normal CLI
persistence, network/client authentication, browser protocol and GUI remain deferred.
V1 must not be accepted as an ephemeral in-memory session service that promises to
add required persistence someday. V1-A local completion is not hosted acceptance.

## 4. Evidence and non-regression policy

Historical reports preserve their dates, tested models/platforms, failures and
observed results. Baseline C1 reports 260 Rust tests and 152 verification-runner
self-tests; this is a comparison point, not an imposed test-count target.
The live ledger is 31/50 used, 19 remaining; no new traffic is authorized.
Test watchdogs stay outside product runtime. No fixed model/tool-call quota,
whole-run deadline, optional replacement budget, or arbitrary new feature-count
ceiling is justified by the word small or bounded.

Local files are instructions/data, not permission grants. Context preparation
cannot widen tool access, read credential stores, change auth source, or control
service identities. No broad discovery of another harness's private directories.
Unknown provider-native output still does not authorize execution.
