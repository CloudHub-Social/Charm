---
title: "Charm 2.0 Spec — Settings and device management"
type: spec
project: Charm 2.0
created: "2026-07-04"
status: shipped
---

**Workstream:** one PR / one agent. **Tier:** Day-1 launch-critical.

## Problem & why now

Charm 2.0 has **no settings surface at all**. There is nowhere to edit your profile,
change your password, deactivate your account, or — critically — **log out**. `logout`
does not exist as a command anywhere in `src-tauri/`; once logged in, the only way out is
to wipe the app's keychain/store manually. There is also no way to see or manage the
account's **other devices/sessions**: a user can't review which devices are signed in,
revoke a lost device, check cross-signing status, or start verifying another session
(the `VerificationOverlay` only reacts to *incoming* requests). And there's no
notification configuration — every room notifies by default with no per-room control,
keyword alerts, or mute schedule. A Matrix client without logout, device management, and
notification settings is not shippable. This is the natural home for the already-shipped
cross-signing status command to finally surface in UI.

## Current state (in repo)

- **Auth shipped**: `login`, `register`, `discover_homeserver`, `start_sso_login` /
  `complete_sso_login` / `cancel_sso_login`, `try_restore_session`, QR login — all in
  `src-tauri/src/matrix/mod.rs` + `qr_login.rs`. **No `logout`.**
- **Session persistence**: `src-tauri/src/matrix/persistence.rs` — keychain service
  `social.cloudhub.charm`, entries `session` (`MatrixSession`) and `oauth-session`
  (`SavedOAuthSession`), plus the SQLCipher passphrase entry. Helpers `clear_session()`
  and `clear_oauth_session()` already exist (used on dead-session cleanup) — logout will
  reuse them. Store dir via `store_path()` = `app_data_dir()/matrix_store`.
- **Session state**: `MatrixState { client: Mutex<Option<Client>>, pending_sso,
  pending_qr_check_code }`, `require_client()`. Logout must set `client` back to `None`.
- **Verification / cross-signing shipped**: `src-tauri/src/matrix/verification.rs` —
  `bootstrap_cross_signing`, `cross_signing_status` (→ `CrossSigningStatusSummary
  { has_master_key, has_self_signing_key, has_user_signing_key }`),
  `accept_verification_request`, `cancel_verification`, `start_sas_verification`,
  `confirm_sas_verification`. Frontend `src/features/verification/VerificationOverlay.tsx`
  handles **incoming** SAS flows only. Cross-signing **reset is delegated to the OIDC
  account-management URL** — do not reimplement.
- IPC types derive `#[ts(export, export_to="../src/bindings/")]`; the `src/lib/matrix.ts`
  mirror is **hand-authored** — add new types in both places.
- Commands registered in `src-tauri/src/lib.rs` `invoke_handler![…]`.
- Frontend shell: `src/App.tsx` gates login vs. `RoomsScreen`. No settings route/overlay
  exists. UI primitives available: dialog, dropdown-menu, popover, tabs, tooltip, input,
  label, button, avatar.

## Scope (in)

1. **Settings shell**: a full-screen (or large-overlay) settings surface with left-nav
   sections, opened from the app chrome, closable back to the rooms view.
2. **Account panel**: profile edit (display name + avatar — *cross-reference the Profiles
   spec for the profile data model*); password change; account deactivation; **logout**
   (new command; clears the SQLCipher-backed session from keychain and drops the client).
3. **Notifications panel** (the settings **UI** only; push transport is a separate spec):
   per-room notification mode, keyword alerts, a global mute (Do Not Disturb) schedule,
   and sound selection, all backed by `m.push_rules` account data.
4. **Devices/Sessions panel**: list this account's E2EE devices/sessions with metadata;
   per-session **revoke**; cross-signing status (reuse `cross_signing_status`); a
   "verify another session" entry point that starts an outgoing SAS flow; a **unified
   cross-device session list** (called-out new feature vs. Charm 1) showing verified /
   unverified / this-device grouping.

