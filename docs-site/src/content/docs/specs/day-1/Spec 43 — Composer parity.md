---
title: Charm 2.0 Spec — Composer parity
type: spec
project: Charm 2.0
created: 2026-07-13
status: draft
---

**Workstream:** one PR / one agent. Extends Spec 04 (composer). Autocomplete is
already at full parity; this closes the slash-command breadth and formatting gaps.

## Problem & why now

The parity audit (2026-07-13) found Charm 2.0's composer solid on autocomplete
(@user, #room, :emoji:, /command all covered) but thin on two axes vs Charm 1.0:

- **Slash-command breadth:** Charm 2.0's `slashCommands.ts:11` has **5** commands
  (`/me`, `/topic`, `/invite`, `/kick`, `/ban`). Charm 1.0's `useCommands.ts:233-296`
  has **~40** (`/shrug`, `/notice`, `/join`, `/leave`, `/myroomnick`, `/html`,
  `/rainbow`, `/tableflip`, `/ignore`, `/startdm`, `/discardsession`, and more).
- **Formatting:** Charm 2.0's `FormattingToolbar.tsx` = bold/italic/inline-code/
  quote/bullet/ordered. Missing **spoiler** (confirmed absent — Charm 1.0
  `markedAsSpoiler`), **block code** (only inline code today, `toggleCode`), and
  **strikethrough**.

The composer emoji-browse button is handled separately by Spec 38.

## Non-goals

- Not a WYSIWYG rebuild — Charm 2.0's TipTap composer stays; this adds
  marks/commands to it.
- Not the emoji-browse button (Spec 38).

## Scope

### Slash commands

Expand `slashCommands.ts` to cover Charm 1.0's set, grouped by what they do:
- **Message-style:** `/me` (have), `/notice`, `/shrug`, `/tableflip`, `/rainbow`,
  `/plain`, `/html` (send raw HTML).
- **Room actions:** `/topic` (have), `/invite` (have), `/kick` (have), `/ban`
  (have), `/unban`, `/join`, `/leave`, `/op`/`/deop` (power level), `/nick`
  (display name), `/myroomnick` (per-room nick — overlaps Spec 36's per-room
  profile; share the underlying command).
- **User/session:** `/ignore`, `/unignore`, `/startdm`, `/discardsession`
  (rotate megolm session).
  Audit each against what matrix-rust-sdk exposes and what Charm 2.0 already has
  commands for (many map to existing IPC — `/invite` already works, `/ignore` maps
  to the block-list mutation, etc.); this is largely wiring composer verbs to
  existing capabilities, not net-new backend for each. Commands with no safe
  mapping (or that don't apply to this client) can be omitted — note which and why.

### Formatting marks

- **Spoiler:** add a spoiler toolbar button + serialization to the Matrix spoiler
  format (`<span data-mx-spoiler>`), and rendering support (click-to-reveal) in
  `MessageRow` — spoilers need both the send and the render side. Confirm the render
  side isn't already handled by `sanitizeMatrixHtml`; if received spoilers already
  render, this is send-side only.
- **Block code:** a fenced-code-block button distinct from the existing inline-code
  toggle (`FormattingToolbar.tsx:35`).
- **Strikethrough:** add the mark + toolbar button (TipTap has a strike extension).

### Up-arrow to edit last message

Confirmed present in Charm 1.0 (owner-confirmed 2026-07-13 — the audit had wrongly
marked this "not confirmed in 1.0"). Pressing ArrowUp in an **empty** composer
loads the current user's most recent editable message into the composer for editing
(Charm 1.0 behavior). Charm 2.0's `Composer.tsx:358` currently uses ArrowUp only for
autocomplete-suggestion navigation — so this must only trigger when the composer is
empty and no autocomplete popup is open, to avoid stealing the key from suggestion
nav. Reuses the existing edit-message path (Spec 04 / `useMessageActions`), just
triggered by the key instead of the action menu.

### Spell-check (OS-provided)

Owner note (2026-07-13): nice-to-have, and the OS/webview normally handles it. So
the scope here is minimal — ensure the composer's editable surface has native
spell-check **enabled** (`spellcheck` attribute / TipTap config) so the OS underline-
and-correct works; do not build a custom dictionary/spell engine. Verify it's on
across the Tauri webviews (behavior can differ per platform).

## Data flow

Slash commands are parsed in the composer and dispatched to existing IPC/actions;
formatting marks are TipTap marks serialized into `formatted_body` on send (Spec
04's existing serialization path, `composerSerialize.ts`). Spoiler rendering is a
`MessageRow` presentation concern.

## API/contract changes

Mostly none — commands map to existing IPC where possible. Any command needing a
new backend verb (e.g. `/discardsession` if not already exposed) gets a small IPC
addition. No DTO changes for formatting (rides `formatted_body`).

## Testing strategy

- Frontend: each slash command parses and dispatches to the right action (mock the
  IPC); unknown/no-arg commands show sensible help/error; spoiler/block-code/strike
  buttons produce correct `formatted_body`; spoiler renders click-to-reveal.
- Unit: `composerSerialize` output for each new mark.
- Manual: send a spoiler and confirm a second client (and Charm 2.0 itself) hides
  then reveals it; run several slash commands end-to-end.

## Trade-offs

- **Wire verbs to existing IPC vs new backend per command**: most Charm 1.0
  commands map to capabilities Charm 2.0 already has (invite, ban, ignore, DM) —
  the work is composer parsing + dispatch, not 40 new backend commands. Only the
  few with no existing mapping need backend work; skip any that don't apply rather
  than inventing them.

## UI-parity addition (from the 2026-07-13 UI deep-dive)

- **Link-insert toolbar button.** Charm 1.0's formatting toolbar has a link-insert
  action; Charm 2.0's `FormattingToolbar.tsx` (bold/italic/code/quote/lists, plus
  the spoiler/block-code/strike this spec adds) has no "insert link" button. Add one
  (select text → add URL → `<a>` mark) alongside the other formatting marks.

## What I'd revisit as this grows

- Custom/user-defined command aliases — not in Charm 1.0, not built now.
