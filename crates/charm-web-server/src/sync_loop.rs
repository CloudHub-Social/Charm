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
use charm_lib::matrix::verification::{
    self, EmojiPair, SasUpdateEvent, VerificationRequestSummary,
};
use futures_util::StreamExt;
use matrix_sdk::config::SyncSettings;
use matrix_sdk::encryption::verification::{Emoji, SasState};
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
    pub initial_access_token: String,
}

/// Re-saves the session if (and only if) its access token has changed since
/// `last_saved_access_token`, returning the new value to track — cheap to
/// call after every sync iteration without rewriting
/// `sessions.enc.json` on every single poll when nothing actually rotated.
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
    if let Err(e) = persist
        .store
        .save(&persist.token, &persist.homeserver_url, &session)
        .await
    {
        tracing::warn!("failed to re-persist refreshed session: {e}");
        return last_saved_access_token;
    }
    Some(access_token)
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
    pending_verification_requests: std::sync::Arc<
        std::sync::Mutex<Vec<VerificationRequestSummary>>,
    >,
) {
    register_presence_handler(client.clone(), events.clone());
    register_self_profile_handler(client.clone(), events.clone());
    register_verification_handler(client.clone(), events, pending_verification_requests);
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
) -> tokio::task::JoinHandle<()> {
    {
        let client = client.clone();
        tokio::spawn(async move {
            let _ = presence::set_presence_online(&client).await;
        });
    }

    tokio::spawn(async move {
        let _ = events.send(ServerEvent::SyncState(SyncStateEvent::Syncing));
        let _ = events.send(ServerEvent::SyncState(SyncStateEvent::Idle));
        emit_room_list_and_badge(&client, &events).await;
        emit_room_updates(&client, &events, &initial_response).await;

        // Seeded from `PersistHandle::initial_access_token` — what's
        // actually saved on disk right now — not `None` and not the
        // client's own current session; see that field's doc comment for
        // why both of those are wrong (the former rewrites unchanged
        // content on every login/restore, the latter can miss a token
        // refresh that already happened during restore's own initial
        // sync).
        let mut last_saved_access_token = persist.as_ref().map(|p| p.initial_access_token.clone());

        let mut consecutive_failures: u32 = 0;
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
                    emit_room_list_and_badge(&client, &events).await;
                    emit_room_updates(&client, &events, &response).await;
                    if let Some(persist) = &persist {
                        last_saved_access_token =
                            repersist_if_token_changed(&client, persist, last_saved_access_token)
                                .await;
                    }
                }
                Err(e) => {
                    consecutive_failures += 1;
                    if consecutive_failures >= MAX_CONSECUTIVE_SYNC_FAILURES {
                        let _ = events.send(ServerEvent::SyncState(SyncStateEvent::Error {
                            message: e.to_string(),
                        }));
                        break;
                    }
                    let backoff_secs = 1u64 << (consecutive_failures - 1).min(4);
                    tokio::time::sleep(Duration::from_secs(backoff_secs.min(30))).await;
                }
            }
        }
    })
}

async fn emit_room_list_and_badge(client: &Client, events: &broadcast::Sender<ServerEvent>) {
    // No media cache in this crate yet (matches sub-PR A's `snapshot_rooms`
    // calls in `routes.rs`) — room avatars carry their bare `mxc://` url but
    // no locally resolved thumbnail path.
    let snapshot = rooms::snapshot_rooms(client, None).await;
    let badge = shell::compute_badge_state(&snapshot);
    let _ = events.send(ServerEvent::RoomList(snapshot));
    let _ = events.send(ServerEvent::Badge(badge));
}

async fn emit_room_updates(
    client: &Client,
    events: &broadcast::Sender<ServerEvent>,
    response: &matrix_sdk::sync::SyncResponse,
) {
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
                    let _ = events.send(ServerEvent::Typing(TypingUpdate {
                        room_id: room_id.to_string(),
                        user_ids,
                    }));
                }
                _ => {}
            }
        }
        if !receipts.is_empty() {
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
                let _ = events.send(ServerEvent::RoomDetails(details));
            }
        }
    }
}

