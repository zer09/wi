# G1.1 local access and display safety

Contract **g1.1**, September29,2026. This resolves the authentication discussion without creating another identity system. Required behavior, not new security certification.

## Local operation

Normal same-machine use is `http://127.0.0.1:<configured-port>` or the configured literal IPv6 loopback origin. Start the existing `wi serve --config <absolute-file>` and open that origin. No certificate, TLS listener, proxy, public domain or deployment is required for this local workflow. Existing configuration already accepts literal-loopback HTTP; describe it as supported local operation, not merely an insecure-development exception.

Keep one existing shared owner bearer secret and its centralized server verification. Keep `client_token_file` provisioning and validation as implemented. Use the existing Connect field, clear it after reading, keep the secret only in page memory, and send it through the single authenticated fetch wrapper. Full page refresh clears the secret and requires Connect again. This explicit convenience cost is retained in this slice to avoid adding cookies, persistent browser secrets or an additional login lifecycle.

The prior tentative proposal to remove authorization was not adopted. Do not add an unauthenticated local API mode, startup flag or token bypass. Do not add automatic token printing/provisioning, URL tokens, fragment secrets, localStorage/sessionStorage/IndexedDB/cookies, per-device accounts, JWT, refresh tokens, registration or password support. There is no provider-credential exposure to the browser.

The security benefit is possession checking: another website does not automatically inherit a JavaScript-supplied bearer from the Wi page. This does not protect against malicious same-origin code, a privileged extension, or a same-user attacker who can read Wi's secret/database. Host/Origin checks, safe rendering and a private secret file remain separate controls. Unknown API names/ports are not access control. No claim that loopback HTTP encrypts traffic or isolates hostile native users on the host.

Remote/LAN access is NOT required or certified by G1.1. Do not open0.0.0.0, bypass actual-listener validation, add TLS machinery, or require local users to install a proxy. Existing remote HTTPS-proxy requirements remain conditional guidance for separately chosen remote access, not a prerequisite for a local browser. Provider HTTPS/WSS verification and managed OAuth behavior remain unchanged.

## Browser transport

Retain one fetch-based standard SSE decoder, already present and tested, because this slice retains the Authorization header. No second parser, custom EventSource credential tunnel, token URL or cookie bridge. The parser only handles framing/media/UTF-8; it does not decide run/tool/provider state. No automatic mutation retry. On read loss, explicit Reconnect latest obtains a new canonical display snapshot. Browsers must not use native EventSource's transport last-ID as proof of application state if the implementation is changed in a later contract.

## Request and data boundary

All old and new `/v1` reads/writes/streams/reconciliation remain protected by the existing bearer, exact Host/absolute-authority and Origin checks. Existing input/media/body/workspace protections remain. The public exception is only the exact compiled-in page/assets after Host/Origin validation. No directory server, dynamic HTML containing credentials, arbitrary file endpoint or SPA fallback.

Projection metadata and HTTP payloads must not serialize raw StoredEvent, RecordedRunInput, ModelResponse.native, provider binding, account digest, prepared instructions or internal tool definitions. Extract only explicitly allowed display scalars. The original task text and actual tool result can legitimately contain private user content; excluding internal credentials is not a claim that conversations are public.

Render every title, user/assistant/refusal/reasoning/tool string as text. Do not add innerHTML, Markdown HTML passthrough, eval, scriptable URLs, auto-loaded image/font/link resources, source maps, analytics, service workers or outbound content fetches. Projection rows store structured text, not executable HTML. Retain CSP/no-cache/no-sniff headers. Avoid recording tokens in Debug/logs/errors/URLs or test artifacts.

## Tests at the right layer

Test credential/Origin/Host failures through actual HTTP before sensitive work. Test parser splits and apply-before-cursor in deterministic JavaScript tests. Test real browser rebase, safe DOM and task ownership using synthetic credentials. Do not instrument Chromium globals/DevTools byte buffers to prove Window B. Read-time disconnection cannot send cancellation or release host/storage ownership.

Linux/macOS native gates remain. Windows native support stays withdrawn; Windows browser use is a separate client-platform question and not prohibited. macOS Cargo success does not establish a managed-auth port or live-provider support. No live credentials, auth commands, model requests, remote exposure or deployment are authorized by this plan.

References for mechanisms, not implementation evidence:
- https://fetch.spec.whatwg.org/
- https://html.spec.whatwg.org/multipage/server-sent-events.html
- https://cheatsheetseries.owasp.org/cheatsheets/Cross-Site_Request_Forgery_Prevention_Cheat_Sheet.html
- Existing source: src/http_api/boundary.rs, config.rs, files.rs, token.rs; inspect actual token module name through src/http_api/mod.rs before citing a path in evidence.
