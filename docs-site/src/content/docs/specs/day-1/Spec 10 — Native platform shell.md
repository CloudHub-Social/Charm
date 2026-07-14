---
title: "Charm 2.0 Spec — Native platform shell"
type: spec
project: Charm 2.0
created: "2026-07-04"
status: shipped
---

**Workstream:** one PR / one agent. **Tier:** Day-1 launch-critical.

## Problem & why now

Charm currently runs as a bare Tauri window (single 800×600 window declared in
`tauri.conf.json`) with no OS integration. To feel like a real desktop chat app rather than
a web page in a frame, it needs the native shell: a **tray / menu-bar icon with an unread
badge**, a **dock/taskbar badge**, **local OS notifications** (fired in-app on new messages —
distinct from remote push, Spec 11), **start-on-login**, **window state persistence**, a
**native macOS menu bar**, and an **adaptive layout** (sidebar on desktop, bottom-nav on
mobile). These are the ambient-presence affordances users expect Day-1, and they all hang off
the unread counts the Rust sync loop already computes.

## Current state (in repo)

- `src-tauri/src/lib.rs` registers `deep-link`, `opener`, `updater`, `process`, and
  (desktop) `single-instance` plugins. No tray, notification, autostart, or window-state
  plugin. Commands are registered in one `invoke_handler!` block.
- `src-tauri/tauri.conf.json` — one window (`main`, 800×600, title "Charm"), bundle icons
  present (`icons/32x32.png`, `128x128`, `.icns`, `.ico`), updater configured with a real
  pubkey, deep-link scheme `charm`.
- `src-tauri/capabilities/default.json` — permissions: `core:default`, `opener:default`,
  `updater:default`, `process:default`, `deep-link:default` (window `main`).
- **Unread counts already flow**: `matrix/mod.rs` `snapshot_rooms()` reads
  `room.unread_notification_counts().notification_count` into `RoomSummary { room_id, name,
  unread_count }`, and `spawn_sync_loop()` emits `room_list:update` (full snapshot) and
  `timeline:update` (per-room new events) on every sync. This is the data source for badges
  and local notifications.
- Frontend: React 19, Jotai, TanStack Query, radix-ui, lucide-react. No responsive
  layout shell yet (`src/App.tsx` + `src/components` / `src/features`).

## Scope (in)

1. **System tray / menu-bar icon** (desktop) with a dynamic **unread badge** overlay and a
   tray menu (Show/Hide, Quit, quick status).
2. **Dock badge (macOS) / taskbar overlay badge (Windows)** reflecting total unread.
3. **Local OS notifications** via `tauri-plugin-notification`, triggered in-app from the sync
   loop / timeline events (title = room/sender, body = message preview), respecting focus
   (suppress when the target room is focused). *(Remote/push-triggered notifications = Spec 11.)*
4. **Start on login** via `tauri-plugin-autostart`, toggleable from settings.
5. **Window size/position persistence** via `tauri-plugin-window-state`.
6. **Native macOS menu bar** (app menu, Edit menu with copy/paste, Window, Help) via the
   Tauri v2 menu API; minimal/no custom menu on Windows/Linux (rely on in-app chrome).
7. **Adaptive layout**: sidebar (rooms rail) on desktop widths, **bottom-nav** on mobile /
   narrow widths — the responsive frontend switch.
8. Capability/permission entries for every new plugin in `src-tauri/capabilities/`.

## Non-goals (out)

- **Remote push notifications / UnifiedPush / APNs / push-decrypt** — Spec 11.
- **Mobile-native polish**: haptics and swipe gestures are **Day-2** (bottom-nav layout
  itself is Day-1; the native feel bits come later).
- Custom per-OS tray context menus beyond the basic set; global hotkeys; quick-reply from a
  notification (Day-2+).
- Notification grouping/threading and rich media in notifications.
- Windows toast action buttons / Action Center advanced integration.

## Design & approach

