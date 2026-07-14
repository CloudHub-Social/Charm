---
title: "Charm 2.0 Spec — Global settings IA rework (match Charm 1.0 structure)"
type: spec
project: Charm 2.0
created: "2026-07-07"
status: shipped
sidebar:
  label: "Global settings IA rework"
---

**Workstream:** one PR / one agent. **Tier:** post-Day-1 UX rework.

## Problem & why now

Charm 2.0's global/account settings (Spec 08) shipped as a non-routed,
full-screen overlay with 5 sections and no shared internal layout convention.
The owner prefers Charm 1.0's settings information architecture — not its
visual styling (Charm 2.0 keeps its own design system/tokens from Spec 09),
but its structure: routing, section list, and internal layout consistency.
This spec reworks Charm 2.0's settings IA to match, verified directly against
both codebases (not guessed from memory, and cross-checked by two independent
audits that reached consistent conclusions).

## Current state (in repo, verified 2026-07-07)

**Charm 1.0** (legacy codebase):
- Real **routed page** (`SettingsRoute.tsx`, `settingsLink.ts`) — deep-linkable
  URLs (`/settings/:section`), not a modal-only surface. Rendered inside
  `PageRoot`/`PageNav`, the same shell primitive used for room views.
  Desktop shows a **centered modal** (`Modal500`) over a frozen background
  route; mobile/direct-nav shows a **full-page** view — same component, two
  wrapper modes.
- Triggered from the sidebar account-switcher avatar menu
  (`AccountSwitcherTab.tsx` → `openSettings()`), plus deep-linked to from
  elsewhere in the app (e.g. an unverified-session banner →
  `openSettings('devices')`).
- 12 flat sections in a left nav rail: **General, Account, Persona**
  (feature-flagged), **Appearance, Notifications, Devices, Desktop**
  (Tauri-only), **Emojis & Stickers, Developer Tools** (lazy-loaded),
  **Experimental, About, Keyboard Shortcuts**. Logout is a **persistent
  nav-rail footer action**, not a section.
- Every section follows one consistent internal convention: an `L400`
  category heading (e.g. "Date & Time", "Security", "Current") followed by a
  `SequenceCard` (bordered/rounded card container) holding one or more
  `SettingTile` rows (title + description + trailing control). Applied
  uniformly across every section — no sub-tabs/accordions, just
  heading-delimited card groups on one scroll.
- Devices (`devices/Devices.tsx`): grouped Security (verification controls) /
  Current (current-device card + verify + backup-restore) / Others (list,
  per-device verification badge, revoke) / a `LocalBackup` section — plus a
  sticky multi-select "sign out selected" bulk action bar.
- Notifications: 4 separately-configurable groups — System, All Messages,
  Special Messages, Keyword Messages — each independently tunable.
- Account: Profile / Matrix ID / Contact Information / Blocked Users.
  Password-change and deactivate-account flows were **not found implemented**
  (dead action constants only, per the audit) — may live elsewhere or be
  unfinished in 1.0 itself.

**Charm 2.0** (this repository):
- `SettingsScreen.tsx` is a **`fixed inset-0` full-screen overlay** driven by
  a jotai atom (`settingsOpenAtom`), **not routed** — no URL, no deep-link
  entry points from elsewhere in the app.
- Triggered by a plain gear icon in `RoomList.tsx`'s header and a mobile
  bottom-tab item — no account-switcher/avatar menu (Charm 2.0 is
  single-account, so this entry point doesn't map 1:1, see Non-goals).
- **5 sections**: Account, General, Notifications, Devices, Appearance.
  "General" is a thin stand-in (just autostart + OS-notification-permission)
  versus 1.0's much larger General (Date/Time, Accessibility, Editor,
  Messages, Embeds, Calls, Backup, Diagnostics).
- Each panel is a `<div className="max-w-lg space-y-8">` of ad hoc
  `<section>` blocks — no shared card/row primitive equivalent to 1.0's
  `SequenceCard`/`SettingTile`; each panel free-styles its own layout
  (`AccountPanel`'s bespoke sections vs. `AppearancePanel`'s `divide-y` rows
  vs. `NotificationsPanel`'s mixed checkboxes/dropdowns).
- Devices (`DevicesPanel.tsx`): cross-signing status card, then three flat
  groups (This device / Verified / Unverified), per-row `⋮` menu. No bulk
  multi-select sign-out.
- Notifications (`NotificationsPanel.tsx`): global mode dropdown, DND
  checkbox, keyword chips, sound (unwired), **plus a per-room override
  list** — broader than 1.0 in this one respect (1.0 has no per-room
  notification settings at all).
- Account (`AccountPanel.tsx`): Profile, Password (change, OAuth-aware),
  Sign out, Danger zone (deactivate, OAuth-aware) — already more complete
  than 1.0's Account section in this respect (password change + deactivate
  are actually implemented).

## Scope (in)

