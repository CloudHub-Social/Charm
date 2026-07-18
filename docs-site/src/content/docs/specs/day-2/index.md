---
title: Charm 2.0 — Day-2 Spec Index
type: index
project: Charm 2.0
created: 2026-07-13
status: active
---

Day-2 contains secondary, power-user, and administrator capabilities that remain
real product scope but are sequenced after the primary daily-driver foundation.
Numbering is independent of [Day-1](/specs/day-1/).

**Status audited 2026-07-14:** no matching merged or open implementation pull
request was found for any Day-2 spec; all thirteen were planned. Spec 12
(Bookmarks and saved messages) has since shipped — see its own spec for the PR.
This statement is about implementation, not design readiness: several specs
already contain a settled architecture and detailed acceptance criteria.

| # | Spec | Status | Boundary or dependency |
|---|---|---|---|
| 01 | [Threads](/specs/day-2/spec-01--threads/) | **Planned** | Large timeline and navigation surface |
| 02 | [Voice and video calling](/specs/day-2/spec-02--native-voice-and-video-calling/) | **Planned** | Architecture is settled on the Sable Call Matrix widget; depends on Day-1 Spec 49 widget support and the Spec 13 permission foundation |
| 03 | [Polls](/specs/day-2/spec-03--polls/) | **Planned** | Matrix poll events and aggregation UI |
| 04 | [Message pinning](/specs/day-2/spec-04--message-pinning/) | **Shipped** | Shared room pins, distinct from private bookmarks |
| 05 | [Custom emoji and sticker packs](/specs/day-2/spec-05--custom-emoji-and-sticker-packs/) | **Planned** | Pack consumption before authoring tools |
| 06 | [Room directory and public room browser](/specs/day-2/spec-06--room-directory-and-public-room-browser/) | **Planned** | Public-room search and browse UI |
| 07 | [Location sharing](/specs/day-2/spec-07--location-sharing/) | **Planned** | Static location first; live beacons deferred |
| 08 | [Image editing before send](/specs/day-2/spec-08--image-editing-before-send/) | **Planned** | Crop, annotate, and blur before upload |
| 09 | [Multi-account switcher](/specs/day-2/spec-09--multi-account-switcher-ui/) | **Planned** | Builds on shipped Day-1 Spec 15 store isolation |
| 10 | [Export chat history](/specs/day-2/spec-10--export-chat-history/) | **Planned** | Per-room text, HTML, and JSON export |
| 11 | [Jump to date](/specs/day-2/spec-11--jump-to-date/) | **Planned** | Must preserve Day-1 Spec 26 timeline anchoring |
| 12 | [Bookmarks and saved messages](/specs/day-2/spec-12--bookmarks-and-saved-messages/) | **Shipped** | Private saves, distinct from shared room pins |
| 13 | [Scheduled and delayed send](/specs/day-2/spec-13--scheduled-and-delayed-send/) | **Planned** | Prefer server-side MSC4140 delayed events |

## Shared implementation seams

Message pinning, jump-to-date, and bookmarks all need to load a timeline around an
event outside the current window. Bookmarks (Spec 12) shipped with its own
minimal version of this (`load_timeline_around_event`, a plain repeated
`paginate_backwards` loop — see `src-tauri/src/matrix/timeline.rs`), deliberately
not built as a shared abstraction per that spec's own scope. Whichever of
pinning or jump-to-date implements next should evaluate reusing or generalizing
that command rather than writing a third competing loader from scratch.

Calling must begin with [widget support](/specs/day-1/spec-49--widget-support/).
The Sable Call decision is already made; a new native-WebRTC-versus-iframe spike is
not an open prerequisite. Platform permission results remain documented in the
[Spec 13 findings](/specs/day-1/spec-13-findings--voice-video-platform-spike/).
