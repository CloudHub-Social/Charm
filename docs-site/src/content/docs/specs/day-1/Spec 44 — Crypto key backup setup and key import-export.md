---
title: Charm 2.0 Spec — Crypto key backup setup and key import/export
type: spec
project: Charm 2.0
created: 2026-07-13
status: in-progress
sidebar:
  label: "Crypto key backup & import/export"
---

**Workstream:** dependency-ordered security slices. Extends Spec 25 (persistent crypto state &
recovery-key-sufficient verification), which shipped recovery-key **restore** but
not first-time **setup** or manual key file I/O.

## Current implementation status

- **Manual encrypted room-key import/export:** implemented behind the default-off
  `crypto_key_files` feature flag. Charm delegates the interoperable encrypted
  file format to matrix-rust-sdk and uses Rust-owned native pickers so selected
  file paths and key material never enter frontend IPC. These native-only controls
  are hidden in web builds, even when the flag is enabled. While a transfer is
  pending, Cancel, close, Escape, and outside dismissal cannot hide its dialog;
  a session-scoped provider also keeps progress and completion visible across
  Settings closure, tab changes, and browser Back/hash navigation. Credentials
  stay in that owner's local state, not query/mutation caches, and are cleared on
  completion or session teardown. Dismissal becomes available again after the
  native command settles. These lifecycle regressions await CI.
  After the picker and before SDK key access, the native command revalidates the
  active user/device and the feature flag. It clones the current client, releases
  the global client mutex, and retains only session-transition exclusion until
  SDK file work finishes, including when the invoking future is dropped.
  iOS imports use security-scoped in-place document access before Charm's bounded
  snapshot; Android import remains unavailable until bounded content-URI streaming
  is implemented. Passphrases enter zeroizing storage before validation or
  any early return. New exports require at least eight Unicode code points;
  imports accept existing short or empty passphrases without imposing a new
  strength policy. Both paths enforce the same 1024-byte UTF-8 limit in the UI
  and native command. Real-device iOS file-provider export remains a manual gate;
  the pinned dialog plugin's save implementation does not consume FileAccessMode.
- **First-time key backup / 4S setup:** not yet implemented. Existing recovery-key
  restore still covers only accounts whose server-side recovery is already set up.
- **Trust shields, blacklist-unverified-devices, and QR verification:** not yet
  implemented.

## Problem & why now

Native key imports reject zero or more than 1,000,000 PBKDF2 rounds before
client admission; matrix-rust-sdk still authenticates and decrypts the file.
Native key imports read from one opened file into a private, size-bounded
encrypted snapshot before acquiring account-transfer exclusion. The SDK imports
that snapshot rather than reopening the user-selected pathname. Temporary
ciphertext is removed when the owned transfer completes or fails; plaintext keys
are not written to the staging file. iOS opens the selected document in place;
Android does not expose import until Charm can bound reads from provider URIs.
Regression execution remains in CI.

Charm 2.0's crypto is strong on verification and restore: SAS verification,
cross-signing bootstrap, recovery-key restore, and reset are all present
(`DevicesPanel.tsx`, `VerificationOverlay.tsx`, `useDevices.ts`). But the parity
audit (2026-07-13) found two real gaps against Charm 1.0:

1. **First-time key backup / 4S setup is missing.** Charm 2.0's recovery card
   renders **only** when `recoveryState === "incomplete"` (i.e. a backup already
   exists to restore from — `DevicesPanel.tsx:245`). There is no path for the
   `disabled` state: a user who has never set up key backup cannot *create* a
   recovery key / enable server-side key backup from Charm 2.0 at all. Charm 1.0 has
   this (`components/Devices.tsx:60-122` secret-storage bootstrap, `LocalBackup.tsx`).
   This is the more important of the two — without it, new users never establish a
   backup, so a lost device = lost message history.
2. **Manual megolm key export/import was missing.** Charm 1.0 exports/imports
   encrypted `.txt` room-key files (`LocalBackup.tsx:40-47,188-190` —
   `exportRoomKeysAsJson` + `encryptMegolmKeyFile` → `cinny-keys.txt`, and the
   import side). Charm 2.0 now provides this as a default-off, staged feature.
   This is the offline/manual escape hatch when server backup isn't trusted or
   available.

Two further items — per-message/user **trust shields** in the timeline and a
**blacklist-unverified-devices** setting — the owner confirmed (2026-07-13) as
**firm scope, not optional**: Charm should follow Element's security UX here to
strengthen overall E2EE trust signalling. They're now in scope below, not "include
if cheap."

