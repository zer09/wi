# Start here — local Pi / Astra handoff

**One folder, one source baseline, no separate documentation downloads required.**

Prepared September 8, 2026. The Rust crate remains **0.2.0**. This is a packaging
and local-agent handoff, not a new implementation release.

## What you have

This bundle contains the complete previous v0.2.0 project, including README,
architecture, events, and verification documents. Every one of the 35 files from
the original v0.2.0 ZIP is preserved byte-for-byte. New files add project context,
a local review plan, test safeguards, and report templates.

The code is **AI-generated, uncompiled, and unverified**. Its 56 test definitions
are source inventory, not 56 executed or passing tests. No live subscription test
has been performed here. Your local agent's job is to review it skeptically,
repair it, and establish actual evidence.

## What to do

1. Extract this ZIP into a fresh project directory. Do not merge it over another
   checkout or combine it with v0.1.0. Keep the original ZIP as a baseline.
2. Open a terminal in the extracted `harness-gateway-0.2.0-handoff` directory —
   the directory containing `Cargo.toml` and this file. Start your usual Pi harness
   there using the already configured OpenAI-Codex/Astra model. No credential
   upload, new API key, or new login is required just to start the review.
3. Paste the contents of `LOCAL_AGENT_PROMPT.md` into Pi. The prompt explicitly
   tells the agent which local files to read, so the handoff does not depend on
   automatic AGENTS.md discovery or this ChatGPT conversation being available.
4. Let the agent inspect the project, record a short plan, repair build/test
   problems, and execute offline tests. Only after the security and offline gates
   pass may it run the limited live smoke tests in the handoff.
5. Read the resulting `docs/LOCAL_VERIFICATION.md`. Share only its sanitized
   summary when returning to the design conversation. Do not share auth files,
   raw native response dumps, or your Pi conversation/session exports.

If you already made changes to another copy, keep that copy separate and have the
local agent compare it before transferring work. Nothing in this handoff requires
resetting, deleting, or overwriting your existing work.

## File map

| File | Reader / purpose |
|---|---|
| `START_HERE.md` | You: how to unpack and use the bundle. |
| `LOCAL_AGENT_PROMPT.md` | You: copy its prompt into your local Pi session. |
| `AGENTS.md` | Local agent: scope, safety, ownership, and evidence rules. |
| `docs/LOCAL_AGENT_HANDOFF.md` | Local agent: complete project context and phased repair/test plan. |
| `docs/REVIEW_CHECKLIST.md` | Local agent: concrete review and regression targets. |
| `README.md` | Existing build/CLI guide; verify and correct against actual code. |
| `docs/ARCHITECTURE.md` | Existing module ownership and state semantics. |
| `docs/EVENTS.md` | Existing event contract; compare it with emitted events. |
| `docs/VERIFICATION.md` | Historical report: what was and was not checked before delivery. |
| `docs/LOCAL_VERIFICATION_TEMPLATE.md` | Starting structure for the NEW local findings report. |
| `docs/local-verification.template.json` | Machine-readable report template; starts as NOT RUN. |
| `docs/PACKAGING_AUDIT.md` | What was verified about the ZIP and document inclusion. |
| `MANIFEST.sha256` | Hash inventory for the extracted handoff files. |

Markdown (`.md`) files are plain text. You can read them in an editor; they are
not executables or extra dependencies. The agent uses them as instructions,
reference material, or report templates. No uploading of these files to a provider
Files API is part of the setup.

## Smallest task being verified

```text
CLI / library caller
        -> Rust Gateway
        -> Provider / SessionControl traits
        -> OpenAI-Codex subscription adapter
        -> WebSocket (preferred) or explicit SSE
        <- normalized response/item events
```

One side-effect-free local tool, `add_numbers`, proves a model → tool → model
round trip. Pi is the agent helping develop this project, not a runtime dependency
that the gateway is allowed to secretly invoke in place of its own transport.

No web server, GUI, production agent loop, shell, database, native steering,
PTC, async execution, hosted skills, or tool search is required for acceptance.

## Live-test authorization and limits

The user requested local live verification. The handoff permits up to **10 total
provider-generation submissions** from the gateway under test: five for WebSocket
and five for the same SSE scenarios, with no automatic retries. This is a cap,
not a quota to use. Your ongoing Pi assistant conversation is separate traffic;
this budget does not attempt to meter it.

Only synthetic, non-sensitive prompts and the `add_numbers` tool may be sent.
Existing Pi subscription credentials are the preferred source. An exact model ID
must come from the local configured model metadata or the user, not from guessing
what the display name “Astra” means. If authentication, model access, policy, or
networking blocks a test, report the blocker; do not switch to API-key billing.

The current CLI has no user-configurable timeout flag. The local agent should use
a reviewed subprocess deadline or a narrowly scoped test-runner limit rather than
invent command options. Local interruption does not prove upstream cancellation.

## Evidence separation

`docs/VERIFICATION.md` remains the original unverified-delivery report. New local
results belong in `docs/LOCAL_VERIFICATION.md` and `docs/local-verification.json`,
created from the templates. A successful local build must not be rewritten as if
it had happened in the earlier authoring environment.
