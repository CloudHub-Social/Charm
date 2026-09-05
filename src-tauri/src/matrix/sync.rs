//! The background `/sync` long-poll loop and the events it emits every
//! iteration. Room-list snapshotting itself (`RoomSummary`/`snapshot_rooms`)
//! lives in `rooms`, alongside the rest of the room-list-shaping logic.

use futures_util::StreamExt;
use matrix_sdk::config::SyncSettings;
use matrix_sdk::ruma::api::error::ErrorKind;
use matrix_sdk::Client;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager};
use ts_rs::TS;

use super::presence::PresenceStateDto;
use super::{
    ephemeral, persistence, presence, privacy_settings, profiles, room_admin, rooms, search, shell,
    verification, MatrixState,
};

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../src/bindings/")]
#[serde(tag = "status", rename_all = "snake_case")]
pub enum SyncStateEvent {
    Syncing,
    Idle,
    Error { message: String },
}

fn should_seed_room_upgrade_scan(enabled: bool, was_enabled: bool) -> bool {
    enabled && !was_enabled
}

fn room_upgrades_enabled(app: &AppHandle) -> bool {
    app.path().app_data_dir().is_ok_and(|dir| {
        crate::feature_flags::flag(&dir, crate::feature_flags::FeatureFlagKey::RoomUpgrades)
    })
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
/// Snapshots the room list, emits `room_list:update`, and derives+emits
/// `badge:update` from that same snapshot (Spec 10) — the two always travel
/// together so the in-app rail counts and the native dock/taskbar/tray badge
/// can never drift out of sync with each other or with the room list they're
/// both computed from.
async fn emit_room_list_and_badge(app: &AppHandle, client: &Client) {
    let state = app.state::<MatrixState>();
    let media_cache = state.require_media_cache(app).await.ok();
    let include_message_preview = app.path().app_data_dir().is_ok_and(|dir| {
        crate::feature_flags::flag(
            &dir,
            crate::feature_flags::FeatureFlagKey::RoomListMessagePreview,
        )
    });
    let include_activity_sort = app.path().app_data_dir().is_ok_and(|dir| {
        crate::feature_flags::flag(&dir, crate::feature_flags::FeatureFlagKey::RoomListSort)
    });
    let include_canonical_space_hierarchy = app.path().app_data_dir().is_ok_and(|dir| {
        crate::feature_flags::flag(
            &dir,
            crate::feature_flags::FeatureFlagKey::SpaceHierarchyReorganization,
        )
    });
    // Self-contained, *downsampled* Sentry transaction (see
    // `observability_trace::traced_infallible_sampled`'s doc comment) — this
    // call was the single largest measured contributor to login/steady-state
    // latency before its per-room loop was parallelized; tracing it lets
    // that fix (and any future regression) show up as real duration data
    // instead of only being visible via profiling. Sampled well below the
    // client-wide rate (Codex review on #289) because this runs on every
    // `/sync` long-poll response — including ordinary empty ones — for as
    // long as the app is open, unlike login or a cold timeline open, which
    // happen a handful of times per session at most.
    const SNAPSHOT_ROOMS_TRACE_SAMPLE_RATE: f64 = 0.05;
    let snapshot = crate::observability_trace::traced_infallible_sampled(
        "sync.snapshot_rooms",
        "matrix.sync",
        SNAPSHOT_ROOMS_TRACE_SAMPLE_RATE,
        rooms::snapshot_rooms(
            client,
            media_cache,
            include_message_preview,
            include_activity_sort,
            include_canonical_space_hierarchy,
            &state.preview_registered_rooms,
        ),
    )
    .await;
    let badge =
        shell::compute_badge_state_for_presentation(&snapshot, include_canonical_space_hierarchy);
    let _ = app.emit("room_list:update", snapshot);
    let _ = app.emit("badge:update", &badge);
    let _ = shell::apply_native_badge(app, badge.total_unread);
}

async fn emit_room_updates(
    app: &AppHandle,
    client: &Client,
    response: &matrix_sdk::sync::SyncResponse,
    seq_before_response: &std::collections::HashMap<matrix_sdk::ruma::OwnedRoomId, u64>,
    room_detail_retries: &mut std::collections::HashSet<matrix_sdk::ruma::OwnedRoomId>,
    room_upgrades_was_enabled: &mut bool,
) {
    const ROOM_DETAILS_CONCURRENCY: usize = 8;
    let state = app.state::<MatrixState>();
    let own_user_id = client.user_id();
    let authoritative_tombstone = room_upgrades_enabled(app);
    if !authoritative_tombstone {
        super::actions::resume_all_room_upgrade_queues(client).await;
        room_detail_retries.clear();
    }
    let mut room_details_room_ids = std::collections::HashSet::new();
    if should_seed_room_upgrade_scan(authoritative_tombstone, *room_upgrades_was_enabled) {
        room_details_room_ids.extend(
            client
                .joined_rooms()
                .into_iter()
                .map(|room| room.room_id().to_owned()),
        );
    }
    *room_upgrades_was_enabled = authoritative_tombstone;
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
            if room_update_contains_space_child(update) {
                let _ = app.emit("space_children:update", room_id.to_string());
            }
            // Review fix: `room_admin::pin_event`/`unpin_event` maintain
            // their own `pinned_event_cache` (see its own doc comment) so a
            // pin/unpin write can be immediately followed by another one
            // without racing matrix-sdk's sync-lagged local state — but
            // that means the cache goes stale the moment *another* client
            // changes the room's pins, or once this client's own write
            // finally lands via a later `/sync` (harmless in that case,
            // since the two already agree). Reconciling from
            // `Room::pinned_event_ids()` here, right after this response
            // has just updated that same local state, keeps the cache
            // current for both cases — but only for a room this cache
            // already has an entry for, so a plain state-event update in a
            // room nobody has ever pinned/unpinned via this session
            // doesn't grow the map for no reason.
            //
            // Review fix: only reconcile when *this specific response*
            // actually carried an `m.room.pinned_events` event, not on any
            // state-event update for the room — an unrelated membership/
            // power-level change syncing in right after a local
            // `pin_event` call (but before that pin's own echo has synced)
            // would otherwise roll `pinned_event_cache` back to
            // `Room::pinned_event_ids()`'s still-pre-pin local state,
            // discarding the just-cached write. A second quick pin would
            // then send a full replacement list missing the first one.
            if room_update_contains_pinned_events(update) {
                // Review fix: this reconciliation write previously touched
                // `pinned_event_cache` without holding the same per-room
                // `pinned_event_locks` guard that `pin_event`/`unpin_event`
                // use — a local pin/unpin racing this sync-triggered
                // reconciliation could have its write silently overwritten
                // by a stale read of `Room::pinned_event_ids()` landing in
                // between the local write and the cache update. Acquiring
                // the same lock here serializes reconciliation against
                // local writes exactly like two local writes serialize
                // against each other.
                //
                // Review fix (P2): captured *before* waiting on that lock,
                // not after — `pin_event`/`unpin_event` bump this room's
                // entry in `pinned_event_local_write_seq` right after a
                // successful, homeserver-verified write, while still holding
                // this same per-room lock. If one of them held the lock when
                // this sync response arrived, this reconciliation blocks
                // until it releases — but `Room::pinned_event_ids()` (local,
                // synced state from this already-in-flight sync response)
                // can still predate that just-verified write. Re-checking
                // this room's seq after finally acquiring the lock detects
                // that a local write for *this room* completed while this
                // was waiting, and skips clobbering the fresher cached list
                // with stale synced state — this sync round simply no-ops
                // for pin reconciliation; a later sync (once the local
                // write's own echo has landed) reconciles correctly once
                // both agree. Scoped per-room (not a single global counter)
                // — see `pinned_event_local_write_seq`'s own doc comment for
                // why a different room's write must not cause this room's
                // reconciliation to skip.
                //
                // Review fix (P2): read from `seq_before_response` (snapshotted
                // by the caller *before* `emit_room_list_and_badge`'s own
                // await, ahead of this function even being called) rather than
                // re-reading `pinned_event_local_write_seq` live right here.
                // `spawn_sync_task` awaits `emit_room_list_and_badge` before
                // reaching this function at all — a pin/unpin completing
                // during that earlier await already bumped the seq by the
                // time this line used to run, so comparing against a
                // just-read "before" value that already included that bump
                // made `local_write_raced_in` below always false, silently
                // missing the exact race this snapshot exists to catch.
                // Capturing the whole map once, right after `sync_once`
                // returns and before any further awaits, is the only point
                // that's genuinely "before" for every room in this response.
                //
                // Not covered by an automated test: reproducing this needs a
                // live `Client` processing a real sync response while a
                // `pin_event`/`unpin_event` call races in during
                // `emit_room_list_and_badge`'s own await, which this module's
                // existing tests (a mocked-response harness with no live sync
                // loop) can't drive. Verified by code review, consistent with
                // this session's other unrepeatable-race findings.
                let seq_before_wait = *seq_before_response.get(room_id).unwrap_or(&0);
                let lock = state.pinned_event_lock(room_id).await;
                let _guard = lock.lock().await;
                let local_write_raced_in = *state
                    .pinned_event_local_write_seq
                    .lock()
                    .await
                    .get(room_id)
                    .unwrap_or(&0)
                    != seq_before_wait;
                if !local_write_raced_in {
                    let mut pinned_cache = state.pinned_event_cache.lock().await;
                    if pinned_cache.contains_key(room_id) {
                        if let Some(room) = client.get_room(room_id) {
                            pinned_cache.insert(
                                room_id.to_owned(),
                                room.pinned_event_ids().unwrap_or_default(),
                            );
                        }
                    }
                }
            }
            // Review fix: emitted *after* the pin-cache reconciliation
            // above, not before. `PinnedMessagesPanel`'s query key includes
            // `pinned_event_ids`, so this event can make it refetch the
            // instant it lands — if that refetch (via `get_pinned_messages_impl`
            // reading `pinned_event_cache`) raced ahead of the
            // reconciliation block above, it would read the still-stale
            // cached list under the *new* query key, and nothing would
            // invalidate that query again afterward once the cache finally
            // caught up — leaving the panel showing a stale pinned list
            // until some unrelated later refresh. Reconciling first means
            // any refetch this event triggers already sees the fresh cache.
            room_details_room_ids.insert(room_id.to_owned());
        }
    }

    if authoritative_tombstone {
        room_details_room_ids.extend(room_detail_retries.iter().cloned());
    }

    // Authoritative tombstone reads may hit the homeserver once per room.
    // Bound them outside the serial response loop so a multi-room state
    // batch costs a small number of network rounds instead of one per room.
    if authoritative_tombstone {
        // Drop cached writable permissions before any homeserver request
        // begins. Otherwise a slow successful refresh leaves settings and
        // member mutations open throughout the request window.
        for room_id in &room_details_room_ids {
            let _ = app.emit("room_details:unresolved", room_id.to_string());
            let _ = super::actions::set_room_send_queue_read_only_if_enabled(
                app,
                client,
                Some(&state),
                room_id.as_str(),
                true,
                false,
            )
            .await;
        }
    }
    let detail_updates = futures_util::stream::iter(room_details_room_ids)
        .map(|room_id| async move {
            let result =
                room_admin::build_room_details(client, room_id.as_str(), authoritative_tombstone)
                    .await;
            (room_id, result)
        })
        .buffer_unordered(ROOM_DETAILS_CONCURRENCY)
        .collect::<Vec<_>>()
        .await;
    for (room_id, result) in detail_updates {
        match result {
            Ok(details) => {
                if !authoritative_tombstone {
                    let _ = app.emit("room_details:update", details);
                    continue;
                }
                let read_only = details.tombstone.is_some();
                // The refresh above may have crossed a kill-switch change.
                // The gated transition rechecks under the same room/global
                // admission locks used for the destructive drain.
                let barrier_result = if read_only {
                    super::actions::set_room_send_queue_read_only_if_enabled(
                        app,
                        client,
                        Some(&state),
                        room_id.as_str(),
                        true,
                        true,
                    )
                    .await
                } else {
                    super::actions::set_room_send_queue_read_only_impl(
                        client,
                        Some(&state),
                        room_id.as_str(),
                        false,
                        false,
                    )
                    .await
                    .map(Some)
                };
                match barrier_result {
                    Ok(Some(_)) => {
                        room_detail_retries.remove(&room_id);
                        let _ = app.emit("room_details:update", details);
                    }
                    Ok(None) => {
                        super::actions::resume_all_room_upgrade_queues(client).await;
                        room_detail_retries.clear();
                        let _ = app.emit("room_details:update", details);
                    }
                    Err(error) => {
                        room_detail_retries.insert(room_id.clone());
                        tracing::warn!(
                            %error,
                            room_id = %room_id,
                            "room queue barrier transition failed; retrying after next sync"
                        );
                    }
                }
            }
            Err(error) if authoritative_tombstone && room_upgrades_enabled(app) => {
                room_detail_retries.insert(room_id.clone());
                tracing::warn!(
                    %error,
                    room_id = %room_id,
                    "authoritative room details refresh failed; retrying after next sync"
                );
            }
            Err(_) if authoritative_tombstone => {
                super::actions::resume_all_room_upgrade_queues(client).await;
                room_detail_retries.clear();
            }
            Err(_) => {}
        }
    }
}

