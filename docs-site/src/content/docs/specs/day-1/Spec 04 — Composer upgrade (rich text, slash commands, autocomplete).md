---
title: "Charm 2.0 Spec — Composer upgrade (rich text, slash commands, autocomplete)"
type: spec
project: Charm 2.0
created: "2026-07-04"
status: shipped
sidebar:
  label: "Composer upgrade"
---

**Workstream:** one PR / one agent. **Tier:** Day-1 launch-critical.

## Problem & why now

The composer in `src/features/rooms/ChatShell.tsx` is a bare `<textarea>` that
sends `text_plain` only. Matrix users expect inline formatting (bold/italic/
code/quote/lists) delivered as `org.matrix.custom.html` formatted bodies, the
standard slash commands (`/me`, `/topic`, `/invite`, `/kick`, `/ban`), emoji
autocomplete (`:smile:`), and `@`/`#` mention autocomplete producing pills and
`m.mentions`. The planning doc marks all of these Day-1 and explicitly leaves the
rich-text **library decision open** (re-evaluate rather than default to Charm 1's
Slate). This composer is also reused by Spec 03's edit and reply flows, so its
contract must be settled before those land.

## Current state (in repo)

- `src/features/rooms/ChatShell.tsx` — inline `<textarea>` (rows=1, Enter-to-
  send, Shift+Enter newline), a `disabled` attach button, `draft` state as a
  bare string, `handleSend()` calling `sendMessage(room_id, body)`.
- `src-tauri/src/matrix/send.rs` — `send_message` builds
  `RoomMessageEventContent::text_plain(body)`. No HTML, no msgtype variation,
  no command handling.
- `src/lib/matrix.ts` — `sendMessage` wrapper over the `send_message` command.
- `src/components/ui/` — Radix `popover`, `dropdown-menu`, `command`(?),
  `tooltip` primitives available for the autocomplete surface.
- No formatted-body field exists on `RoomMessageSummary` yet (added in Spec 03).

## Scope (in)

1. A rich-text/WYSIWYG composer with a formatting toolbar: **bold, italic,
   inline code, block quote, ordered/unordered lists** (plus code block).
2. Emit `msgtype: m.text` with `format: org.matrix.custom.html` +
   `formatted_body` (via `RoomMessageEventContent::text_html(plain, html)`),
   falling back to `text_plain` when the message has no formatting.
3. Standard **slash commands** `/me`, `/topic`, `/invite`, `/kick`, `/ban`
   with an autocomplete/help menu (name, args hint, description).
4. **Emoji autocomplete** on `:` (`:smile:` → 😄) with a shortcode index.
5. **`@` user + `#` room mention autocomplete**, rendering pills and populating
   `m.mentions` (`user_ids`) / room pills as `<a href="matrix.to/..."`>.
6. Integration with **send** and, via Spec 03, **edit** and **reply** (shared
   composer instance, mode-switched).
7. A **per-room draft persistence hook point** (interface only; autosave is
   Day-2 — see non-goals).

## Non-goals (out)

- Draft **autosave/restore** itself (Day-2). This spec only exposes the
  `getDraft(roomId)` / `setDraft(roomId, value)` seam and calls it; the storage
  implementation is deferred.
- Markdown *input shortcuts* beyond what the chosen lib gives for free (e.g.
  typing `**x**`) are nice-to-have, not required.
- File/image attachments (the disabled paperclip) — separate media spec.
- Spellcheck config, per-message formatting of already-sent messages, and
  message-scheduling.
- Executing `/` commands that need extra confirmation UX beyond a simple send
  (e.g. `/ban` reason dialogs) — Day-1 sends with an optional trailing reason
  arg only.

## Design & approach

### Library decision (the open question)

