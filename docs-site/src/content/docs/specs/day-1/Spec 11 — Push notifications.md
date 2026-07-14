---
title: "Charm 2.0 Spec — Push notifications"
type: spec
project: Charm 2.0
created: "2026-07-04"
status: shipped
---

**Workstream:** one PR / one agent. **Tier:** Day-1 launch-critical.

## Problem & why now

Charm 2.0's headline capability over the matrix-js-sdk-based Charm 1.0 is **push-triggered
background decryption**: because the crypto store is now Rust-native (SQLCipher via
matrix-rust-sdk), the app can wake on a push, decrypt the referenced event, and build a
*meaningful* notification ("Alice: see you at 6") instead of a contentless "New message" —
something the JS SDK could not do in a background/killed state. Delivering real cross-platform
push (Android via a **Charm-owned UnifiedPush fork**, iOS via **APNs** through Tauri v2 mobile
push) with a clean, pluggable **`NotificationTransport`** abstraction is Day-1 launch-critical:
without it, mobile Charm is silent when closed. This is the largest cross-platform backend
workstream in the launch set.

## Current state (in repo)

- Session + crypto persistence exist: matrix-sdk `sqlite` + `e2e-encryption` features
  (`src-tauri/Cargo.toml`), SQLCipher store + keychain key (`matrix/persistence.rs`), sync
  loop in `matrix/mod.rs` (`spawn_sync_loop`) emitting `sync:state` / `room_list:update` /
  `timeline:update`.
- **Local** OS notifications are Spec 10 (`tauri-plugin-notification`, fired in-app on new
  messages). **No** pusher registration, **no** push gateway integration, **no** UnifiedPush
  or APNs plumbing, **no** background/headless decrypt path.
- No mobile capability files yet; `capabilities/default.json` is desktop-scoped.
- `matrix-sdk` is present; its `push` module (`Ruleset` / `m.push_rules`) and
  `HttpPusherData` / `set_pusher` client APIs are available but unused.
- No `NotificationTransport` abstraction exists yet.

## Scope (in)

1. **`NotificationTransport` abstraction** (Rust trait): a pluggable transport where only the
   platform impl changes — `register()` (obtain a push endpoint/token), `endpoint()`,
   `unregister()`, and a way to receive/forward the incoming push payload into the shared
   decrypt-and-notify pipeline. Ported concept from prior art.
2. **Android transport via UnifiedPush** — integrate a **Charm-owned fork of the UnifiedPush
   Android connector/library (NOT Sable)**; register with a distributor, obtain the endpoint,
   register it as an HTTP pusher with the homeserver, receive pushes.
3. **iOS transport via APNs** using **Tauri v2 mobile push** — obtain the APNs device token,
   register it as a pusher (via the push gateway), receive the remote notification.
4. **Pusher registration** with the homeserver: `set_pusher` (matrix-sdk) with
   `HttpPusherData` pointing at the **push gateway** URL (Sygnal-style `/_matrix/push/v1/notify`
   or self-hosted gateway), `event_id_only` format so payloads are minimal and decryption
   happens client-side.
5. **Push-triggered background decryption**: on push receipt, spin up (or reuse) the
   matrix-rust-sdk client against the existing SQLCipher crypto store, fetch/decrypt the
   referenced event (`room_id` + `event_id` from the push), and build the notification body
   from plaintext — the core differentiator.
6. **Per-room notification levels** by reading `m.push_rules` (`matrix_sdk::ruma` `Ruleset`)
   to decide notify / highlight / mute per room and keyword. (The push-rules **settings UI** is
   **Spec 08** — this spec consumes/evaluates the rules server-side/on-device.)
7. Mobile-platform plumbing: capability files, background service/notification-service-extension
   entry points, permission requests.

## Non-goals (out)

- **Desktop remote push** — desktop uses the always-on sync loop + local notifications (Spec
  10). This spec targets mobile (Android/iOS) push where the process can be killed. (A desktop
  push path is a possible later unification, not Day-1.)
- **Push-rules editing UI** — Spec 08. This spec only *evaluates* rules.
- Running/operating the **push gateway** infrastructure itself (see open question) — this spec
  integrates with a gateway; standing one up is an infra task.
- Notification quick-reply / actions, grouping, rich media — Day-2+.
- VoIP/call push, per-device push rule sync UI.
- Web push (browsers) — out of Day-1 scope.

## Design & approach

### `NotificationTransport` abstraction (Rust)
- New module `src-tauri/src/push/mod.rs` defining:
  ```rust
  #[async_trait] // or native async trait
  pub trait NotificationTransport: Send + Sync {
      async fn register(&self) -> Result<PushEndpoint, PushError>;
      async fn unregister(&self) -> Result<(), PushError>;
      fn endpoint(&self) -> Option<PushEndpoint>;
  }
  ```
  where `PushEndpoint { url_or_token: String, app_id: String, kind: PusherKind }` carries what
  `set_pusher` needs. Platform impls: `push::android::UnifiedPushTransport`,
  `push::ios::ApnsTransport`. A `#[cfg(target_os = ...)]` factory (`fn active_transport()`)
  selects the impl so the rest of the code is transport-agnostic.