fn room_update_contains_space_child(update: &matrix_sdk::sync::JoinedRoomUpdate) -> bool {
    fn is_space_child<T>(raw: &matrix_sdk::ruma::serde::Raw<T>) -> bool {
        raw.get_field::<String>("type").ok().flatten().as_deref() == Some("m.space.child")
    }
    let in_state = match &update.state {
        matrix_sdk::sync::State::Before(events) | matrix_sdk::sync::State::After(events) => {
            events.iter().any(is_space_child)
        }
    };
    in_state
        || update
            .timeline
            .events
            .iter()
            .any(|event| is_space_child(event.raw()))
}

/// Whether `update`'s sync response actually carried an `m.room.pinned_events`
/// event for this room, in either the `state` field (pre-timeline changes)
/// or the `timeline` field (an in-window state event) — see
/// `emit_room_updates`'s own comment on why `pinned_event_cache`
/// reconciliation is gated on this specific check, not just "any state
/// event at all".
fn room_update_contains_pinned_events(update: &matrix_sdk::sync::JoinedRoomUpdate) -> bool {
    fn is_pinned_events<T>(raw: &matrix_sdk::ruma::serde::Raw<T>) -> bool {
        raw.get_field::<String>("type").ok().flatten().as_deref() == Some("m.room.pinned_events")
    }
    let in_state = match &update.state {
        matrix_sdk::sync::State::Before(events) | matrix_sdk::sync::State::After(events) => {
            events.iter().any(is_pinned_events)
        }
    };
    in_state
        || update
            .timeline
            .events
            .iter()
            .any(|event| is_pinned_events(event.raw()))
}

