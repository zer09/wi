# Fresh local implementor entry: V1-B

Implement Wi contract **v1b.0**. Accepted baseline:
`16d623a3317abc7796ec203e4fe15d580791a769`.

Read AGENTS.md and docs/slices/v1b/CONTRACT.md, API.md, SECURITY.md,
MATRIX.md, VALIDATION.md and this prompt. Read mapped current source and
V1-A reports as needed. P1-B2 and V1-A are accepted and merged; do not
execute historical milestone prompts or reimplement those foundations.

Inspect actual HEAD/ancestry and every staged, unstaged and untracked file.
Preserve owner changes. Do not reset, clean, force-checkout or stash work
unsolicited. The architecture and matrix are fixed: acknowledge scope,
then implement, verify, obtain independent complete-diff review and report.
Do not return another architecture plan or stop after planning.

Deliver wi::http_api plus thin wi serve --config, using only the approved
minimal Axum addition and existing libraries. Implement authenticated HTTP
commands, explicit workspace selection, safe DTOs, qualified cursors and
committed-history SSE. Devices use a separately provisioned shared Wi-service
bearer secret, not provider OAuth. Loopback HTTP plus documented same-host
HTTPS proxy is this slice's deployment model. No public cleartext switch.

Use actual RunHost -> run_in_session -> SQLite -> existing provider/tools.
Return202 only for actual durable acceptance, never dispatch admission.
HTTP/SSE/client/ticket loss does not cancel work. Explicit cancel addresses
session and run. Follow receipt-first raw command validation and one read-only
reconciliation after a race/failure; no second dispatch, new IDs, B1/arbitrary
receipt adoption, current-source reread on accepted retry, or rollback fiction.
New tasks use actual S1/S2 preparation off the async worker and its paired registry.

Do not serialize internal storage/native/binding/RunCompletion objects directly.
Preserve actual user/model/tool content and error flags through the closed views;
private metadata becomes checkpoints. Final snapshots replace provisional content.
Fixed-head pages and later canonical polling must have no gap and no SQLite lock
held during slow client writes. Page windows are not history-lifetime limits.

Owner shutdown stops admission and network waiters, initiates existing host
cancellation/drain, and observes real storage close and ShutdownOutcome. Private
cancellation-aware socket IO is allowed as specified; do not abort core execution
or owned SQL. No shutdown/task deadline, manual quarantine release, or false claim
that dropping an unawaited owner future proves completion. Restart performs no
automatic model/tool work; only a new explicit task invokes B2.

Complete V1B-00 through V1B-39 with actual evidence. Mandatory joined tests traverse
real HTTP/auth/preparation -> RunHost -> B2 -> SQLite -> OpenAI loopback -> real tools,
for WS/SSE, native/recovered/MIME variants, identity guard, lost response/reconnect,
commit/shutdown races and S2 source deletion. Separate component tests do not substitute.
Run all specified old/new gates, examples and finite measurements; obtain three fresh
final independent complete-diff reviews including untracked files. Preserve initial
failures and every CI attempt. Same-SHA green reruns do not prove old timing issues fixed.

Create docs/slices/v1b/VERIFICATION.md and verification.json. Map all40 rows to actual
assertions/tests/commands/observers. Separate unique passes, source definitions,
ignored children, examples, reruns and zero doctests. Keep source/local/CI/live and
security/deployment claims distinct. Update current-facing docs only; frozen reports
and matrices remain historical records.

Preserve core public APIs, sessionDB2/catalog1/stored1/runtime2/provider1, existing
error mapping, auth/provider behavior and C1 full RunLimits removal. No replacement
budgets, call/task deadlines, lifetime caps, deletion, retries/failover/resumption,
hosted skills/billing, new tools/providers/schema/store, GUI, native TLS, per-device
login, search/import/compaction or unrelated reorganization.

Use synthetic temporary roots, skills, token files/provider credentials and loopback
or scripted providers only. No real credentials/private skills, auth/profile commands,
provider generations, deployment or release. Ledger remains31/50 used,19 remaining.
Normal dependency-cache fetching is development work, not live acceptance.

Report a genuine contract conflict with exact producer/consumer evidence before
changing scope. Leave implementation uncommitted for owner review. No commit, push,
merge, release, deployment or later milestone without separate authorization.
After authorized push report exact-head all-platform CI, including failed attempts.
