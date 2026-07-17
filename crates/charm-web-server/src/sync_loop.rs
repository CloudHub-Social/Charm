//! Per-session background `/sync` loop and live event-handler registration —
//! this crate's equivalent of `src-tauri/src/matrix/sync.rs::spawn_sync_loop`
//! plus the `register_presence_handler`/`register_self_profile_handler`/
//! `register_verification_handler` calls it makes alongside it. Desktop
//! pushes every one of these via `app.emit`; this pushes the exact same DTOs
//! (see `crate::events::ServerEvent`) onto the session's WebSocket broadcast
//! channel instead.
//!
//! Deliberately **not** reproduced here, as desktop-only concerns that don't
//! apply to a browser tab: native OS dock/taskbar/tray badge application
//! (`shell::apply_native_badge`) and local desktop notifications
//! (`shell::maybe_send_notification` / `notify_unopened_room_messages`) — a
//! browser tab has no OS-level badge or notification surface to drive from
//! here (Spec 16's own scope explicitly separates this from the existing Web
//! Push work in Spec 11, which is the actual mechanism for a closed-tab
//! notification).

use std::time::Duration;

use charm_lib::matrix::ephemeral::{self, ReceiptUpdate, TypingUpdate};
use charm_lib::matrix::presence::{self, presence_event_to_update};
use charm_lib::matrix::profiles::self_profile_update;
use charm_lib::matrix::room_admin;
use charm_lib::matrix::rooms;
use charm_lib::matrix::shell;
use charm_lib::matrix::sync::SyncStateEvent;
use charm_lib::matrix::verification::{self, SasUpdateEvent, VerificationRequestSummary};
use futures_util::StreamExt;
use matrix_sdk::config::SyncSettings;
use matrix_sdk::encryption::verification::SasState;
use matrix_sdk::ruma::events::key::verification::request::ToDeviceKeyVerificationRequestEvent;
use matrix_sdk::ruma::events::presence::PresenceEvent;
use matrix_sdk::ruma::events::room::member::SyncRoomMemberEvent;
use matrix_sdk::Client;
use tokio::sync::broadcast;

use crate::events::{SasUpdatePayload, ServerEvent};
use crate::persistence::PersistenceStore;

/// Same bound and backoff shape as desktop's loop — see
/// `src-tauri/src/matrix/sync.rs::spawn_sync_loop` for the full rationale.
const MAX_CONSECUTIVE_SYNC_FAILURES: u32 = 10;

/// Bounds crypto-state loss if the process disappears without a graceful
/// shutdown. SQLite's online-backup API makes each snapshot consistent while
/// normal sync and request traffic continue using the live store.
const CRYPTO_SNAPSHOT_INTERVAL: Duration = Duration::from_secs(5 * 60);

/// What the sync loop needs to keep this session's persisted
/// `MatrixSession` current as the SDK silently rotates its access/refresh
/// token pair in the background (e.g. token refresh on a homeserver that
/// issues expiring tokens) — without this, only the token pair saved at
/// login time is ever persisted, so a restart some time after a refresh
/// restores a *stale, already-invalidated* token and drops the session even
/// though persistence is enabled.
pub struct PersistHandle {
    pub store: std::sync::Arc<PersistenceStore>,
    pub token: String,
    pub homeserver_url: String,
    /// The access token *actually on disk* for this session at the moment
    /// `spawn` is called — from the `MatrixSession` `routes::finish_login`
    /// just saved, or from the persisted entry `persistence::restore_one`
    /// read (**not** whatever `client.matrix_auth().session()` reports at
    /// spawn time). Seeds `last_saved_access_token` in `spawn` below.
    ///
    /// The distinction matters for restore specifically: `restore_one`'s own
    /// `sync_once` (run to re-establish local room-store state before this
    /// function is ever called) can itself trigger a token refresh on a
    /// homeserver that issues expiring tokens — so by the time `spawn` runs,
    /// the *client's* current session may already differ from what's on
    /// disk. Seeding from the client's live state (an earlier version of
    /// this did exactly that) would make that already-refreshed token look
    /// like "no change from what's saved", so it would never get persisted
    /// — a session restored once, silently carrying a token now stale on
    /// disk, would fail to restore again on the *next* restart.
    ///
    /// `None` means "nothing is actually on disk for this session yet" —
    /// `finish_login`'s own initial `persistence.save` failed (a transient
    /// disk/lock error). Seeding `last_saved_access_token` with `None` in
    /// that case (rather than the live token, which an earlier version of
    /// this did) makes `spawn`'s very first `repersist_if_token_changed`
    /// check compare against nothing-saved and immediately retry the write,
    /// instead of mistaking "the live token happens to match what I was
    /// told is saved" for "this session is actually safely on disk" — which
    /// would otherwise leave it persisted nowhere until the token later
    /// happened to rotate.
    pub initial_access_token: Option<String>,
    /// This session's crypto-store identity, if it has one — threaded
    /// through unchanged into every re-save below (see `PersistenceStore::
    /// save`'s doc comment on why a re-save must reuse, not regenerate, the
    /// pair a session was first persisted with).
    pub crypto: Option<crate::session::CryptoStoreHandle>,
}