/// Fires local notifications for new messages in rooms that do **not**
/// currently have a live `Timeline` open — i.e. every room except whichever
/// one the user has open right now, which `timeline::spawn_timeline_listener`
/// already covers via its own `maybe_notify_new_message`. Without this, a
/// message in any room the user hasn't opened this session never reached
/// notification logic at all, since `emit_room_updates` above deliberately
/// stopped driving per-message timeline state from raw sync events back in
/// Spec 14 (opened rooms get theirs from `matrix-sdk-ui`'s `Timeline` diff
/// stream instead) — this restores the room-independent path for the
/// (usually much larger) set of rooms that aren't currently open.
///
/// Only called from the loop's steady-state iterations, never the initial
/// `sync_once` — that response's timeline events are pre-existing history,
/// not new messages, same reasoning as the opened-room listener skipping its
/// own initial `timeline:update`.
async fn notify_unopened_room_messages(
    app: &AppHandle,
    client: &Client,
    response: &matrix_sdk::sync::SyncResponse,
) {
    use matrix_sdk::ruma::events::AnySyncTimelineEvent;

    let state = app.state::<MatrixState>();
    let own_user_id = client.user_id();
    let poll_notifications_enabled = super::polls::notifications_enabled(app);

    for (room_id, update) in &response.rooms.joined {
        if state.is_timeline_open(room_id).await {
            continue;
        }
        let Some(room) = client.get_room(room_id) else {
            continue;
        };

        for raw_event in &update.timeline.events {
            #[derive(serde::Deserialize)]
            struct EventMentions {
                content: ContentMentions,
            }
            #[derive(serde::Deserialize)]
            struct ContentMentions {
                #[serde(rename = "m.mentions")]
                mentions: Option<matrix_sdk::ruma::events::Mentions>,
            }
            let mentions = raw_event
                .raw()
                .deserialize::<EventMentions>()
                .ok()
                .and_then(|event| event.content.mentions);
            let deserialize_result: Result<AnySyncTimelineEvent, _> = raw_event.raw().deserialize();
            let Ok(deserialized) = deserialize_result else {
                continue;
            };
            let Some(original) =
                unopened_notification_content(deserialized, poll_notifications_enabled, mentions)
            else {
                continue;
            };
            if own_user_id.is_some_and(|me| me == original.sender) {
                continue;
            }
            let sender_display_name = room
                .get_member_no_sync(&original.sender)
                .await
                .ok()
                .flatten()
                .and_then(|member| member.display_name().map(ToOwned::to_owned));
            let body = original.body;
            let mentions = original.mentions;

            shell::maybe_send_notification(
                app,
                &room,
                own_user_id,
                shell::NewMessageNotification {
                    event_id: original.event_id.as_str(),
                    sender: original.sender.as_str(),
                    sender_display_name: sender_display_name.as_deref(),
                    body: &body,
                },
                || async move { mentions },
            )
            .await;
        }
    }
}

struct UnopenedNotificationContent {
    event_id: matrix_sdk::ruma::OwnedEventId,
    sender: matrix_sdk::ruma::OwnedUserId,
    body: String,
    mentions: Option<matrix_sdk::ruma::events::Mentions>,
}

fn unopened_notification_content(
    event: matrix_sdk::ruma::events::AnySyncTimelineEvent,
    polls_enabled: bool,
    fallback_mentions: Option<matrix_sdk::ruma::events::Mentions>,
) -> Option<UnopenedNotificationContent> {
    use matrix_sdk::ruma::events::poll::unstable_start::UnstablePollStartEventContent;
    use matrix_sdk::ruma::events::room::message::Relation;
    use matrix_sdk::ruma::events::{AnySyncMessageLikeEvent, AnySyncTimelineEvent};
    let AnySyncTimelineEvent::MessageLike(event) = event else {
        return None;
    };
    // Ruma parses both poll formats. Redactions, edits, responses, and ends
    // are updates to an existing item, never new-message notifications.
    match event {
        AnySyncMessageLikeEvent::RoomMessage(event) => {
            let original = event.as_original()?;
            if matches!(original.content.relates_to, Some(Relation::Replacement(_))) {
                return None;
            }
            Some(UnopenedNotificationContent {
                event_id: original.event_id.clone(),
                sender: original.sender.clone(),
                body: original.content.body().to_owned(),
                mentions: original.content.mentions.clone(),
            })
        }
        AnySyncMessageLikeEvent::UnstablePollStart(event) if polls_enabled => {
            let original = event.as_original()?;
            let UnstablePollStartEventContent::New(content) = &original.content else {
                return None;
            };
            Some(UnopenedNotificationContent {
                event_id: original.event_id.clone(),
                sender: original.sender.clone(),
                body: content
                    .text
                    .clone()
                    .unwrap_or_else(|| format!("Poll: {}", content.poll_start.question.text)),
                mentions: fallback_mentions,
            })
        }
        // matrix-sdk-ui 0.18 does not yet aggregate stable m.poll.start into a
        // renderable timeline item. Do not notify for an event the user cannot
        // see after opening the room; enable this arm with stable rendering.
        AnySyncMessageLikeEvent::PollStart(_) => None,
        _ => None,
    }
}

