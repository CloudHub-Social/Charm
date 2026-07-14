---
title: Charm 2.0 Spec — Chat message layout modes (bubble, Discord, IRC)
type: spec
project: Charm 2.0
created: 2026-07-11
status: shipped
sidebar:
  label: "Chat message layout modes"
---

**Workstream:** one PR / one agent. Purely a rendering/settings change — no new IPC
surface, no Rust changes, no data model changes.

## Problem & why now

Charm currently renders every room with one hardcoded layout:
[MessageRow.tsx](https://github.com/CloudHub-Social/Charm/blob/main/src/features/rooms/MessageRow.tsx)
draws each message as a rounded, colored **bubble** (`bg-primary-solid` for own
messages, `bg-secondary` for others), right-aligned for the current user, with an
avatar shown only on the first message of a same-sender run
(`sameSenderAsPrev`/`sameSenderAsNext` grouping already exists and is reused, not
rebuilt, by this spec).

That's a good default, but it's a strong aesthetic and information-density choice
that not everyone wants:

- **Discord-style** users want a flat, left-aligned, avatar-per-sender-block layout
  with no bubble background — denser, no left/right split, name+timestamp as a
  header line above each sender's message run.
- **IRC-style** users want maximum density: single-line-per-message,
  `[HH:MM] <sender> body`, no avatars, no bubbles, no grouping gaps — closest to a
  terminal chat client.

This is a user preference, not a per-room or per-message concept — no Matrix event
carries "render me as IRC style." It's local presentation only, same bucket as
Spec 09 (Theming and appearance).

## Non-goals

- No new Matrix event types or room state. Layout choice is pure client-side
  presentation over the same `RoomMessageSummary[]` data Charm already has.
- No per-room override in this phase — one global setting. (Flagged as a possible
  follow-up below, not built now.)
- Not a rebuild of grouping/threading/reaction logic — those stay as authored;
  only the rows' visual shell changes per mode.
- Not a redesign of `MediaMessage`, `ReplyPreview`, `ReactionBar`, or
  `MessageActions` internals — each mode reuses them, adapting only their
  container/placement.
- IRC mode does not attempt to hide/strip rich content (images, formatted HTML,
  reactions) — those still render, just inline in a denser single-line-per-event
  shell rather than a bubble. A "true plaintext IRC" mode that drops rich embeds
  entirely is out of scope; note it as a possible future variant if requested.

## High-level design

### Setting

Add a `messageLayout: "bubble" | "discord" | "irc"` field alongside the existing
appearance settings introduced in Spec 09 (theme/accent), persisted the same way
(local settings store, not synced via Matrix account data — matches how Spec 09's
theme choice is scoped, confirm against that spec's actual persistence mechanism
before implementing; if Spec 09 already syncs appearance via account data, follow
that same channel for consistency instead of introducing a second one). Default:
`"bubble"` (matches current/shipped behavior — this is additive, not a breaking
change to existing users).

Exposed as a segmented control (three options, each with a small live preview
thumbnail) in **Settings → Appearance**, next to the existing theme controls from
Spec 09.

### Component shape

`MessageRow` currently owns both the *data plumbing* (send-state derivation, link
click handling, action wiring) and the *visual shell* (bubble div, avatar
placement, alignment). Split those:

- `MessageRow` keeps all data plumbing (`isPending`, `isError`, `hasRealEventId`,
  `disableRelationActions`, `isUndecrypted`, `rowKey`, `handleMessageLinkClick`)
  and becomes a thin dispatcher that picks a layout component based on the
  `messageLayout` setting (read via existing settings atom/hook, not prop-drilled
  through `ChatShell`).
- Three new presentational components, one per mode, each taking the same props
  `MessageRow` currently renders inline:
  - `BubbleMessageRow` — current implementation, moved verbatim (this spec must
    not regress existing bubble-mode behavior or its test coverage; the existing
    `MessageRow.test.tsx` assertions map onto this component unchanged).
  - `DiscordMessageRow` — new.
  - `IrcMessageRow` — new.

This keeps `ChatShell.tsx`'s call site (`sameSenderAsPrev`/`sameSenderAsNext`
grouping computation in [ChatShell.tsx](https://github.com/CloudHub-Social/Charm/blob/main/src/features/rooms/ChatShell.tsx)) completely
unchanged — grouping is layout-agnostic and all three modes use it, just
differently.

### Discord-style layout

- Left-aligned always — no `own && "ml-auto flex-row-reverse"` split. Own and
  others' messages look the same except for name color/interaction affordances.
- Avatar shown once per same-sender run (`showAvatar = !sameSenderAsPrev`, dropping
  the current `!own &&` gate — Discord shows the current user's own avatar too).
- Header line above the *first* message of a run: `sender_display_name` (bold) +
  `formatTime(timestamp_ms)` (muted, small) on the same line.
  - Subsequent messages in the same run render with no header, just body text
    left-padded to align under the first message's body (avatar column width),
    with a timestamp that only appears on hover (small, absolute-positioned to the
    left of the body, matching Discord's own hover-reveal timestamp pattern) —
    implement via existing `group`/`group-hover` Tailwind pattern already used for
    `MessageActions`' hover-reveal.
- No bubble background — body text sits directly on the row background.
  `formatted_body`/plain body still gets the same link-click interception
  (`handleMessageLinkClick`) and sanitization (`sanitizeMatrixHtml`), just without
  the `bg-primary-solid`/`bg-secondary` wrapper classes.
- `MediaMessage`, `ReplyPreview`, `ReactionBar`, `MessageActions` render in the
  same relative positions as bubble mode (reply quote above body, actions
  hover-revealed to the side, reactions below body) but left-aligned, never
  reversed.
- Redacted/pending/error states: same semantics as bubble mode (italic "Message
  deleted" for redacted, "sending…"/"failed to send" suffix on the meta line,
  `border-destructive` outline on error) — just without the bubble.

### IRC-style layout

- One line per message, no avatar column, no grouping gap — same-sender runs still
  collapse the *name* into `sender_display_name` shown once optionally (IRC
  convention actually repeats the nick per line — do this: `[HH:MM] <Nick> body`
  every line, ignore `sameSenderAsPrev`/`sameSenderAsNext` for layout purposes in
  this mode, they stay computed by `ChatShell` for the other modes but this
  component simply doesn't consume them).
- Monospace-leaning but reuse the existing `font-mono` utility already used for
  timestamps elsewhere in `MessageRow`, not a full monospace body font — Matrix
  messages routinely contain non-Latin text and emoji where forcing full monospace
  reads worse, not more authentic.
- Format: `[HH:MM] <sender_display_name ?? sender> body`, timestamp and nick
  muted/colored (reuse `avatarColor(message.sender)` for the nick color — gives
  free per-sender visual distinction without avatars, matching real IRC clients'
  nick-coloring).
- No bubble, no background, no left/right split (own messages distinguished only
  by nick color matching the current user, same as any other sender — this is
  intentional, matches real IRC where you don't get special treatment).
- `redacted` renders as `* message deleted` (IRC action-style `*` prefix), matching
  the terminal-client convention for a system/meta line.
- `formatted_body`/media still render inline after the `<nick>` prefix — an image
  attachment, for instance, still needs to be visually locatable, so `MediaMessage`
  renders on the same line/row, just without a bubble wrapper; a genuinely
  faithful "IRC clients don't render inline images" restriction is explicitly out
  of scope (see Non-goals).
- `MessageActions`/`ReactionBar`: still present (hover-revealed at end of line) —
  removing them would regress delete/react/edit functionality for users who pick
  this mode, which isn't the point of the spec (density, not feature removal).
- Reply quotes (`ReplyPreview`): compress to an inline prefix rather than a
  separate quoted block, e.g. `[HH:MM] <nick> (re: original sender) body` — full
  bubble-style reply preview blocks don't fit the one-line-per-message aesthetic.
  Clicking still scrolls to the replied-to message (`scrollIntoView`, unchanged
  behavior from current `ReplyPreview` `onClick`).

## Data flow

No change. `RoomMessageSummary[]` from `useChatTimeline`/the existing IPC binding
flows into `ChatShell` exactly as today; `messageLayout` is read once via a
settings hook inside `MessageRow` (or passed down once from `ChatShell` if that
matches how Spec 09's theme value is threaded — check that call site before
deciding prop-drilling vs. hook-read-per-row, for consistency with the existing
pattern rather than inventing a second convention).

## API/contract changes

None. This is entirely a `src/` presentational change plus one new settings field
in whatever local store Spec 09's appearance settings already live in. No
`src-tauri/` changes, no `@bindings/*` regeneration.

## Testing strategy

- `MessageRow.test.tsx` (existing) continues to cover bubble mode via the
  extracted `BubbleMessageRow`, unchanged assertions.
- New `DiscordMessageRow.test.tsx` and `IrcMessageRow.test.tsx`: same fixture data
  as the existing suite (own/other, grouped/ungrouped, redacted, pending, error,
  reply, media, reactions) run through each new component, asserting the mode's
  distinguishing structure (no bubble background class in Discord/IRC; header line
  presence/absence per grouping in Discord; single-line format in IRC).
- `ChatShell.test.tsx`: add a case that switches `messageLayout` and asserts the
  correct dispatch component mounts (a settings-driven render-branch test, not a
  re-test of each mode's internals — those live in the per-mode test files above).
- Storybook: add stories for `DiscordMessageRow`/`IrcMessageRow` alongside the
  existing `MessageRow.stories.tsx` states (own/other, grouped, redacted, pending,
  error) so the `storybook-a11y` CI gate exercises all three modes through axe —
  this is the mechanism most likely to catch a contrast/target-size regression in
  the denser IRC mode specifically, since it drops avatar-sized touch targets.
- Manual: verify all three modes at mobile viewport width — IRC mode's line-based
  layout is the one most likely to wrap awkwardly on narrow screens; confirm
  wrapped continuation lines are still legibly distinguishable from a new message
  line (e.g. via left padding matching the `[HH:MM] <nick> ` prefix width).

## Trade-offs

- **One global setting vs. per-room override**: global is simpler to build and
  matches the "personal preference" framing (nobody wants half their rooms in one
  style and half in another) — deferred per-room override to a future spec only if
  actually requested; not speculatively building the plumbing for it now.
- **Extracting three components vs. one component with mode-conditional JSX
  throughout**: extraction adds files but keeps each mode's JSX legible and
  independently testable/storybook-able; the alternative (branching inline
  throughout the current ~180-line render body) would make `MessageRow.tsx`
  materially harder to read and increase the risk of one mode's change
  accidentally leaking into another's rendering path.
- **IRC mode keeping rich media/reactions vs. a "true" plaintext IRC**: kept
  richness because removing working functionality (react, media preview) to chase
  visual authenticity would be a regression for users who pick this mode for
  density, not feature loss. Flagged as a possible separate "plaintext" toggle if
  requested later, not built speculatively now.

## What I'd revisit as this grows

- If per-room layout override is requested, the settings field becomes
  room-scoped-with-global-default rather than a single global enum — worth its own
  spec once actual demand shows up, not built preemptively.
- If IRC mode users specifically ask for images-as-links instead of inline
  previews, that's a small additive toggle on top of this spec, not a rework.
- Revisit the reply-quote compression in IRC mode if it turns out illegible in
  practice with long original messages — may need truncation length tuning after
  real usage.
