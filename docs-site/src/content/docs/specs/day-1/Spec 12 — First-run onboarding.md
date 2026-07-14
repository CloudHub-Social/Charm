---
title: "Charm 2.0 Spec — First-run onboarding"
type: spec
project: Charm 2.0
created: "2026-07-04"
status: shipped
---

**Workstream:** one PR / one agent. **Tier:** Day-1 launch-critical.

## Problem & why now

Today, the moment a user finishes login or registration, `App.tsx` renders
`RoomsScreen` directly (see Current state). A brand-new account lands on an empty
room list with no explanation of what Charm is, no prompt to secure their identity
via device verification / cross-signing, and no invitation to set a display name or
avatar. Two concrete costs:

1. **Security gap made silent.** A freshly-registered account has no cross-signing
   set up and no other verified device. The shipped verification flow exists but is
   only surfaced reactively (the `VerificationOverlay` responds to incoming
   requests). Nothing nudges a first-time user to establish cross-signing, so they
   silently run an unverified session — exactly the population most in need of the
   prompt.
2. **Cold, contextless first screen.** An empty `RoomList` with no orientation reads
   as "broken" to a new user and gives no pointer to where core actions live.

The planning doc files this under "onboarding polish": it must be genuinely
lightweight and, crucially, **skippable** and **never shown to returning users**. It
is orientation, not a wizard, and it must not become a gate that a user with rooms
ever has to click through.

## Current state (in repo)

- `src/App.tsx` — after `tryRestoreSession()` resolves, gates on `session`: falsy →
  `LoginScreen`; truthy → `RoomsScreen` immediately. There is **no** step between
  auth and the room list. `session: LoginResponse` carries `user_id`.
- `src/features/rooms/RoomsScreen.tsx` — mounts, calls `listRooms()`, subscribes to
  `onRoomListUpdate`, auto-selects `rooms[0]`. Renders `RoomList`, `ChatShell`, and
  `VerificationOverlay`.
- `src/features/verification/VerificationOverlay.tsx` — the shipped SAS + cross-
  signing flow, driven reactively by verification events. This spec **reuses** it; it
  does not build new verification UI.
- State stack: Jotai + TanStack Query. Auth/rooms/verification feature folders exist.
- `LoginResponse` is the typed IPC payload returned by login/restore.

## Scope (in)

- A first-run orientation surface rendered **after** successful login/registration
  and **before/over** `RoomsScreen`, only for accounts that qualify (see gating).
- Content, kept to a small number of panes:
  1. **Orientation** — one short pane: what Charm is, where the room list / composer /
     settings live. Static copy + a couple of Lucide-annotated pointers.
  2. **Verify this device** — a nudge into the **already-shipped** verification /
     cross-signing flow if the session is not cross-signing-verified. Reuses the
     verification feature; does not reimplement SAS.
  3. **Profile (optional)** — inline display-name + avatar entry. This pane
     **cross-references** the Profiles spec and Settings spec for the actual
     `set_display_name` / avatar-upload IPC; onboarding only surfaces a lightweight
     entry point and may defer the heavy lifting to those features.
- **Skip** affordance on every pane (persistently dismissible) plus per-pane "not now".
- **Gating**: shown only when the account has **zero joined rooms** AND a first-run
  flag has not been recorded. Returning users (any rooms, or flag set) never see it.
- Persistence of the "seen/skipped" decision (see Design for account-data vs local).
- Reduced-motion-respecting transitions; 44×44 targets; dark-first tokens.

## Non-goals (out)

- No multi-step setup wizard, no room creation / room discovery flow, no invite flow.
- No new verification UI — reuse `features/verification` as-is.
- No full profile editor — that lives in the Profiles/Settings specs; onboarding links
  to / embeds a minimal entry only.
- No server-side onboarding config, no A/B framework, no analytics events beyond what
  already exists.
- Not shown on every new device by default (see open question Q3) — v1 keys off the
  account-level first-run flag, not per-device.

## Design & approach

### Where it inserts

`App.tsx` currently branches `restoring → !session → RoomsScreen`. Introduce a third
branch **between** `session` and `RoomsScreen`:

