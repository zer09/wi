We are continuing a project designed in ChatGPT: a small, headless Rust model
gateway that will later sit inside a provider-pluggable coding harness. You are my
local development/review agent running through Pi with OpenAI-Codex/Astra; Pi is
not a dependency of the gateway being tested.

Read START_HERE.md, AGENTS.md, docs/LOCAL_AGENT_HANDOFF.md, and
 docs/REVIEW_CHECKLIST.md first. Then inspect Cargo.toml, README.md,
 docs/ARCHITECTURE.md, docs/EVENTS.md, docs/VERIFICATION.md, and the implementation.
Treat this as AI-generated, uncompiled source, not a working or tested release.

Briefly summarize the intended scope and your verification plan, then proceed:
audit the code, fix actual defects with focused patches and regression tests,
build it locally, run offline tests and lint checks, and perform the bounded
live smoke tests only after the security/offline gates pass. Do not stop after
writing a plan. Preserve existing user work and do not publish or push anything.

Use my existing Pi OpenAI-Codex subscription login read-only; use Codex credentials
only if I explicitly select that source. Do not create/request/use an API key,
print/read credential contents into the conversation, change my auth settings,
or rotate tokens. Resolve the exact enabled model ID from safe local metadata.

The live-test cap is 10 gateway provider-generation submissions total, including
failed/uncertain attempts, with no automatic retries. Use synthetic prompts and
only add_numbers. If blocked, continue useful offline work and record the exact
blocker instead of bypassing it. Stop live testing when the cap is reached.

Keep GUI/server/full-agent features, native steering, tool search, skills, PTC,
and async tool execution out of scope. Do not replace the native Rust provider
with a Pi/Codex subprocess just to make the tests pass.

Create docs/LOCAL_VERIFICATION.md and docs/local-verification.json from the
provided templates. Report actual commands, results, executed/skipped test
counts, fixes, remaining risks, and transport-specific live evidence. Never mark
a test as passed merely because its code exists, mocks pass, or the model says 42.
