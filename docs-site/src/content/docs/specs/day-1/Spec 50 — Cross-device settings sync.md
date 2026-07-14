---
title: Charm 2.0 Spec — Cross-device settings sync
type: spec
project: Charm 2.0
created: 2026-07-13
status: draft
---

**Workstream:** one PR / one agent. New spec from the 2026-07-13 owner adjudication
(owner: "needed"). Promotes what Spec 48 had deferred as optional.

## Problem & why now

Charm 2.0's user preferences (theme/appearance from Spec 09, layout from Spec 27,
notification and privacy settings, etc.) are **local to each device**. Charm 1.0 has
"Settings Sync & Backup" (`General.tsx:1609-1660` — `exportSettingsAsJson`/
`importSettingsFromJson` + a cross-device sync toggle) that persists settings to
Matrix account data so they follow the user across devices. Owner confirmed this is
needed: a user who configures Charm on desktop shouldn't have to redo it on mobile.

## Non-goals

- Not syncing *device-specific* settings that shouldn't follow the user — e.g.
  Spec 48's desktop close-to-tray behavior, which tray icon shows, per-device push
  transport, and anything tied to one machine's hardware. This spec must classify
  each setting as **synced** vs **device-local** and only sync the former.
- Not a general file-backup system — this is Matrix-account-data sync, the same
  mechanism Charm 1.0 uses, so settings ride the user's existing homeserver account
  (no new backend/service).
- Not real-time collaborative settings — eventual consistency across devices is
  fine; a change on one device shows up on others on next sync.

## High-level design

- **Storage:** persist synced settings to Matrix **account data** under a Charm
  namespace (e.g. `social.cloudhub.charm.settings` — confirm naming against the
  identity rules; must not leak a version suffix). Account data syncs automatically
  via the SDK, so other devices receive updates through normal sync.
- **Setting classification:** introduce a clear split in the settings model between
  **synced** settings (appearance, layout, notification *rules*, privacy toggles,
  emoji style, etc.) and **device-local** settings (desktop shell behavior, push
  transport, per-device UI state). Only synced settings are written to account data;
  device-local stay in the local store. Audit every existing setting and assign it a
  bucket — getting this wrong (syncing a device-local setting) is the main risk.
- **Sync toggle:** a user setting to enable/disable settings sync (matching Charm
  1.0's toggle) — some users may prefer per-device independence.
- **Conflict resolution:** last-write-wins per setting key (account data is
  key-scoped; simple LWW is adequate since settings edits are rare and single-user).
  Document this rather than building a complex merge.
- **Export / import (the manual complement):** "Export settings as JSON" and "Import
  settings from JSON" via file dialog (Charm 1.0 has both) — useful for backup or
  moving between accounts, independent of live sync. (This is the piece Spec 48 had
  listed as its optional fallback; it now lives here with the full sync feature.)
- **Migration:** on first enable, seed account data from the device's current local
  settings; on a fresh device with sync on, adopt the synced values.

## Data flow

Synced settings read/write Matrix account data via the SDK (auto-synced). New IPC:
`get_synced_settings()`, `set_synced_setting(key, value)` (or a single account-data
read/write wrapper if one already exists generically). Device-local settings keep
their existing local-store path unchanged. Export/import is frontend + file dialog.

## API/contract changes

- Account-data read/write for the Charm settings namespace (new IPC if not already
  generically exposed).
- Settings model gains a synced-vs-local classification (frontend-side mostly).

## Testing strategy

- Frontend: changing a synced setting writes account data; a device-local setting
  does not; incoming account-data update applies on this device; sync toggle
  disables writes; export/import round-trips.
- Cross-device manual test: change theme on device A, confirm it appears on device B
  after sync; confirm a device-local setting (e.g. close-to-tray) does **not** cross
  over (the key isolation check).
- Multi-account isolation: synced settings are per-account (respect Spec 15's
  isolation and day-2 Spec 09's switcher) — settings under account A don't bleed to
  account B.

## Trade-offs

- **Account data (Matrix-native) vs a bespoke backend**: account data matches Charm
  1.0, needs no new service, and rides the user's existing homeserver — the obvious
  choice.
- **LWW vs merge**: settings are single-user and rarely edited concurrently on two
  devices; LWW per key is simple and sufficient — a merge engine would be
  over-engineering.
- **The classification is the hard part**: the feature is easy; deciding which
  settings sync is where the care goes. Ship with a conservative default (sync only
  clearly-portable prefs) and expand rather than accidentally syncing device state.

## What I'd revisit as this grows

- Per-setting sync override (let a user pin one setting device-local even if its
  bucket is "synced") if the coarse toggle proves too blunt.