/// Re-saves the session if (and only if) its access token has changed since
/// `last_saved_access_token`, returning the new value to track — cheap to
/// call after every sync iteration without rewriting
/// the encrypted session object on every poll when nothing actually rotated.
async fn repersist_if_token_changed(
    client: &Client,
    persist: &PersistHandle,
    last_saved_access_token: Option<String>,
) -> Option<String> {
    let session = client.matrix_auth().session()?;
    if last_saved_access_token.as_deref() == Some(session.tokens.access_token.as_str()) {
        return last_saved_access_token;
    }
    let access_token = session.tokens.access_token.clone();
    let crypto = persist
        .crypto
        .as_ref()
        .map(|c| (c.store_key.as_str(), c.passphrase.as_str()));
    // `last_saved_access_token` being `None` here means no save has ever
    // succeeded yet for this handle's lifetime — either the very first call
    // (seeded from `PersistHandle::initial_access_token`, which is `None`
    // exactly when `finish_login`'s own initial save failed) or every prior
    // attempt has itself failed. Either way, `persistence::save` needs to
    // know it's allowed to create a fresh object if nothing is there yet,
    // not treat a missing object as "another process's logout deleted it"
    // — see `SaveMode::RetryInitialSave`'s doc comment (Codex review
    // finding on #280).
    let mode = if last_saved_access_token.is_none() {
        crate::persistence::SaveMode::RetryInitialSave
    } else {
        crate::persistence::SaveMode::Resave
    };
    if let Err(e) = persist
        .store
        .save(
            &persist.token,
            &persist.homeserver_url,
            &session,
            crypto,
            mode,
        )
        .await
    {
        tracing::warn!("failed to re-persist refreshed session: {e}");
        return last_saved_access_token;
    }
    Some(access_token)
}

async fn snapshot_crypto_store(client: &Client, persist: &PersistHandle) {
    let (Some(session), Some(crypto)) = (client.matrix_auth().session(), persist.crypto.as_ref())
    else {
        return;
    };
    if let Err(error) = persist
        .store
        .snapshot_crypto_store(
            &persist.token,
            &session,
            Some((crypto.store_key.as_str(), crypto.passphrase.as_str())),
        )
        .await
    {
        tracing::warn!("failed to refresh durable crypto snapshot: {error}");
    }
}

