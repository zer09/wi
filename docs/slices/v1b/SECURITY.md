# V1-B security and deployment boundary

Contract **v1b.0**. Implemented locally in the uncommitted worktree; **LOCAL_VERIFIED,
accepted=false**. [Verification](VERIFICATION.md) separates local evidence, remaining
subcases, pending final review and unrun hosted CI. These application-service choices
do not redesign provider OAuth or claim completed security certification.

## 1. Principal and deployment

This first network service has one owner. Possession of a separately provisioned Wi-service bearer secret authorizes that owner's API operations and all their session history. Multiple devices may use it. There are no independent tenants, user database, role matrix, per-device credentials, browser login page, refresh tokens, cookies, password hashing, JWT or OAuth service in this slice.

The server listens only on a literal loopback IP. For remote browsers/devices, a separately configured HTTPS reverse proxy on the same host is the public entry point; its upstream is the loopback listener. It must terminate valid TLS, preserve Authorization without logging it, stream SSE without response buffering, and either preserve the configured public Host or rewrite to the exact actual loopback listener authority. The trusted proxy and host OS are part of the deployment boundary. This slice provides proxy requirements, not a deployed/certified proxy or native TLS implementation.

Configure the proxy for the exact `public_origin` in [API.md](API.md#0-starting-the-service).
Preserve the browser's Origin and allow Authorization, Content-Type and Last-Event-ID.
Do not convert a forwarded identity header into authentication. Disable SSE response
buffering and caching; flush frames as they arrive. Check proxy idle/stream timeouts
separately. A proxy timeout can disconnect an observer but must not be interpreted as
task cancellation or completion. No proxy product/configuration or remote-device
browser has been validated by this local evidence.

Native EventSource cannot set the bearer header. Browser consumers need authenticated
fetch plus an SSE parser and reconnect logic. Reconnect after the last applied cursor,
not the last received byte. Lost acknowledgments can replay records; deduplicate by
session/sequence and detect conflicting duplicates. JSON/SSE preserves visible text,
including control characters; a future GUI must render it as untrusted text, not HTML.

Plain HTTP is allowed only for explicit literal-loopback local development. Never provide an insecure public-bind switch or recommend sending the secret over a LAN in cleartext. Checking the configured HTTPS public origin cannot prove a proxy actually uses TLS: document that limit. Provider TLS validation and fixed subscription endpoints remain unchanged. A non-loopback TcpListener passed to the library is rejected before serving too.

## 2. Secret provisioning and verification

The owner provisions 32 cryptographically random bytes encoded as 64 lowercase hexadecimal ASCII characters in a private file. Accept exactly 64 characters plus at most one final LF (not CRLF, BOM, spaces, extra lines or arbitrary passwords). The binary accepts a token FILE path, never a raw token flag/environment/query value. No automatic credential creation, token-printing command or browser token persistence is added. The deployment guide describes provisioning without inserting a real secret in documentation or shell history.

For Unix, this operator-only example creates a new file in a trusted private directory.
It generates the secret inside the process and writes it directly to the file. The
command contains no secret and prints none. `O_EXCL` refuses to overwrite an existing
file. Replace only the placeholder paths; do not run this as an acceptance test.

```sh
install -d -m 700 /absolute/private
uv run --no-project python -c 'import os, secrets, sys; fd = os.open(sys.argv[1], os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600); f = os.fdopen(fd, "w", encoding="ascii"); f.write(secrets.token_hex(32) + "\n"); f.close()' /absolute/private/wi-owner-token
```

Keep the file and its parent private. Transfer the token only through a separately
trusted confidential channel to authorized clients. Never print it for a report,
put it in `curl -H` shell arguments, save it in browser URLs, or log request headers.
No browser token-storage mechanism is supplied. On Windows, provision the same byte
format using a trusted local secret generator and owner-only ACLs; this Unix recipe
and Linux results are not Windows ACL/reparse execution evidence.

Load once at startup with a bounded read of at most 66 bytes so oversized files are detected. Require a regular file; reject final symlinks/reparse points and special files before reading. On Unix require no group/other permission bits, using the same style of safe open as existing local sources. On Windows reject reparse points and state that root/file ACL protection is operator-owned. Do not claim protection against a hostile same-user process, hardlinks, ancestor replacement or memory inspection. Keep all verifier/config secret types redacted and not serializable.

Use existing ring::hmac for constant-time token verification: generate an ephemeral HMAC_SHA256 key via ring SystemRandom, retain its tag over the expected canonical ASCII secret, and use hmac::verify for candidates of the valid fixed format. Zeroize the temporary expected-token buffer after verifier construction. This verifier/tag/key is process-private and is never written into SQLite, logs or responses. No production OAuth token, profile alias or account marker is reused as the API credential. Do not change B2's account identity derivation.

The secret stays valid until the operator changes the file and restarts the service; the process does not hot-reload it. This revokes all devices at once, not a single device. Lack of expiration/device revocation is an explicit first-slice limitation, not a recommended general-purpose Internet identity service. Restart continues to stop tasks under the existing owner policy. A future interactive/device-auth design is separate.

## 3. Request boundary and CORS

Use only one Authorization header, in the form Bearer plus one space plus the canonical 64-character token. HTTP authentication scheme comparison may be ASCII case-insensitive; token matching is exact. Reject duplicate/combined/malformed headers. Mark the value sensitive in framework headers where supported. Missing/invalid token returns the same static401 and WWW-Authenticate:Bearer. No alternative cookie, query parameter, proxy-user header or body credential is recognized.

Before protected handlers, validate exactly one Host authority against either (a) the configured public origin's authority or (b) the actual loopback listener authority. Normalize through a parsed authority, including IPv6 brackets and default ports; reject credentials, ambiguous/comma forms, mismatched explicit ports and invalid/missing hosts. If HTTP absolute-form URI authority is supplied, it must agree with Host and be allowed. Forwarded/X-Forwarded-* headers are not authentication or authority sources.

An Origin header, when present, must be exactly one valid serialized origin matching configured public_origin after URL-origin normalization. Reject null, multiple, malformed and foreign origins, including requests with a valid token. Absence of Origin is permitted with valid bearer authentication for native clients and same-origin requests that omit it; never treat absence as authenticated. Comparing request Origin does not prove ownership or replace token validation. Do not use suffix/substring hostname matching.

For allowed-origin requests, emit Access-Control-Allow-Origin with that specific origin, Vary:Origin, and no Allow-Credentials. Do not use wildcard CORS. A preflight OPTIONS request may be answered without a bearer ONLY after authority/origin checks and only for an actual documented route, GET/POST and the fixed requested-header subset Authorization, Content-Type, Last-Event-ID (case-insensitive). Do not echo arbitrary headers/methods. No storage, preparation, provider or tool work occurs on preflight. Disallowed preflight cannot fall through to a handler. Authentication/authority checks precede protected body collection and all session opens, including lazy migration/interruption.

No GET mutation endpoints besides the existing explicit-open storage maintenance, no token URLs, no auth cookies and no body-as-form fallback. This avoids ambient-cookie CSRF in this slice; it is not a claim of immunity to token theft, XSS or malicious browser extensions. The future GUI must use text-safe rendering and protect its token. API JSON is not HTML and SSE data must be encoded, not interpolated.

## 4. Workspace and tool authority

Only configured canonical absolute workspace paths may be new create targets or sources for new context preparation. Reject an unapproved path before any stat/canonicalize/discover/read of that caller path; membership is a pure lookup first. Only then recheck the configured path's canonical identity and call existing S1 discovery. A recorded historical workspace does not grant current execution authority. Historical reads, receipts, rename and cancellation remain accessible even when a workspace has been retired. A matching accepted task is returned before new workspace checks and never executes again.

No API endpoint reads arbitrary files, uploads skills, chooses a global skill root, registers tools, selects a provider endpoint or changes auth profiles. Server-selected existing AddNumbers and automatic main-SKILL.md loading are the only supplied tool behavior. Tool text, project AGENTS.md and skill frontmatter cannot change server authorization. The accepted same-user/TOCTOU limits of local context sources remain; this API is not a filesystem/process sandbox.

## 5. Data, logs and failures

Do not serialize internal StoredEvent/RunResult/native objects directly to the browser. API.md has the closed projection. Provider binding hashes, original encrypted/signed objects, headers, private config roots and prepared instructions stay internal. Authorized prompts, visible model text, names, relative skill labels, workspace selectors and actual tool-result strings intentionally remain conversation data and may themselves contain sensitive content. Do not claim content scanning removes secrets volunteered by a user/tool.

No request/response/body/header tracing middleware, default Debug of requests/config, panic-payload forwarding, SQL error details or failed-JSON excerpts. Ordinary process notices contain only static categories, counters and the actual listening address. Error codes are allowlisted; source chains are not exported. Disable caching of API responses. Unknown native extension content becomes a checkpoint/unsupported-content marker, never a raw JSON escape hatch.

Input-body and page-window bounds are transport/read protections, not global execution budgets. Do not add limits on tasks per session, model calls, tool calls, task duration, history lifetime, idle sessions or retained conversations. This first service does not claim DDoS resistance, fairness under unlimited authenticated clients, constant RSS or native Internet-edge hardening. The operator controls network exposure and the trusted same-host proxy; dependency/runtime transport safeguards remain in force.

## 6. Verification and references

Use synthetic secrets with separate secret canaries in headers, file paths, native/opaque fields, preparation snapshots and private provider identities. Inspect unauthorized responses, errors, SSE framing, all DTO JSON and captured normal logs; intended user/tool text is tested separately. Real device authentication, provider login, live generation, public deployment, physical power loss and penetration-test certification are not authorized.

Source references checked for planning on 2026-09-19:
- https://www.rfc-editor.org/rfc/rfc6750.html — bearer header and confidentiality requirements; Wi's provisioned secret is not an OAuth issuance implementation.
- https://html.spec.whatwg.org/multipage/server-sent-events.html — framing, event IDs and Last-Event-ID; EventSource constructor does not offer arbitrary headers.
- https://docs.rs/ring/0.17.14/ring/hmac/fn.verify.html — constant-time HMAC verification.
- https://docs.rs/axum/0.8.9/axum/serve/struct.Serve.html — serving/graceful shutdown facility, not an application-task owner.

Those planning references are not implementation proof. The [local report](VERIFICATION.md)
and [machine report](verification.json) record actual and attributed observations,
preserve failed attempts, and identify unobserved subcases. Local loopback success is
not public deployment, penetration-test certification, live provider approval or
cross-platform execution evidence. Native Windows reparse/ACL and Ctrl+C behavior,
and native macOS behavior, remain unverified in this Linux worktree.