```tsx
if (restoring) return <Splash/>;
if (!session) return <LoginScreen onSignedIn={setSession} />;
if (onboarding.status === "pending")
  return <OnboardingScreen session={session} onDone={onboarding.complete} />;
return <RoomsScreen ... />;
```

`OnboardingScreen` lives in a new `src/features/onboarding/`. It is a full-surface
overlay (own screen, not a modal inside `RoomsScreen`) so it can render before the
room list machinery mounts and so the deep-link hold logic in `App.tsx` is untouched
(a deep link arriving mid-onboarding stays held in `deepLinkRoomId` and is consumed by
`RoomsScreen` after `onDone`, exactly as today).

### Gating logic — "does this account qualify?"

A small Jotai-derived atom / hook `useOnboardingGate(session)` computes status
`"pending" | "done" | "loading"` from two inputs:

1. **Room count.** New account ⇒ zero joined rooms. Fetch via the existing
   `listRooms()` IPC once at gate time (or read the rooms query if already warm). If
   `rooms.length > 0`, the account is not new — status is immediately `"done"`, and we
   also opportunistically write the persisted flag so we never recompute. This is the
   primary "returning user" short-circuit and it is robust even across a fresh install
   (a returning user restoring a session will sync rooms).
2. **First-run flag.** If room count is zero we still must distinguish "brand-new
   account" from "existing account that genuinely has no rooms and already skipped".
   That's the persisted flag.

**Where the flag lives — account-data (chosen primary) with a local fast-path:**

- **Primary: Matrix account data.** Write a global account-data event
  `social.cloudhub.charm.onboarding` with `{ "completed_at": <ts>, "version": 1 }`
  via a new typed IPC command (`set_account_data` / `get_account_data`) wrapping the
  SDK's account-data API. Account data syncs across devices and survives reinstall, so
  the user is never re-onboarded on a second device or after clearing local state —
  the correct default for "orientation you only need once per human."
