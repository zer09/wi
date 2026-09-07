# Verification evidence — source delivery 2026-09-07

## Actual local checks performed

- Extracted the supplied 0.1.0 archive and used its source as the baseline.
- Inspected current primary OpenAI documentation and Pi's pinned Codex adapter.
- Parsed Cargo.toml and all synthetic JSONL fixtures.
- Checked the source/module inventory, test-definition names, absence of credential
  files in the delivery, and separation of the gateway from OpenAI imports.
- Ran a Pygments lexer/delimiter check on the Rust source. This is NOT Rust parsing
  or type checking and cannot establish that the program compiles.
- Invoked `python3 scripts/verify.py`. It exited 2 at the missing-cargo gate;
  `docs/build-attempt.txt` contains that actual output.

## Not performed

- Cargo dependency resolution or Cargo.lock generation.
- Rust compilation, Rustfmt, Clippy, or execution of ANY Rust test.
- Execution of the supplied GitHub Actions workflow.
- Real credential-file access, login, refresh, or a live OpenAI model request.
- Account/model capability verification for the Codex subscription endpoint.

There is no Rust toolchain in this environment. Outbound compiler retrieval is
blocked by unavailable DNS/download access. **Compiler or lint errors may remain.**
The source must not be presented as a tested release. No successful compile,
executed test count, benchmark, or live compatibility result is claimed.

## Test coverage written, not executed

The package contains **56 Rust test definitions**; platform-specific tests may be
conditionally compiled. The suite covers the existing auth/SSE cases plus:

- real loopback WebSocket handshake and same-socket two-request continuation;
- normalized provider events over WebSocket and SSE framing;
- ordinary function generation → local execution → call_id result submission;
- partial argument rejection and incomplete-response execution prevention;
- busy/control behavior and local cancellation during an active stream;
- dropped and never-polled event streams;
- slow-consumer backpressure with explicit terminal failure;
- idle timeout, disconnect without completion, and idle Ping/Pong handling;
- SSE native context replay, terminal EOF framing, and redirect refusal;
- unknown item preservation and advanced-feature fail-fast checks;
- independent non-OpenAI provider registration;
- allowlisted tools, duplicate call identities, argument validation, overflow,
  and in-memory result reuse without another execution.

## Required acceptance sequence on a development machine

```bash
cargo fmt --all
cargo test --all-targets
cargo clippy --all-targets
cargo build --all-targets
cargo run -- capabilities
cargo run -- auth-check --auth-source codex
```

The first five commands do not need provider credentials. The auth-check is local
only and does not verify entitlement. Resolve any compile/test failures before a
live request. Commit the generated Cargo.lock and formatted source. CI currently
normalizes formatting before checks; switch that step to `cargo fmt --check` once
the formatted baseline is committed.

Then use an exact model ID from your own Codex/Pi installation and execute the
three smoke tests in README: one text response, two linked responses, and the
`add_numbers` tool round trip. This consumes subscription allowance. Record only
sanitized status, tool/client versions, and non-secret identifiers. Never attach
auth.json, refresh/access tokens, or unrestricted native provider output.

Native steering/PTC/tool-search/async/hosted skills stay disabled regardless of
whether ordinary generation succeeds. Each requires separate implementation and
an account-specific compatibility test.