- Incoming pushes from either transport are normalized into a `PushMessage { room_id,
  event_id, unread, counts }` and handed to a shared `handle_push()`.

### Pusher registration (matrix-rust-sdk)
- Use `client.pusher().set(...)` / the `set_pusher` request with `Pusher` +
  `PusherData::Http(HttpPusherData { url: <gateway>/_matrix/push/v1/notify, .. })`,
  `PushFormat::EventIdOnly` (minimal payload), `app_id` per platform
  (`social.cloudhub.charm.android` / `.ios`), `pushkey` = transport endpoint/token,
  `lang`, `app_display_name`, `device_display_name`. Re-register on token rotation and after
  session restore.

### Push-triggered background decryption
- On `handle_push(PushMessage)`:
  1. Ensure a client bound to the existing SQLCipher store + keychain key (headless — no full
     UI). Reuse `build_client` / `persistence.rs` session restore.
  2. `client.get_room(room_id)` then fetch the event (`room.event(event_id)` /
     `room.decrypt_event`) — matrix-rust-sdk decrypts using the Rust-native crypto store,
     working even when the app was killed (the capability js-sdk lacked).
  3. Evaluate `m.push_rules` (`client.account().push_rules()` → `Ruleset`) against the event to
     decide notify/highlight/mute; if suppressed, drop silently.
  4. Build the notification (sender display name + decrypted preview, honoring "hide preview"
     privacy setting) and fire it via the **same notification-building code factored in Spec
     10** (`tauri-plugin-notification`). Fall back to a generic body if decryption fails
     (missing keys) — never leak ciphertext.
- Must run inside the platform's short background window: Android via the UnifiedPush
  receiver → a foreground/worker service invoking the Rust core over the mobile FFI; iOS via a
  **Notification Service Extension** that calls into the Rust core to mutate the notification
  content before display.

### Mobile-platform plumbing
- **Android**: bundle the **Charm-owned UnifiedPush fork**; register a distributor, implement
  the `MessagingReceiver`, bridge received bytes into the Rust core (Tauri mobile plugin /
  JNI). Manifest permissions (`POST_NOTIFICATIONS`, foreground service if used).
- **iOS**: enable Push Notifications + Background Modes capabilities in the Xcode project Tauri
  generates; add a **Notification Service Extension** target that links the Rust core; register
  for remote notifications to get the APNs token via Tauri v2 mobile push APIs.
- Capability files: add `src-tauri/capabilities/mobile.json` (or per-platform) granting
  `notification:default` and any push permissions; keep desktop capabilities unchanged.

### New commands + events (ts-rs)
- `#[tauri::command] register_push() -> PushRegistration` / `unregister_push()` — driven from
  settings (Spec 08) and on login.
- Event `push:status` with `PushStatus { transport: "unifiedpush"|"apns"|"none", registered:
  bool, endpoint_present: bool, last_error: Option<String> }` for the settings UI diagnostics.
- ts-rs: `PushRegistration`, `PushStatus`, `PusherKind` as
  `#[derive(Serialize, Deserialize, Clone, TS)] #[ts(export, export_to = "../src/bindings/")]`,
  mirroring the `matrix/mod.rs` convention.

### Frontend
- `src/features/push/usePush.ts` — calls `register_push`, subscribes to `push:status`; used by
  the Spec 08 notifications settings panel to show transport/registration state and a
  distributor picker (Android UnifiedPush).

## Acceptance criteria

1. On Android, the app registers with a UnifiedPush distributor (Charm-owned fork), obtains an
   endpoint, and registers it as an HTTP pusher with the homeserver (verified via
   `/_matrix/client/v3/pushers`).
2. On iOS, the app obtains an APNs device token and registers it as a pusher via the push
   gateway.
3. With the app **killed/backgrounded**, an incoming encrypted message produces a native
   notification whose body is the **decrypted** message preview (not "New message"), proving
   push-triggered background decryption against the Rust crypto store.
4. When decryption fails (missing megolm key), the notification shows a safe generic body and
   **never** exposes ciphertext; the failure is logged to Sentry.
5. Per-room push level is honored: a muted room produces **no** notification on push; a
   highlight rule (e.g. mention) produces a highlight notification — evaluated from
   `m.push_rules`.
6. `event_id_only` push format is used (gateway payload carries no message content); all
   content is fetched/decrypted on-device.
7. `NotificationTransport` is a single trait with two platform impls selected by `cfg`; adding
   a transport requires no changes outside `push::<platform>`.
8. `register_push` / `unregister_push` round-trip and `push:status` reflects state; unregister
   removes the pusher from the homeserver.
9. `cargo test` and `pnpm build` pass; mobile builds compile for iOS and Android.

## Testing

