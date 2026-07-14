---
title: Charm 2.0 Spec — Android platform integrations
type: spec
project: Charm 2.0
created: 2026-07-13
status: draft
---

**Workstream:** multi-PR, each integration independent. New spec (owner, 2026-07-13)
— native-platform work spec'd per platform. Android counterpart to Spec 60 (iOS).

## Problem & why now

Same gap as iOS (Spec 60): Charm 2.0 has no OS-level Android integration beyond
basic push (Spec 11) and the WebRTC permission fixes (Spec 13). Android's
equivalents of "Contacts/Focus Modes/Share Sheet" exist and are arguably *more*
standardized/expected on Android than iOS (Share intents and Direct Share are
extremely common chat-app affordances there).

## Non-goals

- Not a from-scratch native rewrite — additive integrations on the existing Tauri/
  webview app via Tauri's Android plugin system / custom Kotlin plugins where the
  webview can't reach a capability.
- Not Wear OS / Android Auto — out of scope unless requested later.
- Not foldable-specific layout polish — covered generally by Spec 52's responsive
  work, not a distinct native-integration item.

## Scope — per-integration

### 1. Share intent (send-to Charm) — Android's Share Sheet equivalent

- Register Charm as a **Share target** (`ACTION_SEND`/`ACTION_SEND_MULTIPLE`
  intent filters) so any app's "Share" menu offers Charm — sharing an image/link/
  text/file opens a room picker and sends it. This is the single most-expected
  Android chat-app affordance and the direct analog of Spec 60's #1.
- **Direct Share** (`ShareTarget`/`ChooserTarget` — showing specific recent
  contacts/rooms directly in the system share sheet, not just "Charm" as one
  generic target) — richer version, matches what WhatsApp/Telegram/Signal do on
  Android. Build after the basic share intent works.

### 2. Notification channels + Android-native notification actions

- Android requires **notification channels** for granular user control (separate
  channels per category — messages, mentions, calls) — confirm Spec 11's push
  implementation already creates proper channels; if not, this is where that gets
  fixed. Missing/incorrect channels means the user can't control Charm's
  notification categories from Android's own settings UI, a real usability gap.
- **Notification actions** (reply/mark-read inline from the notification shade,
  via `RemoteInput`) — this is Android's version of day-1 Spec 46's "notification
  inline actions" item; implement the Android-specific `RemoteInput` mechanism
  here, coordinating with that spec's cross-platform framing.
- **Bubbles** (Android's chat-bubble notification style, floating conversation
  heads) — Android's rough analog to iOS Live Activities for an ongoing
  conversation; lower priority, note as a fast-follow.

### 3. Contacts / people integration

- Android's **Conversations/People** shortcuts system lets a messaging app publish
  "shortcuts" for frequent contacts, surfaced in the launcher, notification shade
  grouping, and the system's People tile. Publish `ShortcutManager` conversation
  shortcuts for a user's active DMs so Charm contacts show up the way a real
  Android messaging app's contacts do.
- Coordinate with Spec 36 (profile cards) for the underlying contact/profile data.

### 4. Focus / notification-priority integration

- Android's **Digital Wellbeing Focus mode** / **Do Not Disturb with priority
  conversations** — Android lets a "priority conversation" (marked via the
  Conversations shortcut system above) bypass DND, and respects the system DND
  state otherwise. Wire Charm's conversations into this so muted/DND behavior
  matches system expectations, and support marking a conversation as
  priority/starred at the OS level (distinct from Charm's own mute setting from
  Spec 46).
- Coordinate with day-1 Spec 30 (in-app DND) the same way Spec 60 does for iOS —
  this is the Android OS-level counterpart.

### 5. Other Android-native affordances worth scoping alongside these

- **App Shortcuts** (long-press launcher icon → quick actions like "New message,"
  jump to a specific room) — Android's `ShortcutManager` static/dynamic shortcuts.
- **Quick Settings tile**: a DND-toggle tile (pairs with Spec 30) — lower
  priority, note only.
- **Assistant/App Actions**: Android's Siri-Shortcuts equivalent
  (`capability.START_MESSAGE`) for "send a message in Charm" via Assistant —
  lower priority, note only.

## High-level design

- **Tauri Android plugin scaffolding**: confirm which of these are reachable via
  existing Tauri plugins vs need a custom Kotlin plugin — Share intents,
  notification channels/actions, Conversation shortcuts, and priority-conversation
  marking are unlikely to be webview-reachable and will need custom plugin code
  (the repo's existing `RustWebChromeClient`/permission-fix work in Spec 13 is the
  precedent for this kind of native Kotlin touch-point).
- **Manifest audit**: intent filters, notification channel setup, and shortcut
  declarations all live in `AndroidManifest.xml`/native resources — audit what
  exists today (Spec 13's findings already touched this file for permissions;
  build on that familiarity) before adding new declarations.

## Data flow

Native-Android-side (Kotlin plugin) → Tauri IPC bridge → existing Charm send/
room-list/notification commands. Share intent reuses Spec 02's attachment/message
send path; Conversation shortcuts need a feed of active-DM data (already available
from the room list); notification channels/actions extend Spec 11's existing push
implementation.

## API/contract changes

- New Tauri Android plugin(s) for share intents, notification channels/actions,
  conversation shortcuts, priority-conversation marking.
- Possibly extend Spec 11's notification-dispatch IPC with channel/category
  metadata if not already present.

## Testing strategy

- Manual, real-device: share an image from Photos/Files into Charm via the system
  share sheet; confirm Direct Share surfaces recent rooms; confirm notification
  channels appear correctly in Android system settings and inline reply works;
  confirm a DM published as a Conversation shortcut shows up in the launcher/People
  space and can bypass DND when marked priority.
- Regression: confirm Spec 13's existing permission fixes (`CAMERA`/`RECORD_AUDIO`
  in the manifest) aren't disturbed by manifest changes this spec makes.

## Trade-offs

- **Share intent + notification channels first**: highest user-visible impact and
  most standard Android chat-app expectations; Conversation shortcuts/priority-DND
  next; Bubbles/Quick-Settings-tile/Assistant as fast-follows.
- **Custom Kotlin plugins vs waiting on Tauri**: same reasoning as iOS — these
  capabilities aren't reachable from the webview, so custom native plugin work is
  required, not optional.

## What I'd revisit as this grows

- Bubbles (floating conversation heads) once core sharing/notifications/shortcuts
  are solid.
- Wear OS companion if there's ever product interest.
