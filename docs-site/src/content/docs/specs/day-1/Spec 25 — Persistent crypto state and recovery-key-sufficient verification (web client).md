---
title: Spec 25 — Persistent crypto state and recovery-key-sufficient
  verification (web client)
type: spec
project: Charm 2.0
created: 2026-07-10
status: draft
sidebar:
  label: "Persistent crypto state & recovery"
---

## Status
Draft — high priority, no hard deadline. Written 2026-07-10 from the user's own testing.

**Cross-reference:** **PR #149** ("Implement recovery-key restore (Matrix key backup / 4S)") **merged 2026-07-10 but does not resolve this spec's problem.** Confirmed by re-reading the current repo state: `crates/charm-web-server/src/persistence.rs:37-42` still carries the identical "Known gap: the Olm/Megolm crypto store is not persisted" doc comment, byte-for-byte unchanged. #149 added a manual, on-demand recovery-key restore flow (`recovery_status_impl`/`recover_from_key_impl` in `src-tauri/src/matrix/verification.rs:215-256`, exposed via `GET`/`POST /api/verification/recovery` and a "Recovery" card in Settings) — but it deliberately did not add server-side persistence of the crypto store itself, citing DO App Platform's Web Service tier having no persistent volume. So the underlying bug is unchanged: **every `charm-web-server` restart / page context loss still wipes Olm/Megolm state**, and the user must manually re-paste their recovery key each time — #149 just turned that into a supported UI flow instead of a dead end. This spec's Phase 1 (P0 #1/#2/#5/#6, actual crypto-store persistence) is therefore still fully open, not superseded by #149.

Also confirmed: `recover_from_key_impl` never calls `device.verify()` (verification.rs:244-256) — the only place `.verify()` is called is `bootstrap_cross_signing_impl` (verification.rs:125-138), which is the separate self-verification-during-bootstrap path, not the recovery-key path. So this spec's Phase 2 (recovery-key-alone should mark the device verified) is also still fully open — #149 didn't touch it.

Also cross-reference: issue #143 (closed 2026-07-10) confirmed that `DeviceRow.tsx` hiding "Verify" for the current device is correct, working-as-intended behavior — a related but distinct UI fix already shipped (PR #167, 2026-07-10, hides the entire actions menu — not just the Verify item — for the current device row, since every other item was already gated the same way).

## Problem Statement

On the Charm web client, entering the 4S recovery key and completing device
verification successfully decrypts messages — but neither survives a page
refresh. The user is dropped back into the recovery-key prompt, the device
re-reports as unverified, and other signed-in devices can no longer
re-verify it, leaving the account in a stuck state recoverable only by a
full logout/login cycle. Every session restart forces the user to redo
onboarding from scratch.

**This is still true as of 2026-07-10 after PR #149 merged** — see the Status
section above. #149 added a way to *manually* recover via recovery key
on-demand, which is an improvement (previously there may not have even been
a supported UI path), but it does not make the crypto state survive a
restart, so the re-entry-every-time behavior described here is unchanged.

Root cause (confirmed in code, still current): `charm-web-server` persists only the Matrix
access/refresh token across a restart (`crates/charm-web-server/src/persistence.rs:37-42`).
The Olm/Megolm crypto store (room keys, cross-signing identity, device trust)
lives only in the in-memory `matrix-sdk` `Client` and is rebuilt from
scratch on every restart. Charm's desktop/Tauri client is unaffected: it backs the same
crypto store with a persistent SQLCipher-encrypted SQLite database
(`src-tauri/src/matrix/persistence.rs`) that survives restarts today.

Separately, current verification logic requires **both** recovery-key
recovery and interactive device-to-device (SAS) verification before a
session is treated as trusted: `recovery().recover(recovery_key)` restores
4S secrets but never calls `device.verify()`
(`src-tauri/src/matrix/verification.rs:244-256` — confirmed unchanged by #149); the frontend's
`isVerified` gate additionally requires `DeviceSummary.is_verified`, set
only via the separate SAS/cross-signing bootstrap flow
(`src/components/OnboardingScreen.tsx:44-50`). This
matches the Matrix spec's *mechanics* (recovery key and device verification
are technically separate operations) but not most clients' *UX*, where
successfully recovering via the 4S recovery key is sufficient on its own to
mark a session fully trusted, with device-to-device SAS verification offered
as an optional additional step rather than a hard requirement.

Together, these two issues mean the web client is currently unusable for
any user who refreshes the page — which for a browser tab is not an edge
case, it is the common path.

## Goals

1. Crypto state (room keys, cross-signing identity, device trust) persists
   across a web-client session restart/page-refresh with no user action
   required — parity with desktop's current behavior.
2. Entering a valid 4S recovery key is sufficient, on its own, to mark a web
   session's device as fully verified/trusted — no separate SAS/device
   verification step required to reach a working, decrypting state.
3. A device that has recovered via recovery key is recognized as verified
   by other signed-in devices on the account (cross-signing propagates
   correctly), eliminating the "other devices can't re-verify it" stuck
   state.