## Non-goals

- Not re-doing verification/restore/reset — those work (Spec 25).
- Not changing the web-client persistence limitation Spec 25 documented (DO App
  Platform redeploy loses crypto state) — orthogonal.

## High-level design

### Key backup setup (the `disabled` → enabled path)

- In Settings → Devices/Security, when no key backup exists, show an "enable key
  backup" / "set up recovery" flow: generate a recovery key (and/or passphrase),
  display it for the user to save, bootstrap secret storage (4S) and server-side
  key backup via the SDK, and confirm success. This mirrors Charm 1.0's secret-
  storage bootstrap and complements Spec 25's existing restore path (so the full
  lifecycle — create, restore, reset — is covered).
- Reuse Spec 20's structured UIA error handling — backup setup crosses UIA.

### Megolm key file export/import

- **Export:** "Export room keys" → passphrase prompt → SDK exports encrypted key
  file → save via Tauri file dialog. (Matrix's standard encrypted key export
  format, so files interoperate with Element/Charm 1.0.)
- **Import:** "Import room keys" → file picker + passphrase → SDK imports → report
  how many keys were imported.
- Both are standard matrix-rust-sdk crypto-store operations — confirm the exact API
  (`export_room_keys` / `import_room_keys` or equivalent) before wiring.

### Security trust UX (firm scope — follow Element)

- **Trust shields:** verified/unverified/unverified-device badges on messages and on
  users in the member list / profile card (Spec 36), reflecting device/user trust —
  follow Element's shield semantics (green verified, red warning on an unverified
  device that was previously trusted, grey unverified) so the signalling matches what
  security-conscious Matrix users already understand.
- **Blacklist unverified devices** setting: refuse to send to unverified devices in a
  room when enabled (Element's "never send encrypted messages to unverified sessions"
  equivalent).

### QR-code device verification (firm scope — owner-confirmed 2026-07-13)

Add QR-code self-verification alongside the existing SAS-emoji flow. Charm 1.0
(Cinny) is SAS-only (QR there is *login* only, MSC4108, which Charm 2.0 already
has) — this is a beyond-1.0-parity addition, matching Element's verification UX:
an already-trusted device shows a QR code; the new/untrusted device scans it (or
vice versa) to complete verification without doing the emoji-comparison dance.
Implement as an additional method on Spec 25's existing verification flow
(`VerificationOverlay.tsx`) — offer QR when both sides' clients support it,
falling back to SAS otherwise (matches the Matrix spec's multi-method
negotiation). Reuse whatever QR-generation/scanning the login flow (MSC4108,
`QrLoginScreen.tsx`) already has rather than adding a second QR library.

## Data flow

New IPC: `setup_key_backup(passphrase?) -> recovery_key`,
`export_room_keys(passphrase) -> completed`, and
`import_room_keys(passphrase) -> { completed, imported_count, total_count }`. All
are thin wrappers over matrix-rust-sdk crypto operations. Import/export file paths
are selected and consumed entirely on the Rust side through native pickers; neither
paths nor raw key material cross frontend IPC. Only the future recovery key string
that the user must save will cross that boundary.

## API/contract changes

New IPC commands as above (ts-rs bindings). Import/export expose only completion
and aggregate key counts. Reuse Spec 20's `UiaCommandError` for the UIA-gated
setup. Small DTO additions will be needed for per-message/user trust state.

## Testing strategy

- Rust: setup creates a working backup (round-trip: set up, then restore on a fresh
  session succeeds); export then import round-trips keys; wrong passphrase on import
  fails cleanly.
- Frontend: setup flow renders only in the `disabled` state and transitions to the
  restore/verified state after; export/import dialogs handle success and error;
  trust shields render per fixture trust state.
- Manual: set up backup on a fresh account, sign in on a second device, restore from
  the recovery key (confirms the create side actually produces a restorable backup —
  the highest-value end-to-end check).

## Trade-offs

- **Setup is the priority over key-file I/O**: without setup, backup never exists
  for new users and Spec 25's restore path has nothing to restore from — so the
  `disabled`→enabled flow is the load-bearing gap; key-file export/import is the
  power-user/offline complement.
- **Standard encrypted key format**: ensures exported keys import into
  Element/Charm 1.0 and vice versa — a Charm-only format would strand users.

## What I'd revisit as this grows

- Automatic backup-health nudges ("your keys aren't backed up") if users keep
  ending up without a backup despite the setup flow existing.
