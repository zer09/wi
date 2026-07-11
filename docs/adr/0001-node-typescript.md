# ADR-0001: Use Node.js and TypeScript for the Wi control plane

Status: Accepted  
Date: 2026-07-11

## Context

Wi is primarily an orchestration server. Its workload is dominated by:

- browser and provider network streams
- waiting for tools and child processes
- session scheduling
- event persistence
- plugin communication
- structured event fanout

Several desired integrations and plugins are already implemented in TypeScript. Rust was considered for stronger native parallelism and lower-level control, but adopting it for the initial control plane would increase implementation complexity before a measured bottleneck exists.

Node.js can handle many concurrent I/O-bound sessions effectively, but synchronous SQLite, CPU-heavy work, and arbitrary plugin code would block its main event loop if used carelessly.

## Decision

Use Node.js 24 and strict TypeScript ESM for the Wi v0.1 control plane.

The main Node.js thread is orchestration-only. Move blocking or CPU-heavy work to worker threads or child processes.

## Required boundaries

The main thread may perform:

- HTTP and WebSocket handling
- runtime validation
- scheduling and lightweight state transitions
- bounded serialization
- provider network I/O
- event publication

The main thread must not perform:

- synchronous SQLite operations
- synchronous child-process execution
- CPU-heavy parsing, indexing, compression, or diffing
- arbitrary plugin execution
- unbounded filesystem walks or JSON processing

Use:

- a dedicated catalog database worker
- a fixed session database worker pool
- worker threads for trusted CPU-heavy TypeScript/JavaScript tasks
- child processes for tools and isolated plugin services

## Consequences

Positive:

- direct compatibility with the intended plugin ecosystem
- one primary language across browser, protocol, server, and tests
- rapid iteration on schemas and UI/backend contracts
- strong asynchronous I/O support
- later Rust components can be introduced behind RPC boundaries

Negative:

- event-loop blocking becomes an architectural risk
- synchronous SQLite APIs require worker isolation
- CPU parallelism requires explicit workers/processes
- memory isolation for plugins requires subprocesses or workers

## Alternatives considered

### Rust control plane

Rejected for v0.1 because it adds a second main ecosystem and more IPC/type-generation work without evidence that orchestration performance is the bottleneck.

### One Node.js thread with synchronous SQLite

Rejected because concurrent database or indexing work could starve browser/provider transport.

### One process per session

Rejected because it creates excessive process and connection overhead for idle or lightweight sessions.

## Validation

- dependency tests keep SQLite implementations out of the server main-thread path
- event-loop delay is instrumented in later operational work
- load tests run many concurrent fake-provider sessions
- worker-pool and scheduler limits are property-tested