## Non-goals (out)

- **Appearance/theming settings** — lives in the Theming spec; add a nav item that
  cross-links but build no controls here.
- The **push transport** (pushers, gateway, FCM/APNs, background delivery) — separate
  spec. This spec writes push *rules*, not delivery.
- **Key backup / restore** (Secure Backup) — Day-2, explicitly out.
- **Cross-signing reset** — delegated to the OIDC account-management URL; just open it.
- Multi-account / account switching (single-account app per `MatrixState`).
- Reworking the incoming-verification `VerificationOverlay` (reused as-is for the
  self-verify flow it already renders).
- Server-side profile fields beyond display name + avatar; identity server / 3PID
  management; MSC-specific auth flows.

## Design & approach

### Rust modules / matrix-rust-sdk APIs

New module `src-tauri/src/matrix/account.rs` (`pub mod account;` in `mod.rs`) for
profile/logout/password/deactivate, and `src-tauri/src/matrix/devices.rs`
(`pub mod devices;`) for session management. Notification rules can live in
`src-tauri/src/matrix/notifications.rs`.

**Logout** (`account.rs`) — the load-bearing new command:

```rust
#[tauri::command]
pub async fn logout(state: State<'_, MatrixState>) -> Result<(), String> {
    let client = state.require_client().await?;
    // Best-effort server-side revoke; still clear locally even if it fails.
    if client.matrix_auth().logged_in() {
        let _ = client.matrix_auth().logout().await;
    } else {
        let _ = client.oauth().logout().await;
    }
    persistence::clear_session()?;
    persistence::clear_oauth_session()?;
    *state.client.lock().await = None;
    Ok(())
}
```

Note both session kinds must be cleared (password/SSO `MatrixSession` **and** QR
`OAuthSession`), matching the dual-path handling in `try_restore_session`. The SQLCipher
store dir is intentionally **not** deleted on logout (the passphrase stays in keychain);
this is a session sign-out, not a device wipe — call that out in the confirm dialog. The
frontend must, after `logout` resolves, return to `LoginScreen` (App-level state reset).

**Profile** (`account.rs`) via `client.account()`:
- `set_display_name(Some(&str))`, current via `get_display_name()`.
- `upload_avatar(&mime, data)` then it sets `m.room` avatar url; current via
  `get_avatar_url()`. Also `set_avatar_url(None)` to clear.

**Password change** (`account.rs`): ruma `account::change_password::v3::Request`
(new + old password), sent via `client.send(request)`. Requires UIA — accept an optional
password for the `m.login.password` stage and surface a clear "re-enter password" error
on the first `M_FORBIDDEN`/UIA challenge, mirroring `bootstrap_cross_signing`'s pattern.

**Deactivate** (`account.rs`): `client.account().deactivate(None, auth_data, erase=false)`
(UIA-gated); on success, clear both keychain sessions and drop the client (same teardown
as logout).

**Devices/sessions** (`devices.rs`):
- List account devices metadata: `client.devices().await` (ruma
  `get_devices::v3::Response`) → per device `device_id`, `display_name`, `last_seen_ip`,
  `last_seen_ts`.
- Cross-reference crypto trust: for each, `client.encryption().get_device(own_user_id,
  device_id).await?` → `Device::is_verified()` / `is_cross_signing_trusted()` /
  `is_locally_trusted()`. Own device id from `client.device_id()`.
- **Revoke**: `client.delete_devices(&[device_id], auth_data)` — UIA-gated; same
  optional-password retry pattern.
- **Verify another session**: `client.encryption().get_device(own_user, device_id)
  .await?.request_verification().await?` starts an outgoing verification request; the
  existing `verification.rs` SAS machinery + `VerificationOverlay` then drive it. Add a
  thin command `request_device_verification(device_id)` that kicks this off and emits the
  same `verification:*` events (may require emitting an initial `verification:request` for
  the outgoing case so the overlay opens).

