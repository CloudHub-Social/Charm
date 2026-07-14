---
title: "Charm 2.0 Spec — Message actions (edit, redact, reply, react)"
type: spec
project: Charm 2.0
created: "2026-07-04"
status: shipped
sidebar:
  label: "Message actions"
---

**Workstream:** one PR / one agent. **Tier:** Day-1 launch-critical.

## Problem & why now

The timeline today is send-and-read only. Users cannot edit a typo, delete a
message, reply to a specific message, or react — the four table-stakes actions
every Matrix client ships. Worse, the current data model (`RoomMessageSummary`
= `{event_id, sender, body, timestamp_ms}`) has no concept of edits, redactions,
reactions, or reply references, and the frontend echo logic in
`src/features/rooms/ChatShell.tsx` dedupes real events by `sender + body`, which
actively breaks the moment two identical bodies or an edit ("body changed") enter
the timeline. These actions must land before launch and they force a real
timeline-item type, so this is foundational, not incremental polish.

## Current state (in repo)

- `src-tauri/src/matrix/timeline.rs` — `RoomMessageSummary`, `TimelinePage`,
  `RoomTimelineUpdate`, `events_to_summaries()`, and `get_timeline_page`. Only
  original `AnySyncMessageLikeEvent::RoomMessage` events survive the filter;
  edits (`m.replace`), reactions (`m.reaction`), and redactions are silently
  dropped. `body()` returns the raw body with no edit/reply awareness.
- `src-tauri/src/matrix/send.rs` — `send_message` only; builds
  `RoomMessageEventContent::text_plain(body)` and hands it to
  `room.send_queue().send(...)`. No relation support.
- `src/features/rooms/ChatShell.tsx` — renders plain text bubbles keyed by
  `event_id`; optimistic echoes keyed `local-${Date.now()}`, deduped by
  `sender + body`. No hover affordance, no action menu, no reaction row.
- `src/lib/matrix.ts` — thin `invoke`/`listen` wrappers and the re-exported
  ts-rs binding types.
- `src/components/ui/` — Radix `dropdown-menu`, `popover`, `dialog`, `tooltip`
  primitives already exist and are reused here.
- Bindings live in `src/bindings/` (generated via ts-rs `#[ts(export)]`).

## Scope (in)

1. **Edit** an own message via an `m.replace` relation (`m.new_content` +
   fallback body), surfaced with an "edited" marker.
2. **Redact / delete** any message the user has power to redact (own always;
   others gated by power level).
3. **Reply** using `m.in_reply_to` with the rich-reply fallback body, plus a
   reply-preview quote rendered above the replying message.
4. **React** with `m.reaction` (`m.annotation`), aggregated per-emoji counts,
   own-reaction highlight, click-to-toggle, and an emoji picker.
5. A per-item **action menu** (Radix dropdown on hover; long-press on touch)
   exposing Reply / React / Edit / Delete / Copy, respecting permissions.
6. A richer timeline-item type carrying edit, reaction, reply, and redaction
   state, flowing through the existing `timeline:update` pipeline.

## Non-goals (out)

- Threads (`m.thread` / `rel_type: m.thread`) — separate spec.
- Rich-text / formatted-body composition — that is Spec 04. This spec sends the
  same content shapes the composer produces; the edit flow *reuses* the Spec 04
  composer but does not define it.
- Read receipts, message pinning, forwarding, per-message permalinks.
- Non-text msgtypes (images/files) — separate media spec.
- Custom / frequently-used emoji ranking; a full emoji-mart index (a minimal
  picker is enough for Day-1; autocomplete `:smile:` lives in Spec 04).

## Design & approach

### Rust modules & matrix-rust-sdk APIs

New module `src-tauri/src/matrix/actions.rs` (registered in
`src-tauri/src/matrix/mod.rs` and in the `invoke_handler` in
`src-tauri/src/lib.rs`) holding four commands. All go through the **send queue**
so local echo, retry, and offline behavior are consistent with `send_message`.

- **`edit_message(room_id, event_id, new_body)`** — build
  `RoomMessageEventContent::text_plain(new_body)` then
  `.make_replacement(...)` (ruma `RoomMessageEventContent::make_replacement`,
  which sets `m.new_content` + `rel_type: m.replace` + the `* ` fallback body),
  and enqueue via `room.send_queue().send(...)`. Only originals the current user
  sent are editable (checked client-side and enforced by the server).
- **`redact_event(room_id, event_id, reason?)`** — `room.redact(&event_id,
  reason.as_deref(), None)` (this is a direct `/redact` call, **not** send-queue
  routed in current SDK; document that redactions are not offline-queued Day-1).
- **`toggle_reaction(room_id, target_event_id, key)`** — look up whether the
  user already has an `m.reaction` with that `key` against the target; if yes
  `room.redact(...)` the annotation event, else
  `room.send_queue().send(ReactionEventContent::new(Annotation::new(target,
  key)).into())`. Returns the optimistic direction so the UI can flip
  immediately. (`room.send_single_receipt`-style helpers do not cover reactions;
  build the `ReactionEventContent` explicitly.)