/// Registers this session's live event handlers — presence, self-profile,
/// and incoming verification requests. Split out from [`spawn`] so callers
/// (`auth::login`/`auth::register`/`persistence::restore_one`) can call this
/// *before* their own initial `sync_once`, not just before `spawn`'s loop:
/// a `to-device` event (like `m.key.verification.request`) that arrives
/// during that very first sync is processed once, synchronously, as part of
/// that call — it is never replayed on a later sync. Registering the
/// verification handler only once `spawn` runs (an earlier version of this
/// function did exactly that) meant a verification request that happened to
/// land in the initial sync's response was silently dropped: the browser
/// would never see its `verification:request` event and the flow would be
/// stuck with no way to know it existed.
pub fn register_event_handlers(
    client: &Client,
    events: broadcast::Sender<ServerEvent>,
    pending_verification_events: std::sync::Arc<std::sync::Mutex<Vec<ServerEvent>>>,
    profile_and_presence: crate::session::ProfileAndPresenceSnapshots,
) {
    register_presence_handler(
        client.clone(),
        events.clone(),
        profile_and_presence.presence_snapshots,
    );
    register_self_profile_handler(
        client.clone(),
        events.clone(),
        profile_and_presence.profile_snapshot,
    );
    register_verification_handler(client.clone(), events, pending_verification_events);
}

/// Sends `event` live if there's at least one connected WebSocket receiver;
/// otherwise buffers it in `pending` for `crate::routes::ws_handler` to
/// deliver on the next connection — see `Session::pending_verification_events`'s
/// doc comment for why this matters specifically for verification events.
/// A buffered `verification:sas_update` replaces any earlier one already
/// buffered *for the same flow* rather than accumulating: only the latest
/// state is ever useful to resume from, and keeping every intermediate one
/// would also make it easy for a single fast-moving flow to crowd out a
/// genuinely separate flow's buffered request.
///
/// **Known gap:** `events.send(..).is_ok()` only proves a receiver was
/// *subscribed* at this instant — not that the frame actually reached the
/// browser. `crate::routes::handle_socket`'s own forwarding loop can still
/// fail to write it (a slow/dying connection, or the receiver getting
/// dropped for lagging) *after* this function already decided not to
/// buffer. Closing that gap for real needs delivery-acknowledgement
/// semantics (the client confirming receipt, or `handle_socket` re-queuing
/// on its own send failure) rather than the fire-and-forget broadcast this
/// crate uses everywhere else — a genuinely different design, not a
/// one-line fix, so it's called out here rather than half-solved. In
/// practice this only matters for the narrow window where a connection is
/// live-but-about-to-die exactly when an event fires; the common cases
/// (no connection at all, a healthy connection) are both already handled
/// correctly.
/// `ephemeral::ReceiptTypeDto` has no `PartialEq` (it's a shared `charm_lib`
/// type with no reason to carry one for desktop's own use) — this crate's
/// receipt-snapshot dedup is the only place that needs to compare two of
/// them, so it's a local helper rather than adding a derive upstream.
fn receipt_type_matches(
    a: charm_lib::matrix::ephemeral::ReceiptTypeDto,
    b: charm_lib::matrix::ephemeral::ReceiptTypeDto,
) -> bool {
    use charm_lib::matrix::ephemeral::ReceiptTypeDto;
    matches!(
        (a, b),
        (ReceiptTypeDto::Read, ReceiptTypeDto::Read)
            | (ReceiptTypeDto::ReadPrivate, ReceiptTypeDto::ReadPrivate)
    )
}

fn buffer_verification_event(
    events: &broadcast::Sender<ServerEvent>,
    pending: &std::sync::Arc<std::sync::Mutex<Vec<ServerEvent>>>,
    event: ServerEvent,
) {
    if events.send(event.clone()).is_ok() {
        return;
    }
    let mut pending = pending.lock().unwrap_or_else(|e| e.into_inner());
    if let ServerEvent::VerificationSasUpdate(SasUpdatePayload { flow_id, .. }) = &event {
        pending.retain(|existing| {
            !matches!(
                existing,
                ServerEvent::VerificationSasUpdate(SasUpdatePayload { flow_id: existing_flow, .. })
                    if existing_flow == flow_id
            )
        });
    }
    if pending.len() < crate::session::MAX_PENDING_VERIFICATION_EVENTS {
        pending.push(event);
    }
}