**Notification rules** (`notifications.rs`) via the SDK's high-level
`client.notification_settings().await -> NotificationSettings`:
- Per-room mode: `get_user_defined_room_notification_mode(room_id)` /
  `set_room_notification_mode(room_id, RoomNotificationMode::{AllMessages |
  MentionsAndKeywordsOnly | Mute})`; default via
  `get_default_room_notification_mode` / `set_default_room_notification_mode`.
- Keyword alerts: `add_keyword`/`remove_keyword` (or the keyword push-rule helpers) and
  `contains_keyword_rules`.
- Global mute / DND: there is no native "schedule" push rule; implement the schedule as
  local app state (a persisted setting) that toggles a global `Mute` override via
  `set_default_room_notification_mode` when active. Note this in the spec — the *rule*
  side is `m.push_rules`, the *schedule* side is client-local.
- Sounds: expose the `sound` tweak on push rules where available; otherwise a
  client-local sound preference. (Sounds depend on the push-transport spec for actual
  playback; here we only store the preference.)

### New commands (registered in `lib.rs`)

`logout`, `set_display_name`, `set_avatar` (+ `remove_avatar`), `get_profile`
(display name + avatar for the settings form), `change_password`, `deactivate_account`,
`list_devices`, `delete_device`, `request_device_verification`,
`get_notification_settings`, `set_room_notification_mode`,
`set_default_notification_mode`, `add_notification_keyword`,
`remove_notification_keyword`, `set_global_mute`.

### ts-rs IPC types (new, `#[ts(export, export_to="../src/bindings/")]`)

```rust
pub struct ProfileSummary { pub user_id: String, pub display_name: Option<String>, pub avatar_url: Option<String> }
pub struct DeviceSummary {
    pub device_id: String,
    pub display_name: Option<String>,
    pub last_seen_ip: Option<String>,
    pub last_seen_ts: Option<u64>,
    pub is_current: bool,
    pub is_verified: bool,          // cross-signing trusted
}
pub enum RoomNotificationModeKind { AllMessages, MentionsAndKeywordsOnly, Mute }
pub struct NotificationSettingsSummary {
    pub default_mode: RoomNotificationModeKind,
    pub keywords: Vec<String>,
    pub global_mute: bool,
    pub sound_enabled: bool,
}
```

Reuse the shipped `CrossSigningStatusSummary` for the devices panel — do not redefine it.
Add hand-authored mirrors + wrapper functions to `src/lib/matrix.ts` (`logout`,
`getProfile`, `setDisplayName`, `setAvatar`, `changePassword`, `deactivateAccount`,
`listDevices`, `deleteDevice`, `requestDeviceVerification`, `getNotificationSettings`, …).

### Frontend components / hooks / atoms + surfaces changed

New feature dir `src/features/settings/`:

- `SettingsScreen.tsx` — the shell: left-nav section list + right content pane. Nav items:
  **Account**, **Notifications**, **Devices**, **Appearance** (cross-link to theming, no
  controls). Uses `Tabs` or a nav list + routed content; a close/back control returns to
  `RoomsScreen`.
- `AccountPanel.tsx` — profile edit (display name `input`, avatar upload), a **Change
  password** `Dialog`, a **Deactivate account** destructive `Dialog` (double-confirm),
  and a **Log out** button (confirm `Dialog`; on success App resets to login). Profile
  fields cross-reference the Profiles spec's data model — consume that hook if it exists,
  otherwise the local `get_profile`/`set_display_name` commands.
- `NotificationsPanel.tsx` — default-mode select, per-room override list (rooms from
  `list_rooms`, each with a `RoomNotificationModeKind` dropdown), keyword-alerts editor
  (add/remove chips), global-mute toggle + schedule inputs, sound toggle.
- `DevicesPanel.tsx` + `DeviceRow.tsx` — cross-signing status banner (from
  `cross_signing_status`; if unbootstrapped, a "Set up" action calling the shipped
  `bootstrap_cross_signing`, and a "Reset" link that opens the OIDC account-management
  URL via `tauri_plugin_opener`). Unified session list grouped **This device /
  Verified / Unverified**, each `DeviceRow` showing name, last-seen, trust badge, and a
  dropdown with **Verify** (`request_device_verification` → drives
  `VerificationOverlay`) and **Sign out** (`delete_device`, UIA-gated).

