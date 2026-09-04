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

## Implementation progress

`/notice` is staged behind `composer_parity` and dispatches through `run_command`
on native and web. The backend uses Ruma's `notice_plain` constructor and the
existing serialized send helper, preserving `m.notice` semantics and refusing
blank text. Parser and wire-content regressions are included. The updated
`SlashCommand` union requires CI-generated bindings; generation and end-to-end
verification remain pending.

The editable surface enables native `spellcheck` only while the default-off
`composer_parity` flag is enabled. Rollout and kill-switch changes update the live
editor without discarding its draft, with DOM regression coverage for both
transitions. Platform-native underline and correction behavior still requires manual
verification. Strikethrough and code-block toolbar controls use the existing
TipTap StarterKit extensions behind the default-off `composer_parity` flag.
Their command dispatch and hidden-by-default behavior have regression tests.
The new flag's generated frontend catalog/type still needs CI-generated output
committed before this draft is buildable. Link insertion uses the existing TipTap
link mark and an accessible dialog, validates absolute web/mail/telephone URLs,
rejects embedded credentials, and refuses stale selections after draft changes.
Room/account changes remount the toolbar and close its dialog. These behaviors
have regression tests but remain pending CI verification. Bare ArrowUp in an empty
send-mode paragraph reuses the existing edit action for the latest editable own
text message in the loaded timeline, behind the same default-off flag. It skips
local echoes, failed sends, redactions, undecrypted placeholders, and attachments;
autocomplete, IME composition, modified keys, drafts, and reply/edit mode retain
their existing behavior. It does not fetch additional history to find an edit
target. Shortcut regression tests are pending CI.

The spoiler toolbar control uses TipTap's mark API to serialize
`span[data-mx-spoiler]`, preserving existing spoiler reasons and nested formatting
when editing or restoring drafts. Schema parsing remains available with the flag
off so an existing spoiler is not silently removed during editing; only the new
toolbar action is staged. The existing received-content renderer conceals spoilers
independently of `rich_message_rendering`, with regression coverage for both flag
states. Spoilers are a presentation feature, not encryption: the Matrix plain-text
fallback still contains the text. Edit and reply submissions now carry the
serialized formatted body and mentions through both native IPC and companion
HTTP routes, reusing the normal message-content builder before applying Matrix
replacement/reply relations. Previously those two paths discarded all formatting.
Hook/transport regressions and the message-actions integration scenario cover
spoiler retention at these boundaries, pending CI verification.
The default-off composer flag also enables `/plain`, `/shrug`, and `/tableflip`
in parsing and suggestions. These reuse the existing plain-message send path;
`/plain` preserves internal whitespace and treats markup literally. Dispatch
rechecks the flag and room mutation guard, rejects empty `/plain`, and only
scrolls after a successful message send in the same room. Remaining slash-command
requirements and CI/manual
verification remain open; this does not establish full composer parity.

The same flag stages `/unban`, `/nick`, `/ignore`, and `/unignore`, reusing the
existing membership, global display-name, and ignored-user IPC operations.
The web companion exposes ignored-user reads and mutations through authenticated
JSON routes, sharing the native SDK helpers and user-ID validation. User identifiers
are carried in JSON bodies, not URL paths. Transport mappings and unauthenticated
route rejection have regression coverage, pending CI and live end-to-end verification.
Missing arguments show usage; ignore/unignore require exactly
one user identifier. Backend validation and authorization remain authoritative.
Failures show inline feedback without logging action arguments, and completion
does not update feedback after a room switch. Parsing and dispatch regressions
are included, pending CI. These commands do not send chat messages or trigger
message-send scrolling. `/nick` changes the global profile, not the per-room nick.

## What I'd revisit as this grows

- Custom/user-defined command aliases — not in Charm 1.0, not built now.
