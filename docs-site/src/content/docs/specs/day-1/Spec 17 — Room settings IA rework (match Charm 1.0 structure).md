---
title: "Charm 2.0 Spec — Room settings IA rework (match Charm 1.0 structure)"
type: spec
project: Charm 2.0
created: "2026-07-07"
status: shipped
sidebar:
  label: "Room settings IA rework"
---

**Workstream:** one PR / one agent. **Tier:** post-Day-1 UX rework.

## Problem & why now

Charm 2.0's room settings/info surface (Spec 07) shipped as a permanent right-hand
sidebar panel with 3 shallow tabs. The owner prefers Charm 1.0's room-settings
information architecture — not its visual styling (Charm 2.0 keeps its own design
system/tokens from Spec 09), but its **structure**: how the surface is presented, how
it's navigated, and what's grouped where. This spec reworks Charm 2.0's room-settings
IA to match Charm 1.0's structure, verified directly against both codebases (not
guessed from memory).

## Current state (in repo, verified 2026-07-07)

**Charm 1.0** (legacy Cinny-derived codebase):
- `RoomSettingsRenderer.tsx` / `RoomSettings.tsx`
  (`src/app/features/room-settings/`) renders as a **modal** (`Modal500`,
  full-screen on mobile), globally mounted, state in a jotai atom
  (`roomSettingsAtom`), opened via `useOpenRoomSettings()`.
- Triggered from `RoomViewHeader.tsx`'s room-name dropdown ("Room Settings"
  menu item), the room-list context menu, and the space-hierarchy menu — can
  deep-link straight to a specific page (e.g.
  `openSettings(roomId, spaceId, RoomSettingsPage.MembersPage)`).
- A separate, lightweight **`MembersDrawer.tsx`** (`src/app/features/room/`)
  exists alongside the modal — a quick member-browse surface toggled from the
  header, independent of the full settings modal.
- Left-nav + detail-pane split inside the modal
  (`RoomSettings.tsx:50-90`), 7 sections: **General, Members, Permissions,
  Cosmetics, Abbreviations, Emojis & Stickers, Developer Tools**. Collapses
  to single-page-at-a-time on mobile.
- `Members.tsx`: searchable/sortable virtualized list with a **membership
  filter chip** (Joined/Invited/Left/Kicked/Banned, mutually exclusive,
  defaults to Joined) via `useMembershipFilterMenu`. Clicking a member opens
  a separate globally-mounted `UserRoomProfile` card (not nested in the
  settings tree); kick/ban via `UserModeration.tsx`; roles via
  `PowerChip.tsx`. Invite is a separate header/context-menu-triggered flow
  (`InviteUserPrompt.tsx`), not part of Members settings.
- `General.tsx`: grouped sub-sections — Profile card (name/topic/avatar/
  banner), Options (join rules/history visibility/encryption/publish),
  Addresses (published/local), Advanced Options (room upgrade).
- `Permissions.tsx`: its own top-level nav item, containing `Powers.tsx`
  (role summary) + `PermissionGroups.tsx` (per-action editor) +
  `PowersEditor.tsx` (raw editing) — a distinct page, not merged with
  General.

**Charm 2.0** (this repository):
- `RoomInfoPanel.tsx` (`src/features/room-info/`) is a **permanent
  right-hand column** (`w-80`, no overlay/scrim), rendered by
  `RoomsScreen.tsx`/`ChatShell.tsx`, toggled by an `Info` header icon
  (`ChatShell.tsx`) into a per-room `atomFamily<boolean>`. Never a modal.
- Horizontal Radix `Tabs`, only **3 sections**: Info (settings form +
  power-level thresholds combined), Members, Pinned (disabled "Coming soon"
  stub).
- `MemberList.tsx`/`MemberRow.tsx`: no search, no sort, no membership-state
  filter. Groups into two fixed buckets shown together: active (join +
  invite) and Banned. Per-row `⋯` dropdown (Set power level / Kick / Ban /
  Unban) gated by `PermissionGate`/`GatedItem`; invite is a Dialog launched
  from a button *inside* the Members tab.
- `RoomSettingsForm.tsx`: one flat scroll — name/topic (inline edit+save),
  avatar (upload-only, no remove/preview), join rule, history visibility,
  encryption (irreversible, confirm dialog). No banner, no published
  addresses, no room-upgrade equivalent.