- **`send_reply(room_id, in_reply_to_event_id, body)`** — fetch the target
  event, then `RoomMessageEventContent::text_plain(body).make_reply_to(
  &original_event, ForwardThread::No, AddMentions::Yes)` and enqueue. This emits
  `m.in_reply_to` plus the rich-reply `> <@user> quoted` fallback and populates
  `m.mentions` for the replied-to sender.

### Timeline-item type (bindings via ts-rs)

Replace the flat `RoomMessageSummary` with a richer struct in `timeline.rs`
(keep the name to minimize churn, or introduce `TimelineItem` and alias). New
fields, all `#[ts(export, export_to = "../src/bindings/")]`:

```rust
pub struct RoomMessageSummary {
    pub event_id: String,
    pub sender: String,
    pub body: String,
    pub formatted_body: Option<String>, // set once Spec 04 lands
    pub timestamp_ms: u64,
    pub edited: bool,                    // an m.replace was applied
    pub redacted: bool,                  // tombstone; body cleared
    pub reactions: Vec<ReactionGroup>,   // aggregated
    pub in_reply_to: Option<ReplyRef>,   // resolved preview
    pub transaction_id: Option<String>,  // local echo correlation
    pub send_state: SendState,           // Pending | Sent | Error(String)
}
pub struct ReactionGroup { pub key: String, pub count: u32, pub reacted_by_me: bool }
pub struct ReplyRef { pub event_id: String, pub sender: String, pub preview: String }
pub enum SendState { Pending, Sent, Error { message: String } }
```

**Media content is additive and owned by Spec 02** — keep this struct flat (no
`content` enum). Spec 02 adds a single `pub media: Option<MediaContent>` field (`None`
for text) and owns everything media; this spec only maps text and folds relations. Spec
01 later adds `sender_display_name`/`sender_avatar_url`/`sender_avatar_path` (all
`Option`, additive). `SendState::Error` is a struct variant (not a tuple) because it's
serde-internally-tagged (`#[serde(tag = "state")]`), and every `u64`/`u32` gets
`#[ts(type = "number")]` (repo convention).

`events_to_summaries()` grows to fold relations. Two paths were considered: adopt the
SDK's `Timeline` API (`matrix-sdk-ui`'s `Timeline`/`EventTimelineItem`, which resolves
edits/redactions/reactions/reply-fallback/`send_state` for free) **vs.** hand-roll
relation-folding over the existing `room.messages(...)` walk. **As-built decision
(2026-07-05): hand-roll it** — `matrix-sdk-ui` is not a dependency, and pulling it in
means adopting a whole second timeline/pagination subsystem (its own cursor semantics,
item cache, and event→frontend bridge) as a side effect of "add message actions" — a
far bigger structural change than this spec. So `events_to_summaries` folds `m.replace`
edits, `m.reaction` annotations, and redactions onto their target in a two-pass walk,
and `get_timeline_page`'s cursor (`MessagesOptions::backward()` / `response.end`) is
unchanged. (Revisit `matrix-sdk-ui` adoption as its own workstream later if the
hand-rolled folding becomes a maintenance burden.)

### Events

- Reuse the existing single `timeline:update` event (`RoomTimelineUpdate`);
  emitting the enriched `RoomMessageSummary` covers edits/redactions/reactions
  because they arrive as diffs on existing items. Keep the "one named event per
  concern" rule — do not add a `reaction:update` firehose.
- Add **`send_queue:update`** (per the planning doc) carrying
  `{room_id, transaction_id, send_state}` so local echoes flip
  `pending → sent | error` without a full timeline diff. Emit from a
  `send_queue().subscribe()` listener spawned at login.

### Frontend components / hooks / atoms

- **`ChatShell.tsx`** — delete the `sender + body` dedupe hack. Key timeline
  items by `transaction_id ?? event_id`. Reconcile diffs by id from
  `timeline:update`; flip send-state from `send_queue:update`.
- New **`MessageActions.tsx`** — Radix `DropdownMenu` trigger revealed on
  bubble hover (and a long-press handler for touch, 44×44px targets) with
  Reply / React / Edit / Delete / Copy; items gated by a `canRedact` /
  `isOwn` check.
- New **`ReactionBar.tsx`** — renders `ReactionGroup[]` as toggle chips;
  own-reaction chips use an accent token; a `+` chip opens the emoji picker.
- New **`EmojiPicker.tsx`** — Radix `Popover` wrapping a minimal emoji grid.
- New **`ReplyPreview.tsx`** — the quoted `ReplyRef` block above a reply, and
  the "replying to …" bar shown in the composer while composing a reply.
- **Edit UX** — selecting Edit loads the message body into the shared Spec 04
  composer in "edit mode" (see Spec 04); Enter calls `edit_message`, Esc
  cancels. Reference Spec 04 for the composer contract.
