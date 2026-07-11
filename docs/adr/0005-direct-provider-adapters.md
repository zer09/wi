# ADR-0005: Use direct provider adapters with explicit OpenAI authentication modes

Status: Accepted  
Date: 2026-07-11

## Context

Wi must remain the agent harness. It owns the run loop, tool registry, system instructions, persistence, approvals, and browser events.

The first target provider is OpenAI, with two distinct authentication and billing modes:

- OpenAI Platform API key
- ChatGPT/Codex OAuth through an eligible ChatGPT plan

These modes use different credentials, endpoint behavior, limits, and billing/policy context. Treating them as interchangeable would create hidden account and billing changes.

## Decision

Define a provider-neutral `ProviderAdapter` contract.

The first vertical slice implements only a deterministic fake adapter.

Later, implement two direct OpenAI adapters:

```text
openai_platform
  credential: OpenAI Platform API key
  transport surface: public Responses API
  billing/policy: OpenAI Platform project

openai_codex
  credential: ChatGPT OAuth access + refresh tokens
  transport surface: ChatGPT Codex Responses compatibility endpoint
  billing/policy: selected ChatGPT account/workspace and plan
```

Both adapters normalize provider-specific events into the same Wi provider-event contract.

## Authentication requirements

- credentials stay on the backend
- API keys and OAuth tokens are stored outside catalog/session databases
- browser never receives provider secrets
- ChatGPT OAuth supports browser PKCE and device-code flows
- refresh is single-flight per connection
- runs snapshot provider connection ID and credential generation
- changing account during a run never silently changes its identity
- model/capability discovery is connection-specific and dynamic

## Billing and fallback requirements

Wi never silently changes:

- Platform API billing to ChatGPT-plan usage
- ChatGPT-plan usage to Platform API billing
- account/workspace
- model or endpoint

Any future user-requested switch is explicit and durably recorded.

## Shared and adapter-specific concerns

Shared:

- canonical request Items
- normalized text/reasoning/tool events
- tool-call loop
- usage records
- retry categories
- cancellation

Adapter-specific:

- credential acquisition and refresh
- base URL and headers
- model/capability discovery
- usage-limit classification
- transport feature support

## Consequences

Positive:

- Wi remains the harness in both auth modes
- consistent browser/session/tool semantics
- clean second-provider path later
- no duplicate Codex agent runtime

Negative:

- ChatGPT/Codex compatibility behavior requires dedicated integration tests
- two OpenAI adapters require separate capability/error handling
- credential management becomes a first-class subsystem

## First-slice boundary

Do not implement either real OpenAI adapter in the first vertical slice. Implement only:

- `provider-contract`
- `provider-fake`
- normalized provider events
- failure and partial-stream semantics

## Validation

- the fake provider passes the provider contract tests
- future real adapters must pass the same normalized contract suite
- architecture tests reject `codex app-server` dependencies
- billing/account mode is explicit in future run snapshots
