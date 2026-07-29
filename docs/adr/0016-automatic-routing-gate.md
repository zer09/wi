# ADR-0016: Gate automatic provider routing on telemetry and explicit opt-in

Status: Accepted

Date: 2026-07-29

## Context

Multiple connections make automatic routing possible, but a routing decision can change account, workspace, plan limits, data policy, capabilities, cache affinity, and billing source. A naive round-robin or least-active strategy can destroy provider continuation/cache value and hide a Platform-to-ChatGPT billing change.

Wi has no real-provider telemetry yet. Implementing balancing before observing direct adapters would encode assumptions rather than measured requirements.

## Decision

Wi will define a provider-router boundary, but Milestone 11 implements only an explicit router:

```ts
interface ProviderRouter {
  select(
    request: ProviderRoutingRequest,
    candidates: readonly ProviderConnectionSnapshot[],
  ): Promise<ProviderRoutingDecision>;
}
```

```ts
type ProviderSelectionPolicy = {
  kind: "explicit";
  connectionId: string;
};
```

No routing decision may occur without an explicit policy. Manual selection remains the only active policy through Milestone 14.

Milestones 12–15 may collect bounded, redacted, connection-scoped telemetry:

```text
input tokens
cached input tokens
cache-write tokens when exposed
latency
active requests
rate-limit/reset metadata
recent failures
model/capability snapshots
session/provider-chain/cache affinity
```

Telemetry does not authorize routing by itself.

Milestone 15 must make an explicit go/no-go decision. An automatic affinity-aware router is optional and requires a new accepted ADR or amendment. If approved, it must:

- select only before a new run/provider chain;
- never switch connection mid-run;
- never switch after semantic output;
- never switch after a tool effect;
- never silently cross ChatGPT-plan and Platform billing;
- keep cross-auth-mode pools disabled without explicit user opt-in;
- durably record policy and routing/fallback decision;
- keep account/workspace/billing identity visible;
- prefer session/provider-chain/cache affinity over naive round-robin;
- obey provider capability and model constraints.

A selected connection that reaches a limit reports that connection. The user may explicitly select another connection for a later run; Wi does not silently do so.

## Alternatives

### Round-robin from the first connection milestone

Rejected because it ignores cache/continuation affinity and silently changes account/billing identity.

### Automatic fallback only on rate limit

Rejected because rate limits do not authorize another account, workspace, auth mode, or billing source.

### One mixed Platform/ChatGPT pool by default

Rejected because those modes have distinct credentials, policy, and billing.

### No router abstraction until later

Rejected because run acceptance needs one explicit, durable selection boundary now; defining it prevents selection logic from leaking into adapters.

## Consequences

Positive:

- first provider integrations are predictable and diagnosable;
- operational evidence precedes balancing policy;
- account and billing identity remain user-visible;
- affinity can be measured before optimization;
- automatic routing can be declined if it solves no concrete Wi requirement.

Negative:

- users manually switch when a selected account is limited/unavailable;
- connection pools may be underutilized initially;
- telemetry and a later architecture review are required before automation;
- durable decision records add implementation work even for future routing.

## Security/failure implications

- Provider errors, rate limits, and capability failures never authorize another identity.
- Mid-run, post-output, and post-effect switches are prohibited even if another connection is healthy.
- Cross-auth/billing routing is opt-in and policy-visible.
- Telemetry excludes credentials, raw prompts, hidden reasoning, and unbounded provider payloads.
- A router/policy error rejects run acceptance before provider work and effects.
- No router may invoke `codex app-server` or bypass ADR-0007/ADR-0008.

## Validation requirements

- Prove explicit selection is the only registered policy through Milestone 14.
- Reject run acceptance with no policy, unknown connection, incompatible model/capability, or non-ready selected connection.
- When A hits a limit, prove no request reaches B until a later explicit user selection.
- Prove a run cannot change connection at any continuation step.
- Reject automatic/fallback decisions after semantic output or any tool effect.
- Prove cross-auth pools require explicit opt-in and decisions preserve visible billing identity.
- Property-test affinity preference and durable decision idempotency if an automatic router is later approved.
- Audit telemetry for bounds, redaction, and inability to authorize routing alone.

## Implementation milestone

- Milestone 11: router interface and `ExplicitProviderRouter` only.
- Milestone 15: telemetry validation and explicit go/no-go ADR/amendment.
- Automatic routing, if approved, is after that gate and is not required by Milestone 10 or presumed mandatory for v0.2.
