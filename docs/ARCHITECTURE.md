# Architecture and ownership

Wi is one Rust application with an independent core library and a TypeScript browser client. It does not launch Pi, Codex, or another `wi` process to execute a task.

```text
Browser commands and display
             |
       Rust HTTP adapter
             |
           RunHost
             |
    Persistent execution / B2 replay
             |
      Shared run controller
          /             \
 Provider session     ToolRegistry
          \             /
         Awaited persistence
                 |
     Session SQLite + display projection
```

## Module map

| Module | Responsibility |
|---|---|
| `src/gateway.rs`, `src/provider.rs` | Provider-neutral session and request interfaces |
| `src/providers/openai_codex/` | Subscription transport, decoding, native continuation, and provider authentication |
| `src/context/` | Workspace instructions, metadata catalog, explicit activation, and main-skill loading |
| `src/tools.rs`, `src/tools/` | Full-batch validation, sequential effects, result serialization, run-scoped reuse |
| `src/run/` | Shared model/tool loop, correlation, cancellation, outcomes, observation |
| `src/execution/` | Durable acceptance, awaited capture, compatible saved provider history |
| `src/storage/` | Exclusive ownership, canonical history, receipts, projections, queries, migrations |
| `src/conversation/` | Typed browser-safe display values, identities, cursors, shared wire encoding |
| `src/service/` | Host-owned execution, passive tickets, explicit cancellation, shutdown |
| `src/http_api/` | Request boundary, commands, safe views, embedded assets, HTTP/SSE |
| `web/src/` | Transport, display buffer, input, rendering, viewport behavior |

## Execution path

A new service task validates its raw command, prepares current context, and selects compatible stored history. Persistent acceptance commits before provider work. A matching operation receipt returns the original acceptance instead of executing again. Changed content under the same operation ID conflicts.

The controller opens a provider session, records its binding, checks replay identity, and installs validated history. A fresh WebSocket sends the restored input plus the new task without importing an old connection's parent response ID. Later requests on that connection use its new parent linkage. SSE sends the effective native history. A fresh application conversation has empty previous history.

Only an authoritative completed response can authorize ordinary tools. The registry validates the entire batch before any new execution. It records intent, executes sequentially, serializes the real result, caches it in the run scope, and records the result before finish observation and continuation. Cache reuse is not a second execution.

The final outcome distinguishes execution from observation/persistence failure. Local cancellation does not prove upstream termination or undo effects. A committed result cannot be described as absent merely because delivery failed.

## Three different histories

| Representation | Consumer and meaning |
|---|---|
| Canonical events and receipts | Immutable committed facts and operation identity |
| Provider replay | Compatible original prompts, native/effective responses, and actual correlated tool results for a new task |
| Conversation projection | Saved display-ready blocks, entries, and content for browser reads |

Browser backscroll does not change the model's context. Provider replay is not made by concatenating rendered messages. Display reads do not reload historical skill files or execute tools.

## Ownership and failure

`RunHost` owns tasks. Weak clients and passive tickets do not own the execution future. Dispatch, durable acceptance, and completion are separate boundaries. Dropping an HTTP waiter, browser page, or stream does not cancel accepted work.

Cancellation addresses both session and run. Shutdown stops admission, requests cancellation, drains runs while storage remains writable, and closes storage last. Uncertain retirement retains conservative ownership/quarantine rather than allowing a racing store owner.

Explicit session reopening preserves committed content and records prior-instance unfinished work as interrupted. It never automatically resumes an old model request or tool execution.

## Context and compatibility

New submissions use current instructions, tool definitions, and workspace catalog. Historical replay uses saved original values and requires compatible provider/model/account identity and complete supported exchanges. Active, incomplete, uncertain, or legacy-unbound history remains readable but can reject native replay.

The run API has no run-wide model-request quota, tool-execution quota, or absolute task deadline. Existing input, native history, network, result-size, and display-transfer safeguards are separate scoped protections.

The CLI `wi run` remains nonpersistent. The persistent library, host, and HTTP paths are separate entry points over the shared controller.

## Not implemented

General file/shell coding tools, native steering or follow-up queues, parallel/asynchronous tools, compaction, branching, additional providers, dynamic plugins, hosted skills, automatic retries/failover, and automatic task resumption are outside the shipped scope. Proposed future work is in [milestones](MILESTONES.md).

See [storage](STORAGE.md), [conversation protocol](CONVERSATION.md), and [tools](TOOLS.md). Public module exports are in [`src/lib.rs`](../src/lib.rs).
