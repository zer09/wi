# Wi: naming and managed-auth matrix

Status: **experimental browser login PASS; renewal and broader live matrix deferred**.

At `2026-09-08T20:09:22Z`, one parent-run `wi auth login --experimental`
completed with exit 0. Wi persisted a new profile and reported it eligible.
A fresh `wi auth status` process confirmed logged_in=true and
requires_reauthentication=false. No generation or refresh request ran.

Final checks: **177 Rust tests, 152 runner tests, all six Cargo gates PASS**;
all three final reviews found no blockers. Generation ledger unchanged:
**17/40 used, 23 remaining**. Auth accounting is separate: one browser login,
one code exchange, no retry. The single-login increment is complete.

This proves this login configuration worked locally. It does not establish
stable provider support, model entitlement, renewal, or two-account acceptance.

## Current increment: one experimental login

The user now authorizes a minimal Pi-compatible browser login and one bounded
interactive attempt after offline checks and review. This supersedes the earlier
requirement for provider-confirmed configuration for this experiment only.
The shared public client registration is an undocumented compatibility choice,
not a claim of OpenAI approval. Wi must identify itself honestly. Provider denial,
account restrictions, and rate limits must not be bypassed.

Implement opt-in `wi auth login --experimental` with Pi's minimal browser flow:
fixed auth.openai.com endpoints, localhost:1455/auth/callback, PKCE S256 and state,
minimal identity/offline scopes, and Wi-owned credentials. Validate account hints
only from the fixed TLS token endpoint response; do not claim local JWT signature
verification. Preserve bounded/redacted exchange, secure persistence and session
binding. Do not copy Pi/Codex credentials, invoke their runtimes, kill listeners,
add device/manual-code fallback, connector scopes, or API-key exchange.

This increment is login only. Real renewal remains unavailable and documented;
no generation submission, account switching, or broader live matrix is authorized
by this increment. One interactive login attempt is authorized after review,
without retry. Use a new local profile without replacement. A failed attempt
stops and is diagnosed; successful login proves observed compatibility only.
Parent owns live execution and report updates. Delegates use synthetic data only.

## Previous offline baseline

The following baseline status predates the successful login above. Historical
statements that login was unavailable do not describe the current implementation.


Parent verification completed at `2026-09-08T15:25:22Z`: all six Cargo gates,
**163 Rust tests and 152 runner tests** passed. All three final reviews found
no blockers in the offline Linux scope. See section 8 for current evidence.

The previous pass approved offline implementation only. The current increment
above separately authorizes a bounded login and Wi-owned credential persistence;
prior offline evidence below remains historical. Implement and test the bounded auth mechanics with synthetic fixtures and
loopback endpoints. Keep production OAuth login/renewal unavailable with an
explicit configuration blocker until the permitted client configuration is
established. Do not hardcode another application's client identity to bypass
that blocker. This is a partial offline delivery boundary, not live acceptance.

The existing Pi/Codex source paths remain available but must not be exercised
against real credentials during development. Parent-owned verification reports
will distinguish implemented mechanics, observed tests, and remaining blockers.

This is the bounded follow-up to commit
`718c43afd2a0d826dccc85e7d1c50034139816e4`. The product is now named **Wi**,
inspired by Pi. The earlier gateway matrix is complete. Its live results remain historical.
The new profile/storage/renewal mechanics now have synthetic evidence, but real
Wi browser login and the managed-auth live matrix are not complete.

## 1. Decisions and scope

- Use **Wi** as the product name. The implementation target is Cargo package and
  library `wi`, with CLI binary `wi`. Rename references deliberately, not with a
  global replacement. Keep `Gateway` as an architectural term/type where useful.
- Keep provider ID `openai-codex` and the provider implementation under
  `src/providers/openai_codex/`. Do not rename the checkout directory, GitHub
  repository, historical commits, or historical evidence as part of this task.
- Implement native browser OAuth and credential ownership. Pi and Codex remain
  source references, not runtime dependencies or token donors.
- Store credentials in a private JSON file, not an OS keyring or database.
- Support multiple named account profiles for this provider from the start.
- Default to uniform random selection among eligible profiles when a new session
  opens. An explicit account selection takes precedence.
- Select **once per session**, before transport authentication. The session keeps
  that profile and provider account through text, continuation, refresh, and tools.
- Do not switch accounts within a session in this milestone. This is an explicit
  current boundary, not a claim that a future design cannot support switching.
- Automatic token renewal is intended functionality with explicit TODOs and tests,
  not an unspecified optional follow-up. Metadata/status reads remain non-refreshing.
