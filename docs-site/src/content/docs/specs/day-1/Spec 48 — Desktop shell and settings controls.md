---
title: Charm 2.0 Spec — Desktop shell and settings controls
type: spec
project: Charm 2.0
created: 2026-07-13
status: draft
---

**Workstream:** one PR / one agent. Extends Spec 08/10/18 (native shell + settings/
devices). A cluster of control/settings gaps the audit found, including one active
annoyance (close button can't quit).

## Problem & why now

Charm 2.0's desktop shell wiring is strong (tray, badges, window-state, deep-link,
autostart all present). But the parity audit (2026-07-13) found several missing
*controls* over that shell and a few settings-management basics from Charm 1.0:

1. **Close-to-tray vs quit is hardcoded.** Charm 2.0 `lib.rs:902-904` intercepts
   `CloseRequested` → `prevent_close()` + `window.hide()` with **no user setting** —
   the close button always minimizes to tray; a user cannot make it actually quit.
   Charm 1.0 has the toggle (`desktop/Desktop.tsx` `closeToBackgroundOnClose`). This
   is an active annoyance, not just a missing nicety.
2. **No show/hide-tray-icon toggle.** Charm 1.0 `Desktop.tsx` `showSystemTrayIcon`
   (with a graceful "tray unavailable" fallback). Charm 2.0 always builds the tray,
   no toggle.
3. **Native menu completeness on Windows/Linux.** Charm 2.0's menu-bar block is
   macOS-gated (`lib.rs:712`); Windows/Linux get less. Fill in the standard menus
   there.
4. **Device / session rename.** Charm 1.0 `devices/DeviceTile.tsx:106-334`
   (`setDeviceDetails` display name). Charm 2.0 `DeviceRow.tsx` only *displays* the
   device name (line 56) — Verify / Sign out / Manage-in-account only, no rename.
5. **Clear cache / storage management.** Charm 1.0 `about/About.tsx:391-403`
   ("Clear Cache & Reload") + `developer-tools/DevelopTools.tsx` (clear media/blob/
   URL caches). Charm 2.0 has no user-facing clear-cache control (the `App.tsx:85`
   ref is internal React-Query eviction on logout, not user-invokable).
6. **Settings export/import + cross-device settings sync** (lower priority). Charm
   1.0 General "Settings Sync & Backup" (`exportSettingsAsJson`/`importSettingsFromJson`
   + a sync toggle, `General.tsx:1609-1660`). Charm 2.0 has none. This is a
   Cinny-specific account-data settings-sync feature — lowest priority in this
   spec; include export/import if cheap, treat full cross-device sync as optional.

## Non-goals

- Not re-doing the tray/badge/window-state/autostart/deep-link wiring that already
  works (Spec 10).
- Not device *verification/revoke* (Spec 25) — only the missing **rename** action.
- Not a general developer-tools panel (Charm 1.0's `DevelopTools.tsx` is broader);
  just the user-facing clear-cache action from it.

## High-level design

- **Close behavior setting:** a Desktop-settings toggle "Closing the window keeps
  Charm running in the tray" (default matching Charm 1.0). The `CloseRequested`
  handler reads it: minimize-to-tray when on, actually quit when off. This replaces
  the current unconditional `prevent_close()`.
- **Tray-icon toggle:** a setting to show/hide the tray icon; build/teardown the
  tray accordingly, with the graceful fallback Charm 1.0 has when the tray is
  unavailable (don't leave the user with no way to reach the app if both the window
  is hidden and the tray is off — guard against that combination).
- **Windows/Linux menus:** extend `setup_tray_and_menu` beyond the macOS-gated block
  so the standard app/edit/window items exist on all desktop platforms.
- **Device rename:** add a rename action to `DeviceRow.tsx` calling
  `setDeviceDetails(deviceId, { display_name })` — new IPC
  `rename_device(device_id, name)`.
- **Clear cache:** a user-facing "Clear cache" action (Settings → About or Storage)
  that clears the media cache (Spec 02's cache dir) + in-memory query caches and
  reloads. New IPC `clear_media_cache()`.
- **Settings export/import (optional):** export local settings to a JSON file and
  import them back, via Tauri file dialog. Cross-device account-data sync is
  explicitly deferred unless trivial.

## Data flow

Close/tray/menu are Rust-side shell config reading a synced-from-frontend setting.
Device rename and clear-cache are new IPC commands (Rust-side: `setDeviceDetails`
via SDK; cache dir clear). Settings export/import is frontend + file dialog.

## API/contract changes

New IPC: `rename_device(device_id, name)`, `clear_media_cache()`, and a way for the
close-behavior/tray settings to reach the Rust shell handlers (setting read at
close time). ts-rs bindings. No changes to existing shell commands.

## Testing strategy

- Rust: `rename_device` calls `setDeviceDetails` correctly; `clear_media_cache`
  empties the cache dir; close handler quits vs hides per the setting.
- Frontend: close-behavior and tray toggles render and persist; device rename
  updates the displayed name; clear-cache action invokes the command and reloads.
- Manual (per-platform where it matters): confirm close-to-quit actually quits on
  each desktop OS; confirm hiding the tray while the window is open still leaves a
  way back; confirm Windows/Linux menus appear.

## Trade-offs

- **Guard the hidden-window + no-tray combination**: the tray-icon toggle plus
  close-to-tray could strand the app with no visible surface — the implementation
  must prevent that (e.g. force-show the window if the tray is being turned off
  while hidden), or the "feature" becomes a lockout bug.
- **Bundle shell + settings controls vs split**: bundled because they're all small
  "control over existing shell/settings" items in adjacent surfaces; settings
  export/import is the only piece safe to drop if the PR grows.

## What I'd revisit as this grows

- Cross-device settings sync via account data (the deferred part of #6) if users
  want their preferences to follow them — needs a sync schema, its own design.
- Global/per-app-tier keyboard-shortcut customization (shortcuts panel exists per
  the audit; customization of it is a possible follow-up, not a confirmed 1.0 gap).
