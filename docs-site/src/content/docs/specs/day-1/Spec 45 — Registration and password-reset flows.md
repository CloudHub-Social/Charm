---
title: Charm 2.0 Spec — Registration and password-reset flows
type: spec
project: Charm 2.0
created: 2026-07-13
status: draft
---

**Workstream:** one PR / one agent (registration is the bulk; reset + SSO polish
can split out). Extends Spec 12 (first-run onboarding). **Highest-impact onboarding
gap in the audit.**

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
5. **Guest access / peek** (owner-added 2026-07-13, **very low priority, UI-only**).
   Absent in both clients today; owner wants a guest/peek path but scoped minimally:
   let a user browse/peek a room without a real account, and **disable every action
   that requires a real Matrix account** (send, react, join, upload, settings, etc.
   — render them absent/disabled, not failing). Effectively a read-only preview
   surface, not a full guest-account (`m.login.guest`) session unless trivial. Lowest
   priority item in this spec — do last or split into a follow-up.

## Non-goals

- Not guest access (absent in both — not a regression).
- Not multi-account (day-2 Spec 09).
- Not a visual redesign of the login screen — this adds the missing flows within
  the existing onboarding surface (Spec 12).

## High-level design

### Registration UIA

- Drive the `/register` UIA loop: call register, inspect the `flows`/`stages` the
  server returns, and present the right stage UI in sequence:
  - **Terms** (`m.login.terms`): show the policy links, require acceptance.
  - **reCAPTCHA** (`m.login.recaptcha`): render the captcha challenge (this needs a
    webview-embeddable captcha — confirm the mechanism; reCAPTCHA in a Tauri webview
    has CSP/domain considerations, flag as a risk to validate early).
  - **Email** (`m.login.email.identity`): request token, prompt for the emailed
    code / poll for verification, continue.
  - **Dummy** (`m.login.dummy`): auto-complete.
- Reuse Spec 20's structured UIA error type (`UiaCommandError`) — this is exactly
  the UIA-stage-vs-other-error distinction it was built for.
- On success, land in the same post-login/onboarding state as a normal login.

### Password reset

- "Forgot password?" entry on the login screen → email-identity token flow →
  set new password. Mirrors Charm 1.0's `reset-password` pages. Needs the
  homeserver's password-reset (`/account/password` + `/account/3pid/email/requestToken`)
  endpoints via IPC.

### Per-provider SSO

- Read the server's identity-provider list (already available from the login flows
  response) and render one button per provider with its name/icon, each initiating
  SSO for that specific provider — instead of the single generic button.

### Standalone token login (minor)

- Expose the existing `loginToken` handling as a standalone entry (paste/deep-link a
  login token) in addition to the SSO-callback path.

## Data flow

New/extended IPC: a registration command that returns the UIA state and accepts
stage responses (or a stateful register-session command), a password-reset
request/confirm pair, and exposure of the provider list to render per-provider
buttons. Most ride matrix-rust-sdk's auth APIs — confirm its registration-UIA and
password-reset surface before designing the command shape.

## API/contract changes

- Registration UIA command(s) returning stage state (reuse `UiaCommandError`
  patterns from Spec 20).
- `request_password_reset(email)` / `confirm_password_reset(token, new_password)`.
- Provider list surfaced to the login screen.
- Standalone token-login entry.

## Testing strategy

- Rust: registration against a dev Synapse configured to require terms + dummy
  (and, where feasible, email) completes end-to-end; password reset round-trips;
  provider list parses.
- Frontend: each UIA stage renders and advances; reset flow renders request +
  confirm; multiple providers render multiple buttons; single provider still works.
- Manual: **register a brand-new account on matrix.org** (or another server
  requiring reCAPTCHA + terms) — this is the acceptance test that proves the gap is
  actually closed, since it's the case that fails today.

## Trade-offs

- **reCAPTCHA in a webview is the real risk** — validate embeddability (CSP,
  allowed domains, callback) early; if a specific server's captcha can't be
  embedded, at minimum fail with a clear message rather than a silent registration
  failure. Flag before committing to the full flow.
- **Split reset/SSO out if registration UIA grows**: registration is the bulk and
  the priority; password-reset and per-provider SSO are independent and can be a
  second PR if needed.

## What I'd revisit as this grows

- Phone (`msisdn`) registration/verification stage if any target homeserver
  requires it (email is the common case; add msisdn only if needed).