- Keep the existing Pi/Codex credential readers explicit and read-only. Never
  automatically fall back to them or modify their files.

The current experiment uses the published Pi/Codex public-client configuration
with its undocumented support status recorded. It does not assert provider
permission or a stable API contract. A public client ID alone neither proves
permission nor establishes a ban. Do not spoof another application's headers to
bypass a restriction. Broader production acceptance and renewal remain deferred.

## 2. Minimal architecture

### Provider ownership

OpenAI-specific login, renewal, token interpretation, and profile selection live
under `src/providers/openai_codex/`. Generic CLI dispatch must not contain OpenAI
OAuth details. Preserve the compiled-in provider model; no dynamic plugin loader
or general-purpose authentication framework is needed.

A provider-local selection module, proposed as `profile_selection.rs`, exposes
one small selection boundary:

`profile metadata + optional explicit profile -> selected profile ID`

The initial policy is uniform random selection. Keep the policy separate from
storage, OAuth, and transport so later selection strategies can replace it.
Do not build speculative scoring, scheduling, or routing parameters now.

### Credential ownership and session binding

1. Read profile metadata.
2. Resolve an explicit profile, or choose randomly among eligible profiles.
3. Prepare fresh credentials for the selected profile through the auth manager.
4. Open the transport with those credentials.
5. Retain the selected profile ID and account identity for that session.

An eligible random candidate is enabled, has a stored OAuth login, and is not
already marked as requiring reauthentication. An expired access token does not
alone exclude a profile with refresh credentials. This is local metadata
selection, not a live quota or entitlement probe.

With no eligible profiles, return an actionable login/selection error. With one,
select that profile. An invalid explicit choice is an error, not permission to
choose another profile. Uniform random selection does not promise balanced usage
across a small number of sessions.

`CredentialSource::load()` must not choose profiles or perform token rotation.
It supplies credentials for the already selected profile. The auth manager owns
renewal and persistence separately. Status commands remain read-only and offline.

SSE repeatedly loads credentials, but always for the same selected profile and
account. A refresh can change its tokens, not its identity. WebSocket credentials
remain bound to the handshake; expiry still requires an explicit new session.
No transparent reconnect, continuation replay, or account substitution is added.
Deleting or replacing a selected profile must not cause an active session to
silently consume another account's credentials.

### File storage

Proposed defaults, honoring `XDG_CONFIG_HOME`:

- `~/.config/wi/config.toml`: non-secret settings, including any explicit defaults.
- `~/.config/wi/auth/openai-codex.json`: versioned collection of account profiles.

Each profile has a stable local identifier/name and its own account identity,
access token, refresh token, and expiry. Do not hardcode a profile count. Use the
WSL Linux home filesystem rather than a Windows-mounted directory for the
initial permission-checked implementation.

The file is plaintext. Processes with sufficient access can read it. Require
private directories and owner-only credential files (`0700`/`0600` on Linux),
symlink resistance, bounded parsing, locking, atomic replacement, and secret-safe
errors. If other platforms are implemented, use their actual permission controls;
do not claim Unix modes establish Windows protection. No silent keyring fallback.

Concurrent profile updates must preserve unrelated profiles. Refresh must reread
current state under its lock and persist rotated credentials safely. Request
cancellation must not silently discard a successfully rotated token. An ambiguous
exchange or failed persistence must fail closed rather than blindly replay a
refresh with an old token.

Separate local storage does not guarantee provider-side login/token families are
independent. Never copy refresh tokens from Pi, Codex, or another Wi profile.

## 3. CLI surface

These commands now parse. Production `auth login` and `auth refresh` return a
configuration blocker before credential reads or network activity. No production
command currently creates a login profile. Other profile operations are local;
synthetic tests establish their behavior. Existing generation arguments remain
applicable. Details: `docs/WI_AUTH.md`.

| Command or option | Behavior |
|---|---|
| `wi auth login --provider openai-codex --account personal` | Browser login into a named Wi profile |
| `wi auth login --provider openai-codex --account work` | Add another independently logged-in profile |
| `wi auth list --provider openai-codex` | List safe local profile metadata |
| `wi auth status --provider openai-codex --account personal` | Inspect local status without refreshing/network |
| `wi auth refresh --provider openai-codex --account personal` | Explicit renewal, also useful for diagnostics |
| `wi auth logout --provider openai-codex --account personal` | Remove only this Wi profile locally |
| `wi generate --auth-source gateway ...` | Select randomly once when opening the session |
| `wi generate --auth-source gateway --account work ...` | Select exactly `work` |

