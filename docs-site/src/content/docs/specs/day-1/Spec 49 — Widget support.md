---
title: Charm 2.0 Spec — Widget support
type: spec
project: Charm 2.0
created: 2026-07-13
status: draft
---

**Workstream:** likely 2 PRs (embed + widget API, then management UI). New spec from
the 2026-07-13 owner adjudication of the parity audit. **Load-bearing:** Sable Call
(the intended calling solution) is delivered as a Matrix widget, so widget support
is a prerequisite for calling — see the cross-reference to day-2 Spec 02.

## Problem & why now

The parity audit initially marked "integrations manager" as absent-in-both and low
value. Owner correction (2026-07-13): widget support is **needed**, because **Sable
Call is a widget** — the calling experience is an embedded Matrix widget, not native
WebRTC. Charm 2.0 has no widget support at all today (no widget embedding, no widget
API, no widget state-event handling). Without it, Sable Call can't be embedded, and
the broader Matrix widget ecosystem (Jitsi, custom dashboards, bots-with-UI, etc.)
is unavailable.

## Non-goals

- Not a full third-party integration-manager marketplace (Scalar/Dimension-style
  hosted catalog) — this builds native widget *embedding + a lightweight add/remove/
  configure UI*, not a hosted integrations store.
- Not native WebRTC calling — that's day-2 Spec 02's *alternative* approach. If Sable
  Call as a widget is the chosen calling path, this spec is what day-2 Spec 02
  actually builds on (and the native-WebRTC option there becomes moot or secondary —
  reconcile the two once the calling approach is settled).
- Not arbitrary-origin unrestricted iframes — widgets run in a sandboxed iframe with
  an explicit capability/permission model (see security below); this is not a
  general "embed any website" feature.

## High-level design

### Widget state model

Matrix widgets live as state events: **room widgets**
(`im.vector.modular.widgets` / `m.widget` state, keyed by widget id) and **account
widgets** (user-account-data `m.widgets`). Read these to know which widgets exist in
a room / for the user. Confirm the current stable event shape (the widget MSCs have
evolved) before implementing.

### Embedding + the widget API

- Render a widget in a **sandboxed iframe** (Tauri webview considerations: CSP,
  allowed origins, `sandbox` attribute) in an appropriate surface — a room widget
  panel (reuse the right-panel slot pattern) and/or a dedicated widget view; a call
  widget (Sable Call) likely wants a prominent in-room or full-height placement.
- Implement the **widget postMessage API** (the `fromWidget`/`toWidget` protocol,
  a.k.a. the widget API / `matrix-widget-api`): capability negotiation, sending the
  widget the data it's allowed (room id, user id, scoped event send/receive,
  `m.always_on_screen` for calls, turn-server info for a call widget, etc.). Prefer
  the maintained `matrix-widget-api` library over hand-rolling the protocol — it's
  the ecosystem-standard implementation and getting the capability model wrong is a
  security hole.
- **Capabilities / permissions:** a widget must request capabilities (read/send
  specific event types, sticker sending, always-on-screen, etc.); the client prompts
  the user to approve them on first load and remembers the grant. Never grant a
  widget blanket event access — scope to what it requested and the user approved.

### Management UI (integrations-manager-lite)

- Add / remove / configure widgets in a room (for users with sufficient power level —
  reuse Spec 07's power-level gating, since adding a room widget is a state-event
  send).
- A small set of known widget types with friendly add flows (Sable Call, Jitsi,
  custom URL), plus a generic "add widget by URL" for power users.
- Account widgets (personal, cross-room) add/remove.

### Sable Call specifically

- A first-class "start/join call" affordance that adds/opens the Sable Call widget in
  the room, wired with the capabilities a call widget needs (always-on-screen, turn
  server, to-device or room event relay for signaling per Sable Call's requirements —
  confirm against Sable Call's actual widget contract).
- Coordinate with **day-2 Spec 02 (calling)**: if Sable-Call-as-widget is the chosen
  approach, that spec's "architecture decision" resolves to "embed the Sable Call
  widget via this spec's widget support," and its native-WebRTC option is dropped or
  deferred. Update day-2 Spec 02 accordingly when this lands.

## Data flow

Widget definitions come from room state / account data (already synced). The widget
API bridges the sandboxed iframe and the client over postMessage; event send/receive
the widget performs (within its granted capabilities) routes through the existing
Matrix send/timeline plumbing, mediated/authorized by the client. New IPC only where
the widget API needs Rust-side data (e.g. turn-server credentials for a call
widget); much of the widget API is frontend↔iframe postMessage.

## API/contract changes

- Read/write widget state events + account-data widgets (new IPC reads/writes if not
  already exposed generically).
- Turn-server / capability data surfacing as needed for call widgets.
- Widget capability-grant persistence (local).

## Testing strategy

- Frontend: widget renders in a sandboxed iframe; capability negotiation prompts and
  persists grants; a widget request outside granted capabilities is refused; add/
  remove widget updates room state; power-level gating on add.
- Security: assert the iframe sandbox + capability scoping actually constrain a
  widget (a widget cannot send/read event types it wasn't granted).
- Manual: embed Sable Call, start and join a call end-to-end; embed a generic widget
  (e.g. a Jitsi or a simple test widget) and confirm the API bridge works.

## Trade-offs

- **Use `matrix-widget-api` vs hand-roll**: use the library — the capability model is
  security-critical and the ecosystem-standard implementation is battle-tested; a
  hand-rolled version risks over-granting.
- **Widget calling (Sable Call) vs native WebRTC (day-2 Spec 02)**: the owner has
  indicated Sable Call is a widget, which makes widget support the pragmatic calling
  path and likely supersedes the native-WebRTC investigation in day-2 Spec 02.
  Confirm and reconcile the two specs rather than building both.
- **Sandbox strictness in a Tauri webview**: Tauri's CSP and webview sandboxing differ
  from a browser; validate the iframe sandbox + widget API postMessage works under
  Tauri's constraints early (flag as the main implementation risk).

## What I'd revisit as this grows

- A fuller integrations catalog if users want many third-party widgets beyond the
  known set.
- Widget-specific mobile layout (a call widget on a phone needs different placement
  than on desktop).