- `PowerLevelThresholdsEditor` is appended directly under the Info tab's
  settings form — not a standalone section.

## Scope (in)

1. **Shell**: replace the permanent right-hand panel with a **modal**
   (full-screen on mobile, matching Charm 1.0's `Modal500` pattern), opened
   from the same header trigger `ChatShell.tsx` already has. Decide whether
   to keep a lightweight always-on member-browse surface (mirroring
   `MembersDrawer`) separate from the full settings modal, or fold that into
   the modal's Members section — recommend keeping a lightweight drawer,
   since that's what Charm 1.0 actually does and it's a real, distinct UX
   affordance (quick member glance without a full modal).
2. **Navigation**: rebuild the left-nav + detail-pane split with at minimum:
   **General, Members, Permissions**. Cosmetics, Abbreviations, Emojis &
   Stickers, Developer Tools have no Charm 2.0 equivalent feature at all —
   out of scope for this spec (no underlying feature to expose); revisit only
   if those features get built later.
3. **Permissions as its own section**: move `PowerLevelThresholdsEditor` out
   of the Info/General tab into a dedicated Permissions section, matching
   Charm 1.0's separation.
4. **Member management**: add search, sort, and a membership-state filter
   (Joined/Invited/Banned at minimum — Charm 2.0 has no "Left"/"Kicked"
   distinct membership states surfaced elsewhere, confirm against
   `room_admin.rs`'s actual membership data before committing to the full
   1.0 filter set).
5. **Room settings fields**: add labeled grouping (Profile / Options /
   Advanced, mirroring 1.0's card structure) to `RoomSettingsForm.tsx`. Add
   room banner and published-address fields if the Rust-side
   `room_admin.rs` already exposes the underlying data/actions (check before
   building new backend surface — this spec is IA-focused, not new-Rust-API
   scope creep). Room upgrade is out of scope unless trivial to wire.

## Non-goals (out)

- Any visual/token/color change — Charm 2.0's design system (Spec 09) stays
  as-is; only structure/navigation changes.
- Cosmetics, Abbreviations, Emojis & Stickers, Developer Tools sections —
  no underlying Charm 2.0 feature exists to expose; not in scope.
- New Rust-side capabilities beyond what `room_admin.rs` already supports
  (e.g. don't build room-upgrade support from scratch if it doesn't exist).

## Design & approach

- Keep `RoomInfoPanel`'s existing data-fetching/state (via whatever hooks
  currently back it) — this is a presentation/IA rework, not a data-layer
  rewrite. The modal's content panes can likely reuse most of the existing
  `RoomSettingsForm`/`MemberList`/`PowerLevelThresholdsEditor` components
  largely as-is, just re-homed into a left-nav + detail-pane modal shell
  instead of tabs in a sidebar.
- If a lightweight member-browse drawer is kept (recommended), it can likely
  be a thinner wrapper around the existing `MemberList` component rather
  than a new implementation.
- Follow this repo's git-worktree-isolation convention (`CLAUDE.md`).

## Acceptance criteria

1. Room settings opens as a modal (full-screen on mobile), not a permanent
   sidebar panel.
2. Left-nav + detail-pane split with at least General, Members, Permissions
   as distinct sections.
3. Permissions/power-level editing lives in its own section, not folded into
   General.
4. Member list supports search and a membership-state filter.
5. Room settings fields are visually grouped (not one flat list).
6. `pnpm test:coverage`, `pnpm build`, Storybook a11y, and existing e2e specs
   touching room info/settings all still pass — update/add coverage for the
   new modal shell and navigation.

## Testing

- Vitest/RTL for the new modal shell, left-nav section switching, and the
  membership filter.
- Update `e2e/room-info.spec.ts` (or equivalent) for the new modal-based
  flow if it currently asserts against the sidebar-panel shape.
- Storybook stories for the modal shell + each settings section, running
  through the existing blocking-a11y CI gate.

## Dependencies & sequencing

- Independent of Spec 11/16 (push, web client) — pure frontend IA rework
  layered on Spec 07's existing room-admin data/actions.
- No Rust-side changes expected unless the banner/address fields need new
  `room_admin.rs` support (verify first).

## Effort estimate

**M** — a real IA rework (new modal shell, left-nav navigation, member
search/filter) but reusing most existing data-fetching and several existing
components rather than building new backend capability.
