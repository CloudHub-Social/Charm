---
title: Charm 2.0 Spec — Native voice and video calling
type: spec
project: Charm 2.0
created: 2026-07-13
status: draft
---

**Workstream:** multi-PR, likely the largest single Day-2 item. The architecture
decision is complete: embed Sable Call as a Matrix widget after Day-1 Spec 49
establishes the generic widget lifecycle and trust boundary.

## Problem & why now

Charm 1.0's calling is a third-party iframe embed (Element Call or similar),
historically its most bug-churned area (19 of the last 100 commits touched calling,
per the parity gap analysis) — flaky call setup, embed-boundary state bugs, and a
poor native-app feel. Charm 2.0's Spec 13 (voice-video platform spike) landed
code-level media-permission plumbing for all five target platforms, with macOS and
Windows confirmed on real hardware and Android, iOS, and Linux still awaiting
recorded runtime verification. It is explicitly scoped as a **spike only** — no
actual calling UI or signaling exists. This spec applies the already-decided widget
architecture to the first real calling implementation.

> **Owner update, confirmed 2026-07-13: the calling architecture is decided.**
> **Sable Call is a Matrix widget — same model as Element Call.** This spec's
> "architecture decision" is resolved: **embed the Sable Call widget**, on top of
> **[Spec 49 — Widget support](/specs/day-1/spec-49--widget-support/)** (day-1). Do not build native WebRTC. This spec's
> real scope becomes "wire up Sable Call as a first-class call widget" — call
> initiation UI (start/join button in a room), incoming-call notification/ringing
> via Spec 10's native notification path, and any Sable-Call-specific widget
> capabilities (screen-share, always-on-screen, participant list) layered on Spec
> 49's generic widget-embedding + postMessage API. Element Call is the closest
> reference implementation for how a widget-based call UI should behave (call
> lobby, device picker, in-call controls) — match that pattern rather than
> inventing a new one. The native-WebRTC content below is fully superseded; kept
> only as historical context for the platform-permission groundwork Spec 13 did
> (still relevant — a call widget's `getUserMedia` still needs those per-platform
> permission fixes), not as an alternative implementation path.

## Non-goals (for this spec's Phase 1)

- Not group calls / large conference rooms in Phase 1 — 1:1 calling first,
  matching how most chat clients phase this in; group calling is a follow-up once
  1:1 is solid.
- Not screen sharing in Phase 1.
- Not call recording/transcription.
- Not building native WebRTC signaling/peer-connection handling — superseded by the
  widget decision (see below). Cross-client calling compatibility (e.g. with
  Element users) is Sable Call's concern as a widget implementation, not something
  this spec needs to solve at the Matrix-event level.

## High-level design — Sable Call as a widget (decided)

The architecture question is closed: **Sable Call is a Matrix widget**, same model
as Element Call. This spec builds on Spec 49's generic widget-embedding + widget
API (`matrix-widget-api` postMessage bridge, sandboxed iframe, capability
negotiation) and adds the call-specific UI/UX around it.

### Phase 1 scope

- **Call entry point**: a "start call" affordance in the room header/composer area
  that adds/opens the Sable Call widget in the room (per Spec 49's "Sable Call
  specifically" section — this spec is where that gets fully fleshed out).
- **Call lobby / device picker**: before joining, let the user pick
  camera/mic and preview, matching Element Call's lobby pattern — this may be
  provided by the widget itself (most call widgets render their own lobby inside
  the iframe) or need a thin native wrapper; confirm against Sable Call's actual
  widget contract before building a redundant one.
- **Incoming-call notification/ringing**: when a call widget signals an incoming
  call (via the widget API's event bridge or a room-level call-notify event —
  confirm Sable Call's signaling), surface a ringing UI using Spec 10's native
  notification/tray infrastructure, distinct from a normal message notification.
- **In-call controls**: whatever the widget doesn't own natively (e.g. a
  native "leave call" affordance in the app chrome even if the widget is
  minimized/backgrounded) — most in-call controls (mute, camera, hangup,
  participant list) live inside the widget itself per the widget model; this spec
  should not duplicate UI the widget already provides.
- **1:1 first, group calling as a fast-follow** — Sable Call being a widget makes
  group calling largely "the widget's problem" (Element Call widgets already
  support group calls), so this phasing constraint may be looser than it would be
  for a from-scratch WebRTC build; confirm against Sable Call's actual
  capabilities rather than assuming the 1:1-first constraint still applies.
- Still needs the per-platform `getUserMedia` permission fixes from Spec 13 (the
  widget's iframe still triggers real camera/mic permission prompts on each
  platform).

## Data flow

Call signaling and media are entirely inside the Sable Call widget's own
implementation (its iframe talks to whatever signaling/SFU/TURN infrastructure it
uses) — Charm 2.0's job is the widget API bridge (Spec 49) plus the
entry-point/ringing/lobby chrome around it, not owning WebRTC peer connections or
TURN configuration directly. Confirm what capabilities the widget API needs to grant
Sable Call specifically (camera/mic access, always-on-screen, to-device relay for
signaling if it needs one) during Spec 49/this spec's implementation.

## API/contract changes

Mostly rides Spec 49's widget IPC surface. This spec may add: a call-specific
"start/join call" IPC action (adds the Sable Call widget with the right init
parameters), and native ringing-notification wiring (Spec 10). No native WebRTC
peer-connection commands are needed — that was the superseded option.

## Testing strategy

- Frontend: call entry point adds/opens the widget correctly; ringing notification
  fires on an incoming call signal; leaving/hangup via native chrome (if built)
  correctly tears down the widget.
- Widget-integration: confirm Sable Call's specific capability requests are
  correctly granted (camera/mic, always-on-screen) via Spec 49's capability model.
- Manual (unavoidable for real calling): two-device call test across target
  platforms, reusing Spec 13's per-platform permission findings; confirm the mic/
  camera prompt flow works inside the widget iframe on each platform.

## Trade-offs

- **Widget over native WebRTC**: resolved by the owner — Sable Call being a widget
  makes this the pragmatic and correct path (less Charm-owned surface area, calling
  bugs are Sable Call's to fix, and it's the same model Element uses successfully).
  The native-WebRTC alternative that used to be under consideration here is
  dropped, not deferred.

## What I'd revisit as this grows

- Group calling (MSC3401) once 1:1 is stable.
- Screen sharing.
- Interop testing matrix against Element/other Matrix clients if cross-client
  calling turns out to matter to real users (likely does, given Matrix's federated
  nature).

## Related documentation

- [Spec 13: voice/video platform spike](/specs/day-1/spec-13--voice-video-platform-spike/)
  and its [recorded findings](/specs/day-1/spec-13-findings--voice-video-platform-spike/)
  explain why embedded Sable Call is the selected foundation.
- [Spec 49: widget support](/specs/day-1/spec-49--widget-support/) defines the
  reusable widget lifecycle and trust boundary.
- [Spec 10: native platform shell](/specs/day-1/spec-10--native-platform-shell/)
  owns the desktop integration points around a call.