### Rust / Tauri plugins & APIs
- **Tray**: Tauri v2 built-in `tauri::tray::TrayIconBuilder` (no plugin) — build in `setup()`
  in `lib.rs`, attach a `Menu` (Show Charm / Quit). Update the tray icon to a badge-composited
  variant when unread > 0 (render a small overlay onto the base icon in Rust using the icon
  bytes, or swap between pre-baked `icons/tray.png` / `icons/tray-badge.png`).
- **Badge**:
  - macOS dock: use the window/app badge API — Tauri v2 exposes
    `WebviewWindow::set_badge_count` / `AppHandle` badge on macOS (`set_badge_label`),
    driving the dock badge.
  - Windows: taskbar **overlay icon** via `set_overlay_icon` (Tauri v2 window API,
    Windows-only) — render the count as a small overlay.
  - Linux: best-effort Unity launcher count where supported; otherwise tray badge only.
- **Notifications**: `tauri-plugin-notification` (Rust + `@tauri-apps/plugin-notification`).
  Notifications are triggered from Rust in the sync loop (so they fire even when the webview
  is backgrounded) via the plugin's Rust `Notification` builder, OR surfaced to JS which
  calls `sendNotification()` — **choose Rust-side triggering** so it works when the webview is
  throttled. Request permission on first run.
- **Autostart**: `tauri-plugin-autostart` (`enable()/disable()/is_enabled()`), toggled via a
  command.
- **Window state**: `tauri-plugin-window-state` — auto save/restore size/position/maximized
  for the `main` window.
- **Menu**: Tauri v2 `tauri::menu::MenuBuilder` / `SubmenuBuilder`, set as the app menu on
  macOS in `setup()`.

### New commands + events (ts-rs where relevant)
- `#[tauri::command] set_autostart(enabled: bool)` / `get_autostart() -> bool`.
- `#[tauri::command] set_badge_count(count: u32)` (thin wrapper; also called internally).
- **Unread flow**: extend the sync loop to compute a **total unread** across rooms and emit a
  new narrow typed event `badge:update` with `BadgeState { total_unread: u32,
  total_highlight: u32 }`, derived from the same `unread_notification_counts()` used by
  `snapshot_rooms()`. The Rust side both updates the native badge (dock/taskbar/tray) and
  emits `badge:update` for the frontend rail counts.
- New event `notification:local` is **not** needed if Rust triggers notifications directly;
  keep notification decisions in Rust (focus-aware suppression via a
  `focused_room_id: Mutex<Option<String>>` on `MatrixState`, set by a
  `set_focused_room(room_id: Option<String>)` command).
- ts-rs types: `BadgeState` with `#[derive(Serialize, Deserialize, Clone, TS)]
  #[ts(export, export_to = "../src/bindings/")]`, mirroring `RoomSummary` /
  `SyncStateEvent` in `matrix/mod.rs`.

### Frontend components/hooks/atoms
- `src/features/shell/useAdaptiveLayout.ts` — a hook keyed on a `matchMedia`/container-width
  breakpoint returning `'desktop' | 'mobile'`.
- `src/features/shell/AppShell.tsx` — renders `<SidebarLayout>` (rooms rail + content) on
  desktop, `<BottomNavLayout>` (content + bottom tab bar: Chats / People / Settings) on
  mobile. Lucide icons for nav.
- `src/features/shell/badgeAtom.ts` — Jotai atom fed by `listen('badge:update', …)` for
  in-UI unread counts (tray/dock handled natively in Rust).
- Settings toggles (rendered in Spec 08 panel): start-on-login, notification enable — call
  `set_autostart` / notification permission.

### Capability / permission entries (`src-tauri/capabilities/default.json`)
- Add: `notification:default` (allow send + permission request),
  `autostart:allow-enable`, `autostart:allow-disable`, `autostart:allow-is-enabled`,
  window-state plugin permissions (`window-state:default`), and tray/menu core permissions
  (`core:tray:default`, `core:menu:default`, `core:window:allow-set-badge`,
  `core:window:allow-set-overlay-icon` as applicable). Split mobile vs desktop capabilities if
  a mobile capability file is added (tray/autostart/window-state are desktop-only).