1. **Routing**: give settings a real route/URL (or Tauri-appropriate
   equivalent — a stable, addressable location within the app's own
   navigation state, not necessarily a browser-style URL if that doesn't fit
   Tauri's shell) so it can be deep-linked to from elsewhere in the app
   (e.g. an unverified-device banner linking straight to Devices).
2. **Shell modes**: desktop gets a centered-modal-over-frozen-background
   presentation; mobile gets full-page — matching 1.0's dual-mode single
   component, not the current single full-screen-overlay-always mode.
3. **Section list**: add the sections that have no Charm 2.0 equivalent yet
   and are worth having: **About, Keyboard Shortcuts**. Fold Desktop-specific
   toggles (currently jammed into "General") into their own **Desktop**
   section on Tauri builds. **Experimental/Labs** — add only if there's
   actually something to flag/toggle today; otherwise stub it minimally so
   the section exists for future use. **Emojis & Stickers, Developer Tools,
   Persona** — no underlying Charm 2.0 feature exists; out of scope (see
   Non-goals).
4. **Shared internal layout convention**: introduce a reusable
   card/heading/row primitive (a `SequenceCard`/`SettingTile`-equivalent) and
   migrate each existing panel to it, so every section reads consistently.
5. **Devices**: add a bulk multi-select "sign out selected" action, matching
   1.0.
6. **Notifications**: consider splitting the single "default mode" enum into
   independently tunable All/Special/Keyword categories matching 1.0's
   three-tier model — evaluate whether this is a real improvement or just
   different for its own sake; Charm 2.0's per-room-override addition should
   be kept regardless (1.0 doesn't have it and it's a net improvement).
7. **Account**: add Matrix ID display, Contact Information, and a
   Blocked/Ignored Users list (features 1.0 has that 2.0 lacks).

## Non-goals (out)

- Any visual/token/color change — Charm 2.0's design system (Spec 09) stays
  as-is; only structure/navigation/routing changes.
- An account-switcher menu / multi-account entry point — Charm 2.0 is
  explicitly single-account for now (per the planning doc); a plain settings
  entry point (gear icon or equivalent) is fine, don't build multi-account
  UI as a side effect of this spec.
- Persona, Emojis & Stickers, Developer Tools sections — no underlying
  Charm 2.0 feature exists to expose.
- Removing Charm 2.0's per-room notification overrides — this is a genuine
  improvement over 1.0, keep it.
- Local backup/key-restore UI — flagged by the audit as possibly missing in
  Charm 2.0 entirely; if it doesn't exist anywhere else in the app, adding it
  is out of scope for this IA-focused spec (file as a follow-up if it's a
  real gap, not a structural one).

## Design & approach

- Introduce the shared card/row primitive first (e.g. `SettingsCard` +
  `SettingsRow` components under `src/features/settings/` or a shared UI
  location), then migrate each existing panel onto it — this can likely be
  done incrementally per-panel within the same PR without a risky big-bang
  rewrite.
- For routing: check what navigation primitive the rest of Charm 2.0 uses
  (React Router? A custom screen-stack? Confirm before assuming) and follow
  that existing pattern rather than introducing a new one.
- Follow this repo's git-worktree-isolation convention (`CLAUDE.md`).

## Acceptance criteria

1. Settings is reachable via a stable, linkable location (not just an
   ephemeral atom toggle) and can be deep-linked to a specific section from
   elsewhere in the app.
2. Desktop shows a centered-modal-over-frozen-background; mobile shows
   full-page.
3. About and Keyboard Shortcuts sections exist; Desktop-specific toggles are
   in their own section, not folded into General.
4. Every settings panel uses the same shared card/heading/row layout
   convention.
5. Devices supports bulk multi-select sign-out.
6. Account shows Matrix ID, Contact Information, and a Blocked/Ignored Users
   list.
7. `pnpm test:coverage`, `pnpm build`, Storybook a11y, and existing e2e specs
   touching settings all still pass — update/add coverage for the new
   routing/shell modes and shared layout primitive.

## Testing

- Vitest/RTL for the new routing/deep-link behavior, shell-mode switching
  (modal vs full-page), and the shared card/row primitive.
- Update `e2e/settings.spec.ts` (or equivalent) for the new shell if it
  currently asserts against the always-full-screen-overlay shape.
- Storybook stories for the shared primitive and each migrated panel,
  running through the existing blocking-a11y CI gate.

## Dependencies & sequencing

- Independent of Spec 11/16 (push, web client) and of Spec 17 (room
  settings) — separate surfaces, can run concurrently with Spec 17.
- No Rust-side changes expected for the IA rework itself; Matrix ID/Contact
  Info/Blocked Users may need small `account.rs`/`devices.rs` additions if
  the underlying data isn't already exposed — check before assuming new
  backend work is needed.

## Effort estimate

**M** — routing change, a new shared layout primitive applied across ~5
existing panels, plus a few net-new sections/fields. Larger than a pure
visual tweak but reuses most existing panel logic.
