---
title: Charm 2.0 Spec — Location sharing
type: spec
project: Charm 2.0
created: 2026-07-13
status: draft
---

**Workstream:** one PR / one agent.

## Problem & why now

Charm 1.0 has a `LocationDialog.tsx` for sending `m.location` events (a
lat/long pin, optionally with a description) — used for "here's where I am" or
"meet me here" messages. Charm 2.0 has no equivalent; an `m.location` event sent
from another client currently has no dedicated rendering (falls back to raw/
unhandled event display, if it renders at all).

## Non-goals

- Not live/continuously-updating location sharing (a moving pin over time,
  `org.matrix.msc3672`-style beacon/live-location) — one-shot static pin only,
  matching Charm 1.0's scope. Live location is a plausible richer follow-up, not
  built now.
- Not an in-app map-picker with full interactive map tiles as a hard requirement —
  acceptable to start with device-native location (browser/OS geolocation API) plus
  a simple "confirm this pin" static map preview; a fully interactive
  pick-any-point-on-a-map picker can be a fast-follow if the simple version proves
  too limiting.

## High-level design

- Composer action ("Share location," alongside existing attachment/poll actions)
  opens a small dialog: request device location permission (via Tauri's
  geolocation plugin or platform-native API — confirm what's available across the
  5 target platforms, matching the platform-by-platform diligence Spec 13 already
  did for media permissions), show a static map preview centered on the detected
  coordinates, optional free-text description field, "Send" button.
- Sends `m.location` content: `geo_uri` (`geo:lat,long`), `body` (fallback text
  description), optionally `org.matrix.msc3488.asset` type (`m.self` for "this is
  where I am" vs a generic pin).
- Rendering: `LocationMessage` timeline component shows a static map thumbnail
  (using whatever map-tile provider is chosen — check for one already used
  elsewhere in the codebase, e.g. if link-preview thumbnails or any existing
  feature already has a map-tile dependency, reuse it rather than adding a new
  one) plus the description text; clicking opens the location in the OS's default
  maps app (`geo:` URI handling) or a full-size map view.

## Data flow

No new sync-side plumbing — `m.location` is an ordinary room message event type,
flows through existing timeline/send commands once the frontend knows how to
render/compose it. Device geolocation permission/read is a new native-platform
integration point, likely via a Tauri plugin.

## API/contract changes

Possibly none beyond generic message-send if it already accepts arbitrary
`msgtype` content. New Tauri capability/permission entry for geolocation access
per platform (mirrors the permission-plumbing work pattern from Spec 13).

## Testing strategy

- Frontend: `LocationMessage` renders correctly from fixture `m.location` content,
  missing/malformed `geo_uri` fails gracefully (no crash, shows fallback text only).
- Frontend: composer dialog handles permission-denied gracefully (clear message,
  no silent failure) — geolocation permission prompts are exactly the kind of
  platform-permission edge case Spec 13's findings doc catalogued issues with.
- Manual: real location send/receive across at least macOS and one mobile target,
  confirm the "open in maps app" action actually opens the OS's default handler.

## Trade-offs

- **Static pin over live location for Phase 1**: matches Charm 1.0's actual scope
  and avoids the added complexity of beacon-event lifecycle (start/update/stop)
  management for a Day-2 feature whose primary value (share where you are, once) is
  fully delivered by the simpler static version.

## What I'd revisit as this grows

- Live/beacon location sharing if requested — meaningfully more complex (ongoing
  event stream, explicit stop action, staleness handling) so scope as its own spec
  rather than folding into this one later.