- **Local fast-path: Tauri store.** Mirror the decision in the app's local store
  (the same persistence layer used elsewhere in `src-tauri`, e.g. a
  `tauri-plugin-store` JSON file or the existing session persistence module) keyed by
  `user_id`. This avoids a first-paint flash while account data is still syncing: read
  local first, treat account-data as the source of truth once sync settles, and
  reconcile (if either says "done", it's done).
- **Precedence:** `done` if (rooms > 0) OR (account-data flag present) OR (local flag
  present). Only `pending` when all three say "new". This fail-safe bias means the
  worst case is *not* showing onboarding to someone who might have wanted it — never
  re-showing it to someone who dismissed it.

### "Skip" and completion

- Any skip / "not now" / finishing the last pane calls `onboarding.complete()`, which
  writes **both** the account-data event and the local flag, then flips the atom to
  `"done"` so `App.tsx` re-renders into `RoomsScreen`.
- Skipping is terminal for the orientation surface: we do not re-prompt on next launch.
  (The verification nudge, if skipped, is still independently recoverable later from
  Settings — onboarding is not the only path to verify.)

### Verification pane reuse

The pane checks cross-signing status via the verification feature's existing state
(is this session cross-signing-verified / does the account have cross-signing keys).
If already verified, the pane auto-advances / is hidden. If not, "Verify" triggers the
shipped flow (self-verification against another device, or 4S/recovery-key entry as
the verification feature already supports) — onboarding renders the entry button and
lets `features/verification` own the actual UX.

### Design system

Radix primitives from `src/components/ui/`, CSS-var tokens, dark-first, Manrope /
JetBrains Mono, Lucide icons, 44×44 targets, `prefers-reduced-motion` honored on
pane transitions. Claude Design is system of record for the pane visuals.

## Acceptance criteria

1. A newly-registered account with **zero joined rooms** and no onboarding flag sees
   `OnboardingScreen` immediately after registration, before `RoomsScreen` renders.
2. An account with **≥1 joined room** is routed straight to `RoomsScreen` and
   `OnboardingScreen` never mounts — verified by a session-restore test where
   `listRooms()` returns a non-empty list.
3. After completing or skipping onboarding, relaunching / restoring the session goes
   straight to `RoomsScreen` (no re-prompt), verified against **both** a warm local
   store and a cleared local store where only account data carries the flag.
4. Skipping onboarding on device A and logging in on device B does **not** re-show
   onboarding on B (account-data flag syncs) — asserted with a two-session test double.
5. Every pane exposes a reachable, 44×44 "Skip" / "Not now" control; activating it on
   any pane completes onboarding (flag written) and lands on `RoomsScreen`.
6. The verification pane is **hidden/auto-advanced** when the session is already
   cross-signing-verified, and when not verified its primary action invokes the
   existing `features/verification` flow (no new verification component is rendered).
7. The profile pane's save path calls the profile/settings IPC (display name / avatar)
   and a failure there does not block completing onboarding.
8. A deep link received during onboarding is preserved and honored by `RoomsScreen`
   after `onDone` (the `App.tsx` deep-link hold behavior is unchanged).
9. Writing the completion flag persists to **both** Matrix account data and the local
   store; if the account-data write fails, the local write still lets the user proceed
   and the app does not re-onboard on next launch.
10. All onboarding UI respects `prefers-reduced-motion` and renders correctly in the
    dark-first token theme with no hardcoded colors.

## Testing

- **Vitest + RTL:** gate hook `useOnboardingGate` — matrix of `{rooms 0/≥1}` ×
  `{flag absent / local-only / account-data-only / both}` → correct
  `pending`/`done`. `OnboardingScreen` pane navigation, skip-on-each-pane completes,
  verification pane hidden-when-verified.
- **App routing test:** `App.tsx` three-way branch (`restoring` / `!session` /
  onboarding-pending / rooms) with mocked `tryRestoreSession` + `listRooms`.
- **`cargo test`:** the `set_account_data` / `get_account_data` IPC commands round-
  trip; local-store flag read/write keyed by `user_id`.
- **Playwright + tauri-driver:** register a fresh account → onboarding appears → skip
  → lands on rooms → relaunch → no onboarding. Second: seed a session with rooms →
  onboarding never appears.
- **Storybook + axe:** each pane, light/dark, reduced-motion, keyboard-only skip path;
  zero critical a11y violations.

## Dependencies & sequencing

- **Depends on:** shipped auth (`LoginResponse`), shipped `features/verification`,
  `listRooms()` IPC, a local persistence layer in `src-tauri` (the session-persistence
  module already exists).
- **New IPC:** `get_account_data` / `set_account_data` typed commands (ts-rs). Small;
  can land in the same PR.
- **Soft dependency / cross-reference:** Profiles spec and Settings spec own the real
  display-name/avatar editing. Onboarding can ship its profile pane as a thin entry
  and deepen once those land; it must not block on them.
- **Sequencing:** land after verification (done) and after the rooms list (done);
  independent of the calling spike (Spec 13). One PR, one agent.

## Risks & open questions

- **R1 — "zero rooms" false positives.** A returning user whose sync hasn't populated
  rooms yet could momentarily look "new." Mitigation: the account-data flag is the
  real discriminator; room count only *short-circuits to done*, never forces
  `pending` on its own once the flag exists. Open: should we wait for first sync to
  settle before deciding? (Q1)
- **Q2 — account-data event namespace.** Confirm `social.cloudhub.charm.onboarding`
  as the event type (aligns with `social.cloudhub.charm` identifier). No version
  suffix in the type string.
- **Q3 — per-device vs per-account.** v1 is per-account (account data). Do we ever
  want a lighter per-device "verify this new device" nudge that reuses the same
  surface? Deferred; would key off local store only.
- **R2 — scope creep into a wizard.** Guard rail: max 3 panes, all skippable, no
  blocking network calls on the critical path.

## Effort estimate

**S–M.** Small if the profile pane stays a thin cross-referenced entry and the only
new backend surface is the account-data IPC pair; edges into M mainly from the
gate-precedence logic (rooms × account-data × local reconciliation) and its test
matrix.
