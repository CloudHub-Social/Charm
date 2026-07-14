---
title: Charm 2.0 Spec — Desktop platform integrations (macOS and Windows)
type: spec
project: Charm 2.0
created: 2026-07-13
status: draft
sidebar:
  label: "Desktop platform integrations"
---

**Workstream:** multi-PR, platform-split internally (macOS and Windows sections can
land independently; Linux noted but not scoped in depth). New spec (owner,
2026-07-13) — native-platform work spec'd per platform. Desktop counterpart to Spec
60 (iOS) and Spec 61 (Android).

## Problem & why now

Spec 10 (native platform shell, shipped) already covers the baseline desktop
integrations: tray/badges/notifications/menus/window-state/deep-link/autostart. This
spec is the *next* layer — OS-level integrations beyond basic shell chrome that a
"real" native Mac/Windows chat app has and Charm 2.0 doesn't yet, mirroring the
Contacts/Focus/Share-Sheet-class gaps identified for iOS/Android.

## Non-goals

- Not re-covering anything Spec 10 already shipped (tray, badges, notifications,
  menus, window-state, deep-link, autostart) — this is additive.
- Not Linux-specific integrations in depth — Linux's native-integration surface
  (varies wildly by desktop environment) is lower priority given Spec 13 already
  flagged Linux as needing more foundational verification; a brief note is included
  below but not a full scoped plan.

## Scope — per-platform

### macOS

1. **Share Extension / Share Sheet**: register Charm as a macOS Share Menu target
   (same underlying mechanism as iOS's Share Extension — macOS and iOS share
   NSExtension-based extensions) so right-click "Share" in Finder/Safari/Photos
   offers Charm. Direct analog of Spec 60 #1.
2. **Focus Modes (macOS)**: macOS shares the same Focus Status API family as iOS
   (Spec 60 #3) — register Charm as Focus-aware so it can show "notifications
   silenced" indicators and respect Focus filtering. Since Charm 2.0 is Tauri
   (Rust-native on macOS, not a webview-only iOS build), this may be more directly
   reachable via native macOS APIs than the iOS Tauri-plugin route — confirm.
3. **Contacts.app integration**: macOS Contacts is the same underlying framework as
   iOS Contacts — if Spec 60's Matrix-ID↔Contact association ships, extend it to
   macOS (likely low incremental cost given shared `CNContact` APIs), including
   a "message in Charm" action from Contacts.app.
4. **Spotlight integration**: index rooms/contacts so macOS Spotlight search can
   surface "jump to {room} in Charm" — a native-desktop analog of Spec 55's in-app
   quick switcher, but system-wide.
5. **Handoff / Continuity**: continue a conversation from iPhone to Mac (or vice
   versa) if both Spec 60 (iOS) and this land — lower priority, note only.
6. **Quick Look / Services menu**: minor — a macOS "Services" menu entry (e.g.
   "Send to Charm" on selected text/files system-wide, distinct from Share
   Extension which is Finder/app-specific). Low priority.

### Windows

1. **Share contract**: Windows' equivalent of Share Sheet/Share intent — register
   Charm as a **Share Target** via the Windows Share contract so the system Share
   flyout (from Photos, Edge, Files, etc.) offers Charm. Direct analog of Spec 60/61
   #1. Tauri's Windows support for this needs checking — likely a custom
   WinRT/UWP-adjacent integration since Tauri apps on Windows aren't packaged as
   MSIX by default; confirm whether MSIX packaging (needed for many Windows Shell
   integrations, including Share) is already in Charm 2.0's Windows build pipeline
   or would need to be added — **this is the main technical risk for Windows**, flag
   before committing to a phase order.
2. **Jump Lists**: right-click the taskbar icon → quick actions (recent
   conversations, "new message") — Windows' analog to macOS/Android app shortcuts.
3. **Notification actions (Action Center)**: inline reply/mark-read from a Windows
   toast notification — Windows' analog to Spec 46/61's inline-notification-actions
   item; implement the Windows-specific toast `ActivationType`/`input` mechanism
   here.
4. **Focus Assist integration**: Windows' Focus Assist (its DND) has a priority-app
   allowlist mechanism — lower priority than Share/Jump-Lists, note only.
5. **Windows Timeline / Recent activity**: largely deprecated by Microsoft; skip
   unless there's a clear current replacement API worth targeting.

### Linux (brief note, not scoped)

- Linux's native-integration surface fragments heavily by desktop environment
  (GNOME/KDE/etc.) with no single Share/Focus/Contacts API to target the way
  macOS/Windows/iOS/Android each have one. Given Spec 13 already flagged Linux as
  needing more foundational device/display verification, defer deep Linux-specific
  integration work until that foundation is solid; a reasonable Linux-only item to
  revisit later is a `.desktop` file's MIME/URI handler registration (already
  partially covered by Spec 10's deep-link work) and, if targeting GNOME
  specifically, an XDG "Share" portal integration.

## High-level design

- **macOS**: mostly native Rust/Swift-bridge work inside the existing Tauri macOS
  build (Charm already ships real native code here per Spec 10) — Share Extension,
  Focus Status, and Contacts each need their own small native module + entitlement
  declarations.
- **Windows**: resolve the MSIX-packaging question first (risk item above) since
  several integrations (Share Target, some notification features) may depend on it;
  this determines whether the rest of this spec's Windows section is a small
  incremental change or a packaging-pipeline project.

## Data flow

Native-platform-side integration → Tauri IPC bridge → existing Charm send/room-
list/notification commands, same pattern as Spec 60/61. Share targets reuse Spec
02's attachment/send path; Focus/notification-priority gates Spec 46's dispatch
logic; Spotlight/Jump-List indexing needs a feed of room/contact data (already
available).

## API/contract changes

- macOS: new native module(s) for Share Extension, Focus Status, Contacts,
  Spotlight indexing.
- Windows: packaging change (if MSIX is adopted) + new native module(s) for Share
  Target, Jump Lists, toast notification actions.
- No changes to core Matrix/IPC commands beyond invoking existing send/room actions
  from these entry points.

## Testing strategy

- Manual, real-device per OS: share a file from Finder/Explorer into Charm; confirm
  Focus/Focus-Assist silences notifications appropriately; confirm Jump List/
  Spotlight entries work; confirm toast/notification inline actions work.
- Windows packaging: if MSIX is adopted, confirm the existing build/release pipeline
  (CI, code-signing per CLAUDE.md's macOS-equivalent Windows docs if any) still
  produces an installable, auto-updatable build — packaging changes are exactly the
  kind of thing that can quietly break existing release flows.

## Trade-offs

- **macOS before Windows**: macOS's Share/Focus/Contacts APIs are closer to what
  Spec 60 (iOS) will have already built (shared Apple frameworks), so there's
  cross-platform code/knowledge reuse if macOS follows iOS; Windows's MSIX question
  is an independent, potentially larger unknown, so sequence it with its own risk
  assessment rather than blocking on it.
- **Linux deferred**: correctly reflects that Linux lacks a single native-
  integration target and is already behind on foundational verification (Spec 13)
  — not worth speculative integration work until that's resolved.

## What I'd revisit as this grows

- Windows MSIX migration as its own larger spec if the risk assessment above shows
  it's a real project, not a small addition.
- Linux desktop-environment-specific integrations once Spec 13's Linux gaps close.