- **Jotai atoms** — `activeReplyTargetAtom` and `editingEventIdAtom` (per-room,
  atom-family keyed by `room_id`) coordinate composer mode between
  `MessageActions` and the composer.
- New wrappers in `src/lib/matrix.ts`: `editMessage`, `redactEvent`,
  `toggleReaction`, `sendReply`, and `onSendQueueUpdate`.

## Acceptance criteria

1. Editing an own message sends an `m.replace`; the bubble shows the new body
   and an "edited" marker; other clients see the edit.
2. Redacting a message removes its body and renders a "message deleted"
   tombstone; the action is hidden when the user lacks redact power for others'
   messages.
3. Reacting adds an `m.reaction`; the chip appears with count 1 and
   `reacted_by_me` highlighting; a second identical reaction from another user
   increments the count to 2.
4. Clicking an own reaction chip redacts the annotation and decrements/removes
   the chip (toggle round-trips).
5. Replying sends `m.in_reply_to` with a correct rich-reply fallback body and
   `m.mentions`; the replying bubble renders a `ReplyPreview` with the quoted
   sender and text; clicking the preview scrolls to the source.
6. The action menu appears on hover (desktop) and long-press (touch), with
   44×44px hit targets, and only offers actions the user is permitted.
7. All four actions emit local echo tagged `pending`, flip to `sent` on
   homeserver ack, and to `error` (with retry affordance) on failure, driven by
   `send_queue:update` — no `sender + body` dedupe remains anywhere.
8. `RoomMessageSummary` (or `TimelineItem`) with the new fields is exported to
   `src/bindings/` by ts-rs and consumed by the frontend with no hand-written
   duplicate types.

## Testing

- **cargo** (`src-tauri/tests/`): unit tests that `make_replacement`,
  `make_reply_to`, and `ReactionEventContent` build the expected
  content/relation JSON (`rel_type: m.replace`, `m.in_reply_to`,
  `m.annotation`); a `Timeline`-mapping test asserting an edit event collapses
  onto its target with `edited = true`, a redaction sets `redacted = true` and
  clears `body`, and two reactions aggregate into one `ReactionGroup{count:2}`.
  Command-boundary tests for `edit_message` / `redact_event` /
  `toggle_reaction` / `send_reply` against a mocked room.
- **vitest + RTL**: `MessageActions` renders permitted items only; toggling a
  reaction chip calls `toggleReaction` and optimistically updates;
  `send_queue:update` flips a bubble `pending → sent → error`; reply-target atom
  wires the composer into reply mode.
- **playwright** (web build + tauri-driver): the Phase-2 exit e2e —
  send → react → edit → reply → delete a message end-to-end and assert each
  reflected state. Storybook + axe stories for `ReactionBar`, `MessageActions`,
  `ReplyPreview`.

## Dependencies & sequencing

- **Depends on** the send-queue local-echo plumbing (`send_queue:update` event)
  — build it here if not already present; Spec 04's edit flow depends on it too.
- **Couples with Spec 04** for the shared composer (edit-in-composer, reply bar).
  Land the richer `RoomMessageSummary` + `Timeline` adoption first; Spec 04 fills
  `formatted_body`. The two can ship in either order but must agree on the
  composer contract.
- Adopting the SDK `Timeline` API is the biggest internal change; do it up front
  so relation handling is not hand-maintained.

## Risks & open questions

- **`Timeline` adoption vs. hand-rolled aggregation — decided.** Implementation
  hand-rolled relation-folding directly over `room.messages()` in
  `events_to_summaries` rather than adopting `matrix-sdk-ui`'s `Timeline`: this
  crate doesn't vendor `matrix-sdk-ui` at all (only `matrix-sdk`), and pulling
  it in would mean adopting a second pagination/item-cache subsystem as a side
  effect of this spec. PR #11 is the accepted implementation of this decision;
  later specs should build on `timeline.rs` as-is rather than revisit this.
  **Known gap from this approach (fast-follow, not blocking):** a relation
  (edit/reaction/redaction) whose target isn't in the same sync batch/page as
  the relation event itself folds onto nothing and is silently dropped —
  reacting to/editing/deleting an older, already-loaded message won't update
  live until a refetch or repagination. Fixing this needs `timeline:update` to
  carry a refreshed summary for the target event when a relation's target
  isn't in the current batch, plus a frontend merge that replaces in place by
  timestamp rather than appending.
- Redactions are not send-queue routed in the current SDK — offline delete is
  not queued Day-1. Acceptable? (Assumed yes; note in UI.)
- Reaction toggle has a race if the same emoji is double-clicked before the echo
  resolves; debounce on `transaction_id`.
- Permission source: read redact power level from room state vs. attempt-and-
  handle-error. Prefer reading power levels for correct affordance gating.

## Effort estimate

**L** — four new commands, a substantially richer timeline-item type,
adoption of the SDK `Timeline` API, the `send_queue:update` event, and four new
interactive frontend surfaces plus the composer edit/reply integration.
