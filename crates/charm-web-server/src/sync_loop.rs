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

/// Same bound and backoff shape as desktop's loop — see
/// `src-tauri/src/matrix/sync.rs::spawn_sync_loop` for the full rationale.
const MAX_CONSECUTIVE_SYNC_FAILURES: u32 = 10;

/// Registers this session's live event handlers and spawns its background
/// sync loop. Called once per session, right after login/register/restore
/// (mirrors desktop calling `spawn_sync_loop` from the same three places).
/// Returns the loop's `JoinHandle` so the caller can abort it on logout.
pub fn spawn(
    client: Client,
    events: broadcast::Sender<ServerEvent>,
) -> tokio::task::JoinHandle<()> {
    register_presence_handler(client.clone(), events.clone());
    register_self_profile_handler(client.clone(), events.clone());
    register_verification_handler(client.clone(), events.clone());

    {
        let client = client.clone();
        tokio::spawn(async move {
            let _ = presence::set_presence_online(&client).await;
        });
    }

    tokio::spawn(async move {
        let _ = events.send(ServerEvent::SyncState(SyncStateEvent::Syncing));

        let initial_response = match client.sync_once(SyncSettings::default()).await {
            Ok(response) => response,
            Err(e) => {
                let _ = events.send(ServerEvent::SyncState(SyncStateEvent::Error {
                    message: e.to_string(),
                }));
                return;
            }
        };
        let _ = events.send(ServerEvent::SyncState(SyncStateEvent::Idle));
        emit_room_list_and_badge(&client, &events).await;
        emit_room_updates(&client, &events, &initial_response).await;

        let mut consecutive_failures: u32 = 0;
        loop {
            match client.sync_once(SyncSettings::default()).await {
                Ok(response) => {
                    consecutive_failures = 0;
                    emit_room_list_and_badge(&client, &events).await;
                    emit_room_updates(&client, &events, &response).await;
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
fn register_verification_handler(client: Client, events: broadcast::Sender<ServerEvent>) {
    client.add_event_handler(
        move |ev: ToDeviceKeyVerificationRequestEvent, client: Client| {
            let events = events.clone();
            async move {
                let Some(request) = client
                    .encryption()
                    .get_verification_request(&ev.sender, ev.content.transaction_id.as_str())
                    .await
                else {
                    return;
                };

                let _ = events.send(ServerEvent::VerificationRequest(
                    VerificationRequestSummary {
                        flow_id: request.flow_id().to_string(),
                        other_user_id: request.other_user_id().to_string(),
                        other_device_id: ev.content.from_device.to_string(),
                    },
                ));
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