/// Spawns this session's background sync loop. Called once per session,
/// right after login/register/restore (mirrors desktop calling
/// `spawn_sync_loop` from the same three places) — **after**
/// [`register_event_handlers`] has already been called on this same
/// `client` by the caller, before its own initial `sync_once` (see that
/// function's doc comment for why the ordering matters).
///
/// `initial_response` is the `SyncResponse` `auth::login`/`auth::register`/
/// `persistence::restore_one` already obtained establishing local room-store
/// state — **not** re-fetched here. An earlier version of this function did
/// its own `sync_once` first thing, which was a real user-visible bug, not
/// just redundant work: since the caller's sync already advanced the
/// client's sync token, this second call would find nothing new and
/// long-poll for its full timeout (tens of seconds) before returning,
/// delaying the very first `sync:state`/`room_list:update` a freshly
/// connected browser tab sees.
///
/// Returns the loop's `JoinHandle` so the caller can abort it on logout.
///
/// **Known gap: no idle/abandoned-session expiry.** This loop (and the
/// presence-online task it spawns) runs for as long as the session exists
/// in `SessionStore` — aborted only on an explicit logout (`sync_handle` in
/// `session.rs`), never because a browser tab was simply closed without
/// logging out, or because a restored-at-startup session has had no
/// WebSocket connection at all since the restart. Both cases keep
/// long-polling `/sync` and advertising the account as online indefinitely.
/// Desktop doesn't have this problem — its single client's lifetime is tied
/// to the app process itself, closing the window *is* logging out in every
/// practical sense — but a web session has no equivalent signal; there's no
/// tab-close event a server can observe. Fixing this properly needs its own
/// idle-timeout design (e.g. track last-WebSocket-activity per session and
/// abort/re-mark-offline after some threshold with nobody connected) rather
/// than a one-line change, so it's called out here rather than silently
/// shipped incomplete — same treatment as the crypto-store persistence gap
/// (see `persistence.rs`'s module doc comment).
pub fn spawn(
    client: Client,
    events: broadcast::Sender<ServerEvent>,
    sync_presence: std::sync::Arc<std::sync::Mutex<charm_lib::matrix::presence::PresenceStateDto>>,
    persist: Option<PersistHandle>,
    initial_response: matrix_sdk::sync::SyncResponse,
    snapshots: crate::session::SyncSnapshots,
) -> tokio::task::JoinHandle<()> {
    {
        let client = client.clone();
        let sync_presence = sync_presence.clone();
        tokio::spawn(async move {
            // Read whatever `sync_presence` already holds rather than
            // hardcoding `Online` — for an ordinary fresh login/register or
            // a full-process restart's `restore_all`, `Session::new`
            // defaults this to `Online` anyway (see `PresenceStateDto`'s
            // `Default` impl), so behavior there is unchanged. But
            // `routes::require_session`'s on-demand restore of an
            // idle-evicted session (see `session::SessionStore::sweep_idle`)
            // seeds this with the session's presence choice *at the moment
            // it was evicted* before calling this `spawn` — hardcoding
            // `Online` here would silently undo an explicit
            // `unavailable`/`offline` choice the instant that session comes
            // back from an idle eviction, even though the steady-state loop
            // below already takes care to read this same value fresh on
            // every iteration for exactly that reason.
            let presence = *sync_presence.lock().unwrap_or_else(|e| e.into_inner());
            let _ = presence::set_presence_impl(&client, presence, None).await;
        });
    }

    tokio::spawn(async move {
        let last_snapshot = &snapshots.last_snapshot;
        emit_snapshot(
            &events,
            last_snapshot,
            ServerEvent::SyncState(SyncStateEvent::Syncing),
        );
        emit_snapshot(
            &events,
            last_snapshot,
            ServerEvent::SyncState(SyncStateEvent::Idle),
        );
        emit_room_list_and_badge(&client, &events, last_snapshot).await;
        emit_room_updates(&client, &events, &initial_response, &snapshots).await;

        // Seeded from `PersistHandle::initial_access_token` — what's
        // actually saved on disk right now — not `None` and not the
        // client's own current session; see that field's doc comment for
        // why both of those are wrong (the former rewrites unchanged
        // content on every login/restore, the latter can miss a token
        // refresh that already happened during restore's own initial
        // sync).
        let mut last_saved_access_token = persist
            .as_ref()
            .and_then(|p| p.initial_access_token.clone());
        // Check immediately, not just from the loop's first iteration below:
        // `restore_one`'s own initial sync (run before `spawn` is ever
        // called) can itself refresh an expiring token, so the client's
        // live session may already differ from `initial_access_token` right
        // now. The loop's first `sync_once` can long-poll for tens of
        // seconds, exhaust its retry budget, or the process can restart
        // before that first iteration ever completes — any of which would
        // otherwise leave the encrypted session object holding the stale,
        // already-invalidated token for that whole window.
        if let Some(persist) = &persist {
            last_saved_access_token =
                repersist_if_token_changed(&client, persist, last_saved_access_token).await;
        }

        let mut consecutive_failures: u32 = 0;
        let mut last_crypto_snapshot = tokio::time::Instant::now();
        loop {
            // Read fresh every iteration, not baked into one long-lived
            // `SyncSettings` — see `Session::sync_presence`'s doc comment
            // for why (an explicit `unavailable`/`offline` choice must
            // survive past the very next long-poll).
            let presence = *sync_presence.lock().unwrap_or_else(|e| e.into_inner());
            let settings = SyncSettings::default().set_presence(presence.into());
            match client.sync_once(settings).await {
                Ok(response) => {
                    consecutive_failures = 0;
                    emit_room_list_and_badge(&client, &events, last_snapshot).await;
                    emit_room_updates(&client, &events, &response, &snapshots).await;
                    if let Some(persist) = &persist {
                        last_saved_access_token =
                            repersist_if_token_changed(&client, persist, last_saved_access_token)
                                .await;
                        if last_crypto_snapshot.elapsed() >= CRYPTO_SNAPSHOT_INTERVAL {
                            snapshot_crypto_store(&client, persist).await;
                            last_crypto_snapshot = tokio::time::Instant::now();
                        }
                    }
                }
                Err(e) => {
                    consecutive_failures += 1;
                    if consecutive_failures >= MAX_CONSECUTIVE_SYNC_FAILURES {
                        emit_snapshot(
                            &events,
                            last_snapshot,
                            ServerEvent::SyncState(SyncStateEvent::Error {
                                message: e.to_string(),
                            }),
                        );
                        break;
                    }
                    let backoff_secs = 1u64 << (consecutive_failures - 1).min(4);
                    tokio::time::sleep(Duration::from_secs(backoff_secs.min(30))).await;
                }
            }
        }
    })
}

