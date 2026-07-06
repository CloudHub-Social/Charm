//! The background `/sync` long-poll loop and the events it emits every
//! iteration. Room-list snapshotting itself (`RoomSummary`/`snapshot_rooms`)
//! lives in `rooms`, alongside the rest of the room-list-shaping logic.

use matrix_sdk::config::SyncSettings;
use matrix_sdk::Client;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager};
use ts_rs::TS;

use super::{ephemeral, presence, room_admin, rooms, verification, MatrixState};

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../src/bindings/")]
#[serde(tag = "status", rename_all = "snake_case")]
pub enum SyncStateEvent {
    Syncing,
    Idle,
    Error { message: String },
}

// Spec 14 removed `spawn_send_queue_listener` (and the `send_queue:update`
// event/`SendQueueUpdateEvent` DTO it fed): a room's live `matrix-sdk-ui`
// `Timeline` now surfaces the same pending -> sent -> error transitions as
// per-item `send_state` on the `RoomMessageSummary`s it emits via
// `timeline:update` (see `timeline::spawn_timeline_listener`), so a second,
// room-list-wide event carrying the identical information was redundant for
// the message list this event only ever fed. If a future global "outbox" UI
// needs cross-room send-queue status independent of any single room's
// `Timeline` being open, that's a new, narrower listener to add back — not a
// reason to keep this one around unused in the meantime.

/// Emits `receipts:update`/`typing:update` for every joined room in one sync
/// response. Shared by the initial `sync_once` (whose response can already
/// carry ephemeral events — e.g. receipts left over from a prior session —
/// and would otherwise be silently dropped) and every iteration of the
/// long-running sync loop.
///
/// Message-timeline updates (`timeline:update`) are no longer driven from
/// here as of Spec 14: each open room's live `matrix-sdk-ui` `Timeline` (see
/// `MatrixState::get_or_create_timeline`) subscribes to its own diff stream
/// and emits `timeline:update` itself (`timeline::spawn_timeline_listener`),
/// independent of the raw per-sync-batch event list — which is what fixes a
/// relation (edit/reaction/redaction) targeting an already-loaded-but-out-of-
/// batch message being silently dropped instead of updating it in place.
///
/// Also emits `room_details:update` (Spec 07) for any joined room whose batch
/// carries state events — covers room settings, power levels, and membership
/// changes (kick/ban/invite/unban all land as `m.room.member` state events).
/// Unconditional on every such room rather than only rooms with an open right
/// panel: simple, and the frontend already filters by `room_id` the same way
/// `timeline:update` is filtered — see Spec 07's design notes on revisiting
/// if this proves too chatty.
async fn emit_room_updates(
    app: &AppHandle,
    client: &Client,
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
                    let _ = app.emit(
                        "typing:update",
                        ephemeral::TypingUpdate {
                            room_id: room_id.to_string(),
                            user_ids,
                        },
                    );
                }
                _ => {}
            }
        }
        if !receipts.is_empty() {
            let _ = app.emit(
                "receipts:update",
                ephemeral::ReceiptUpdate {
                    room_id: room_id.to_string(),
                    receipts,
                },
            );
        }

        // `update.state`'s `Before` variant only covers changes up to the
        // *start* of the timeline — state events landing within the timeline
        // window itself (the common case for an incremental sync) arrive as
        // ordinary timeline events that happen to carry a `state_key`, not in
        // this separate field (see `State::Before`'s doc comment). Missing
        // that would mean a room-name/power-level/member change often never
        // triggers `room_details:update`. `After` already covers the whole
        // window, so checking the timeline too there is redundant but harmless.
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
                let _ = app.emit("room_details:update", details);
            }
        }
    }
}

pub(crate) fn spawn_sync_loop(app: AppHandle, client: Client) {
    verification::register_verification_handler(app.clone(), &client);
    presence::register_presence_handler(app.clone(), &client);

    let app_for_handle = app.clone();

    // Best-effort: some homeservers disable presence entirely, and a failure
    // here shouldn't ever block or fail login/session-restore.
    {
        let client = client.clone();
        tokio::spawn(async move {
            let _ = presence::set_presence_online(&client).await;
        });
    }

    let handle = tokio::spawn(async move {
        let _ = app.emit("sync:state", SyncStateEvent::Syncing);

        // Establish initial sync state before entering the long-running loop below.
        let initial_response = match client.sync_once(SyncSettings::default()).await {
            Ok(response) => response,
            Err(e) => {
                let _ = app.emit(
                    "sync:state",
                    SyncStateEvent::Error {
                        message: e.to_string(),
                    },
                );
                return;
            }
        };
        let _ = app.emit("sync:state", SyncStateEvent::Idle);
        let _ = app.emit("room_list:update", rooms::snapshot_rooms(&client).await);
        emit_room_updates(&app, &client, &initial_response).await;

        // A manual loop, not `sync_with_callback` — that method only honors
        // the `SyncSettings` passed to its *first* call for the whole
        // lifetime of the loop (only `timeout` is adjusted internally after
        // that), so a presence change made mid-session via `set_presence`
        // would otherwise be silently reverted to `Online` on the very next
        // long-poll. `SyncToken::ReusePrevious` (the default) means each
        // `sync_once` still picks up from the client's stored sync token, so
        // this preserves the exact continuation behavior `sync_with_callback`
        // provided — including, for parity, that it does *not* retry a
        // `sync_once` failure at the application level either (it has no
        // callback path for errors; see `Client::sync_with_result_callback`,
        // which just propagates the first `Err` and stops). But relying on
        // that parity alone means a single transient network blip kills sync
        // for the rest of the session, so this loop adds its own bounded
        // retry with backoff on top: consecutive failures back off up to 30s
        // and only give up (matching the old terminal behavior) after
        // `MAX_CONSECUTIVE_SYNC_FAILURES` in a row.
        const MAX_CONSECUTIVE_SYNC_FAILURES: u32 = 10;
        let mut consecutive_failures: u32 = 0;
        loop {
            let presence = *app
                .state::<MatrixState>()
                .sync_presence
                .lock()
                .unwrap_or_else(|e| e.into_inner());
            let settings = SyncSettings::default().set_presence(presence.into());
            match client.sync_once(settings).await {
                Ok(response) => {
                    consecutive_failures = 0;
                    let _ = app.emit("room_list:update", rooms::snapshot_rooms(&client).await);
                    emit_room_updates(&app, &client, &response).await;
                }
                Err(e) => {
                    consecutive_failures += 1;
                    if consecutive_failures >= MAX_CONSECUTIVE_SYNC_FAILURES {
                        let _ = app.emit(
                            "sync:state",
                            SyncStateEvent::Error {
                                message: e.to_string(),
                            },
                        );
                        break;
                    }
                    // Exponential backoff (1s, 2s, 4s, ... capped at 30s) before
                    // retrying, rather than hammering a struggling homeserver.
                    let backoff_secs = 1u64 << (consecutive_failures - 1).min(4);
                    tokio::time::sleep(std::time::Duration::from_secs(backoff_secs.min(30))).await;
                }
            }
        }
    });

    let previous = app_for_handle
        .state::<MatrixState>()
        .sync_loop_handle
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .replace(handle);
    if let Some(previous) = previous {
        previous.abort();
    }
}