Keep `--auth-source gateway` as the source-kind term; it describes ownership, not
the former product name. Keep `pi` and `codex` as the explicit external sources.
If external-source arguments conflict with Wi profile selection, reject the
combination instead of ignoring the account choice. Report the selected local
profile name so the user can identify which profile the session uses. Never print
tokens or raw account claims.

Browser login uses authorization code with PKCE S256, random single-use state,
a temporary loopback listener, strict callback matching, and bounded deadlines.
The user signs in on OpenAI's website. Wi does not collect passwords or cookies.
No persistent web UI/server, device-code flow, or manual callback-paste fallback
is needed for this first version. Bind before opening the browser; report a port
conflict rather than terminating another application's listener.

## 4. Implementation and offline acceptance matrix

Every PASS below means observed **offline Linux evidence**, not real login or
account entitlement. Rows A1 and R2 explicitly retain their production blocker.

| ID | Requirement | Minimum acceptance evidence | Status |
|---|---|---|---|
| N1 | Wi naming | Package/library/binary, active docs, examples, scripts, and CI references agree. Client identification remains honest. Historical evidence and provider ID remain intact. | PASS offline |
| A1 | Browser login | Experimental fixed Pi-compatible browser integration is implemented. Synthetic security/persistence tests and one real login passed. Identity is derived from the fixed TLS token response, not arbitrary token input. Broader provider support remains undocumented. | PASS single experimental login |
| A2 | Protected file store | Permission/symlink/size checks; atomic-write failure preserves usable state or reports failure; concurrent updates preserve unrelated profiles; no ambient credential reads in tests. Rotation guards cover post-rename sync failure. | PASS offline |
| A3 | Multiple profiles | Add, list, inspect, and remove at least two synthetic profiles independently. Existing profile replacement requires explicit intent. No single-account assumption or cross-profile token copying. | PASS offline |
| P1 | Explicit selection | Exact requested profile is selected. Missing, disabled, or reauthentication-required selection reports an error without fallback. | PASS offline |
| P2 | Random default | Controlled randomness tests prove selection from eligible candidates only; empty, single, and multiple candidate cases pass. No flaky frequency benchmark. | PASS offline |
| P3 | Per-session binding | Selection runs once per open. WS continuation, SSE reloads, tool-result delivery, profile deletion/replacement cannot silently change account or login incarnation. No mutable default-selection config was added. | PASS offline |
| R1 | Safe renewal | Synthetic expiry, refresh rotation, concurrent attempts, stale updates, cancellation, account mismatch, invalid grant, and persistence failures pass before automatic renewal is enabled. | PASS offline |
| R2 | Automatic renewal | Separate preparation hook and auth manager pass synthetic renewal/binding tests. Status/load never refresh. WS expiry requires a new session. No generation retry/fallback. Production exchange is unavailable. | PARTIAL: synthetic PASS, production BLOCKED |
| C1 | Existing sources | Pi/Codex readers still work read-only with synthetic fixtures; no credential migration, mutation, automatic source fallback, or profile-argument ambiguity. | PASS offline |
| G1 | Final offline gate | All six Cargo gates, 177 Rust tests, 152 runner tests, and diff check passed in the parent final login run. Zero failed/ignored/filtered Rust tests; zero doctests. | PASS offline |

## 5. Bounded live acceptance matrix

Live login, renewal, and generation require separate authorization after the
applicable source/security/offline checks pass. This planning document does not
authorize real credential writes or provider traffic.

| ID | Case | Required evidence | Generation submissions | Status |
|---|---|---|---:|---|
| L0 | Login two named profiles | One experimental profile completed real login and fresh metadata status. A second independent account/profile has not been attempted. Existing Pi/Codex files remain untouched. | 0 | PARTIAL: one profile PASS |
| L1 | Explicit refresh | A selected profile renews and persists without changing identity or another profile. Do not dump or fingerprint tokens. Automatic expiry/rotation edge coverage remains synthetic unless separately observed. | 0 | NOT RUN |
| W1 | WS text, explicit profile A | Actual lifecycle, expected effective text, selected profile A, valid completed response. | 1 | NOT RUN |
| W2 | WS continuation, random profile | Record the selected local profile; both requests stay bound to it, reuse the same socket, and send the prior response ID plus new input only. | 2 | NOT RUN |
| W3 | WS tool round trip | One selected profile throughout; validated `add_numbers(17,25)`, one correlated execution/result delivery, and final `42`. | 2 | NOT RUN |
| S1 | SSE text, explicit profile B | Actual lifecycle, expected effective text, selected profile B, valid completed response. | 1 | NOT RUN |
| S2 | SSE continuation, random profile | Same selected profile across both requests and credential reloads; correct native history replay and remembered text. Opaque replay is conditional on actual emission. | 2 | NOT RUN |
| S3 | SSE tool round trip | One selected profile throughout; validated call, correlated local result delivery, correct native replay, and final `42`. | 2 | NOT RUN |