/// Sends `event` live (best-effort, same as every other broadcast in this
/// module) and also overwrites `last_snapshot`'s entry for this same
/// `ServerEvent` variant — see `Session::last_snapshot`'s doc comment.
/// Unlike `buffer_verification_event`, this always updates the cache
/// regardless of whether the live send had any receivers: the point isn't
/// "deliver this exact event eventually", it's "always have *a* current
/// value ready to hand a newly connecting socket".
fn emit_snapshot(
    events: &broadcast::Sender<ServerEvent>,
    last_snapshot: &std::sync::Arc<std::sync::Mutex<Vec<ServerEvent>>>,
    event: ServerEvent,
) {
    // Cache updated *before* the live broadcast, not after: a socket that
    // subscribes in between those two steps would otherwise be too late to
    // receive the live send and too early to see the new value in the
    // replay cache — missing this update entirely until the next one.
    // Updating the cache first closes that window (a socket connecting
    // during this function now always sees at least this value, either via
    // the live broadcast or the replay cache, whichever race it lands in).
    {
        let mut snapshot = last_snapshot.lock().unwrap_or_else(|e| e.into_inner());
        snapshot
            .retain(|existing| std::mem::discriminant(existing) != std::mem::discriminant(&event));
        snapshot.push(event.clone());
    }
    let _ = events.send(event);
}

