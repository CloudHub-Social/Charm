---
title: Charm 2.0 — Day-2 Spec Index
type: index
project: Charm 2.0
created: 2026-07-13
status: active
---

Specs for the **secondary / power-user / admin tier** of the Charm 2.0 rebuild —
everything found in a Charm 1.0 → 2.0 feature-parity pass (2026-07-13, see
[product vision and architecture](/product/vision/)) that isn't needed for a viable daily driver but is a real gap
against Charm 1.0's feature set. Remaining Day-1 gaps live in the sibling
`../day-1/` folder as Specs 28-32; specs 01-27 there are Charm 2.0's original,
fully-shipped Day-1 tier.

None of these are started as of 2026-07-13. Numbering here is independent of the
day-1 folder's — Day-2 Spec 01 is unrelated to Day-1 Spec 01.

## The specs

| # | Spec | Status | Notes |
|---|------|--------|----|
| 01 | [Spec 01 — Threads](/specs/day-2/spec-01--threads/) | **Draft, unbuilt** | Largest UI-surface gap; likely 2-3 PRs. `m.thread` relations currently render inline or are dropped. |
| 02 | [Spec 02 — Native voice and video calling](/specs/day-2/spec-02--native-voice-and-video-calling/) | **Draft, needs architecture spike** | Charm 1.0's calling (iframe-embedded Element Call) is its most bug-churned area. Spec 13 (day-1) only proved WebRTC *permissions* work per-platform — no calling UI/signaling exists yet. This spec's real first deliverable is an architecture decision (native WebRTC vs embed), not code. |
| 03 | [Spec 03 — Polls](/specs/day-2/spec-03--polls/) | **Draft, unbuilt** | `m.poll.start`/`response`/`end` (MSC3381). Unrecognized by Charm 2.0's timeline today. |
| 04 | [Spec 04 — Message pinning](/specs/day-2/spec-04--message-pinning/) | **Draft, unbuilt** | `m.room.pinned_events`, shared/room-visible (distinct from Spec 12's private bookmarks). |
| 05 | [Spec 05 — Custom emoji and sticker packs](/specs/day-2/spec-05--custom-emoji-and-sticker-packs/) | **Draft, unbuilt** | MSC2545-convention pack consumption prioritized over pack-authoring tooling. |
| 06 | [Spec 06 — Room directory and public room browser](/specs/day-2/spec-06--room-directory-and-public-room-browser/) | **Draft, unbuilt** | Near-parity gap (neither 1.0 nor 2.0 has this well-built) but a real Day-2 need — `/publicRooms` search UI. |
| 07 | [Spec 07 — Location sharing](/specs/day-2/spec-07--location-sharing/) | **Draft, unbuilt** | Static `m.location` pin send/render; live/beacon location explicitly deferred. |
| 08 | [Spec 08 — Image editing before send](/specs/day-2/spec-08--image-editing-before-send/) | **Draft, unbuilt** | Crop/annotate/blur before upload, client-side canvas, no new IPC surface. |
| 09 | [Spec 09 — Multi-account switcher UI](/specs/day-2/spec-09--multi-account-switcher-ui/) | **Draft, unbuilt** | Builds directly on Spec 15 (day-1)'s per-account storage isolation — that spec built the plumbing, this builds the UI to actually use it. |
| 10 | [Spec 10 — Export chat history](/specs/day-2/spec-10--export-chat-history/) | **Draft, unbuilt** | Per-room export (text/HTML/JSON); full-account export explicitly deferred. |
| 11 | [Spec 11 — Jump to date](/specs/day-2/spec-11--jump-to-date/) | **Draft, unbuilt** | Beyond-parity item (neither 1.0 nor 2.0 has it) — flagged as needing careful integration with Spec 26 (day-1)'s bottom-up virtualized timeline to avoid reintroducing its scroll-anchoring bug class. |
| 12 | [Spec 12 — Bookmarks and saved messages](/specs/day-2/spec-12--bookmarks-and-saved-messages/) | **Draft, unbuilt** | Private, local-only per-user save — distinct from Spec 04's shared room pins. |
| 13 | [Spec 13 — Scheduled and delayed send](/specs/day-2/spec-13--scheduled-and-delayed-send/) | **Draft, unbuilt** | From the 2026-07-13 UI deep-dive. 1.0 has scheduled send; prefer MSC4140 server-side delayed events over client-only timers. |

## Shared plumbing across these specs

A few specs above independently need "load the timeline around an arbitrary event
ID not currently in the loaded window" (message pinning, jump-to-date, bookmarks
all reference this). Build this once — check whether matrix-sdk-ui's `Timeline`
already exposes it — rather than each spec's implementer building a competing
version. Whichever of Spec 04, 11, or 12 lands first should own building it, and
the other two should reuse it.

## Sequencing notes

- **Spec 02 (calling)** should not block the others — it needs a real technical
  spike before implementation can even be scoped confidently, so treat it as
  parallel/lower-priority relative to the smaller, well-scoped items (04, 05, 07,
  08, 12) that can land independently and quickly.
- **Spec 09 (multi-account switcher)** is arguably closer to "Day 1.5" than deep
  Day 2 — it's UI on top of already-shipped Day-1 storage work (Spec 15) and closes
  a real usability gap for anyone with more than one Matrix account. Worth
  prioritizing early in the Day-2 sequence.
- **Spec 01 (threads)** is likely the single most-requested gap for any
  active/high-traffic room and probably deserves to be the first Day-2 spec picked
  up, engineering cost notwithstanding.
