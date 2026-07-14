---
title: Charm 2.0 Spec — Custom emoji and sticker packs
type: spec
project: Charm 2.0
created: 2026-07-13
status: draft
---

**Workstream:** one PR / one agent.

## Problem & why now

Charm 2.0 has a basic emoji picker (standard Unicode emoji for reactions/composer)
but no support for account- or room-level **custom** emoji/sticker packs
(`im.ponies.room_emotes`/`m.room.emotes`-style account data conventions, the
de-facto Matrix ecosystem standard originating from MSC2545). Charm 1.0 supports
adding custom emoji packs and using them both as reactions and as sticker-style
inline sends. Rooms/communities that have invested in custom emoji packs lose that
entirely in Charm 2.0.

## Non-goals

- Not building a pack-creation/upload tool from scratch in Phase 1 if a stable
  MSC2545-compatible format already covers "add pack by pointing at a room/URL that
  already has one" — prioritize consuming existing packs (usable immediately across
  the wider Matrix ecosystem) over authoring tooling; authoring can follow once
  consumption works.
- Not full sticker-as-widget support (some clients render stickers via a widget
  picker UI) — treat stickers as an emoji-pack variant sent as `m.sticker` events,
  matching Charm 1.0's scope.

## High-level design

- Pack discovery: read `im.ponies.emote_rooms`/`im.ponies.user_emotes` account data
  (or room-level `im.ponies.room_emotes` state, per MSC2545) to find packs the user
  has already subscribed to or that exist in joined rooms.
- Pack management UI: settings section listing subscribed packs, with add-by-room
  (subscribe to a room's emote pack) and remove.
- Usage surfaces:
  - Reaction picker (Spec 03's react action) gets a new section for custom
    emoji, rendered as small images instead of Unicode glyphs, sent as
    `m.reaction` with the custom shortcode/mxc URI per the pack's convention.
  - Composer autocomplete (Spec 04's `:shortcode:` completion) extends to include
    custom pack shortcodes alongside standard emoji.
  - Sticker send: a distinct picker (larger preview, since stickers are meant to be
    visually prominent) sending `m.sticker` events with the image and a body/
    fallback text.

## Data flow

Reads account-data/room-state per MSC2545's convention (already synced via
existing sync machinery, no new event-fetch path needed beyond parsing this
specific account-data/state-event shape). Sends are ordinary reaction/sticker
events through existing send plumbing.

## API/contract changes

Likely none new for sending (reuse `send_reaction`/generic message-send if it
already handles arbitrary msgtypes). May need a new IPC read path for account-data
if that's not already exposed to the frontend in a generic way — confirm current
account-data read surface before adding a pack-specific command.

## Testing strategy

- Frontend: pack list renders from fixture account-data, custom emoji appear in
  reaction picker and composer autocomplete, sticker picker sends correct
  `m.sticker` content.
- Cross-client manual test: use a real, existing MSC2545-format pack (many public
  Matrix community rooms have these) to confirm compatibility with the ecosystem
  convention rather than inventing a Charm-only format.

## Trade-offs

- **Consume-first, author-later**: prioritizes immediate value (using packs that
  already exist across the Matrix ecosystem) over building pack-creation tooling
  Charm 2.0 users would have to bootstrap from scratch; matches where the actual
  Day-2 pain point is (missing custom emoji when other clients' users send them).

## What I'd revisit as this grows

- Pack-creation/authoring UI as a follow-up once consumption is solid and there's
  real demand for authoring inside Charm specifically (vs using an existing
  third-party pack-builder tool and just subscribing).

## Related documentation

- [Spec 38: full emoji picker](/specs/day-1/spec-38--full-emoji-picker/) owns
  emoji discovery and selection.
- [Spec 58: rich message rendering](/specs/day-1/spec-58--rich-message-content-rendering/)
  governs custom-emoji rendering in timeline content.
- [Spec 50: cross-device settings sync](/specs/day-1/spec-50--cross-device-settings-sync/)
  is the account-data precedent for portable pack subscriptions.