async fn emit_room_list_and_badge(
    client: &Client,
    events: &broadcast::Sender<ServerEvent>,
    last_snapshot: &std::sync::Arc<std::sync::Mutex<Vec<ServerEvent>>>,
) {
    // No media cache in this crate yet (matches sub-PR A's `snapshot_rooms`
    // calls in `routes.rs`) — room avatars carry their bare `mxc://` url but
    // no locally resolved thumbnail path. The `room_list_message_preview`
    // flag isn't wired into web sessions yet either (no feature-flag
    // evaluation exists in this crate at all), so this is always `false` —
    // a fresh, never-populated `Mutex` per call is correct: nothing ever
    // registers with `LatestEvents` from this path, so there's nothing to
    // track across calls or forget.
    let snapshot = rooms::snapshot_rooms(client, None, false, &std::sync::Mutex::default()).await;
    let badge = shell::compute_badge_state(&snapshot);
    emit_snapshot(events, last_snapshot, ServerEvent::RoomList(snapshot));
    emit_snapshot(events, last_snapshot, ServerEvent::Badge(badge));
}

async fn emit_room_updates(
    client: &Client,
    events: &broadcast::Sender<ServerEvent>,
    response: &matrix_sdk::sync::SyncResponse,
    snapshots: &crate::session::SyncSnapshots,
) {
    let room_details_snapshots = &snapshots.room_details_snapshots;
    let receipt_snapshots = &snapshots.receipt_snapshots;
    let typing_snapshots = &snapshots.typing_snapshots;
    let own_user_id = client.user_id();
    for (room_id, update) in &response.rooms.joined {
        let mut receipts = Vec::new();
        for raw_event in &update.ephemeral {
            let Ok(event) = raw_event.deserialize() else {
                continue;
            };
            match event {
                matrix_sdk::ruma::events::AnySyncEphemeralRoomEvent::Receipt(receipt_event) => {
                    receipts.extend(ephemeral::receipt_content_to_updates(
                        &receipt_event.content,
                    ));
                }
                matrix_sdk::ruma::events::AnySyncEphemeralRoomEvent::Typing(typing_event) => {
                    let user_ids =
                        ephemeral::typing_content_to_user_ids(&typing_event.content, own_user_id);
                    let event = ServerEvent::Typing(TypingUpdate {
                        room_id: room_id.to_string(),
                        user_ids,
                    });
                    typing_snapshots
                        .lock()
                        .unwrap_or_else(|e| e.into_inner())
                        .insert(room_id.clone(), event.clone());
                    let _ = events.send(event);
                }
                _ => {}
            }
        }
        if !receipts.is_empty() {
            // Update the accumulated per-room/per-user snapshot (for replay
            // on reconnect, see `Session::receipt_snapshots`'s doc comment)
            // but still broadcast just this delta live — the frontend
            // (`useReadReceipts`) already applies live `receipts:update`s
            // incrementally, so sending the full accumulated set here too
            // would just be redundant re-application of receipts it's
            // already applied.
            {
                let mut snapshots = receipt_snapshots.lock().unwrap_or_else(|e| e.into_inner());
                let room_receipts = snapshots.entry(room_id.clone()).or_default();
                for receipt in &receipts {
                    room_receipts.retain(|existing| {
                        !(existing.user_id == receipt.user_id
                            && receipt_type_matches(existing.receipt_type, receipt.receipt_type))
                    });
                }
                room_receipts.extend(receipts.iter().cloned());
            }
            let _ = events.send(ServerEvent::Receipts(ReceiptUpdate {
                room_id: room_id.to_string(),
                receipts,
            }));
        }

        let state_events_present = match &update.state {
            matrix_sdk::sync::State::Before(events) | matrix_sdk::sync::State::After(events) => {
                !events.is_empty()
            }
        } || update.timeline.events.iter().any(|event| {
            event
                .raw()
                .get_field::<String>("state_key")
                .ok()
                .flatten()
                .is_some()
        });
        if state_events_present {
            if let Ok(details) = room_admin::build_room_details(client, room_id.as_str()).await {
                let event = ServerEvent::RoomDetails(details);
                room_details_snapshots
                    .lock()
                    .unwrap_or_else(|e| e.into_inner())
                    .insert(room_id.clone(), event.clone());
                let _ = events.send(event);
            }
        }
    }
}

