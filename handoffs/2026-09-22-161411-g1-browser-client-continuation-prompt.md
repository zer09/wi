# Continuation prompt for the next agent

Copy the text below into a fresh Pi agent session from `/home/gc/projects/wi`.

---

Resume the Wi G1 browser-client implementation from the project-local handoff:

`handoffs/2026-09-22-161411-g1-browser-client-continuation.md`

This request authorizes continuation of the uncommitted G1 implementation and its local tests. It does **not** authorize staging, committing, pushing, merging, deploying, hosted-service mutation, live provider generations, real credential reads, or auth commands.

First, use the session-handoff resume workflow. Read the handoff completely and verify it against the current tree. Then read and follow, in order:

1. `AGENTS.md`
2. `docs/PLATFORM_SUPPORT.md`
3. `docs/slices/v1b/PLATFORM_FOLLOWUP.md`
4. `docs/slices/v1b/platform-followup.json`
5. `docs/slices/g1/CONTRACT.md`
6. `docs/slices/g1/CLIENT_PROTOCOL.md`
7. `docs/slices/g1/MATRIX.md`
8. `docs/slices/g1/VALIDATION.md`
9. `docs/slices/g1/IMPLEMENTOR_PROMPT.md`
10. Current V1-B API/security and mapped DTO/router/service/browser-fixture source.

Before feature edits:

- Verify branch, HEAD, ancestry, staged/unstaged/untracked files, and handoff staleness.
- Preserve every owner change. Do not reset, clean, stash, or force-checkout.
- Satisfy the repository's mandatory fresh-agent G1-00/G1-01 platform-preflight requirement. Do not restore native Windows support.
- Treat prior review-gated increments through **8c1d-b** as fixed unless current source evidence proves a contradiction.
- Confirm no partial 8c1d-c file exists. The prior implementation delegate changed no files.

Continue with the smallest next increment, **8c1d-c**, using the repository's delegated implementation and review workflow:

- Add one focused real joined-Chromium test for post-framing input overflow.
- The actual JSON task request body must be accepted at or below `MAX_INPUT_BYTES`.
- The unframed user InputItem must pass validation.
- Real project/catalog context framing must push the provider input over `MAX_INPUT_BYTES`.
- The exact response must be **HTTP 413** with ErrorView:
  - `code: context.input_too_large`
  - `stage: null`
  - `certainty: not_applicable`
  - `acceptance: null`
  - `notices: []`
- Do not change this to 422. `src/http_api/dto/errors.rs` and the V1-B API establish 413. Distinguish this case from HTTP-boundary `413 api.body_too_large` by exact error code.
- Use one explicit browser Send and one task POST. Do not probe with trial POSTs.
- Determine the task byte count deterministically. The prior 8c1d-b request envelope measured 115 bytes, but assert the captured actual body is `<= MAX_INPUT_BYTES`; do not trust an unverified magic constant.
- Prove exact text preservation at draft, wire, and immutable rejected command without logging the full text, UUIDs, or digest.
- Retain only bounded lengths, 64-character boundaries, hashes used through boolean comparisons, and identity-change booleans.
- All unexpected page console messages must fault except the exact expected task-endpoint 413 resource error.
- Use the real browser UI, embedded assets, auth, HTTP parser, context preparation, SQLite, and closed mutation/task fixture evidence. Do not mock or fulfill the API response.
- Prove one browser-created session plus the fixture seed, sequence 1 only, exactly one create POST and one task POST, and zero task command/receipt/run/checkpoint/provider/auth/tool/cancel/rename work.
- Preserve inert markup, no external requests, no browser persistence, memory-only credentials, Disconnect clearing, and clean fixture teardown.
- Keep traces, HAR, screenshots, and video off for this case.

Run bounded focused checks, retain all failures, inspect the diff, and complete the independent review-a/review-b/review-c gate. If a reviewer reports a blocking finding, independently verify each finding, remediate only confirmed findings, and repeat the full review gate. Do not advance automatically after any required delegate returns a non-completed state.

After 8c1d-c is review-gated, continue G1 in bounded increments. The next remaining G1-11 cases are stale history, unknown commit, known acceptance warning, incomplete/unbound history, and account mismatch. Do not bundle unrelated lifecycle, paging, multi-client, restart, CI, or reporting work.

Important retained facts:

- Current planning HEAD: `122166bf842cc174cf4942e6284440318b5564dd`.
- Accepted runtime baseline: `76bb32fd04fd4737c0efcceaabc7d10387453147`.
- All implementation changes are unstaged and uncommitted, including the untracked `web/` tree and Rust browser fixture files.
- Latest stable Node count: 281.
- Latest broad Chromium run: 7/7 through increment 8b. Five later focused mutation/failure specs pass, but no final accumulated all-browser run is claimed.
- Current matrix assessment: 14 review-gated, 14 partial, 4 not run.
- Local Playwright runs on openSUSE Tumbleweed under WSL; eventual Ubuntu browser CI is the supported-platform confirmation.
- Final reports must retain initial failures, review disagreements, remediations, source/browser/native/CI distinctions, and the documented response-identity protocol contradiction.

Report verified resume state before implementation, then proceed unless verification finds a material conflict that changes scope or safety.