Hooks/state:

- `useProfile()`, `useDevices()`, `useNotificationSettings()` — TanStack Query queries
  over the respective commands; mutations invalidate on success.
- Jotai `settingsOpenAtom` (which section is open, or closed) driving whether
  `SettingsScreen` renders over `RoomsScreen`.

Surfaces changed:

- `src/App.tsx` — render `SettingsScreen` when `settingsOpenAtom` is set; on `logout`
  success, clear session state and route back to `LoginScreen` (App already distinguishes
  logged-in vs. login states). Ensure `QueryClientProvider`/Jotai `Provider` exist
  (shared concern with Spec 07).
- Add a settings entry point (gear/avatar menu) to the app chrome — a small addition to
  the `RoomsScreen`/`RoomList` header using `dropdown-menu`.

## Acceptance criteria

1. A **Log out** control signs the user out: server-side session revoked (best effort),
   both keychain entries (`session` and `oauth-session`) cleared, `MatrixState.client`
   set to `None`, and the UI returns to `LoginScreen`. A subsequent app relaunch does
   **not** auto-restore (`try_restore_session` returns `None`).
2. Logout succeeds and clears local session even when the server-side revoke call fails
   (offline), and shows no false error.
3. Editing display name persists via `set_display_name` and is reflected after refetch;
   uploading an avatar updates `m.room` avatar url and the settings avatar preview.
4. Password change with correct current password succeeds; a UIA/`M_FORBIDDEN` challenge
   surfaces a clear "re-enter your password" prompt rather than a raw error.
5. Deactivate account, after double-confirm, deactivates server-side and tears down the
   local session identically to logout.
6. Devices panel lists all of the account's devices with display name, last-seen, a
   trust badge, and the current device clearly marked (`is_current`).
7. Revoking (signing out) another device calls `delete_device`, satisfies UIA, and the
   device disappears from the list after refetch.
8. Cross-signing status banner reflects `cross_signing_status`; when unbootstrapped a
   "Set up" action runs `bootstrap_cross_signing`; "Reset" opens the OIDC
   account-management URL (no in-app reimplementation).
9. "Verify another session" starts an outgoing SAS flow and drives the existing
   `VerificationOverlay` (emoji comparison) to a verified result; the device's trust badge
   updates to verified.
10. Notifications panel reads current settings; changing the default mode and a per-room
    mode persists to `m.push_rules`; adding/removing a keyword updates keyword rules.
11. Global mute toggle silences notifications (default mode → Mute while active) and
    restores the prior default when disabled.
12. Appearance nav item is present and cross-links to theming without duplicating theme
    controls here.
13. All new IPC types exist as ts-rs bindings in `src/bindings/` **and** as matching
    hand-authored types/wrappers in `src/lib/matrix.ts`; `CrossSigningStatusSummary` is
    reused, not redefined.

## Testing

- **Rust (`cargo test`, network-gated `tests/` against local Synapse, matching the
  existing pattern)**: `logout` clears both keychain entries and nulls the client, and a
  follow-up `try_restore_session` returns `None` (reuse the real-keychain approach from
  `persistence.rs` tests); `set_display_name` round-trips via `get_display_name`;
  `list_devices` returns the current device with `is_current == true`; `delete_device`
  removes a second logged-in device (create it via a second `login`).
- **UIA paths**: unit-test that `change_password`/`delete_device`/`deactivate_account`
  return a recognizable "needs password" error on the first challenge and succeed on
  retry with the password (can stub the UIA response).
- **ts-rs binding drift**: bindings export test + a Vitest assertion that the
  `matrix.ts` mirrors match the generated `src/bindings/*` shapes (guard the manual sync).
