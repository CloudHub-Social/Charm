---
title: Charm 2.0 Spec — Registration and password-reset flows
type: spec
project: Charm 2.0
created: 2026-07-13
status: in-progress
---

## Implementation status

The first registration-UIA core slice is implemented for the Tauri transport
behind the default-off `registration_and_recovery` flag. It adds typed
`begin_registration`, `continue_registration`, and `cancel_registration`
commands; keeps the pending Matrix client, password, attempt lifetime, and
encrypted temporary-store key in Rust; selects the shortest incomplete
homeserver-advertised flow; supports direct terms/dummy completion; and exposes a
homeserver fallback URL for CAPTCHA and unknown stages. The direct email stage
generates and retains its client secret and Matrix validation session in Rust,
requests the homeserver email, accepts either a direct token or link-based
completion, and exposes neither credential to the frontend. The default-off
desktop UI renders policy links and terms acceptance, auto-completes dummy
stages, opens other stages in the homeserver fallback, supports cancellation,
and lands successful registration in the existing onboarding flow. The
continuation validates both the opaque Charm attempt ID and the next advertised
stage, while policy links are restricted to HTTP(S).

The web companion now implements the same registration and recovery surface.
Before a normal session exists, the server owns every pending Matrix client,
password, UIA session, client secret, email validation session, and cancellation
token. A separate opaque, HttpOnly, SameSite-strict pre-auth cookie binds each
attempt to one browser; a superseding flow cancels the previous attempt, and the
twenty-minute expiry covers both stored and in-flight work. Companion routes also
provide login-flow discovery and advertised one-time token login. The browser
never receives a Matrix access token, email `sid`, client secret, or crypto-store
credential.

This does not yet complete Spec 45. Real-homeserver verification remains open.
Repository and Playwright tests for DTO mapping, stage/session validation, direct
email-token submission, browser-owner isolation, cancellation, and UI navigation
are not live-homeserver evidence.