4. Zero increase in how long decrypted room history / key backup material
   is recoverable by anyone other than the account owner, relative to
   today's desktop-client threat model.
5. Reduce "recovery key entry" occurrences per web session to 1 (first
   login only) for the common case of a user returning within their
   session's normal token lifetime — down from "every refresh."

## Non-Goals

- **Changing desktop/Tauri client behavior.** It already persists crypto
  state correctly; this spec only touches `charm-web-server`.
- **Removing SAS/device-to-device verification entirely.** It remains
  available as an optional, user-initiated way to establish trust between
  two specific devices (e.g. for a paranoid user who doesn't want to rely
  on the recovery key alone) — it is downgraded from required to optional
  for reaching a "verified" state, not deleted.
- **Redesigning the recovery-key UX/UI itself** (entry screen, key
  generation, rotation flows) — #149 already shipped a "Recovery" card in
  Settings and the manual-restore flow; out of scope to redesign that UI
  unless a specific defect surfaces during implementation.
- **Browser-storage-based (IndexedDB/WASM-in-browser) crypto persistence.**
  `charm-web-server` is a native server process (`crates/charm-web-server/src/main.rs`),
  not a WASM-in-browser client — there is no browser storage to persist
  into. Persistence must be server-side.
- **Multi-instance/horizontally-scaled crypto-store consistency.** If
  `charm-web-server` ever runs more than one instance against the same
  account concurrently, keeping two olm/megolm stores consistent is a
  separate, harder problem; this spec assumes single-instance-per-deploy,
  matching the current session-token persistence design.

## User Stories

- As a web-client user, I want my decrypted message history and device
  trust to survive a page refresh so that I don't have to re-enter my
  recovery key every time I reload the tab.
- As a web-client user, I want entering my recovery key to be enough to
  fully trust my session so that I'm not blocked on a second, separate
  verification step just to read my messages.
- As a user with multiple devices, I want a web session that recovered via
  recovery key to show as verified on my other devices so that I'm never
  stuck unable to re-establish trust without logging out everywhere.
- As a user who wants extra assurance, I want the option to additionally
  SAS-verify my web session against another device, even though it's no
  longer required to unlock functionality.
- As the operator of a `charm-web-server` deployment, I want crypto state
  encrypted at rest using the same key-management model already in place
  for session tokens, so I'm not introducing a new secrets-management
  surface for this fix.

## Requirements

### Must-Have (P0)

1. **Persist the Olm/Megolm crypto store per web session**, keyed the same
   way as `media_cache`/existing session persistence
   (`charm_lib::matrix::persistence::account_key`), using a per-account
   encrypted `matrix-sdk-sqlite` store directory rather than the current
   bare in-memory `Client`.
   - Acceptance: after a `charm-web-server` process restart, a
     previously-recovered session's `Client` is rebuilt against its
     existing crypto store (not a fresh one) and can decrypt
     previously-readable room history without re-entering the recovery
     key.
   - **Not covered by #149** — confirmed still fully open. #149's author
     explicitly chose the manual-recovery-flow route over this, citing DO
     App Platform's Web Service tier having no persistent volume (relevant
     to Open Question 1 below — the existing session-token persistence
     already solved a similar "no persistent volume" constraint via DO
     Spaces object storage; the same approach likely applies here).
2. **Encrypt the persisted crypto store at rest**, consistent with the
   existing `CHARM_WEB_SERVER_MASTER_KEY`-derived encryption model in
   `persistence.rs` (or an equivalent per-store key derived from it) — no
   plaintext olm/megolm secrets on disk or in the object-store backend.
   - Acceptance: inspecting the raw persisted store (local disk or DO
     Spaces object) with the wrong master key yields no recoverable crypto
     material, mirroring the existing `wrong_key_cannot_decrypt_*` test
     pattern for session tokens.
3. **Recovering via a valid 4S recovery key alone marks the device
   verified/trusted**, without a separate device-to-device SAS step.
   - Acceptance: after `recovery().recover(recovery_key)` succeeds, the
     session's own device reports `is_verified: true` and the frontend's
     "verified" gate (`OnboardingScreen.tsx`-equivalent check) passes
     without requiring `bootstrap_cross_signing`/SAS to also complete.
   - **Not covered by #149** — confirmed `recover_from_key_impl` never
     calls `device.verify()`.
4. **Cross-signing trust propagates to other devices** after recovery-key-only
   recovery, so other signed-in devices on the account see the recovered
   web session as verified/trusted and are not blocked from any
   cross-signing-dependent action toward it.
   - Acceptance: from a second (e.g. desktop) device already signed in,
     the recovered web session appears verified in the device list with no
     additional action required on the second device's part.
5. **Startup restore is resilient to a corrupt/unreadable crypto store**,
   matching the existing fail-open pattern for session-token restore
   (`restore_one`/`restore_all` drop-and-log rather than block startup or
   the whole account). A session whose crypto store can't be restored
   falls back to requiring recovery-key re-entry for that one session —
   never a hard failure that blocks that user's login entirely, and never
   affects any other session's restore.