#[cfg(test)]
mod unopened_poll_notification_tests {
    #[test]
    fn poll_start_notifies_but_replacement_does_not() {
        let content = serde_json::json!({
            "org.matrix.msc1767.text": "Lunch?",
            "org.matrix.msc3381.poll.start": {
                "question": {"org.matrix.msc1767.text": "Lunch?"},
                "kind": "org.matrix.msc3381.poll.disclosed",
                "max_selections": 1,
                "answers": [
                    {"id": "a", "org.matrix.msc1767.text": "Pizza"},
                    {"id": "b", "org.matrix.msc1767.text": "Tacos"}
                ]
            }
        });
        let mut event = serde_json::json!({
            "type": "org.matrix.msc3381.poll.start",
            "event_id": "$poll", "sender": "@alice:example.org",
            "origin_server_ts": 1, "content": content
        });
        assert!(super::unopened_notification_content(
            serde_json::from_value(event.clone()).unwrap(),
            false,
            None,
        )
        .is_none());
        let mentions = serde_json::from_value(serde_json::json!({
            "user_ids": ["@bob:example.org"]
        }))
        .unwrap();
        let notification = super::unopened_notification_content(
            serde_json::from_value(event.clone()).unwrap(),
            true,
            Some(mentions),
        )
        .unwrap();
        assert_eq!(notification.body, "Lunch?");
        assert_eq!(notification.event_id.as_str(), "$poll");
        assert_eq!(notification.sender.as_str(), "@alice:example.org");
        assert!(notification.mentions.is_some());
        event["content"]["m.new_content"] = content;
        event["content"]["m.relates_to"] = serde_json::json!({
            "rel_type": "m.replace", "event_id": "$original"
        });
        assert!(
            super::unopened_notification_content(
                serde_json::from_value(event).unwrap(),
                true,
                None,
            )
            .is_none()
        );
    }

    #[test]
    fn stable_poll_start_does_not_notify_until_the_timeline_can_render_it() {
        let event = serde_json::json!({
            "type": "m.poll.start",
            "event_id": "$stable-poll",
            "sender": "@alice:example.org",
            "origin_server_ts": 1,
            "content": {
                "m.text": [{"body": "Lunch?", "mimetype": "text/plain"}],
                "m.poll": {
                    "question": {"m.text": [{"body": "Lunch?", "mimetype": "text/plain"}]},
                    "kind": "m.poll.disclosed",
                    "max_selections": 1,
                    "answers": [
                        {"id": "a", "m.text": [{"body": "Pizza", "mimetype": "text/plain"}]},
                        {"id": "b", "m.text": [{"body": "Tacos", "mimetype": "text/plain"}]}
                    ]
                }
            }
        });
        assert!(
            super::unopened_notification_content(
                serde_json::from_value(event).unwrap(),
                true,
                None,
            )
            .is_none()
        );
    }
}

fn build_invite_notification(
    room_name: Option<&str>,
    inviter_display_name: Option<&str>,
    inviter_user_id: Option<&str>,
) -> (String, String) {
    let title = room_name.unwrap_or("Room invitation").to_owned();
    let inviter = inviter_display_name
        .or(inviter_user_id)
        .unwrap_or("Someone");
    (title, format!("{inviter} invited you"))
}

fn should_notify_invite(mode: matrix_sdk::notification_settings::RoomNotificationMode) -> bool {
    !matches!(
        mode,
        matrix_sdk::notification_settings::RoomNotificationMode::Mute
    )
}

/// `Room::notification_mode()` intentionally returns `None` for invited
/// rooms in matrix-sdk 0.18, so resolve the same push-rule precedence here:
/// an explicit room rule first, then the default for the invite's room kind.
async fn invite_notification_mode(
    client: &Client,
    room: &matrix_sdk::Room,
) -> matrix_sdk::notification_settings::RoomNotificationMode {
    use matrix_sdk::notification_settings::{IsEncrypted, IsOneToOne};

    let settings = client.notification_settings().await;
    if let Some(mode) = settings
        .get_user_defined_room_notification_mode(room.room_id())
        .await
    {
        return mode;
    }

    let is_encrypted = room
        .latest_encryption_state()
        .await
        .map(|state| state.is_encrypted())
        .unwrap_or(false);
    let is_one_to_one = room.active_members_count() == 2;
    settings
        .get_default_room_notification_mode(
            IsEncrypted::from(is_encrypted),
            IsOneToOne::from(is_one_to_one),
        )
        .await
}

/// Notifies only for invites in a steady-state sync response. The initial
/// sync's invited rooms are existing inbox state, not new activity.
async fn notify_new_room_invites(
    app: &AppHandle,
    client: &Client,
    response: &matrix_sdk::sync::SyncResponse,
) {
    use tauri_plugin_notification::NotificationExt;

    // Review fix: this dispatch path posts notifications directly and never
    // ran through `shell::maybe_send_notification`'s DND guard, so a user
    // with `room_invites` and `focus_mode` both enabled would still get
    // native room-invite notifications while Do Not Disturb was on. Same
    // guard, same rationale as `maybe_send_notification`'s own — never
    // touches unread/badge state, only suppresses the OS-level popup.
    if super::dnd::is_dnd_active(app) {
        return;
    }

    for room_id in response.rooms.invited.keys() {
        let Some(room) = client.get_room(room_id) else {
            continue;
        };
        if !should_notify_invite(invite_notification_mode(client, &room).await) {
            continue;
        }
        let details = room.invite_details().await.ok();
        let inviter_user_id = details.as_ref().map(|details| details.inviter_id.as_str());
        let inviter_display_name = details
            .as_ref()
            .and_then(|details| details.inviter.as_ref())
            .and_then(|member| member.display_name());
        let display_name = match room.cached_display_name() {
            Some(name) => name,
            None => room
                .display_name()
                .await
                .unwrap_or(matrix_sdk::RoomDisplayName::Empty),
        };
        let room_name = match display_name {
            matrix_sdk::RoomDisplayName::Empty => None,
            other => Some(other.to_string()),
        };
        let (title, body) =
            build_invite_notification(room_name.as_deref(), inviter_display_name, inviter_user_id);
        // Invite mode/details/display-name lookups above may span a Focus
        // toggle. Check again for every invite immediately before posting so
        // the remainder of a multi-invite response is suppressed as soon as
        // DND is enabled.
        if super::dnd::is_dnd_active(app) {
            continue;
        }
        if let Err(error) = app.notification().builder().title(title).body(body).show() {
            tracing::warn!(%error, room_id = %room_id, "failed to show room-invite notification");
        }
    }
}

