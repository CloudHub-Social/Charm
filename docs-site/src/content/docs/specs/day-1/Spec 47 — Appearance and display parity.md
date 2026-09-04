---
title: Charm 2.0 Spec — Appearance and display parity
type: spec
project: Charm 2.0
created: 2026-07-13
status: draft
---

**Workstream:** one PR / one agent (custom themes can split out if heavy). Extends
Spec 09 (theming) and Spec 27 (layout modes). A cluster of display/appearance
settings the audit found in Charm 1.0 but not Charm 2.0.

## Problem & why now

Charm 2.0's appearance settings (`AppearancePanel.tsx`, `appearance/atoms.ts`) cover
theme (dark/light/midnight/system), font size (4 steps), density (compact/cozy),
reduced motion, and layout mode (bubble/discord/irc) — a solid base. But the parity
audit (2026-07-13) found a set of Charm 1.0 display options missing
(`cosmetics/Themes.tsx`, `Cosmetics.tsx`, `settings.ts`). Individually small; as a
group they're the difference between "themeable" and "as configurable as Charm
1.0."

## Non-goals

- Not custom-emoji packs (day-2 Spec 05) — this is *emoji rendering style*
  (system vs twemoji), not pack management.
- Not the message-layout modes themselves (Spec 27, shipped).
- Not membership-event visibility toggles — those live with Spec 39 (state/
  membership events), where they actually have something to hide.

## Scope

Grouped by weight:

### Real gaps

1. **Custom theme import / CSS.** Charm 1.0 has `cosmetics/ThemeImportModal.tsx` +
   `ThemeCatalogSettings.tsx` (import a theme, browse a catalog). Charm 2.0 has a
   fixed 3-theme enum. Add custom-theme import — at minimum a set of additional
   built-in themes and an import path for a theme definition; full arbitrary-CSS
   injection is the heavier option (flag the security surface of injecting
   user-supplied CSS before allowing raw CSS — prefer a constrained token-override
   theme format over unrestricted CSS). This is the heaviest item and can split into
   its own PR.
2. **System emoji vs twemoji toggle.** Charm 1.0 `Themes.tsx:939` ("Twitter
   Emoji"). Charm 2.0 always uses one style. Add a toggle; the emoji picker (Spec
   37) and message rendering both honor it.

### Minor cluster (include together; each is small)

3. **12h/24h clock toggle** — Charm 1.0 `hour24Clock`; Charm 2.0's `formatTime` is
   hardcoded to locale default (`messageRowShared.tsx:61-62`).
4. **Configurable date format** — Charm 1.0 `dateFormatString`; Charm 2.0 uses a
   fixed Intl format (`timelineDividers.ts`).
5. **Finer message spacing** — Charm 1.0 `messageSpacing` (6 levels); Charm 2.0 has
   only 2-level density (compact/cozy). Widen the density control.
6. **Autoplay-media toggles** — autoplay GIFs / animated stickers / emoji (Charm
   1.0 `Themes.tsx:336,366,376`). The GIF one pairs with Spec 42's inline-GIF
   rendering — share the setting.
7. **Global font-family picker** (owner-added 2026-07-13 — "Sable has this"). A
   setting to choose the app's UI/message font family. Persist as a **synced** setting
   (Spec 50). Not present in Charm 1.0, but the owner wants parity with Sable here.

### Firm cosmetic scope (owner-confirmed 2026-07-13 — no longer "include if cheap")

The owner ruled these **in** (they were previously flagged optional):

8. **Pronoun pills** (`showPronouns`) — **must-have** per owner. Render a user's
   pronouns as a small pill next to their name (from the user's profile/pronoun
   field). Pairs with Spec 36 (profile cards) for where pronouns are read/set. This
   is also the confirmed scope of the "locale" adjudication — pronoun display is in;
   full app localization is the separate stretch Spec 51.
9. **Code-block syntax theme picker** (`Themes.tsx:178`).
10. **Page zoom** — scale the whole UI up/down.
11. **Saturation / accent adjustment** — beyond the fixed accent, let the user tune
    saturation/accent.