6. **No regression in existing session-token persistence behavior** —
   token restore, idle-eviction restore-by-token, and the "opt-in via
   `CHARM_WEB_SERVER_MASTER_KEY`" fallback to fully-in-memory (dev/test)
   behavior all continue to work unchanged when only crypto-store
   persistence is added.

### Nice-to-Have (P1)

7. Surface, in the frontend, an explicit (optional, dismissible) prompt to
   additionally SAS-verify a recovery-key-only session against another
   device, for users who want stronger per-device assurance — replacing
   the current hard requirement with an opt-in offer.
8. Metrics/logging on crypto-store restore success/failure rate at startup,
   so a rollout regression (e.g. a store-format bug) is visible operationally
   rather than only reported anecdotally by users.
9. A migration/backfill path for currently-live sessions that only have a
   persisted token (no crypto store yet) — on their next restore, treat
   them as "no crypto store found" (falls back to requirement 5's existing
   fail-open path: prompt recovery key once) rather than as an error.

### Future Considerations (P2)

10. Extend persisted per-session crypto-store storage to support the
    eventual multi-instance deployment case (Non-Goals), e.g. via a
    lock/lease scheme or moving the store to a shared database backend
    instead of per-instance-local `matrix-sdk-sqlite` files.
11. Revisit whether SAS/device-to-device verification should be surfaced
    more prominently as a security-hardening feature (P1 item 7) once
    usage data exists on how many users opt into it voluntarily.

## Success Metrics

**Leading indicators**
- Recovery-key entry events per unique web session per day: target drop
  from current baseline (effectively 1 per refresh) to ≤1 per session
  lifetime for returning users within token lifetime, within 2 weeks of
  rollout.
- Rate of "device shows unverified after recovery" support reports /
  self-reports: target zero within 2 weeks of rollout (current baseline:
  the reported bug itself).
- Crypto-store restore failure rate on `charm-web-server` restart: track
  as a new metric (requirement 8); target under 1% of restorable sessions once
  stable, investigate anything higher.

**Lagging indicators**
- Web-client session retention (fraction of logged-in web sessions still
  valid/functional 24h after last activity, not requiring a fresh
  recovery-key entry): target measurable increase within 1 month.
- Reduction in "stuck unverified, had to log out/in" reports to zero
  ongoing occurrences.

Measurement method and dashboards TBD with engineering — flagged as an
open question below since this repo doesn't yet have a metrics pipeline
confirmed for `charm-web-server` specifically.

## Open Questions

1. **(Engineering, blocking)** Does extending the per-session encrypted
   object store to also hold a full `matrix-sdk-sqlite` crypto-store file
   (rather than a small JSON blob) work cleanly against the existing
   `object_store` abstraction (local disk vs. DO Spaces/S3), or does a
   SQLite file need to be staged to local disk per-instance and
   synced/uploaded separately? This affects the DO Spaces deployment
   target specifically — note #149's author flagged the no-persistent-volume
   constraint as their reason for not attempting this, so this question is
   the crux of Phase 1 and should be resolved before implementation starts,
   not discovered mid-PR.
2. **(Engineering, blocking)** Requirement 3/4 (recovery-key-alone marks
   the device verified) needs a decision on *how* — does
   `recover_from_key_impl` additionally call `device.verify()` /
   equivalent itself post-recovery, or does the frontend's `isVerified`
   gate simply stop requiring `DeviceSummary.is_verified` when 4S recovery
   has succeeded? These have different trust-model implications and should
   be resolved with whoever owns the crypto/security model for Charm 2.0
   before implementation.
3. **(Security, blocking)** Does downgrading the verification requirement
   (P0 #3) match the intended Charm 2.0 threat model, or was requiring both
   recovery-key and SAS verification a deliberate hardening decision
   somewhere in [product vision and architecture](/product/vision/) that this spec should
   reconcile with rather than override?
4. **(Engineering, non-blocking)** Should the per-session crypto-store
   directory be cleaned up (and how promptly) on explicit logout, to avoid
   unbounded server-side disk/object-store growth from abandoned sessions?
5. **(Engineering, non-blocking)** What's the actual metrics pipeline
   available for `charm-web-server` today (if any) to implement the
   success metrics above — needs an answer before those become concrete
   dashboards rather than aspirational targets.

## Timeline Considerations

- No hard external deadline. Flagged as high priority because the current
  behavior makes the web client unusable across ordinary page refreshes,
  which is not an edge case for a browser-based client.
- Suggested phasing:
  - **Phase 1**: P0 #1, #2, #5, #6 — crypto-store persistence itself,
    independent of the verification-requirement question. **Confirmed still
    fully open after #149** — resolve Open Question 1 (object-store
    feasibility for a SQLite file) before starting implementation.
  - **Phase 2**: P0 #3, #4 — recovery-key-alone verification, once Open
    Questions 2 and 3 are resolved. **Confirmed still fully open after #149.**
  - **Phase 3**: P1 items, as follow-ups.
- Dependency: Phase 2 is blocked on resolving Open Question 3 (security/
  threat-model sign-off) before implementation, not just design.
