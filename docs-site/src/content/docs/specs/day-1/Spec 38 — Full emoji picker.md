---
title: Charm 2.0 Spec — Full emoji picker
type: spec
project: Charm 2.0
created: 2026-07-13
status: shipped
---

## Implementation status

Charm now ships the shared full-Unicode picker behind the default-off
`full_emoji_picker` flag. The existing compact reaction grid remains the fallback
while the flag is disabled. When enabled, `emoji-picker-react@4.19.1` is loaded only
when the popover opens and provides search, category navigation, recent ordering,
skin-tone variants, native system glyphs, and lazy emoji rendering.
Its chrome follows the user's Charm appearance choice: light uses the light
picker, dark and midnight use the dark picker, and system delegates to the OS
color scheme.

The same `EmojiPicker` wrapper mounts from message reactions and the TipTap
formatting toolbar; composer selection inserts at the active cursor. Optional
named extra-category inputs are flattened into the library's custom-emoji category,
giving day-2 Spec 05 a stable pack-injection seam without changing either caller.
Component regressions cover the flag fallback, full-picker configuration, custom
emoji forwarding, popover close, and cursor insertion. The dedicated Storybook
story exercises the real grid through the repository's remote build, axe, and
visual-snapshot gates.

**Workstream:** one PR / one agent. Shared component underpinning Spec 03
(reactions), Spec 04 (composer emoji), and day-2 Spec 05 (custom emoji/sticker
packs).

## Problem & why now

Before this delivery, Charm 2.0's emoji picker (`src/features/rooms/EmojiPicker.tsx`)
was **40 hardcoded emoji with no search and no custom emoji**. The parity audit
(2026-07-13) flagged this from two directions:

- **Reactions** (Spec 03): reacting is limited to those 40; Charm 1.0 uses a full
  `EmojiBoard` picker with search and categories.
- **Composer** (Spec 04): Charm 2.0 has `:shortcode:` autocomplete but **no
  clickable emoji-browse button** (`Composer.tsx:310` is autocomplete only); Charm
  1.0 has an `EmojiBoard` button in `RoomInput.tsx`.

Both need the same thing: a real, searchable, full-Unicode emoji picker component.
Building it once and using it in both places (and as the plug-in point for day-2's
custom emoji packs) is the clean move.

## Non-goals

- Not custom-emoji-pack *management/discovery* — that's day-2 Spec 05. This spec
  builds the picker component with a clean extension point so pack emoji can be
  injected as an additional category later, but doesn't implement pack
  subscription itself.
- Not stickers — also day-2 (Spec 05). A sticker tab can be added to this same
  surface later.
- Not a full skin-tone-variant management system beyond what the emoji dataset
  provides out of the box (most emoji libraries include skin-tone modifiers; use
  them, don't build a bespoke system).

## High-level design

- Behind `full_emoji_picker`, replace `EmojiPicker.tsx`'s hardcoded list with the
  lazy-loaded `emoji-picker-react` picker: full Unicode
  emoji dataset, category tabs (smileys, people, nature, food, activities, etc.),
  **search by name/shortcode**, account-scoped recently-used section (persisted
  locally), and
  skin-tone selection. Native emoji rendering avoids a new image-CDN dependency;
  the library's dataset remains outside the initial bundle. Spec 04's compact
  shortcode map remains the keystroke fast path rather than eagerly importing the
  browse dataset.
- **Two mount points, one component:**
  - Reaction picker: opened from `MessageActions` "React"; selecting inserts an
    `m.reaction`.
  - Composer emoji button: a new button in the composer toolbar
    (`FormattingToolbar.tsx` area) that opens the same picker and inserts the emoji
    at the cursor.
- **Extension point:** the picker takes an optional set of extra categories
  (custom emoji), so day-2 Spec 05 injects subscribed pack emoji without modifying
  this component's core.
- **Appearance:** read the canonical Spec 09 theme atom. Map Charm's light theme
  to the picker's light theme, dark and midnight to dark, and system to auto so
  live OS color-scheme changes continue to apply.
- Respect the "use system emoji vs twemoji" appearance setting once that exists
  (Spec 47) — render the chosen glyph style; until then, system default.

## Data flow

Emoji data is bundled into the lazy picker chunk — no IPC. Charm persists the
recently-used ordering through its existing Matrix-account-scoped reaction store.
The dependency's profile-wide Suggested category is disabled and its legacy
`epr_suggested` key is cleared so switching accounts cannot expose another user's
emoji history. Reaction insert and composer insert reuse existing send/compose
paths.

## API/contract changes

None (no Rust/IPC). Pure frontend component swap + a new composer toolbar button.

## Testing strategy

- Frontend: picker renders categories, search filters correctly, skin-tone
  variant selection works, recently-used updates and persists; reaction mount
  inserts `m.reaction`; composer mount inserts at cursor.
- Storybook + axe: the picker is a large interactive grid — exercise keyboard
  navigation and focus management through the a11y gate (an easy area to regress).
- Manual: react with a searched-for emoji; open the composer emoji button and
  insert mid-sentence.

## Trade-offs

- **Reuse the Spec 04 autocomplete's emoji dataset vs a picker-specific one**:
  the existing autocomplete has only a compact map, not a full dataset. The chosen
  picker therefore owns the sole full dataset and is lazy-loaded; keeping the tiny
  map on the typing path avoids eagerly loading the browse chunk.
- **Build the extension point now vs retrofit for day-2 packs later**: adding the
  optional-extra-categories seam now is cheap and saves day-2 Spec 05 from having
  to refactor this component; building the whole pack system now would over-reach
  this spec's scope.

## What I'd revisit as this grows

- Sticker tab (day-2 Spec 05).
- Frequently-used vs recently-used ranking if users want smarter ordering.
