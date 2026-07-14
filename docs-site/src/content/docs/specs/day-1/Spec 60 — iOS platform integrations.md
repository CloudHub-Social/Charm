---
title: Charm 2.0 Spec — iOS platform integrations
type: spec
project: Charm 2.0
created: 2026-07-13
status: draft
---

**Workstream:** likely multi-PR — each integration below is fairly independent and
can land separately. New spec (owner, 2026-07-13): native-platform UI/integration
work needs to be spec'd **per platform**, not lumped into one generic "mobile" item.
This is the iOS entry.

## Problem & why now

Everything audited so far (the feature parity pass, the UI deep-dive) compared
Charm 1.0 vs 2.0 at the level of in-app screens and components. Neither client has
been assessed for **OS-level integration** — the platform affordances iOS users
expect from a real native Messages-class app, which a Tauri-wrapped webview doesn't
get "for free." The owner named concrete examples: **Messages-app Contacts
integration, Focus Modes, and the Share Sheet.** Charm 2.0 currently ships as a
Tauri iOS app (per the repo's real-device testing docs) but has none of these.

## Non-goals

- Not a from-scratch native rewrite — these are additive platform integrations on
  top of the existing Tauri/webview app, using Tauri's iOS plugin system / native
  Swift shims where a capability isn't exposed to the webview.
- Not App Store submission/compliance work beyond what a given integration
  requires (e.g. entitlements) — that's a separate release-process concern.
- Not iPad-specific multitasking (Split View/Stage Manager) polish — worth a
  follow-up once the phone integrations below are solid.
- Several of these require capabilities gated behind a paid Apple Developer
  Program membership (push entitlements, some extension types) — the repo's
  CLAUDE.md already documents the free-tier Personal Team signing boundary; flag
  per-item below where that applies rather than assuming free-tier covers it.

## Scope — per-integration

### 1. Share Sheet (send-to Charm)

- **Share extension**: let iOS's system Share Sheet offer "Charm" as a target from
  any app (Photos, Safari, Files, another chat app) — sharing an image/link/text
  opens a room picker in Charm and sends it. This is table-stakes for a modern
  chat app and the most user-visible gap.
- Implementation: a native iOS Share Extension target (Swift) that hands off to
  the main app (App Group container for data passing) or, if Tauri's iOS plugin
  surface supports registering extensions directly, use that. Needs its own
  minimal UI (room picker) since extensions run in a separate, constrained
  process.

### 2. Contacts integration (Messages-app style)

- iOS's Messages app resolves phone-number contacts to iMessage identities and
  shows them in Search/Contacts/Siri suggestions. For Charm, the equivalent is
  resolving **Matrix user IDs to the device's Contacts** where a contact has a
  linked Matrix ID (or supporting "start a chat" from a contact card via a
  Charm-registered contact action).
- Concretely: request Contacts permission (with a clear rationale prompt), let a
  user associate a Contacts entry with a Matrix ID (or auto-match via a shared
  identifier if the homeserver supports 3PID lookup), and surface a "message in
  Charm" action from the iOS Contacts app / Siri contact suggestions where
  supported (`INSendMessageIntent` / `CNContact` extensions).
- Coordinate with Spec 36 (profile cards) — this is where a resolved contact's
  Charm profile gets shown.

### 3. Focus Modes integration

- iOS Focus (Do Not Disturb, Work, Personal, custom Focus filters) lets apps
  register as **Focus-aware**: respect the user's current Focus and optionally let
  Charm notifications be allowed/silenced per Focus, and (richer) let a custom
  Focus filter change Charm's own state (e.g. a "Work" Focus could auto-switch to
  a work-account or mute personal DMs — ties into day-2 Spec 09's multi-account
  switcher if built).
- Baseline: register for Focus Status API so Charm can show "this contact has
  notifications silenced" indicators (matches Messages-app behavior) and respects
  system Focus filtering automatically (iOS handles the actual notification
  suppression once the app supports the Focus Status entitlement — request it).
- Coordinate with day-1 Spec 30 (in-app DND) — this is the OS-level counterpart;
  Spec 30 intentionally deferred OS Focus sync as a future item, and this is where
  it lands for iOS specifically.

### 4. Other iOS-native affordances worth scoping alongside these

- **Siri / Shortcuts**: expose `INSendMessageIntent`/`INStartCallIntent`-style
  intents so "Hey Siri, message X in Charm" and Shortcuts automations work.
- **Handoff**: continue a conversation between iPhone/iPad/Mac (ties to the
  desktop-shell work in Spec 47/day-2 Spec 09 area) — lower priority, note only.
- **Live Activities / Dynamic Island**: an active-call or "typing"/unread Live
  Activity — only relevant once day-2 Spec 02 (Sable Call widget) ships; note as
  a fast-follow, not blocking.
- **Widgets (Home Screen/Lock Screen)**: a "recent messages" or "unread count"
  widget — separate from Spec 49's in-app Matrix widgets; this is an iOS
  WidgetKit extension. Lower priority than Share Sheet/Contacts/Focus.

## High-level design

Each integration above is its own workstream; a shared foundation is worth
building first:

- **Tauri iOS plugin scaffolding**: confirm which of these are reachable via
  existing Tauri plugins vs need a custom Swift plugin (Tauri supports custom iOS
  plugins — this is the mechanism for Share Extension, Contacts, Focus Status,
  and Siri Intents, since none of these are exposed to a plain webview).
- **Entitlements audit**: Share Extension, Contacts, Focus Status, and Siri
  Intents each need specific `Info.plist`/entitlement declarations — audit which
  are free-tier-signable (per the repo's existing Personal Team documentation) vs
  require a paid Apple Developer Program membership, before committing to a
  phase order.

## Data flow

Mostly native-iOS-side (Swift plugin) → Tauri IPC bridge → existing Charm
send/room-list/settings commands. Share Sheet reuses Spec 02's attachment/message
send path; Contacts resolution needs a new Matrix-ID↔Contact mapping (local
storage, possibly synced per Spec 50); Focus Status is read-only from iOS →
gates Charm's own notification dispatch (Spec 46).

## API/contract changes

- New Tauri iOS plugin(s) for Share Extension, Contacts, Focus Status, Siri
  Intents.
- New local (or synced, per Spec 50) storage for Contact↔Matrix-ID associations.
- No changes to core Matrix/IPC commands beyond what's needed to invoke existing
  send/room actions from the extension process.

## Testing strategy

- Manual, real-device (simulator can't exercise Share Sheet/Contacts/Focus
  meaningfully): share an image from Photos into Charm; associate a contact and
  message them via the Contacts app; set a Focus and confirm Charm notifications
  are silenced per the Focus's settings.
- Entitlement/provisioning: confirm each integration actually builds and installs
  under the free-tier Personal Team signing the repo documents, or explicitly flag
  which need a paid account.

## Trade-offs

- **Phase by user-visible impact**: Share Sheet and Contacts are the most
  immediately felt gaps (matches "this doesn't feel like Messages" complaints);
  Focus Modes next; Siri/Handoff/Widgets/Live Activities as fast-follows.
- **Custom Swift plugins vs waiting for Tauri to add first-class support**: these
  capabilities aren't reachable from the webview at all, so a custom plugin is
  required regardless — not optional scope.

## What I'd revisit as this grows

- Live Activities once Sable Call (day-2 Spec 02) ships.
- iPad multitasking polish.
- Home Screen/Lock Screen widgets if Share Sheet/Contacts/Focus land well and
  there's appetite for more native surface.
