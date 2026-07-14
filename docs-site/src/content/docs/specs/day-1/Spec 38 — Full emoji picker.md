---
title: Charm 2.0 Spec — Full emoji picker
type: spec
project: Charm 2.0
created: 2026-07-13
status: draft
---

**Workstream:** one PR / one agent. Shared component underpinning Spec 03
(reactions), Spec 04 (composer emoji), and day-2 Spec 05 (custom emoji/sticker
packs).

## Problem & why now

Charm 2.0's emoji picker (`src/features/rooms/EmojiPicker.tsx`) is **40 hardcoded
emoji with no search and no custom emoji**. The parity audit (2026-07-13) flagged
this from two directions:

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

- Replace `EmojiPicker.tsx`'s hardcoded list with a real picker: full Unicode
  emoji dataset, category tabs (smileys, people, nature, food, activities, etc.),
  **search by name/shortcode**, recently-used section (persisted locally), and
  skin-tone selection. Prefer a well-maintained, reasonably-sized emoji dataset
  over hand-maintaining one — check what's already available in the dependency
  tree (the `:shortcode:` autocomplete from Spec 04 already needs an emoji dataset;
  reuse that same source rather than adding a second).
- **Two mount points, one component:**
  - Reaction picker: opened from `MessageActions` "React"; selecting inserts an
    `m.reaction`.
  - Composer emoji button: a new button in the composer toolbar
    (`FormattingToolbar.tsx` area) that opens the same picker and inserts the emoji
    at the cursor.
- **Extension point:** the picker takes an optional set of extra categories
  (custom emoji), so day-2 Spec 05 injects subscribed pack emoji without modifying
  this component's core.
- Respect the "use system emoji vs twemoji" appearance setting once that exists
  (Spec 47) — render the chosen glyph style; until then, system default.

## Data flow

Emoji dataset is bundled/static — no IPC. Recently-used list persists in the local
settings store (same store as other client-local prefs). Reaction insert and
composer insert reuse existing send/compose paths.

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
  reuse avoids shipping two emoji datasets (bundle-size and consistency win — a
  shortcode that autocompletes should exist in the picker and vice versa).
- **Build the extension point now vs retrofit for day-2 packs later**: adding the
  optional-extra-categories seam now is cheap and saves day-2 Spec 05 from having
  to refactor this component; building the whole pack system now would over-reach
  this spec's scope.

## What I'd revisit as this grows

- Sticker tab (day-2 Spec 05).
- Frequently-used vs recently-used ranking if users want smarter ordering.