/// Web-server-local equivalent of `presence::register_presence_handler`,
/// reusing its pure `presence_event_to_update` mapper rather than
/// `app.emit`.
fn register_presence_handler(client: Client, events: broadcast::Sender<ServerEvent>) {
    client.add_event_handler(move |ev: PresenceEvent| {
        let events = events.clone();
        async move {
            let _ = events.send(ServerEvent::Presence(presence_event_to_update(&ev)));
        }
    });
}

/// Web-server-local equivalent of `profiles::register_self_profile_handler`.
fn register_self_profile_handler(client: Client, events: broadcast::Sender<ServerEvent>) {
    let own_user_id = client.user_id().map(ToOwned::to_owned);
    let last_emitted: std::sync::Arc<
        std::sync::Mutex<Option<charm_lib::matrix::profiles::SelfProfileUpdate>>,
    > = std::sync::Arc::new(std::sync::Mutex::new(None));
    client.add_event_handler(move |ev: SyncRoomMemberEvent| {
        let events = events.clone();
        let own_user_id = own_user_id.clone();
        let last_emitted = last_emitted.clone();
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
            let _ = events.send(ServerEvent::ProfileSelf(update));
        }
    });
}

/// Web-server-local equivalent of `verification::register_verification_handler`.
fn register_verification_handler(
    client: Client,
    events: broadcast::Sender<ServerEvent>,
    pending: std::sync::Arc<std::sync::Mutex<Vec<VerificationRequestSummary>>>,
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

                // `broadcast::Sender::send` returns `Err` precisely when
                // there are zero active receivers right now — i.e. exactly
                // the "nobody could have gotten this live" case buffering
                // exists for (see `Session::pending_verification_requests`'s
                // doc comment). Buffering unconditionally (an earlier
                // version of this did exactly that) meant a request that
                // *was* delivered live still sat in the buffer and got
                // redelivered — stale and duplicated — to the next socket
                // that connects (a reconnect, a second tab), and could fill
                // the bounded buffer with already-delivered entries,
                // crowding out a genuinely missed one for the flow that
                // actually needs it.
                if events
                    .send(ServerEvent::VerificationRequest(summary.clone()))
                    .is_err()
                {
                    let mut pending = pending.lock().unwrap_or_else(|e| e.into_inner());
                    if pending.len() < crate::session::MAX_PENDING_VERIFICATION_REQUESTS {
                        pending.push(summary);
                    }
                }
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
    other_user_id: &str,
    flow_id: &str,
) -> Result<(), String> {
    let sas = verification::start_sas_verification_impl(client, other_user_id, flow_id).await?;
    let flow_id = flow_id.to_string();

    tokio::spawn(async move {
        let mut changes = sas.changes();
        while let Some(sas_state) = changes.next().await {
            let update = match sas_state {
                SasState::Started { .. } => SasUpdateEvent::Started,
                SasState::Accepted { .. } => SasUpdateEvent::Accepted,
                SasState::KeysExchanged { emojis, .. } => SasUpdateEvent::KeysExchanged {
                    emojis: emojis
                        .map(|e| e.emojis.into_iter().map(to_emoji_pair).collect())
                        .unwrap_or_default(),
                },
                SasState::Confirmed => SasUpdateEvent::Confirmed,
                SasState::Done { .. } => SasUpdateEvent::Done,
                SasState::Cancelled(info) => SasUpdateEvent::Cancelled {
                    reason: info.reason().to_string(),
                },
                SasState::Created { .. } => continue,
            };
            let is_terminal = matches!(
                update,
                SasUpdateEvent::Done | SasUpdateEvent::Cancelled { .. }
            );
            let _ = events.send(ServerEvent::VerificationSasUpdate(SasUpdatePayload {
                flow_id: flow_id.clone(),
                update,
            }));
            if is_terminal {
                break;
            }
        }
    });

    Ok(())
}

fn to_emoji_pair(emoji: Emoji) -> EmojiPair {
    EmojiPair {
        symbol: emoji.symbol.to_string(),
        description: emoji.description.to_string(),
    }
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

        let _ = events.send(ServerEvent::VerificationRequest(
            VerificationRequestSummary {
                flow_id: emit_flow_id,
                other_user_id: own_user_id.to_string(),
                other_device_id: device_id.to_string(),
            },
        ));
    });

    Ok(flow_id)
}