/// Stops the currently-running sync loop, every live per-room timeline
/// listener, and drops the active `Client` (if any) without starting
/// replacements — call this and *await* it just before a login flow is
/// about to supersede the current account's on-disk store (see
/// `persistence::relocate_store_and_save_session`), so nothing is still
/// mid-`/sync`, mid-timeline-diff-stream, or holding the store's SQLite
/// files open when the directory gets renamed out from under it.
/// `spawn_sync_loop` already does its own version of the sync-loop abort
/// when it starts a *new* loop, but that happens *after* the store swap on
/// a re-login for an already-active account — too late to prevent the old
/// loop from touching the directory during the rename itself. Each opened
/// room's `Timeline` has its own listener task holding its own `Client`
/// clone (see `timeline::spawn_timeline_listener`) — stopping the sync loop
/// and clearing `MatrixState::client` alone would still leave those running
/// against the old store.
///
/// Genuinely waits for every aborted task to stop (not just requests
/// cancellation and moves on): `JoinHandle::abort` only requests
/// cancellation at the task's next `.await` point, so a task using
/// `spawn_blocking`-free async I/O like this one's `sync_once`/`sync_with_callback`
/// calls does stop promptly, but only once actually polled again — awaiting
/// the handle here (and ignoring the resulting `Cancelled` error, which is
/// the expected outcome of a deliberate abort) is what actually blocks until
/// that's happened, rather than racing ahead while the task might still hold
/// its `Client` (and the SQLite handles under it) for a few more
/// microseconds. `MatrixState::clear_timelines` applies the same rigor to
/// the timeline listeners.
pub(crate) async fn abort_current_sync_loop(app: &AppHandle) {
    abort_current_sync_loop_inner(app, false).await;
}

pub(crate) async fn abort_current_sync_loop_for_rollback(
    app: &AppHandle,
) -> Vec<super::TimelineRollbackEntry> {
    abort_current_sync_loop_inner(app, true).await
}

async fn abort_current_sync_loop_inner(
    app: &AppHandle,
    retain_views: bool,
) -> Vec<super::TimelineRollbackEntry> {
    let previous_sync = app
        .state::<MatrixState>()
        .sync_loop_handle
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .take();
    if let Some(previous_sync) = previous_sync {
        previous_sync.abort();
        let _ = previous_sync.await;
    }
    let snapshot = if retain_views {
        app.state::<MatrixState>().drain_timelines(true).await
    } else {
        app.state::<MatrixState>().clear_timelines().await;
        Vec::new()
    };
    // Review fix: see `clear_pinned_event_cache`'s own doc comment — same
    // "nothing from the old session carries over" cleanup as
    // `clear_timelines` above, for pin/unpin's own cache instead of the
    // timeline listeners.
    app.state::<MatrixState>().clear_pinned_event_cache().await;
    let state = app.state::<MatrixState>();
    *state.client.lock().await = None;
    // Interactive login/registration/QR/SSO all use this teardown before
    // adopting a replacement client. Invalidate search work here, at the
    // shared supersession boundary, so no queued/deferred task from the old
    // client can borrow the replacement session's generation or index slot.
    super::search::invalidate_for_session_replacement(&state).await;
    snapshot
}

/// Decides what the sync loop's next `sync_once` call should report as this
/// account's presence — pulled out of the loop body as a pure function so
/// the "reconcile with the privacy setting every iteration, in *both*
/// directions" logic (this block's own review-fix comments) is unit-
/// testable without a live sync loop.
///
/// - Flag disabled: lifts a cached `Offline` back to `Online` — Appear
///   offline is a `presence_privacy_controls`-gated feature, and its
///   settings UI disappears along with the flag, so this is the only
///   remaining off-ramp for an `Offline` value that flag left behind.
///   Anything else (`Online`/`Unavailable`) is left alone.
///
///   Review fix (P2): this used to force `Online` unconditionally whenever
///   the flag was disabled, regardless of `current` — that also caught
///   pre-existing Spec 05 presence choices unrelated to this privacy
///   feature (e.g. `Unavailable` from the auto-idle timer, or a future
///   manual "away" control), silently overriding them back to `Online` on
///   every sync iteration purely because the flag happened to be off.
///   Only `Offline` is treated as this feature's own artifact here.
/// - Flag enabled and `appear_offline` persisted: always `Offline` — closes
///   the gap where the flag is *re*-enabled after being off and a
///   previously-persisted `appear_offline` was never re-applied.
/// - Flag enabled and `appear_offline` not set: leaves `current` alone —
///   this function has no opinion on auto-idle/manual presence in that
///   case, only on enforcing (or lifting) Appear offline.
fn reconciled_sync_presence(
    presence_privacy_controls_enabled: bool,
    appear_offline: bool,
    current: PresenceStateDto,
) -> PresenceStateDto {
    if !presence_privacy_controls_enabled {
        if current == PresenceStateDto::Offline {
            PresenceStateDto::Online
        } else {
            current
        }
    } else if appear_offline {
        PresenceStateDto::Offline
    } else {
        current
    }
}

pub(crate) fn spawn_sync_loop(app: AppHandle, client: Client) {
    verification::register_verification_handler(app.clone(), &client);
    presence::register_presence_handler(app.clone(), &client);
    profiles::register_self_profile_handler(app.clone(), &client);
    spawn_sync_task_with_presence(app, client, true);
}

fn is_terminal_auth_error(error: &matrix_sdk::Error) -> bool {
    error
        .client_api_error_kind()
        .is_some_and(is_terminal_auth_kind)
}

fn is_terminal_auth_kind(kind: &ErrorKind) -> bool {
    // Soft logout asks for same-device reauthentication, not destruction of
    // the retained crypto/session store. Only a hard invalidation may enter
    // the terminal cleanup path.
    matches!(kind, ErrorKind::UnknownToken(data) if !data.soft_logout)
}