- **Vitest + RTL** (coverage floor): `AccountPanel` logout confirm dialog invokes
  `logout` and triggers the App reset callback; `DeviceRow` shows the correct trust badge
  and marks the current device; `NotificationsPanel` add/remove keyword and mode-change
  call the right commands; deactivate requires double-confirm.
- **Storybook + axe**: stories for `SettingsScreen` nav, `AccountPanel`, `DevicesPanel`
  (bootstrapped vs. not; verified vs. unverified rows), `NotificationsPanel`; axe passes;
  44×44 targets on all row/menu actions.
- **Playwright + tauri-driver**: full logout flow (settings → logout → back at
  `LoginScreen`); open Devices, start a verify-another-session flow and confirm the
  overlay appears.

## Dependencies & sequencing

- **`logout` is the highest-priority item** and unblocks basic account hygiene; can land
  first as a standalone slice (command + button) ahead of the rest of the panel work.
- **Cross-references the Profiles spec** for the profile data model (display name/avatar)
  — align on a shared `ProfileSummary`/hook rather than two sources of truth; if Profiles
  lands first, consume it, else define `ProfileSummary` here and let Profiles adopt it.
- **Cross-references the Theming spec** (Appearance nav item) and the **Push-transport
  spec** (this spec writes rules; that one delivers). Sounds playback depends on push.
- Reuses shipped `cross_signing_status` / `bootstrap_cross_signing` and the
  `VerificationOverlay`; the outgoing-verification entry point may need a small change in
  `verification.rs` to emit an overlay-opening event for the self-initiated case.
- Shares the `QueryClientProvider`/Jotai `Provider` bootstrap and the `invoke_handler!`
  list with Spec 07 — coordinate to avoid merge conflicts.

## Risks & open questions

- **UIA ergonomics**: `change_password`, `delete_device`, and `deactivate_account` all
  require User-Interactive Auth; the password re-prompt UX must be consistent. Reuse the
  `bootstrap_cross_signing` "prompt-and-retry" convention already established.
- **Outgoing verification wiring**: `VerificationOverlay` currently only opens on incoming
  `verification:request` events; the self-verify entry point needs the overlay to open for
  an outgoing request — confirm whether a synthetic emit or a small overlay change is
  cleaner.
- **DND schedule has no native Matrix representation** — implementing it as client-local
  state that flips the global default mode is a pragmatic Day-1 choice; a device that's
  offline won't honor it. Confirm this trade-off is acceptable for launch.
- **`client.devices()` last-seen fields** can be sparse/absent on some homeservers; UI
  must tolerate `None`.
- **Logout store retention**: not deleting `matrix_store` on logout leaves encrypted data
  on disk (protected by the keychain passphrase). Decide whether a "sign out and forget
  this device" variant that also wipes the store is needed for Day-1 (recommend: no,
  Day-2), and make the plain-logout confirm copy accurate about what is/isn't removed.
- **Notification-settings API surface** (`NotificationSettings` helper method names) can
  vary across matrix-rust-sdk versions — verify against the pinned `Cargo.toml` version.

## Effort estimate

**L** — spans a new settings shell plus three substantive panels, ≈16 new commands
(several UIA-gated), new IPC types, first-class device/session management with trust
badges and an outgoing-verification hookup, and notification-rule plumbing; `logout` is
small and can ship early, but the devices and notifications panels plus UIA handling carry
real weight.

## Status update (2026-07-06)

PR review rounds 2–5 addressed on branch `feat/spec-08-settings-devices`: UIA session threading/sync-loop leak/cache invalidation; UIA error masking/presence leak/concurrent verify/session-scoped cross-signing; verification loop terminal states/mute-override escape/Jotai leak/password-change device logout; mute-snapshot ordering/SSO-OIDC action gating/dialog error surfacing. CI also bumped to Node 24 for jobs running the Storybook test-runner. PR: [CloudHub-Social/Charm#18](https://github.com/CloudHub-Social/Charm/pull/18).

**Open follow-up:** reconcile this spec's local `ProfileSummary` with Spec 01's profile read-model now that Spec 01 has a PR open (#22) — see the Day-1 spec index.
