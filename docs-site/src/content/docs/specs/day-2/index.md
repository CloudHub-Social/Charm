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

**Status audited 2026-09-06.** These labels describe repository implementation;
default-off rollout and physical-device verification are recorded separately in
the boundary column and governing spec.

| # | Spec | Status | Boundary or dependency |
|---|---|---|---|
| 01 | [Threads](/specs/day-2/spec-01--threads/) | **Planned** | Mobile implementation is tracked in [#523](https://github.com/CloudHub-Social/Charm/issues/523) |
| 02 | [Voice and video calling](/specs/day-2/spec-02--native-voice-and-video-calling/) | **Planned** | Hosted MatrixRTC path is tracked in [#524](https://github.com/CloudHub-Social/Charm/issues/524); depends on Day-1 Spec 49 widget support, Charm-owned infrastructure, and the Spec 13 permission foundation |
| 03 | [Polls](/specs/day-2/spec-03--polls/) | **In progress** | Default-off Matrix poll implementation is in review in [#468](https://github.com/CloudHub-Social/Charm/pull/468) |
| 04 | [Message pinning](/specs/day-2/spec-04--message-pinning/) | **Shipped** | Shared room pins, distinct from private bookmarks |
| 05 | [Custom emoji and sticker packs](/specs/day-2/spec-05--custom-emoji-and-sticker-packs/) | **Planned** | Pack consumption before authoring tools |
| 06 | [Room directory and public room browser](/specs/day-2/spec-06--room-directory-and-public-room-browser/) | **Shipped** | Own-homeserver public-room search, pagination, and join UI shipped default-off in [#470](https://github.com/CloudHub-Social/Charm/pull/470); physical-device and live-homeserver verification remain rollout evidence |
| 07 | [Location sharing](/specs/day-2/spec-07--location-sharing/) | **Planned** | Static location first; live beacons deferred |
| 08 | [Image editing before send](/specs/day-2/spec-08--image-editing-before-send/) | **Planned** | Crop, annotate, and blur before upload |
| 09 | [Multi-account switcher](/specs/day-2/spec-09--multi-account-switcher-ui/) | **Planned** | Builds on shipped Day-1 Spec 15 store isolation |
| 10 | [Export chat history](/specs/day-2/spec-10--export-chat-history/) | **Planned** | Per-room text, HTML, and JSON export |
| 11 | [Jump to date](/specs/day-2/spec-11--jump-to-date/) | **Shipped** | Reuses Day-1 Spec 26 anchoring and Spec 12's load-around-event path |
| 12 | [Bookmarks and saved messages](/specs/day-2/spec-12--bookmarks-and-saved-messages/) | **Shipped** | Private saves, distinct from shared room pins |
| 13 | [Scheduled and delayed send](/specs/day-2/spec-13--scheduled-and-delayed-send/) | **Planned** | Prefer server-side MSC4140 delayed events |
| 14 | [Guest room previews](/specs/day-2/spec-14--guest-room-previews/) | **Planned** | Read-only summary or ephemeral guest-token history preview, split from Day-1 Spec 45 |

## Shared implementation seams

Message pinning, jump-to-date, and bookmarks all need to load a timeline around an
event outside the current window. Bookmarks (Spec 12) introduced the shared
`load_timeline_around_event` path; jump-to-date now resolves a timestamp to an event
ID and deliberately reuses that loader and its focused-timeline fallback rather than
adding a competing pagination mechanism.

Calling must begin with [widget support](/specs/day-1/spec-49--widget-support/).
The Sable Call decision is already made; a new native-WebRTC-versus-iframe spike is
not an open prerequisite. Platform permission results remain documented in the
[Spec 13 findings](/specs/day-1/spec-13-findings--voice-video-platform-spike/).