async fn teardown_terminal_auth_session(app: &AppHandle, client: &Client) {
    let (Some(user_id), Some(device_id)) = (client.user_id(), client.device_id()) else {
        return;
    };
    let account_key = persistence::account_key(user_id.as_str());
    let state = app.state::<MatrixState>();
    let completion_guard = std::sync::Arc::clone(&state.login_completion_lock)
        .lock_owned()
        .await;
    let is_active = state.client.lock().await.as_ref().is_some_and(|active| {
        active.user_id() == client.user_id() && active.device_id() == client.device_id()
    });
    if !is_active {
        return;
    }

    let tombstone = persistence::mark_logout_tombstone(app, &account_key);
    let matrix = persistence::clear_session(&account_key);
    let oauth = persistence::clear_oauth_session(&account_key);
    let durable =
        super::account::logout_is_durable(tombstone.is_ok(), matrix.is_ok(), oauth.is_ok());
    let credential_error = super::account::clear_logout_credentials(tombstone, || matrix, || oauth);
    if !durable {
        // The caller reports the sync failure and stops syncing. Keep the
        // shell available for a visible retry instead of claiming sign-out
        // while the same saved session can still restore on next launch.
        tracing::warn!(
            command = "terminal_session_cleanup",
            status = "restore_veto_failed"
        );
        return;
    }

    // Match explicit logout: unregister the OS transport and remove its
    // persisted endpoint while the active client is still available. A stale
    // token may prevent deleting the homeserver pusher, but the shared helper
    // still performs local/platform cleanup after that server error.
    if crate::push::unregister_push_impl(app, &state)
        .await
        .is_err()
    {
        tracing::warn!(
            command = "terminal_session_cleanup",
            status = "push_cleanup_incomplete"
        );
    }

    // Revoke access before waiting on disk work. Generation invalidation also
    // prevents an in-flight backfill from reopening this session's index.
    *state.client.lock().await = None;
    search::reset_index_lifecycle(&state);
    if credential_error.is_some() {
        tracing::warn!(
            command = "terminal_session_cleanup",
            status = "credential_cleanup_incomplete"
        );
    }
    // Finish volatile invalidation while the completion guard still excludes
    // replacement login. Disk cleanup can panic or fail; neither may leave the
    // renderer displaying an account whose client has already been revoked.
    state.clear_timelines().await;
    state.clear_pinned_event_cache().await;
    *state
        .push_transport
        .lock()
        .unwrap_or_else(|error| error.into_inner()) = None;
    *state
        .push_status
        .lock()
        .unwrap_or_else(|error| error.into_inner()) = crate::push::PushStatus::default();
    let _ = shell::apply_native_badge(app, 0);
    let _ = app.emit("session:invalidated", ());

    let search_index = std::sync::Arc::clone(&state.search_index);
    let cleanup_account_key = account_key.clone();
    let cleanup_device_id = device_id.to_string();
    let app_data_dir = app.path().app_data_dir();
    let cleanup_result = run_locked_cleanup(completion_guard, move || {
        // Taking and dropping the slot closes SQLite even if path resolution
        // failed. Windows cannot reliably unlink an open database. Acquire the
        // potentially contended index mutex only on a blocking worker.
        let active = search_index
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .take();
        drop(active);
        app_data_dir.is_ok_and(|directory| {
            search::SearchIndex::delete_for_source(
                &directory,
                &cleanup_account_key,
                &cleanup_device_id,
            )
            .is_ok()
        })
    })
    .await;
    let Ok((_completion_guard, index_cleared)) = cleanup_result else {
        // A panicked worker has released its lock. Do not clear another
        // session's state after that point; the durable marker owns retries.
        tracing::warn!(
            command = "terminal_session_cleanup",
            status = "worker_failed"
        );
        return;
    };
    if credential_error.is_none() && index_cleared {
        let _ = persistence::clear_logout_tombstone(app, &account_key);
    }
}

/// Keep replacement login excluded until blocking work really finishes, even
/// when the async caller is aborted. Return the guard so subsequent teardown
/// remains serialized too, without an unlock/relock window.
async fn run_locked_cleanup<T, F>(
    guard: tokio::sync::OwnedMutexGuard<()>,
    cleanup: F,
) -> Result<(tokio::sync::OwnedMutexGuard<()>, T), tokio::task::JoinError>
where
    T: Send + 'static,
    F: FnOnce() -> T + Send + 'static,
{
    tokio::task::spawn_blocking(move || {
        let result = cleanup();
        (guard, result)
    })
    .await
}

#[cfg(test)]
mod cleanup_cancellation_tests {
    #[tokio::test]
    async fn aborted_caller_cannot_release_login_before_cleanup_finishes() {
        let lock = std::sync::Arc::new(tokio::sync::Mutex::new(()));
        let guard = std::sync::Arc::clone(&lock).lock_owned().await;
        let (started_tx, started_rx) = tokio::sync::oneshot::channel();
        let (release_tx, release_rx) = std::sync::mpsc::channel();
        let caller = tokio::spawn(super::run_locked_cleanup(guard, move || {
            started_tx.send(()).unwrap();
            release_rx.recv().unwrap();
        }));
        started_rx.await.unwrap();
        caller.abort();
        let caller_result = caller.await;
        let replacement_blocked = lock.try_lock().is_err();
        release_tx.send(()).unwrap();
        assert!(caller_result.unwrap_err().is_cancelled());
        assert!(replacement_blocked);
        let _replacement = tokio::time::timeout(std::time::Duration::from_secs(5), lock.lock())
            .await
            .expect("cleanup must release login after finishing");
    }
}

/// The sync-task-spawning half of [`spawn_sync_loop`], without the
/// `register_*_handler` calls — use this (not `spawn_sync_loop`) to *resume*
/// a `Client` that already had those registered by an earlier
/// `spawn_sync_loop` call (e.g. restoring the previous session after a
/// failed re-login attempt). matrix-sdk's event handlers accumulate rather
/// than replace on repeated registration, so calling `spawn_sync_loop` again
/// on the same `Client` would leave it with duplicate handlers, emitting
/// duplicate presence/profile updates and verification requests on every
/// subsequent event.
pub(crate) fn spawn_sync_task(app: AppHandle, client: Client) {
    spawn_sync_task_with_presence(app, client, false);
}

fn initial_sync_presence(
    fresh_session: bool,
    appear_offline: bool,
    current: PresenceStateDto,
) -> PresenceStateDto {
    if appear_offline {
        PresenceStateDto::Offline
    } else if fresh_session {
        PresenceStateDto::Online
    } else {
        current
    }
}

