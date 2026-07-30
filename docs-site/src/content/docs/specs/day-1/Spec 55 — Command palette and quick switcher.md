---
title: Charm 2.0 Spec — Command palette and quick switcher
type: spec
project: Charm 2.0
created: 2026-07-13
status: in-progress
---

## Implementation status

The navigation-only v1 is decision-ready. Its ⌘F integration remains conditional
on the linked [Spec 28 message-search contract](/specs/day-1/spec-28--cross-room-message-search/)
landing first. No user-facing implementation exists yet.
The first code PR may start after approval to add an established fuzzy-search
dependency; the preferred choice is Fuse.js.

**Workstream:** one PR / one agent. New spec from the UI-parity deep-dive
(2026-07-13); two agents independently confirmed its absence.

## Problem & why now

Charm 1.0 has a **⌘/Ctrl-K quick switcher** — a modal to jump to any room / DM /
space by fuzzy name (`searchModalAtom`, `features/search/Search.tsx:613`,
documented in the keyboard-shortcuts panel). Charm 2.0 has nothing: no command
palette, no quick room jump (grep for cmdk/command-palette/quick-switch returns
nothing). For anyone with more than a handful of rooms, keyboard-driven navigation
is a core productivity affordance, and its absence is felt immediately by power
users migrating from 1.0 (or from Slack/Element/Discord, which all have it).

## Non-goals

- Not cross-room *message* search ([Spec 28](/specs/day-1/spec-28--cross-room-message-search/))
  — this jumps to *rooms/people/spaces* by
  name, not message content. (They can share a launcher surface — see below — but
  they're different result types.)
- Not a full action-command palette (run arbitrary commands) in v1 — start with
  navigation (jump to room/DM/space); adding commands (e.g. "create room", "toggle
  theme") is a natural follow-up.

## High-level design

- A modal launcher opened by **⌘K / Ctrl-K** and a clickable sidebar affordance,
  rendering a fuzzy-filtered list of the user's rooms, DMs, and spaces with avatar,
  name, and context (space membership or DM peer). Enter navigates; Arrow Up/Down,
  Home/End, Page Up/Down, and Esc work without leaving the input. Use the existing
  dialog primitives and Fuse.js over the already-synced room list.
- **In-room search hotkey (⌘F)**: Charm 1.0 also binds ⌘F to in-room message search.
  Wire ⌘F only after Spec 28's room-scoped search surface exists. The binding and
  shortcut-help row require both `quick_switcher` and
  `encrypted_local_message_search`; either flag can independently remove the
  integration. This spec owns delegation, not the search implementation.
- Keep an account-scoped, most-recent-first list of the last 20 successfully
  navigated room IDs. Reuse the account-keyed local-storage pattern already used by
  recent reactions; never share recents between accounts. Purge the recents key on
  logout, account deactivation, and local-data removal. Empty-query ordering is
  recents first, then remaining spaces, DMs, and rooms in stable room-list order.
- Register both shortcuts in the keyboard-shortcuts panel (which exists in 2.0) so
  they're discoverable.

### Result identity and navigation

- One Matrix room/space ID produces one result even when it appears in multiple
  spaces. Context may list more than one parent, but navigation identity is the room
  ID.
- DMs are ordinary room results with peer context, not user-profile results; v1
  does not create a new DM from a person search.
- Selecting a space activates its existing `SpaceRail` scope. Selecting a room or
  DM activates that room through the same navigation state used by `RoomList`.
- Exclude left/invited rooms and entries unavailable to the current account.
- Record a recent only after navigation succeeds. Stale recent IDs are filtered
  against the current synced result set and removed lazily.

## Data flow

Pure frontend over the already-synced room/space list — no new IPC for the
switcher itself. The v1 corpus is deliberately limited to fields already exposed
by `RoomSummary`: resolved room name, DM peer MXID, and parent-space context.
Canonical aliases and a separate DM-peer display name are deferred until that
summary contract exposes them without per-room fetches. Fuse.js must not inspect
message bodies, topics, or hidden account data. ⌘F delegates to Spec 28's
room-scoped search command and does not issue Matrix traffic itself.

## API/contract changes

- Add a default-off `quick_switcher` flag to the Rust and TypeScript catalogs.
  Although v1 is frontend-only, both catalogs remain authoritative and the global
  hotkey, sidebar entry, modal, recents writes, and shortcut-help row are all gated.
- No Matrix or Tauri command changes for the switcher. ⌘F reuses Spec 28's typed
  room-scoped search surface after it lands.

## Testing strategy

- Frontend: ⌘K opens the palette; typing filters rooms/DMs/spaces by fuzzy match;
  Enter navigates to the selected room; arrow/Esc behavior; empty-query shows
  recents. ⌘F opens room-scoped search (when Spec 28 present).
- Frontend: account switching cannot reveal the previous account's recents;
  duplicate multi-space rooms collapse to one result; stale recents are discarded;
  logout/deactivation removes the recents key; flag-off does not register either
  hotkey or write recents.
- a11y: focus trap in the modal, roving selection, screen-reader labels (through the
  Storybook axe gate), active-option announcements, and focus restoration to the
  launcher after close.
- E2E: open with the platform shortcut, fuzzy-match a space and room, navigate using
  keyboard only, reopen to verify recency, then exercise ⌘F once Spec 28 is present.
- Manual: with many rooms, jump to a room by typing part of its name in a couple of
  keystrokes.

## Trade-offs

- **Navigation-only v1 vs full command palette**: navigation is the high-value core
  and matches 1.0; commands can layer onto the same surface later without rework.
- **Share the launcher with message search vs separate**: keep the ⌘K room-jump and
  ⌘F message-search as distinct entry points (matching 1.0 and user muscle memory),
  even if they can share a modal shell.
- **Fuzzy matcher**: use Fuse.js rather than a bespoke scorer. Its mature weighted
  keys, match ranges, threshold controls, and deterministic tests cover the solved
  edge cases this feature needs. Adding it requires explicit dependency approval
  before `pnpm install`.

## What I'd revisit as this grows

- Action commands (create room/space, toggle settings) in the same palette.
- Including messages/files in the same launcher (unified search) if desired later.