/// Web-server-local equivalent of `presence::register_presence_handler`,
/// reusing its pure `presence_event_to_update` mapper rather than
/// `app.emit`.
fn register_presence_handler(
    client: Client,
    events: broadcast::Sender<ServerEvent>,
    presence_snapshots: std::sync::Arc<
        std::sync::Mutex<std::collections::HashMap<matrix_sdk::ruma::OwnedUserId, ServerEvent>>,
    >,
) {
    client.add_event_handler(move |ev: PresenceEvent| {
        let events = events.clone();
        let presence_snapshots = presence_snapshots.clone();
        async move {
            let sender = ev.sender.clone();
            let event = ServerEvent::Presence(presence_event_to_update(&ev));
            presence_snapshots
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .insert(sender, event.clone());
            let _ = events.send(event);
        }
    });
}

/// Web-server-local equivalent of `profiles::register_self_profile_handler`.
fn register_self_profile_handler(
    client: Client,
    events: broadcast::Sender<ServerEvent>,
    profile_snapshot: std::sync::Arc<std::sync::Mutex<Option<ServerEvent>>>,
) {
    let own_user_id = client.user_id().map(ToOwned::to_owned);
    let last_emitted: std::sync::Arc<
        std::sync::Mutex<Option<charm_lib::matrix::profiles::SelfProfileUpdate>>,
    > = std::sync::Arc::new(std::sync::Mutex::new(None));
    client.add_event_handler(move |ev: SyncRoomMemberEvent| {
        let events = events.clone();
        let own_user_id = own_user_id.clone();
        let last_emitted = last_emitted.clone();
        let profile_snapshot = profile_snapshot.clone();
        async move {
            let Some(own_user_id) = own_user_id else {
                return;
            };
            let SyncRoomMemberEvent::Original(ev) = ev else {
                return;
            };
            let Some(update) = self_profile_update(&own_user_id, &ev.state_key, &ev.content) else {
                return;
            };
            let mut last_emitted = last_emitted.lock().unwrap_or_else(|e| e.into_inner());
            if last_emitted.as_ref() == Some(&update) {
                return;
            }
            *last_emitted = Some(update.clone());
            let event = ServerEvent::ProfileSelf(update);
            *profile_snapshot.lock().unwrap_or_else(|e| e.into_inner()) = Some(event.clone());
            let _ = events.send(event);
        }
    });
}

/// Web-server-local equivalent of `verification::register_verification_handler`.
fn register_verification_handler(
    client: Client,
    events: broadcast::Sender<ServerEvent>,
    pending: std::sync::Arc<std::sync::Mutex<Vec<ServerEvent>>>,
) {
    client.add_event_handler(
        move |ev: ToDeviceKeyVerificationRequestEvent, client: Client| {
            let events = events.clone();
            let pending = pending.clone();
            async move {
                let Some(request) = client
                    .encryption()
                    .get_verification_request(&ev.sender, ev.content.transaction_id.as_str())
                    .await
                else {
                    return;
                };

                let summary = VerificationRequestSummary {
                    flow_id: request.flow_id().to_string(),
                    other_user_id: request.other_user_id().to_string(),
                    other_device_id: ev.content.from_device.to_string(),
                };

                buffer_verification_event(
                    &events,
                    &pending,
                    ServerEvent::VerificationRequest(summary),
                );
            }
        },
    );
}