fn spawn_sync_task_with_presence(app: AppHandle, client: Client, fresh_session: bool) {
    let app_for_handle = app.clone();
    let handle = tokio::spawn(async move {
        let _ = app.emit("sync:state", SyncStateEvent::Syncing);
        let mut room_detail_retries = std::collections::HashSet::new();
        let mut room_upgrades_was_enabled = false;

        // Review fix: this used to unconditionally call
        // `set_presence_online`, ignoring a persisted `appear_offline`
        // privacy setting (Spec 40) — so a user who'd asked to appear
        // offline would be shown online again after every app restart or
        // session restore, until they happened to re-open the Privacy
        // settings panel and re-toggle it. Read the persisted setting
        // first and seed both `initial_presence` and `sync_presence` (so
        // the sync loop's subsequent `sync_once` calls keep reasserting
        // the right state) to match.
        //
        // Review fix (P2): there used to also be a standalone, awaited
        // `presence::set_presence_impl(&client, initial_presence, None)`
        // call here, sequenced *before* the initial `sync_once` below so
        // appear-offline was genuinely applied ahead of that first request
        // rather than racing it (an earlier, detached-`tokio::spawn`
        // version of this same call raced it and lost). But a slow or
        // hanging presence endpoint on that blocking call delayed the
        // entire sync task — room-list updates, receipts, typing,
        // notifications, verification traffic — from ever starting, even
        // though login itself had already succeeded. The initial
        // `sync_once` call below already passes this exact
        // `initial_presence` via its own `set_presence` request parameter
        // (which sets presence for that request at the protocol level, the
        // same mechanism `presence::set_presence_impl` uses under the
        // hood) — so the standalone call was purely redundant, not load-
        // bearing for correctness, and removing it here closes the P2 gap
        // without reopening the ordering race the two earlier fixes above
        // exist to avoid.
        let privacy = privacy_settings::current_settings(&app, &app.state::<MatrixState>()).await;
        let initial_presence = {
            let state = app.state::<MatrixState>();
            let mut current = state
                .sync_presence
                .lock()
                .unwrap_or_else(|e| e.into_inner());
            // A rollback resumes this same session, including its away state.
            // Read and update under one lock so a concurrent presence change
            // is not overwritten with a value captured before settings loaded.
            *current = initial_sync_presence(fresh_session, privacy.appear_offline, *current);
            *current
        };

        // Subscribing spawns the task that listens to
        // `client.subscribe_to_all_room_updates()` — the event cache (and
        // `LatestEvents`, which `rooms::last_message_preview` reads for
        // Spec 54's message preview) only sees a room's events from the
        // point this subscription starts. Doing it before the initial
        // `sync_once` below, rather than only later in
        // `emit_room_list_and_badge`'s `last_message_preview` call, means
        // existing rooms' latest messages are already known by the time the
        // first `room_list:update` is emitted, instead of showing no preview
        // until the next message arrives. Cheap/idempotent per its own doc
        // comment, so unconditional here regardless of whether the preview
        // flag ends up enabled.
        let _ = client.event_cache().subscribe();

        // Establish initial sync state before entering the long-running loop below.
        //
        // Review fix: this used to call `sync_once` with a bare
        // `SyncSettings::default()`, which has no explicit `set_presence`
        // of its own — per the `/sync` endpoint's spec, an absent
        // `set_presence` defaults to reporting the account online (see the
        // steady-state loop's own comment below), so even with
        // `appear_offline` persisted, this very first request would report
        // the account online at the protocol level regardless. Explicitly
        // passing `initial_presence` here is what actually applies it —
        // see this block's own comment above for why a separate one-shot
        // `set_presence_impl` call is unnecessary alongside it.
        let initial_response = match client
            .sync_once(SyncSettings::default().set_presence(initial_presence.into()))
            .await
        {
            Ok(response) => response,
            Err(e) => {
                if is_terminal_auth_error(&e) {
                    teardown_terminal_auth_session(&app, &client).await;
                }
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
        search::submit_sync_response(&app, &client, &initial_response).await;
        // Review fix (P2): snapshotted here, before `emit_room_list_and_badge`'s
        // own await — see `emit_room_updates`'s `seq_before_response` param doc
        // comment for why capturing it any later (even at the top of
        // `emit_room_updates` itself) is already too late to catch a pin/unpin
        // that completes while this response is being processed.
        let seq_before_response = app
            .state::<MatrixState>()
            .pinned_event_local_write_seq
            .lock()
            .await
            .clone();
        emit_room_list_and_badge(&app, &client).await;
        emit_room_updates(
            &app,
            &client,
            &initial_response,
            &seq_before_response,
            &mut room_detail_retries,
            &mut room_upgrades_was_enabled,
        )
        .await;

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
            // Review fix: `sync_presence` can be cached as `Offline` from an
            // `appear_offline` privacy setting applied earlier in this same
            // session — but if `presence_privacy_controls` is then disabled
            // mid-session (a local override cleared, or a remote kill
            // switch), the Privacy tab that would let the user undo it
            // disappears too, while this loop kept resending the cached
            // value on every sync regardless, with no in-app off-ramp
            // until restart or some other presence write happened to reset
            // it. Rechecking the flag every iteration and forcing `Online`
            // while it's off closes that gap.
            let presence_privacy_controls_enabled = app.path().app_data_dir().is_ok_and(|dir| {
                crate::feature_flags::flag(
                    &dir,
                    crate::feature_flags::FeatureFlagKey::PresencePrivacyControls,
                )
            });
            // Review fix (P1): the flag-disabled path above forces `Online`
            // and gives the user no other off-ramp — but the reverse
            // transition (flag re-enabled after being off, e.g. via Labs or
            // a remote kill switch recovering) never re-read the persisted
            // setting at all. An account with `appear_offline` already
            // persisted would keep advertising whatever `sync_presence`
            // last held (typically `Online`, from the disabled branch)
            // indefinitely, even though the Privacy panel shows Appear
            // offline as on. Reconciling from `current_settings` here too —
            // *before* acquiring the (non-async) `sync_presence` lock, so
            // nothing holds it across this `.await` — closes that gap the
            // same way the disabled branch already closes its own.
            let appear_offline_when_enabled = if presence_privacy_controls_enabled {
                privacy_settings::current_settings(&app, &app.state::<MatrixState>())
                    .await
                    .appear_offline
            } else {
                false
            };
            let presence = {
                let state = app.state::<MatrixState>();
                let mut sync_presence = state
                    .sync_presence
                    .lock()
                    .unwrap_or_else(|e| e.into_inner());
                let reconciled = reconciled_sync_presence(
                    presence_privacy_controls_enabled,
                    appear_offline_when_enabled,
                    *sync_presence,
                );
                if reconciled != *sync_presence {
                    *sync_presence = reconciled;
                }
                *sync_presence
            };
            let settings = SyncSettings::default().set_presence(presence.into());
            match client.sync_once(settings).await {
                Ok(response) => {
                    consecutive_failures = 0;
                    search::submit_sync_response(&app, &client, &response).await;
                    // Review fix (P2): same reasoning as the initial-response
                    // call site above — snapshotted before
                    // `emit_room_list_and_badge`'s own await.
                    let seq_before_response = app
                        .state::<MatrixState>()
                        .pinned_event_local_write_seq
                        .lock()
                        .await
                        .clone();
                    emit_room_list_and_badge(&app, &client).await;
                    emit_room_updates(
                        &app,
                        &client,
                        &response,
                        &seq_before_response,
                        &mut room_detail_retries,
                        &mut room_upgrades_was_enabled,
                    )
                    .await;
                    notify_unopened_room_messages(&app, &client, &response).await;
                    if app.path().app_data_dir().is_ok_and(|dir| {
                        crate::feature_flags::flag(
                            &dir,
                            crate::feature_flags::FeatureFlagKey::RoomInvites,
                        )
                    }) {
                        notify_new_room_invites(&app, &client, &response).await;
                    }
                }
                Err(e) => {
                    if is_terminal_auth_error(&e) {
                        tracing::error!(
                            command = "sync_loop",
                            status = "terminal_authentication_error",
                            "Sync session was revoked"
                        );
                        teardown_terminal_auth_session(&app, &client).await;
                        let _ = app.emit(
                            "sync:state",
                            SyncStateEvent::Error {
                                message: e.to_string(),
                            },
                        );
                        break;
                    }
                    consecutive_failures += 1;
                    if consecutive_failures >= MAX_CONSECUTIVE_SYNC_FAILURES {
                        tracing::error!(
                            command = "sync_loop",
                            status = "failed",
                            consecutive_failures,
                            error = %e,
                            "Sync loop giving up after repeated failures"
                        );
                        let _ = app.emit(
                            "sync:state",
                            SyncStateEvent::Error {
                                message: e.to_string(),
                            },
                        );
                        break;
                    }
                    tracing::warn!(
                        command = "sync_loop",
                        status = "failed",
                        consecutive_failures,
                        error = %e,
                        "Sync iteration failed, retrying with backoff"
                    );
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

#[cfg(test)]
mod room_upgrade_scan_tests {
    use super::should_seed_room_upgrade_scan;

    #[test]
    fn seeds_on_startup_or_transition_to_enabled_only() {
        assert!(should_seed_room_upgrade_scan(true, false));
        assert!(!should_seed_room_upgrade_scan(true, true));
        assert!(!should_seed_room_upgrade_scan(false, true));
        assert!(!should_seed_room_upgrade_scan(false, false));
    }
}

#[cfg(test)]
mod invite_notification_tests {
    use matrix_sdk::notification_settings::RoomNotificationMode;

    use super::{build_invite_notification, should_notify_invite};

    #[test]
    fn soft_logout_does_not_authorize_terminal_session_cleanup() {
        use super::is_terminal_auth_kind;
        use matrix_sdk::ruma::api::error::{ErrorKind, UnknownTokenErrorData};

        let mut data = UnknownTokenErrorData::new();
        assert!(is_terminal_auth_kind(&ErrorKind::UnknownToken(
            data.clone()
        )));
        data.soft_logout = true;
        assert!(!is_terminal_auth_kind(&ErrorKind::UnknownToken(data)));
    }

    #[test]
    fn uses_room_and_inviter_display_names() {
        assert_eq!(
            build_invite_notification(
                Some("Project room"),
                Some("Alice"),
                Some("@alice:example.org"),
            ),
            ("Project room".to_owned(), "Alice invited you".to_owned()),
        );
    }

    #[test]
    fn falls_back_to_inviter_id_and_generic_room_title() {
        assert_eq!(
            build_invite_notification(None, None, Some("@alice:example.org")),
            (
                "Room invitation".to_owned(),
                "@alice:example.org invited you".to_owned(),
            ),
        );
    }

    #[test]
    fn suppresses_invites_only_when_notifications_are_muted() {
        assert!(!should_notify_invite(RoomNotificationMode::Mute));
        assert!(should_notify_invite(
            RoomNotificationMode::MentionsAndKeywordsOnly,
        ));
        assert!(should_notify_invite(RoomNotificationMode::AllMessages));
    }
}

#[cfg(test)]
mod reconciled_sync_presence_tests {
    use super::{initial_sync_presence, reconciled_sync_presence, PresenceStateDto};

    #[test]
    fn resumed_session_preserves_its_presence_choice() {
        for current in [
            PresenceStateDto::Online,
            PresenceStateDto::Unavailable,
            PresenceStateDto::Offline,
        ] {
            assert_eq!(initial_sync_presence(false, false, current), current);
        }
    }

    #[test]
    fn fresh_session_does_not_inherit_the_previous_sessions_away_state() {
        assert_eq!(
            initial_sync_presence(true, false, PresenceStateDto::Unavailable),
            PresenceStateDto::Online
        );
    }

    #[test]
    fn appear_offline_applies_before_both_fresh_and_resumed_initial_sync() {
        for fresh_session in [true, false] {
            assert_eq!(
                initial_sync_presence(fresh_session, true, PresenceStateDto::Unavailable),
                PresenceStateDto::Offline
            );
        }
    }

    #[test]
    fn lifts_a_cached_offline_when_the_flag_is_disabled_regardless_of_appear_offline() {
        assert_eq!(
            reconciled_sync_presence(false, true, PresenceStateDto::Offline),
            PresenceStateDto::Online
        );
        assert_eq!(
            reconciled_sync_presence(false, false, PresenceStateDto::Offline),
            PresenceStateDto::Online
        );
    }

    /// Review fix (P2) regression test: the flag being disabled must only
    /// lift a cached `Offline` (this feature's own artifact) — it must not
    /// also override an unrelated Spec 05 presence choice like
    /// `Unavailable` (e.g. from the auto-idle timer) back to `Online`.
    #[test]
    fn leaves_non_offline_presence_alone_when_the_flag_is_disabled() {
        assert_eq!(
            reconciled_sync_presence(false, false, PresenceStateDto::Unavailable),
            PresenceStateDto::Unavailable
        );
        assert_eq!(
            reconciled_sync_presence(false, true, PresenceStateDto::Unavailable),
            PresenceStateDto::Unavailable
        );
        assert_eq!(
            reconciled_sync_presence(false, false, PresenceStateDto::Online),
            PresenceStateDto::Online
        );
    }

    /// Review fix (P1) regression test: re-enabling the flag after it was
    /// off must re-apply a persisted `appear_offline`, not just leave
    /// whatever `Online` value the disabled branch left behind.
    #[test]
    fn forces_offline_when_the_flag_is_enabled_and_appear_offline_is_set() {
        assert_eq!(
            reconciled_sync_presence(true, true, PresenceStateDto::Online),
            PresenceStateDto::Offline
        );
    }

    #[test]
    fn leaves_current_alone_when_the_flag_is_enabled_and_appear_offline_is_off() {
        assert_eq!(
            reconciled_sync_presence(true, false, PresenceStateDto::Unavailable),
            PresenceStateDto::Unavailable
        );
        assert_eq!(
            reconciled_sync_presence(true, false, PresenceStateDto::Online),
            PresenceStateDto::Online
        );
    }
}