The generation cases reuse the existing matrix and synthetic prompts; extend the
existing smoke helper rather than creating another runner. Random distribution
is tested offline. Do not repeat live sessions until a particular random result
appears. Distinct explicit A/B cases establish that both profiles are usable.

Use the previously verified model unless the user explicitly selects another.
Stop an affected transport's dependent cases after failure. Do not retry,
fallback, query quotas, or switch accounts after 401/403/429 or an uncertain send.
This feature does not change any account's provider-imposed limits.

**Budget:** the user granted 20 additional generation submissions for this
follow-up. The cumulative assistant cap is now **40: 17 used, 23 remaining**.
The previous 17/20 ledger remains historical; no usage was reset. The proposed
10-submission generation matrix fits this budget and would leave 13 if all cases
complete with their planned counts. This is a cap, not a quota to consume.

The budget extension did not itself start implementation. The user subsequently
approved the offline pass; that pass is now verified and does not remove the
remaining production/auth authorization gates. Login and refresh are separate auth traffic and credential mutations,
not generation submissions; they still require authorization.

## 6. TODO checklist and stopping rule

- [x] Complete naming row N1.
- [x] Record the user's experimental Pi-compatible configuration choice; this is not provider approval.
- [x] Verify A1 synthetic mechanics, A2-A3 storage/profiles, and C1 external sources.
- [x] Complete A1 experimental browser integration and fixed-TLS-response identity handling; one real login passed.
- [ ] Establish broader supported-auth contract, if required beyond the experiment.
- [x] Implement and verify P1-P3: explicit/random selection and session binding.
- [x] Complete R1 fault/rotation/cancellation tests and synthetic R2 automatic preparation.
- [ ] Complete R2 production renewal after its OAuth contract is established.
- [x] Run and record final offline gate G1.
- [x] Obtain sufficient generation budget: user added 20; 23 remain.
- [ ] Obtain explicit authorization for live login and credential renewal.
- [ ] Execute the bounded live matrix, recording PASS/BLOCKED/NOT RUN honestly.
- [ ] Prepare the combined design-conversation report described below.

Stop when this matrix is satisfied or blocked. Do not add more selection policies,
usage-aware balancing, quota queries, cooldowns, automatic account failover,
mid-session switching, transparent reconnect/replay, background schedulers,
other providers, device login, a database, a keyring, or a web UI. Those require
separate design decisions. A bounded auth manager is not a general agent scheduler.

## 7. Pending combined report for the design conversation

**The previous report has not been sent.** The user is waiting for the design
conversation. Keep both milestones together in the next report, but separate
their evidence and implementation status.

### Completed and pushed work

- Commit: `718c43afd2a0d826dccc85e7d1c50034139816e4`, pushed to `origin/master`.
- Validated finalized-item recovery, lifecycle/tool validation and diagnostics,
  and bounded missing-Content-Type SSE admission.
- Previous six-case WebSocket/SSE live matrix PASS with explicitly selected
  external Codex OAuth and `gpt-6-astra` on local Linux.
- Previous offline evidence: 134 Rust tests and 152 runner tests passed; all six
  Cargo gates passed. These counts do not validate future edits.
- Previous live ledger: 17/20 assistant submissions used; manual user runs excluded.
- Limits: no live opaque reasoning replay observed; no new cross-platform CI
  result claimed in that report.
- Detailed evidence remains in `docs/LOCAL_VERIFICATION.md` and
  `docs/local-verification.json`. Preserve historical reports unchanged.

### Locally implemented offline follow-up

- Wi package/library/binary naming, private Linux JSON profile storage, multiple
  profiles, explicit or session-local random selection, and fixed session identity.
- Synthetic OAuth callback/exchange and cancellation-safe renewal mechanics.
- No account change within a session in this milestone.
- Latest login increment: 177 Rust tests and 152 runner tests passed; all three final reviews passed.
- Experimental browser login, fixed-TLS-response identity handling and guarded
  profile persistence are implemented. One real login and fresh status passed.