| Option | Pros | Cons |
|---|---|---|
| **Slate** (Charm 1's) | Familiar; fully controlled model; arbitrary pills | Heavy custom code; Charm 1 accrued real maintenance pain; the doc says re-evaluate, not re-adopt |
| **contenteditable + minimal model** | Zero dep; full control of HTML→Matrix mapping | Selection/IME/paste normalization is notoriously fragile; reinvents a rich-text engine |
| **TipTap (ProseMirror)** | Schema-constrained doc (maps cleanly to a bounded HTML subset), first-class `Mention` + `suggestion` utilities (drive `@`/`#`/`:`/`/`), stable IME/paste, `generateHTML` | New dependency; ProseMirror learning curve |

**Recommendation: TipTap (ProseMirror).** Its `suggestion` plugin gives one
uniform trigger mechanism for all four autocompletes (`@`, `#`, `:`, `/`), its
schema naturally constrains output to the exact `org.matrix.custom.html` subset
Matrix allows (bold/italic/code/blockquote/lists/`<a>`), and its `Mention` node
maps directly to pills → `m.mentions`. This avoids both Slate's accrued
complexity and the contenteditable normalization tar pit, and keeps the
HTML-generation deterministic (`getHTML()` → sanitize → send).

### Serialization: TipTap doc → Matrix content

- On send/edit, `editor.getHTML()` → run through an allowlist sanitizer limited
  to the Matrix-permitted tag/attr set → `formatted_body`; `editor.getText()`
  (with mention → `@user:server` / room-alias fallbacks and list markers) →
  plain `body`.
- If the sanitized HTML is structurally equal to the escaped plain body (no real
  formatting), send `text_plain` only (no wasteful `formatted_body`).
- Mentions collected from the doc's `Mention` nodes populate
  `content.m_mentions.user_ids`; room pills render as `matrix.to` anchors.

### Rust modules / commands

- Extend `send_message` in `src-tauri/src/matrix/send.rs` to accept an optional
  `formatted_body: Option<String>` and `mentions: Option<Vec<String>>`, building
  `RoomMessageEventContent::text_html(body, html)` (or `text_plain` when
  `formatted_body` is `None`) and setting `.add_mentions(Mentions::with_user_ids(...))`.
  Keep the send-queue path.
- **Slash-command routing** in a new `src-tauri/src/matrix/commands.rs`:
  - `/me <text>` → `RoomMessageEventContent::emote_html(...)` (`msgtype: m.emote`).
  - `/topic <text>` → `room.set_room_topic(text)`.
  - `/invite <user_id>` → `room.invite_user_by_id(&user_id)`.
  - `/kick <user_id> [reason]` → `room.kick_user(&user_id, reason)`.
  - `/ban <user_id> [reason]` → `room.ban_user(&user_id, reason)`.
  Exposed as a single `run_command(room_id, name, args)` command returning a
  typed result (success / permission-denied / bad-args) so the UI can show
  inline feedback. Parsing the leading `/word` happens on the frontend; only the
  resolved command + args cross IPC.

### IPC types (ts-rs)

- New `SlashCommand` enum + `CommandResult` struct in `commands.rs`, and the
  extended `send_message` signature — all `#[ts(export, export_to =
  "../src/bindings/")]`. No hand-written TS.

### Frontend components / hooks / atoms

- New **`Composer.tsx`** (replaces the inline `<textarea>` block in
  `ChatShell.tsx`) wrapping a TipTap `EditorContent`, driven by a `mode` prop:
  `send | edit(eventId) | reply(eventId)` — the same instance Spec 03 reuses,
  reading `editingEventIdAtom` / `activeReplyTargetAtom`.
- **`FormattingToolbar.tsx`** — bold/italic/code/quote/list toggle buttons
  (Lucide icons, 44×44px), bound to TipTap commands; keyboard shortcuts
  (Cmd/Ctrl+B/I/E).
- **`AutocompletePopover.tsx`** — a single Radix `Popover`/`Command`-backed
  list driven by TipTap `suggestion`, rendering four providers:
  - `SlashCommandProvider` — static command list with args/description.
  - `EmojiProvider` — shortcode index (`:smile:`), inserts the unicode glyph.
  - `MentionUserProvider` — queries room members (new `search_room_members`
    command or client-side over already-synced members) → inserts `Mention`
    pill.
  - `MentionRoomProvider` — `#` over known rooms / `resolve_room_alias`.
- **Hooks**: `useComposer(roomId, mode)` owning the editor instance, send/edit
  dispatch, and the draft seam `useRoomDraft(roomId)` (Day-1 returns a no-op
  in-memory store; Day-2 swaps to persisted).
- **`src/lib/matrix.ts`**: extend `sendMessage` for `formatted_body` + mentions;
  add `runCommand`.
- **Surfaces changed**: `ChatShell.tsx` swaps `<textarea>` + `handleSend` for
  `<Composer>`; the disabled attach button stays disabled (media spec).

## Acceptance criteria

1. Bolding text and sending produces an event with `format:
   org.matrix.custom.html` and a `formatted_body` containing `<strong>` (or
   `<b>`); a message with no formatting sends `text_plain` with no
   `formatted_body`.
2. The toolbar toggles bold/italic/inline-code/blockquote/ordered+unordered
   lists, reflected in both the editor and the emitted HTML, and via keyboard
   shortcuts.
3. `/me waves` sends an `m.emote`; `/topic`, `/invite`, `/kick`, `/ban` invoke
   the corresponding room action and show inline success/permission-denied
   feedback; an unknown `/x` is sent as literal text, not swallowed.
4. Typing `:smi` shows an emoji autocomplete; selecting inserts the glyph;
   `:smile:` with no menu interaction still resolves on send.
5. Typing `@` lists room members and inserts a mention pill; the sent event
   contains that user in `m.mentions.user_ids`. Typing `#` lists/resolves rooms
   and inserts a room pill as a `matrix.to` link.
6. The composer is reused for Spec 03's edit and reply modes: entering edit mode
   preloads the message HTML; reply mode shows the reply bar; Esc exits either
   mode without sending.
7. Enter sends, Shift+Enter inserts a newline, both while the autocomplete
   menu is closed; when the menu is open, Enter selects the highlighted item
   instead of sending.
8. `useRoomDraft(roomId)` is called on every keystroke and on room switch (the
   seam exists and is exercised) even though persistence is a no-op Day-1.
9. All new IPC types are ts-rs generated into `src/bindings/`; no duplicate
   hand-written TS.

## Testing

- **cargo**: `send_message` builds `text_html` when `formatted_body` is
  present and `text_plain` otherwise; `add_mentions` populates
  `m.mentions.user_ids`; each `run_command` arm maps to the right SDK call
  (`emote_html`, `set_room_topic`, `invite_user_by_id`, `kick_user`,
  `ban_user`) and surfaces permission errors as a typed `CommandResult`.
- **vitest + RTL**: TipTap→Matrix serializer unit tests (bold/italic/code/quote/
  list/link → expected sanitized HTML; unformatted → plain only; sanitizer drops
  disallowed tags); autocomplete providers filter and insert correctly;
  Enter-vs-menu keybinding logic; `/x` passthrough; `useRoomDraft` called on
  change and room switch.
- **playwright** (web build + tauri-driver): part of the Phase-2 exit e2e —
  type formatted text + a `@mention`, send, assert the rendered bubble and the
  outgoing content; run a `/me`; trigger `:emoji:`; and (with Spec 03) drive the
  edit flow through this composer. Storybook + axe stories for `Composer`,
  `FormattingToolbar`, `AutocompletePopover`.

## Dependencies & sequencing

- **Adds `formatted_body` consumption** to the timeline item defined in Spec 03;
  agree the `RoomMessageSummary.formatted_body` field with that spec. Rendering
  received HTML safely (sanitized) in the bubble is part of landing formatted
  sends — coordinate the render-side sanitizer with Spec 03's bubble.
- **Reused by Spec 03** for edit/reply. If Spec 04 lands first, ship with
  `mode: send` only and add edit/reply modes when Spec 03 lands; if Spec 03
  lands first, it stubs the composer contract this spec fulfills.
- New dependency: TipTap (`@tiptap/react`, `@tiptap/starter-kit`,
  `@tiptap/extension-mention`) — adds to `package.json`; verify bundle size
  against the `pnpm build` gate.

## Risks & open questions

- **HTML sanitization on both send and render** is security-critical (stored
  XSS via `formatted_body`). Must use a strict allowlist matching the Matrix
  spec's permitted subset on the way in and on the way out; do not trust the
  editor to be the only gate.
- TipTap/ProseMirror IME and mobile-touch behavior inside a Tauri webview needs
  a real-device check (44×44px targets, virtual keyboard).
- Slash-command parsing ambiguity: a message legitimately starting with `/`
  (e.g. a path). Decide the escape rule (leading `//` → literal `/`).
- Mention search source: query the homeserver vs. filter already-synced members.
  Prefer client-side over synced members for latency; may miss large rooms.
- Emoji shortcode index size vs. bundle — pick a compact dataset.

## Effort estimate

**L** — introduces a rich-text engine, four autocomplete providers over a shared
suggestion mechanism, HTML↔Matrix serialization with security-sensitive
sanitization, slash-command routing across the IPC boundary, and a
mode-switching composer that Spec 03 depends on.

## Follow-ups from PR review (not done in this pass)

Raised in review on the implementation PR ([CloudHub-Social/Charm#15](https://github.com/CloudHub-Social/Charm/pull/15)); each
was judged out of scope for a single-PR pass and deferred rather than fixed
silently. Pick these up as small, separate PRs.

1. **`/me` has no pending local echo.** `run_command`'s `/me` arm sends via
   `send_and_capture_transaction_id` but discards the transaction id, only
   returning `CommandResult::Success`. Normal messages show "sending…" via
   the transaction id `send_message` returns; `/me` has no equivalent, so it
   just doesn't appear until the next sync in slow/offline conditions.
   Fix needs either changing `run_command`'s return shape to carry a
   transaction id (like `send_message`) or a parallel optimistic-echo path
   in `ChatShell` for emotes.
2. **`editMessage`/`send_reply` don't carry `formatted_body`/mentions.**
   Only `send_message` was extended in Spec 04, matching its literal scope
   line ("Extend `send_message` with optional `formatted_body` + mentions").
   Editing a formatted message or a reply currently drops formatting/mentions
   silently on save. Needs extending `edit_message`'s Rust command + IPC
   signature the same way `send_message` was.
3. **`/me` renders as a normal bubble, not an emote, once synced.**
   `RoomMessageSummary` doesn't carry a msgtype/emote flag, so
   `ChatShell`'s render loop can't special-case `m.emote` events (own or
   remote) — "waves" appears as a literal message instead of "*Alice waves*"
   styling. Needs a msgtype/emote field threaded through
   `events_to_summaries` (Spec 04/14's timeline code) and a render-side
   special case.
4. **`#` room-mention autocomplete can't match aliases.** `filterRooms` is
   written and tested against `alias`, but the composer always populates
   `alias: null` since `list_rooms` doesn't return alias data. Needs either a
   new backend field on `RoomSummary`/a dedicated members-style command, or
   a per-room `resolve_room_alias` round trip (adds latency to open the `#`
   menu).
5. **Real-device IME/touch-target check for the ProseMirror editor.** Called
   out as an open risk in the spec's own "Risks & open questions" above —
   never verified against Tauri's actual WebView (Windows: WebView2, macOS:
   WKWebView) on a touch device. Needs a manual pass once a build is
   available.