12. **Privacy blur** — blur media / emoji / GIFs / avatars until hovered/clicked
    (owner: "media/emoji/gifs/etc"). A privacy/NSFW-guard setting.
13. **Legacy username color** (`legacyUsernameColor`, owner-confirmed 2026-07-13).
    A toggle to use Charm 1.0's older per-user name-coloring algorithm instead of
    the current one, for users who want the familiar look. Match 1.0's exact
    color-hash function (`colorMXID`-equivalent) behind the toggle rather than
    approximating it — the point is visual continuity with 1.0, so an inexact
    recreation defeats the purpose.

## Implementation progress (2026-09-03)

The in-progress branch adds locale/12-hour/24-hour clock choices and locale,
day-first, month-first, and year-first date choices. These use the platform Intl
formatter, validated local persistence, and the default-off `appearance_parity`
flag. Message layouts and message/state-notice date dividers consume the settings;
relative Today/Yesterday labels remain unchanged. Disabling the flag restores
locale presentation without erasing saved preferences.

The branch also adds a global font-family picker with Charm default, system UI,
sans-serif, serif, and monospace presets. Fixed local CSS font stacks avoid remote
font requests or arbitrary CSS input; code-specific monospace styling is preserved.
The value is persisted locally and remains a required portable input for Spec 50.
The rollout flag gates its DOM application as well as its settings control.

Six message-spacing levels add 0, 2, 4, 8, 12, or 16 pixels between rows in all
three layouts. This is independent of the existing compact/cozy bubble-padding
control and does not shrink touch targets. Flag-off restores the layout's original
spacing while keeping the saved value. Extreme-spacing E2E snapshots cover bubble,
Discord, and IRC rendering; CI verification is still required.

This is not completion of Spec 47. The other scope items above, settings sync under
Spec 50, generated catalog reconciliation, end-to-end coverage, visual review, and
manual verification remain outstanding. CI is the verification environment.

## Data flow and settings ownership

Appearance settings use Spec 09's local store for immediate rendering (message
rows, dividers, emoji, media). Their portable values, including the global font
family, are required inputs to [Spec 50 — Cross-device settings sync](/specs/day-1/spec-50--cross-device-settings-sync/).
Spec 50 owns per-setting classification, account-data transport, opt-in behavior,
and export/import; synchronization is required, not an optional Spec 48 follow-up.
Device-specific values stay local under that classification. Custom-theme import
may need persistence for constrained theme definitions; arbitrary CSS and external
asset URLs must not enter the synced settings payload.

## API/contract changes

None Rust-side for the toggles (pure frontend/local settings). Custom-theme import
may add a local storage path for theme definitions. No IPC.

## Testing strategy

- Frontend: each toggle changes rendering (12h/24h flips timestamps; spacing
  widens; twemoji swaps glyph rendering; autoplay-GIF setting gates animation);
  custom theme applies and persists.
- Storybook + axe: run the timeline/message stories under a couple of the new
  settings (especially spacing extremes and twemoji) so the a11y gate catches
  contrast/target regressions.
- Manual: import/apply a custom theme; toggle 12h/24h and confirm all timestamps
  update.

## Trade-offs

- **Constrained theme format vs arbitrary CSS**: injecting user-supplied raw CSS is
  a real security/stability surface (can break layout, exfiltrate via background
  URLs) — prefer a token-override theme definition (extends Spec 09's token engine)
  over unrestricted CSS; only allow raw CSS behind an explicit "advanced" warning if
  at all.
- **Bundle the minor cluster vs many micro-PRs**: bundled — they're all one-line-ish
  settings in the same panel; splitting each would be pure overhead. Custom themes
  is the only piece heavy enough to reasonably split out.

## What I'd revisit as this grows

- A community theme catalog (Charm 1.0 has one) if custom-theme import sees real
  use — larger surface (hosting, trust), its own spec.