- **`cargo test`**: `handle_push` pipeline with a fixture encrypted event and a seeded crypto
  store → asserts decrypted preview; missing-key path → generic body, no ciphertext; push-rule
  evaluation (`Ruleset`) for mute/notify/highlight fixtures; `NotificationTransport` mock
  drives the pipeline without real APNs/UnifiedPush. Pusher-registration request shape asserted
  against ruma types.
- **Integration (dev Synapse + Sygnal-style gateway)**: register a pusher, send an encrypted
  message from a second account, assert the gateway `notify` fires and the decrypt-notify
  pipeline builds the expected body. Use the existing `dev/synapse` harness.
- **Android instrumentation**: UnifiedPush registration + receiver delivers bytes into the Rust
  core (emulator with a test distributor).
- **iOS**: Notification Service Extension unit test invoking the Rust core to mutate content
  (simulator; APNs token via a test harness).
- **Vitest + RTL**: `usePush` register/unregister flows and `push:status` rendering.

## Dependencies & sequencing

- **Depends on** Spec 10's factored notification-building code (title/body from a Matrix event)
  — reuse it for push-decrypt notifications; do not duplicate.
- **Depends on** existing crypto store / session restore (`persistence.rs`, `build_client`).
- **Consumes** push-rules; the **editing UI is Spec 08** (this spec ships the evaluation, Spec
  08 ships the toggles).
- **Push gateway**: a **Sygnal gateway already exists** — Android/UnifiedPush is unblocked.
  **iOS/APNs is gated on an APNs certificate** (Apple Developer account pending) — known
  limitation; sequence Android first and add iOS when the cert lands.
- Requires the **Charm-owned UnifiedPush fork** to exist and be buildable as an Android dep.
- Mobile capability files + Tauri mobile build targets must be established (coordinate with any
  mobile-bootstrap work).

## Risks & open questions

- **Push gateway infrastructure**: a **Sygnal gateway already exists** (2026-07-05) —
  this covers the UnifiedPush→homeserver path, so **Android push is unblocked** and should
  be built first. The remaining blocker is **iOS/APNs: no APNs certificate yet** (requires
  an Apple Developer account, which is pending). Treat iOS push as a **known limitation** —
  scope it behind the APNs cert becoming available; build and ship Android via the existing
  Sygnal gateway now, and wire the APNs pusher + iOS NSE once the cert lands.
- **UnifiedPush fork scope**: what diverges in the Charm-owned fork vs upstream, and its
  maintenance burden; distributor availability on user devices (some users have none — need a
  graceful fallback / embedded distributor story).
- **iOS background decrypt time budget**: Notification Service Extensions have a short, memory-
  limited window; opening SQLCipher + megolm decrypt must fit. Risk of timeouts → generic
  fallback.
- **Key availability on push**: the pushed event's megolm session may not yet be on device →
  decryption fails; mitigation is the generic-body fallback and a follow-up key request.
- **Rust core on mobile FFI**: bridging UnifiedPush (JNI) and the iOS NSE into the shared Rust
  core is non-trivial; the extension links a separate binary — code-sharing strategy TBD.
- **Battery/rate limits**: `event_id_only` minimizes payload but each push triggers a network
  fetch; ensure this is acceptable.

## Effort estimate

**L** — a large cross-platform backend workstream: a new transport abstraction, two native
mobile integrations (a forked Android library + an iOS NSE), homeserver pusher registration,
push-rule evaluation, and the headless decrypt pipeline, all gated on external push-gateway
infra. Realistically the largest single spec in the launch set.


## Real-device testing status update (2026-07-09)

Researched what's actually testable on a free-tier Apple Account (Xcode
Personal Team signing, no paid Apple Developer Program membership) ahead of
the owner doing real-device QA. See `CLAUDE.md`'s "Real-device Apple testing
with a free Apple Account" section for the build/install mechanics
(commands, Xcode signing steps, Personal Team limits) — this note covers
what that signing tier actually lets you verify against this spec.

**Not testable end-to-end on Personal Team signing:** remote APNs push
delivery, and push-triggered background decrypt/display. APNs requires the
app's App ID/provisioning profile to carry the Push Notifications
capability, and the gateway needs an Apple push key/certificate — both are
paid-Apple-Developer-Program-only. Separately (not a signing-tier issue):
**this repo's iOS APNs Rust/Swift bridge is still a documented stub** —
confirm current state before assuming this is purely a signing-tier
limitation; the settings UI should report no available iOS push transport
until that native plugin work actually lands.

**Testable on Personal Team signing regardless:** app launch, WebView
rendering, Matrix login, normal foreground sync, local storage/Keychain
behavior, local file/media flows, and most local UI flows. Spec 10's desktop
shell features aren't blocked by the iOS signing tier either — macOS dock
badge/local notifications are testable on macOS; tray/taskbar/autostart are
desktop-only and the mobile build intentionally reports autostart
unsupported (not a gap).

This is in addition to the already-tracked Android gaps: see issue #47
(push doesn't work when the app process is fully killed — the headline
capability this spec exists for) and issue #48 (embedded-FCM fallback needs
a VAPID gateway, infra not app code).
