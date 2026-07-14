---
title: Charm 2.0 Spec — Command palette and quick switcher
type: spec
project: Charm 2.0
created: 2026-07-13
status: draft
---

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

- Not cross-room *message* search (Spec 28) — this jumps to *rooms/people/spaces* by
  name, not message content. (They can share a launcher surface — see below — but
  they're different result types.)
- Not a full action-command palette (run arbitrary commands) in v1 — start with
  navigation (jump to room/DM/space); adding commands (e.g. "create room", "toggle
  theme") is a natural follow-up.

## High-level design

- A modal launcher opened by **⌘K / Ctrl-K** (and a clickable affordance, e.g. the
  search field in the sidebar), rendering a fuzzy-filtered list of the user's rooms,
  DMs, and spaces with avatar + name + context (space it's in / DM peer). Enter
  navigates; arrow keys move; Esc closes. Uses the existing dialog system
  (`components/ui/dialog.tsx`) and a fuzzy matcher over the already-synced room list.
- **In-room search hotkey (⌘F)**: Charm 1.0 also binds ⌘F to in-room message search.
  Wire ⌘F to open Spec 28's search scoped to the current room (this spec provides the
  hotkey + entry; Spec 28 provides the search itself). If Spec 28 hasn't landed,
  ship the quick-switcher alone and add ⌘F when it does.
- Recent/frequently-visited rooms shown first when the query is empty (nice-to-have,
  matches the "jump back to where I was" use case).
- Register both shortcuts in the keyboard-shortcuts panel (which exists in 2.0) so
  they're discoverable.

## Data flow

Pure frontend over the already-synced room/space list — no new IPC for the switcher
itself. Fuzzy matching client-side (small dependency or hand-rolled). ⌘F delegates to
Spec 28's search command.

## API/contract changes

None for the switcher (uses existing room-list data). ⌘F reuses Spec 28's search.

## Testing strategy

- Frontend: ⌘K opens the palette; typing filters rooms/DMs/spaces by fuzzy match;
  Enter navigates to the selected room; arrow/Esc behavior; empty-query shows
  recents. ⌘F opens room-scoped search (when Spec 28 present).
- a11y: focus trap in the modal, roving selection, screen-reader labels (through the
  Storybook axe gate).
- Manual: with many rooms, jump to a room by typing part of its name in a couple of
  keystrokes.

## Trade-offs

- **Navigation-only v1 vs full command palette**: navigation is the high-value core
  and matches 1.0; commands can layer onto the same surface later without rework.
- **Share the launcher with message search vs separate**: keep the ⌘K room-jump and
  ⌘F message-search as distinct entry points (matching 1.0 and user muscle memory),
  even if they can share a modal shell.

## What I'd revisit as this grows

- Action commands (create room/space, toggle settings) in the same palette.
- Including messages/files in the same launcher (unified search) if desired later.