## Acceptance criteria

1. A tray/menu-bar icon appears on macOS/Windows/Linux with a working menu (Show, Quit); when
   total unread > 0 the tray icon shows a badge/dot, cleared when unread returns to 0.
2. macOS dock badge shows the total unread count and updates within one sync cycle of a new
   message; Windows taskbar shows an overlay badge; both clear at 0.
3. A local OS notification fires on a new incoming message when its room is **not** focused,
   with sender/room title and message-preview body; **no** notification fires when that room
   is currently focused.
4. Start-on-login can be enabled/disabled from settings and the state survives reboot
   (`get_autostart()` reflects it); the app launches on login when enabled.
5. Window size, position, and maximized state are restored on next launch.
6. macOS shows a native menu bar with functional Edit (copy/paste/select-all) and Window
   items; standard shortcuts (⌘C/⌘V/⌘W/⌘Q) work.
7. At desktop widths the layout shows the sidebar rail; below the breakpoint it switches to a
   bottom-nav layout; switching is live on window resize.
8. `badge:update` events drive the in-app rail unread counts consistently with the native badge.
9. All new plugin permissions are declared in `capabilities/`; app builds and runs on all
   three desktop OSes; `pnpm build` and `cargo test` pass.

## Testing

- **`cargo test`**: unit-test the total-unread aggregation (sum of
  `unread_notification_counts`) and `BadgeState` construction from a fixture room set;
  focus-suppression logic (given focused_room_id, a timeline event for that room yields no
  notification).
- **Vitest + RTL**: `useAdaptiveLayout` returns the right mode across mocked widths;
  `AppShell` renders sidebar vs bottom-nav accordingly; `badgeAtom` updates on a mocked
  `badge:update` event.
- **Playwright + tauri-driver**: launch app, resize window to trigger layout switch, assert
  bottom-nav present; verify window-state persistence by relaunch; assert autostart command
  round-trips `get_autostart()`.
- **Manual/CI-smoke matrix**: tray icon + dock/taskbar badge visually verified per-OS
  (screenshot capture in the tauri-driver harness where the OS permits).
- **Storybook + screenshot-diff**: sidebar and bottom-nav layouts as stories; axe on nav.

## Dependencies & sequencing

- Consumes the existing sync-loop unread data (`snapshot_rooms` / `unread_notification_counts`)
  — no Matrix changes required; just an added aggregation + `badge:update` emit.
- Settings toggles (start-on-login, notifications) render in **Spec 08 (Settings)** — this spec
  provides the commands; Spec 08 wires the UI.
- **Local** notifications here are the precursor to **Spec 11** remote push; keep the
  notification-building code (title/body from a Matrix event) factored so Spec 11 can reuse it
  for push-decrypt notifications.
- Adaptive layout coordinates with Spec 09 (density/font-size tokens apply within both layouts).

## Risks & open questions

- **Tauri v2 badge API coverage**: dock badge (macOS) and taskbar overlay (Windows) surface
  through different window/app calls; Linux badge support is DE-dependent (Unity launcher
  entry). Confirm exact Tauri v2 method names/permissions per platform; Linux may be tray-only.
- **Tray badge rendering**: compositing a count onto the tray icon at runtime vs pre-baked
  variants — pre-baked dot is simpler and cross-platform; numeric tray badges are hard on some DEs.
- **Notification triggering from Rust** while webview is throttled must be validated — this is
  the whole point (fire without an active JS context).
- Mobile: tray/autostart/window-state are desktop-only; ensure capability split so mobile
  builds don't reference desktop-only permissions.
- Focus-suppression needs an accurate `focused_room_id` — races between focus change and
  incoming event could cause a stray notification; acceptable Day-1, tighten later.

## Effort estimate

**L** — spans several distinct native subsystems (tray, per-OS badges, notifications,
autostart, window-state, menus) plus a responsive frontend shell and per-OS capability
plumbing; each is small but the cross-platform surface and testing matrix make the whole large.