/// Starts the SAS flow on an already-accepted verification request and
/// streams `verification:sas_update` events until it's done/cancelled — same
/// state machine as desktop's `verification::start_sas_verification`, just
/// pushed onto this session's broadcast channel instead of `app.emit`. Called
/// from the `POST /api/verification/sas/start` route (see `routes.rs`).
pub async fn start_sas_verification(
    client: &Client,
    events: broadcast::Sender<ServerEvent>,
    pending: std::sync::Arc<std::sync::Mutex<Vec<ServerEvent>>>,
    other_user_id: &str,
    flow_id: &str,
) -> Result<(), String> {
    let verification::StartedSasVerification {
        sas,
        accept_after_subscribe,
    } = verification::start_sas_verification_impl(client, other_user_id, flow_id).await?;
    let watcher_sas = sas.clone();
    let mut changes = watcher_sas.changes();
    if accept_after_subscribe {
        sas.accept().await.map_err(|e| e.to_string())?;
    }
    let flow_id = flow_id.to_string();

    tokio::spawn(async move {
        if buffer_sas_update(&events, &pending, &flow_id, watcher_sas.state()) {
            return;
        }

        while let Some(sas_state) = changes.next().await {
            if buffer_sas_update(&events, &pending, &flow_id, sas_state) {
                break;
            }
        }
    });

    Ok(())
}

fn buffer_sas_update(
    events: &broadcast::Sender<ServerEvent>,
    pending: &std::sync::Arc<std::sync::Mutex<Vec<ServerEvent>>>,
    flow_id: &str,
    sas_state: SasState,
) -> bool {
    let Some(update) = verification::sas_state_to_update(sas_state) else {
        return false;
    };
    let is_terminal = matches!(
        update,
        SasUpdateEvent::Done | SasUpdateEvent::Cancelled { .. }
    );
    buffer_verification_event(
        events,
        pending,
        ServerEvent::VerificationSasUpdate(SasUpdatePayload {
            flow_id: flow_id.to_string(),
            update,
        }),
    );
    is_terminal
}

/// Starts an outgoing SAS verification of another of this account's own
/// devices ("verify another session") — web-server-local equivalent of
/// desktop's `devices::request_device_verification`, reusing the SDK calls
/// directly (that command has no `_impl` split; it's tightly coupled to
/// `app.emit`) rather than duplicating them into `charm_lib`. Without this,
/// a web session could only ever *respond* to a verification request
/// another client started — never initiate one itself. Returns the new
/// flow's id immediately, before the other device has necessarily accepted,
/// same as desktop: the caller should watch for
/// `verification:sas_update`/`verification:request` afterward rather than
/// block on this waiting for the whole flow.
pub async fn request_device_verification(
    client: &Client,
    events: broadcast::Sender<ServerEvent>,
    pending: std::sync::Arc<std::sync::Mutex<Vec<ServerEvent>>>,
    device_id: &str,
) -> Result<String, String> {
    use matrix_sdk::encryption::verification::VerificationRequestState;
    use matrix_sdk::ruma::OwnedDeviceId;

    let own_user_id = client
        .user_id()
        .ok_or_else(|| "not logged in".to_string())?
        .to_owned();
    let device_id: OwnedDeviceId = device_id.into();

    let device = client
        .encryption()
        .get_device(&own_user_id, &device_id)
        .await
        .map_err(|e| e.to_string())?
        .ok_or_else(|| format!("device {device_id} not found"))?;

    let request = device
        .request_verification()
        .await
        .map_err(|e| e.to_string())?;
    let flow_id = request.flow_id().to_string();

    let emit_flow_id = flow_id.clone();
    tokio::spawn(async move {
        let mut changes = request.changes();
        while let Some(request_state) = changes.next().await {
            match request_state {
                VerificationRequestState::Ready { .. } => break,
                // Same exhaustive terminal-state bailout as
                // `start_sas_verification`'s SAS-state loop above — these
                // states are never expected without first observing
                // `Ready`, so give up rather than loop forever if one
                // somehow arrives anyway.
                VerificationRequestState::Cancelled(_)
                | VerificationRequestState::Done
                | VerificationRequestState::Transitioned { .. } => return,
                VerificationRequestState::Created { .. }
                | VerificationRequestState::Requested { .. } => continue,
            }
        }

        buffer_verification_event(
            &events,
            &pending,
            ServerEvent::VerificationRequest(VerificationRequestSummary {
                flow_id: emit_flow_id,
                other_user_id: own_user_id.to_string(),
                other_device_id: device_id.to_string(),
            }),
        );
    });

    Ok(flow_id)
}