- Production renewal and the two-profile/full generation matrix remain deferred.
- No new commit or push: HEAD remains `718c43a`; changes are unstaged. Do not
  attribute this follow-up to that old commit. Add the actual new commit if the
  user later authorizes one.
- One browser login and code exchange completed without retry. No generation
  requests consumed; generation ledger remains 17/40 used, 23 remaining.
- The combined report is still pending delivery to the design conversation.

No report delivery, credential mutation, commit, push, or live request is
authorized merely by updating this matrix.

## 8. Offline implementation evidence

Checked at `2026-09-08T15:25:22Z` against an unstaged tree based on `718c43a`.

| Area | Evidence |
|---|---|
| Naming and version | `Cargo.toml`, Cargo.lock, active imports/docs/runner; `target/debug/wi --version` returned `wi 0.2.0` |
| Selection | `src/providers/openai_codex/profile_selection.rs`: deterministic explicit/eligibility/unbiased-sampling tests |
| File store | `managed_store_tests.rs`: permissions, absent/unsafe trees, symlinks/hardlinks, bounded writes and real synthetic child-process updates |
| Renewal/binding | `managed_auth.rs` tests: rotation, cancellation, failure phases, restart guards, profile incarnation, logout preservation |
| WS/SSE | `managed_loopback_tests.rs`: selection per open, same-socket continuation, same-profile SSE renewal and correlated tool delivery |
| OAuth mechanics only | `oauth_offline.rs` is test-only; two valid callbacks yield one exchange and persistence; other callback/PKCE/bounds cases remain synthetic |
| CLI absence | `tests/managed_absence_cli.rs`: isolated HOME/XDG fixtures; list/status/logout/selection create nothing; unsafe stores remain rejected |
| Parent final gate | `uv run scripts/verify.py` exit 0: 142 library + 16 CLI + 1 absence integration + 4 provider-contract tests = 163 passed |
| Runner | `node scripts/cli_retest.mjs --self-test`: 152 passed, live_started=false |
| Other checks | `git diff --check` passed; index empty; no new commit/push |

The static inventory counts 160 test definitions, not executions; it misses three
parameterized Tokio test attributes. Executed totals above are authoritative.
There are 41 Rust source/test/example files and 25 fixture events. No dependency
versions were upgraded; existing locked `ring` and Linux `rustix` gained direct
uses for secure randomness/PKCE and descriptor-relative filesystem protection.

Reviews confirmed and remediation corrected post-rename durability ambiguity,
missing two-valid-callback evidence, and first-run/list/logout absence errors.
A proposed async-runtime deadlock was not confirmed: session selection and auth
reads already run on blocking workers. Advisory lock waits can still be prolonged
by another process; no bounded lock-acquisition claim is made. Fault injection
proves control-flow handling, not physical power-loss behavior. Rotation guard
cleanup failure can conservatively require login after a committed rotation.

Managed persistence remains Linux-only. No new non-Linux/hosted CI or model
capability claim is made. The later login uses honest `wi` identification, but
renamed-client model transport has not been live-tested. The old six-case live
result belongs to the previous commit.

## 9. Experimental login result

Parent offline checks finished at `2026-09-08T20:08:41Z`: 156 library + 16 CLI +
1 absence integration + 4 provider-contract = 177 Rust tests; 152 runner tests;
43 Rust files, 170 regex-counted test definitions and 25 fixture events. Executed
test counts are authoritative. All six Cargo gates and diff check passed.

One invocation used a new alias without replacement:
`./target/debug/wi auth login --provider openai-codex --account wi-experiment --experimental`.
It printed static browser-waiting/completion messages, returned exit 0 and safe
metadata with persisted=true, eligible=true and an expiry. A fresh metadata-only
status command reported enabled=true, logged_in=true, requires_reauthentication=false.
No credential values, provider account IDs, raw URLs or token payloads were saved
in reports. Real tokens were handled only by the reviewed Wi process and its
private credential store. Existing Pi/Codex auth files were not read or modified.

Review remediation corrected unknown OAuth callback parameters, case-insensitive
Bearer type handling and an unsupported one-day expiry cap. Malformed callbacks,
recognized duplicates, state/issuer checks, bounds and expiry overflow checks
remain strict. All three repeated final reviews passed.

The L0 row still requires two separate profiles; this single login is partial
coverage of L0, not a two-profile PASS. L1 renewal and new W1-W3/S1-S3 remain
NOT RUN. No further live request is planned in this increment. Changes remain
unstaged; no new commit or push. Include this success in the pending combined
report, separately from historical commit `718c43a`.