The login-choice slice now also discovers advertised password, token, and SSO
flows; renders one action per advertised identity provider; revalidates a
selected provider against a fresh homeserver response before building its SSO
redirect; and supports one-time token login only when the server advertises it.
Token values remain request-only and the desktop flow uses the same encrypted
temporary-store relocation as password and SSO login. The web companion supports
flow discovery and token login, while browser provider SSO and provider icon
resolution are explicitly split into
[issue #338](https://github.com/CloudHub-Social/Charm/issues/338) because the
server-owned callback needs an operator-configured public URL and a dedicated
redirect lifecycle. Live verification also remains open.

Desktop password recovery now generates its email-validation client secret in
Rust, retains the Matrix `sid` and unauthenticated client behind an opaque
twenty-minute attempt, supports both email-link and homeserver-hosted token
submission, and completes `/account/password` with `m.login.email.identity`.
Cancellation, expiry, and superseding requests cancel in-flight confirmation;
the challenge DTO exposes neither the `sid` nor client secret. A returned
submission URL may use the homeserver origin or a delegated identity-service
HTTPS origin. Charm resolves it once, rejects non-public delegated addresses,
pins the approved addresses, and disables redirects; explicitly configured
same-origin localhost or literal-IP development servers remain supported.
Request failures remain deliberately generic in the UI.

**Workstream:** three implementation PRs after this decision-ready spec update:
(1) registration UIA, (2) recovery + provider-aware SSO/token login, and
(3) real-homeserver verification and evidence. Extends Spec 12 (first-run
onboarding). **Highest-impact onboarding gap in the audit.**

## Problem & why now

Charm 2.0's login works, but account creation is effectively broken against real
homeservers. The parity audit (2026-07-13) found:

1. **Registration has no UIA stages.** Charm 2.0's `register`
   (`LoginScreen.tsx:121`) submits username/password only. Charm 1.0
   (`pages/auth/register/PasswordRegisterForm.tsx`) drives the full interactive-auth
   flow: terms acceptance (`AutoTermsStageDialog`), reCAPTCHA
   (`ReCaptchaStageDialog`), email verification (`EmailStageDialog`), dummy stage
   (`AutoDummyStageDialog`). **Any homeserver that requires those stages — including
   matrix.org — will reject Charm 2.0's registration.** So a new user cannot sign up
   on most real servers. This is the load-bearing gap.
2. **No forgot-password / reset flow.** Charm 1.0 has
   `pages/auth/reset-password/*` (email-token reset). Charm 2.0 has none (confirmed
   absent) — a user who forgets their password has no in-app recovery path.
3. **Single generic SSO button, no per-provider buttons.** Charm 1.0
   (`pages/auth/SSOLogin.tsx`) renders one button per identity provider ("Continue
   with {name}"). Charm 2.0 shows one generic "Continue with SSO"
   (`LoginScreen.tsx:271`), so on multi-IdP homeservers the user can't pick a
   provider.
4. **No standalone token login** (minor). Charm 1.0 has
   `pages/auth/login/TokenLogin.tsx`; Charm 2.0 handles `loginToken` only inside the
   SSO callback (`src-tauri/src/matrix/auth.rs`), not as a standalone entry.

## Non-goals

- Not guest access or room peeking. That read-only, session-boundary-heavy surface,
  including the ephemeral guest-token acquisition required for history previews,
  is now [day-2 Spec 14](/specs/day-2/spec-14--guest-room-previews/) rather than a
  contradictory low-priority item inside this daily-driver authentication spec.
- Not multi-account (day-2 Spec 09).
- Not a visual redesign of the login screen — this adds the missing flows within
  the existing onboarding surface (Spec 12).
- Not phone/MSISDN registration in this stage. Preserve unknown stages in the
  typed response and offer the homeserver fallback flow rather than pretending an
  unsupported stage completed.

## High-level design

### Registration UIA

- Replace the current one-shot `register` call with a typed two-command lifecycle:
  `begin_registration(request)` creates the temporary encrypted account store and
  makes the first `/register` request; `continue_registration(attempt_id, auth)`
  submits one stage response against the same homeserver UIA session. The attempt
  is owned by the active app/web session, expires on cancellation or timeout, and
  never exposes the Matrix client, access token, store key, or raw server response
  to TypeScript.
- Return a discriminated `RegistrationStep` DTO containing an opaque Charm attempt
  ID, completed stage names, viable ordered flows,
  sanitized stage parameters, and exactly one of `challenge` or `complete`.
  Passwords and CAPTCHA/email tokens are request-only fields and must not be
  persisted, logged, added to breadcrumbs, or echoed in errors.
- Select a viable server-advertised flow rather than assuming a single global stage
  order. Preserve `completed` across requests and present the next incomplete stage
  from the selected flow:
  - **Terms** (`m.login.terms`): show the policy links, require acceptance.
  - **CAPTCHA** (`m.login.recaptcha`): prefer the homeserver's UIA fallback page in
    the system browser or a tightly origin-checked popup/webview. An embedded
    surface can use the Matrix fallback completion callback; after a system-browser
    flow the user returns to Charm and Charm resubmits the existing session ID to
    observe completion. Do not inject a third-party CAPTCHA script into Charm's
    main application origin.
  - **Email** (`m.login.email.identity`): request token, prompt for the emailed
    code when `submit_url` is present, or poll/continue when the homeserver handles
    validation. Generate a random `client_secret` per attempt and retain it only in
    the Rust/server-side pending-attempt state. Bind the first normalized address
    to the attempt, cap resends, enforce per-source and keyed-hash-per-address
    quotas, and honor the homeserver's retry interval; changing the address starts
    a new admitted attempt rather than reusing the existing mail capability.
  - **Dummy** (`m.login.dummy`): auto-complete.
- Reuse Spec 20's structured UIA distinction, but do not force registration into
  the settings-only `UiaCommandError` retry shape: registration needs to return
  multiple viable flows, stage parameters, and a continuing attempt.
- Unknown or currently unsupported stages are not fatal to discovery. Return their
  type and a safe homeserver fallback URL when available; otherwise explain that
  this homeserver's registration requirements are unsupported.
- On success, land in the same post-login/onboarding state as a normal login.
- Cancellation, app exit, superseding login/registration, and timeout must release
  the pending client and clean its temporary store using Spec 15's existing
  reservation/sweep rules.
- The companion persists enough pending-store ownership metadata to sweep
  abandoned unauthenticated crypto-store directories on startup after a crash.
  Restart tests interrupt registration after store creation and verify that the
  orphan is removed before a new attempt is admitted.
- The companion admits at most one unauthenticated registration attempt per
  pre-auth browser session, enforces a process-wide cap before allocating a
  client/store, and applies per-source quotas. The hard expiry starts before
  client discovery and the first `/register` request, so a slow hostile
  homeserver cannot occupy every permit outside the cancellation lifecycle.
  Rejected and expired attempts leave no client, passphrase, or store directory.

### Password reset

- "Forgot password?" entry on the login screen → email-identity token flow →
  set new password. `request_password_reset` generates and retains a random
  `client_secret`, sends `/account/password/email/requestToken`, and returns an
  opaque reset attempt plus a sanitized submission mode; the homeserver `sid`
  remains bound to backend pending state.
  `confirm_password_reset` submits or observes validation and completes
  `/account/password` with the email identity auth data. Neither command requires
  an authenticated Matrix session.
- Reset attempts have an opaque cancellation command, a hard expiry that starts
  before discovery, per-session supersession, and a process-wide active-attempt
  cap. Cancellation, expiry, or abandonment releases the client secret, SID, and
  Matrix client; tests cover abandoned and quota-permitted attempt accumulation.
- Rate limits and deliberately ambiguous homeserver responses must remain generic
  in the UI so Charm does not become an account-enumeration oracle.
- The companion applies per-source and keyed-hash-per-address reset-mail quotas,
  caps resends for an attempt, and honors upstream retry intervals before sending
  another homeserver request. Raw email addresses never become quota-map keys,
  logs, metrics, or telemetry.
- Login discovery must distinguish classic Matrix authentication from delegated
  OIDC/MAS authentication. For delegated authentication, open the sanitized
  authorization-server account-management/recovery URL or report recovery as
  unsupported; never send the legacy `/account/password` flow to a delegated
  homeserver.
- For non-delegated homeservers, show the legacy password-reset action only when
  the current `LoginFlowSummary` advertises `m.login.password`. SSO-only and
  token-only homeservers report password recovery as unsupported.

### Per-provider SSO

- Add unauthenticated login-flow discovery and expose sanitized identity-provider
  entries (`id`, `name`, optional `brand`, and a resolved/safe icon URL). Render one
  button per provider and initiate `/login/sso/redirect/{idpId}` for that specific
  provider. Keep the generic SSO action only when the homeserver advertises SSO
  without an identity-provider list.
- Extend the existing desktop pending-SSO state and callback-state validation; the
  selected provider ID is untrusted input and must be chosen from the just-discovered
  response before it is included in a redirect URL.

### Standalone token login (minor)

- Reuse the existing `m.login.token` completion path as a standalone entry
  only when login-flow discovery advertises `m.login.token`. A paste entered
  directly into an already-open Charm form is explicit user intent. A deep-link
  token must additionally match a pending homeserver-specific Charm attempt and
  random state nonce, or present an explicit account-switch confirmation before
  exchange; never accept an unsolicited token-bearing link as an immediate login.
  Treat the token like a password: request-only, never logged, persisted, or
  included in telemetry.

### Platform boundary

| Surface | Desktop/mobile Tauri | Web companion |
|---|---|---|
| Registration UIA | Rust owns pending client + temp store | Companion session owns pending client + temp store |
| CAPTCHA/unknown fallback | System browser or origin-checked webview callback | Companion-owned redirect/callback route |
| Password reset | Rust request/confirm commands | Same-origin companion request/confirm routes |
| Provider SSO | Existing deep-link callback, extended with `idp_id` | Requires the server-owned redirect/callback design deferred by Spec 16 |
| Token login | Rust pending-login completion | Companion-owned pending-login completion |

Registration and recovery must ship on both transports. Provider SSO/token login
may land desktop-first, but Spec 45 cannot be marked shipped until the web
companion boundary is implemented or the remaining web gap is split into an
explicit follow-up spec rather than silently inheriting Spec 16's password-only
limitation.

## Data flow

The Tauri and companion implementations expose the same TypeScript DTOs while each
owns its pending Matrix clients and secrets on its trusted side of the transport.
Every continuation is keyed by an opaque, session-bound Charm attempt ID. UIA
session IDs, email `sid`s, and provider IDs are data, not authority: the backend
must bind them to the pending attempt rather than accepting arbitrary combinations
from the frontend.

matrix-sdk 0.18 already exposes the raw registration/UIA response used by Charm's
dummy-only flow. Prefer its typed requests where available; use Ruma request types
through `client.send` for missing password-reset or login-flow discovery helpers
instead of adding a second HTTP stack.

## API/contract changes

- `begin_registration(request) -> RegistrationStep`
- `request_registration_email(attempt_id, email) -> RegistrationEmailChallenge`
- `continue_registration(attempt_id, response) -> RegistrationStep`
- `cancel_registration(attempt_id) -> ()`
- `request_password_reset(homeserver, email) -> PasswordResetChallenge`
- `confirm_password_reset(attempt_id, token?, new_password) -> ()`
- `cancel_password_reset(attempt_id) -> ()`
- `get_login_flows(homeserver) -> LoginFlowSummary`
- `start_sso_login(homeserver, idp_id?) -> redirect_url`
- `begin_token_login(homeserver) -> { attempt_id, state }`
- `login_with_token(attempt_id, token, state?) -> LoginResponse` (the state is
  required for deep-link completion; direct paste uses the already-open attempt)
- `cancel_token_login(attempt_id) -> ()`

Token-login attempts are backend-owned resources with one active attempt per
browser/account flow, a hard expiry that starts before discovery or client
allocation, explicit cancellation and supersession, and the companion's
per-source/global unauthenticated admission limits. Completion consumes the
attempt exactly once; abandoned and flooded attempts are covered by repository
tests.

New UIA stages, recovery, provider selection, and standalone token-login entry
points use a matching Rust and TypeScript `registration_and_recovery` feature flag
defaulting to `false`. The existing legacy dummy registration and generic SSO
actions remain available while the flag is off, so a dark launch cannot regress
baseline authentication. Tauri commands enforce the same flag and fully validate
attempt and stage inputs when enabled; flags are rollout controls, not
authorization boundaries.

## Testing strategy

- Rust/companion repository tests: flow selection, session threading, terms/dummy/
  email/CAPTCHA continuation, unknown fallback, cancellation/timeout cleanup,
  superseding attempts, reset request/confirm, provider parsing, provider allowlist,
  token secrecy, and cross-account isolation.
- Frontend: each stage renders and advances; reset renders request + confirm;
  multiple providers render multiple buttons; generic SSO remains for a providerless
  response; unsupported stages and rate limits render safe actionable errors.
- Playwright: registration terms → CAPTCHA fallback → completion, password reset,
  provider selection, standalone token login, cancellation, and reload/supersession.
- Real Synapse: separate integration profiles requiring terms + dummy, email, and a
  mocked/test CAPTCHA fallback. Exercise both Tauri and companion transports.
- Live evidence: register a brand-new account on matrix.org (or another target
  server requiring comparable UIA), then verify login, onboarding, restart/session
  restore, and logout. Repository tests and local Synapse evidence must not be
  presented as this live result.

## Trade-offs

- **Fallback browser vs embedded CAPTCHA:** a homeserver fallback page avoids
  loading third-party active content into Charm's application origin, at the cost
  of a context switch and platform callback work. Security and interoperability
  win over a bespoke embedded CAPTCHA.
- **Stateful backend attempts:** pending clients and secrets require cleanup and
  replay protection, but keep credentials out of the compromised-frontend threat
  boundary and reuse Spec 15's store lifecycle.
- **Three PRs instead of one:** registration UIA is independently reviewable;
  recovery/SSO can reuse the resulting attempt patterns; live verification cannot
  be confused with mocked repository coverage.

## What I'd revisit as this grows

- Phone (`msisdn`) registration/verification stage if any target homeserver
  requires it (email is the common case; add msisdn only if needed).
- OAuth-native account creation as Charm adopts the Matrix 2.0 authentication API.

## Delivery slices

1. **Registration UIA:** shared DTOs, Tauri + companion begin/continue/cancel,
   terms/dummy/email/CAPTCHA fallback UI, cleanup, feature flag, tests, changeset,
   and gallery evidence.
2. **Recovery and login choices:** password reset, login-flow/IdP discovery,
   provider-aware SSO, standalone token login, and both transport boundaries.
3. **Real-homeserver evidence:** target Synapse profiles, desktop/web journeys,
   matrix.org/comparable live verification, and final spec/roadmap reconciliation.

## Protocol references

- [Matrix Client-Server API: account registration](https://spec.matrix.org/latest/client-server-api/#account-registration)
- [Matrix Client-Server API: User-Interactive Authentication](https://spec.matrix.org/latest/client-server-api/#user-interactive-authentication-api)
- [Matrix Client-Server API: password management](https://spec.matrix.org/latest/client-server-api/#password-management)
- [Matrix Client-Server API: SSO client login](https://spec.matrix.org/latest/client-server-api/#sso-client-loginauthentication)
