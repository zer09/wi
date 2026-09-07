# Implementation references

Reviewed for this source milestone on 2026-09-07. Repository source can evolve
independently of released documentation; no model/account access is inferred.

## OpenAI primary documentation

- WebSocket Responses framing and continuation:
  https://developers.openai.com/api/docs/guides/websocket-mode
- Ordinary function calls, argument schemas, and call_id-linked results:
  https://developers.openai.com/api/docs/guides/function-calling
- Codex authentication and file/keyring distinction:
  https://developers.openai.com/codex/auth
- Tool-search output items (reserved, not executed here):
  https://developers.openai.com/api/docs/guides/tools-tool-search
- Programmatic tools, caller/fingerprint metadata (reserved, not executed here):
  https://developers.openai.com/api/docs/guides/tools-programmatic-tool-calling

## Pi source: compatibility reference, not a runtime dependency

- Codex subscription adapter pinned to v0.85.1:
  https://github.com/earendil-works/pi/blob/v0.85.1/packages/ai/src/api/openai-codex-responses.ts
  Inspected cached WebSocket continuation and fixed store:false behavior. The
  inspected source file blob SHA was d7e3749f5831cc8a05a98fb7a7670ba697f9ecc6.
- WebSocket beta header confirmed in repository source:
  responses_websockets=2026-02-06
- Previously supplied 0.1.0 implementation provided the read-only auth parser and
  SSE framer used as the starting source. Those components were reviewed and
  retained; Unix file opening was hardened with O_NOFOLLOW.

## Rust library primary references

- Tokio-Tungstenite 0.28.0 connection API:
  https://docs.rs/tokio-tungstenite/0.28.0/tokio_tungstenite/fn.connect_async_with_config.html
- Reqwest 0.13.4 features and HTTP client options:
  https://docs.rs/crate/reqwest/0.13.4/source/Cargo.toml.orig
  https://docs.rs/reqwest/0.13.4/reqwest/struct.ClientBuilder.html
- Tungstenite configuration implementation:
  https://github.com/snapview/tungstenite-rs/blob/master/src/protocol/mod.rs

These references establish protocol/library design intent, not proof that this
source compiles or that the subscription endpoint accepts our requests. See
VERIFICATION.md for the separate evidence status.
