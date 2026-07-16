//! Message-action commands: edit, redact, react, reply, resend/discard a
//! failed send.
//!
//! Edit/react/reply all route through the room's send queue, same as
//! `send::send_message`, for consistent local-echo/retry/offline behavior.
//! Redact does not — see the doc comment on `redact_event` for why.
//! Resend/discard operate on the send queue's own local-echo handles
//! (`SendHandle::unwedge`/`abort`) rather than composing a new send — see
//! `resend_message`/`discard_failed_message`.

use matrix_sdk::ruma::events::reaction::ReactionEventContent;
use matrix_sdk::ruma::events::relation::Annotation;
use matrix_sdk::ruma::events::room::message::{
    AddMentions, ForwardThread, ReplacementMetadata, RoomMessageEventContent,
};
use matrix_sdk::ruma::events::room::power_levels::RoomPowerLevelsEventContent;
use matrix_sdk::ruma::events::{AnyMessageLikeEventContent, AnySyncMessageLikeEvent};
use matrix_sdk::ruma::{EventId, OwnedEventId, OwnedTransactionId, RoomId};
use matrix_sdk::send_queue::{LocalEchoContent, SendHandle};
use matrix_sdk::Client;
use serde::{Deserialize, Serialize};
use tauri::State;
use ts_rs::TS;

use super::MatrixState;

fn get_room(client: &Client, room_id: &str) -> Result<matrix_sdk::Room, String> {
    let parsed_room_id = RoomId::parse(room_id).map_err(|e| e.to_string())?;
    client
        .get_room(&parsed_room_id)
        .ok_or_else(|| format!("room {room_id} not found"))
}

/// Result of `toggle_reaction`, so the frontend can optimistically flip
/// local state without waiting for a `timeline:update` round-trip.
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../src/bindings/")]
#[serde(tag = "action", rename_all = "snake_case")]
pub enum ReactionToggleResult {
    Added,
    Removed,
}

/// Edits the sender's own message via an `m.replace` relation
/// (`m.new_content` + a `* ...` fallback body on `content`). Enforces
/// client-side that only the sender's own original message is editable —
/// the homeserver enforces this too (an edit from a non-sender is simply not
/// applied by well-behaved clients per the spec), but checking here gives an
/// immediate, specific error instead of a silent no-op.
#[tauri::command]
pub async fn edit_message(
    state: State<'_, MatrixState>,
    room_id: String,
    event_id: String,
    new_body: String,
) -> Result<(), String> {
    let client = state.require_client().await?;
    edit_message_impl(&client, &room_id, &event_id, new_body).await
}

/// Core logic behind [`edit_message`], taking a plain `&Client` so it's
/// callable from integration tests without a Tauri `State` to construct.
pub async fn edit_message_impl(
    client: &Client,
    room_id: &str,
    event_id: &str,
    new_body: String,
) -> Result<(), String> {
    let room = get_room(client, room_id)?;

    let parsed_event_id = EventId::parse(event_id).map_err(|e| e.to_string())?;
    // Cache-first: editing almost always targets a message already rendered
    // in the timeline (and so already cached), matching send_reply_impl's
    // same reasoning — this keeps editing a visible message queueable while
    // offline instead of failing on the fetch before the edit ever reaches
    // the send queue.
    let original = room
        .load_or_fetch_event(&parsed_event_id, None)
        .await
        .map_err(|e| e.to_string())?;

    let deserialized: matrix_sdk::ruma::events::AnySyncTimelineEvent = original
        .kind
        .raw()
        .deserialize()
        .map_err(|e| e.to_string())?;
    let matrix_sdk::ruma::events::AnySyncTimelineEvent::MessageLike(
        AnySyncMessageLikeEvent::RoomMessage(msg),
    ) = deserialized
    else {
        return Err("target event is not a room message".to_string());
    };
    let original_message = msg
        .as_original()
        .ok_or_else(|| "target event has already been redacted".to_string())?;

    let own_user_id = client
        .user_id()
        .ok_or_else(|| "not logged in".to_string())?;
    if original_message.sender != own_user_id {
        return Err("only the original sender can edit this message".to_string());
    }

    let metadata = ReplacementMetadata::from(original_message);
    let content = RoomMessageEventContent::text_plain(new_body).make_replacement(metadata);

    // Routed through the same capture helper as send_message/send_reply
    // (discarding the transaction id — edits don't need frontend
    // reconciliation the way new messages do) so this send is covered by
    // the same global serialization: without it, an edit's own
    // `NewLocalEvent` broadcast could be the one a concurrent
    // send_message/send_reply call reads off the shared subscription,
    // handing that message's optimistic echo the wrong transaction id.
    super::send::send_and_capture_transaction_id(
        client,
        &room,
        AnyMessageLikeEventContent::RoomMessage(content),
    )
    .await?;

    Ok(())
}

/// Redacts (deletes) an event the current user has power to redact — either
/// their own message, or another user's if the room's power levels grant
/// them the required `redact` level (see `can_redact` for the read-side of
/// that check, which the frontend uses to gate the action's visibility).
///
/// Unlike the other three commands here, this is a direct `/redact` API call
/// (`Room::redact`) rather than a send-queue-routed one: matrix-rust-sdk's
/// send queue (as of the vendored 0.18) only queues new-event sends, not
/// redactions, so a redaction issued while offline is NOT retried or queued
/// — it simply fails immediately. Making redactions offline-durable would
/// require either waiting on upstream send-queue support for redactions or
/// hand-rolling an offline queue for this one action, both out of scope for
/// this Day-1 cut.
#[tauri::command]
pub async fn redact_event(
    state: State<'_, MatrixState>,
    room_id: String,
    event_id: String,
    reason: Option<String>,
) -> Result<(), String> {
    let client = state.require_client().await?;
    redact_event_impl(&client, &room_id, &event_id, reason.as_deref()).await
}

/// Core logic behind [`redact_event`]; see that command's doc comment for
/// why this isn't send-queue routed.
pub async fn redact_event_impl(
    client: &Client,
    room_id: &str,
    event_id: &str,
    reason: Option<&str>,
) -> Result<(), String> {
    let room = get_room(client, room_id)?;
    let parsed_event_id = EventId::parse(event_id).map_err(|e| e.to_string())?;

    room.redact(&parsed_event_id, reason, None)
        .await
        .map_err(|e| e.to_string())?;

    Ok(())
}

/// Reads the room's power levels and the current user's own level to decide
/// whether they're allowed to redact an event sent by `target_sender`.
/// Preferred over attempt-and-handle-error so the frontend can correctly
/// gate the delete affordance in the action menu rather than showing it and
/// failing later.
#[tauri::command]
pub async fn can_redact(
    state: State<'_, MatrixState>,
    room_id: String,
    target_sender: String,
) -> Result<bool, String> {
    let client = state.require_client().await?;
    can_redact_impl(&client, &room_id, &target_sender).await
}

/// Core logic behind [`can_redact`].
pub async fn can_redact_impl(
    client: &Client,
    room_id: &str,
    target_sender: &str,
) -> Result<bool, String> {
    let own_user_id = client
        .user_id()
        .ok_or_else(|| "not logged in".to_string())?;

    if target_sender == own_user_id.as_str() {
        return Ok(true);
    }

    let room = get_room(client, room_id)?;

    let raw_state = room
        .get_state_event_static::<RoomPowerLevelsEventContent>()
        .await
        .map_err(|e| e.to_string())?;

    let Some(raw_state) = raw_state else {
        // No power_levels state event — every room in practice has one, but
        // fail closed (no redact permission for others) if it's somehow missing.
        return Ok(false);
    };
    let Ok(deserialized) = raw_state.deserialize() else {
        return Ok(false);
    };

    let power_levels: &RoomPowerLevelsEventContent = match &deserialized {
        matrix_sdk::deserialized_responses::SyncOrStrippedState::Sync(
            matrix_sdk::ruma::events::SyncStateEvent::Original(ev),
        ) => &ev.content,
        // A redacted `m.room.power_levels` event resets to spec defaults, or
        // this is a not-yet-joined (stripped/invite) room state — neither
        // gives us a real `redact` level to check against, so fail closed
        // (no elevated redact permission for other users' messages).
        _ => return Ok(false),
    };

    let my_level = power_levels
        .users
        .get(own_user_id)
        .copied()
        .unwrap_or(power_levels.users_default);

    Ok(my_level >= power_levels.redact)
}

/// Toggles the current user's `m.reaction` with `key` on `target_event_id`:
/// if they already have one, it's redacted (removed); otherwise a new one is
/// sent via the send queue. Returns which happened so the frontend can flip
/// its optimistic reaction state without waiting for a `timeline:update`.
#[tauri::command]
pub async fn toggle_reaction(
    state: State<'_, MatrixState>,
    room_id: String,
    target_event_id: String,
    key: String,
) -> Result<ReactionToggleResult, String> {
    let client = state.require_client().await?;
    toggle_reaction_impl(&client, &room_id, &target_event_id, key).await
}

/// Core logic behind [`toggle_reaction`].
pub async fn toggle_reaction_impl(
    client: &Client,
    room_id: &str,
    target_event_id: &str,
    key: String,
) -> Result<ReactionToggleResult, String> {
    let room = get_room(client, room_id)?;

    let parsed_target = EventId::parse(target_event_id).map_err(|e| e.to_string())?;
    let own_user_id = client
        .user_id()
        .ok_or_else(|| "not logged in".to_string())?;

    // Scan the room's relations of the target event for an existing
    // reaction from the current user with this key. matrix-sdk (as vendored)
    // doesn't expose a higher-level "my reactions" API, so this walks the
    // raw relations the homeserver returns.
    let (_event, relations) = room
        .load_or_fetch_event_with_relations(&parsed_target, None, None)
        .await
        .map_err(|e| e.to_string())?;

    let mut existing_reaction_event_id: Option<OwnedEventId> = None;
    for related in &relations {
        let deserialized: Result<matrix_sdk::ruma::events::AnySyncTimelineEvent, _> =
            related.kind.raw().deserialize();
        let Ok(deserialized) = deserialized else {
            continue;
        };
        let matrix_sdk::ruma::events::AnySyncTimelineEvent::MessageLike(
            AnySyncMessageLikeEvent::Reaction(reaction),
        ) = deserialized
        else {
            continue;
        };
        let Some(original) = reaction.as_original() else {
            continue;
        };
        if original.sender == own_user_id
            && original.content.relates_to.event_id == parsed_target
            && original.content.relates_to.key == key
        {
            existing_reaction_event_id = Some(original.event_id.clone());
            break;
        }
    }

    if let Some(reaction_event_id) = existing_reaction_event_id {
        room.redact(&reaction_event_id, None, None)
            .await
            .map_err(|e| e.to_string())?;
        Ok(ReactionToggleResult::Removed)
    } else {
        let content = ReactionEventContent::new(Annotation::new(parsed_target, key));
        // Same reasoning as edit_message_impl above: routed through the
        // shared capture helper purely for its global serialization, not
        // for the transaction id (reactions don't need frontend
        // reconciliation against a local echo).
        super::send::send_and_capture_transaction_id(
            client,
            &room,
            AnyMessageLikeEventContent::Reaction(content),
        )
        .await?;
        Ok(ReactionToggleResult::Added)
    }
}

/// Sends a reply to `in_reply_to_event_id`: fetches the target event to
/// build the rich-reply fallback body (quoted sender + text) and `m.mentions`
/// via ruma's `make_reply_to`, then queues the resulting message. Returns the
/// SDK's transaction id (see [`super::send::send_and_capture_transaction_id`])
/// so the frontend can key its optimistic echo the same way the synced event
/// and `send_queue:update` will.
#[tauri::command]
pub async fn send_reply(
    state: State<'_, MatrixState>,
    room_id: String,
    in_reply_to_event_id: String,
    body: String,
) -> Result<String, String> {
    let client = state.require_client().await?;
    send_reply_impl(&client, &room_id, &in_reply_to_event_id, body).await
}

/// Core logic behind [`send_reply`].
pub async fn send_reply_impl(
    client: &Client,
    room_id: &str,
    in_reply_to_event_id: &str,
    body: String,
) -> Result<String, String> {
    let room = get_room(client, room_id)?;

    let parsed_target = EventId::parse(in_reply_to_event_id).map_err(|e| e.to_string())?;
    // Replying almost always targets a message already rendered in the
    // timeline (and so already in the local event cache) — `load_or_fetch`
    // serves that case with no network round trip, only falling back to a
    // `/rooms/.../event` request if it's genuinely not cached. This keeps
    // "reply to a visible message" working offline, matching the send
    // queue's own offline behavior for the resulting reply event.
    let target_event = room
        .load_or_fetch_event(&parsed_target, None)
        .await
        .map_err(|e| e.to_string())?;

    let deserialized: matrix_sdk::ruma::events::AnySyncTimelineEvent = target_event
        .kind
        .raw()
        .deserialize()
        .map_err(|e| e.to_string())?;
    let matrix_sdk::ruma::events::AnySyncTimelineEvent::MessageLike(
        AnySyncMessageLikeEvent::RoomMessage(msg),
    ) = deserialized
    else {
        return Err("target event is not a room message".to_string());
    };
    let original_message = msg
        .as_original()
        .ok_or_else(|| "target event has already been redacted".to_string())?;

    let content = RoomMessageEventContent::text_plain(body).make_reply_to(
        original_message,
        ForwardThread::No,
        AddMentions::Yes,
    );

    super::send::send_and_capture_transaction_id(
        client,
        &room,
        AnyMessageLikeEventContent::RoomMessage(content),
    )
    .await
}

/// Finds the send-queue [`SendHandle`] for the local echo identified by
/// `transaction_id` in `room`, if it's still a pending/failed event (not yet
/// sent, not a reaction/redaction echo — those use their own handle types
/// and aren't reachable from the "· failed to send" affordance this backs).
///
/// `RoomSendQueue` doesn't expose a "get handle by transaction id" lookup
/// directly; the handle only comes attached to a [`LocalEcho`] yielded by
/// `subscribe()`/`local_echoes()`, so this walks the current local echoes
/// (typically very few — this is per-room, human-paced compose activity, not
/// a hot path) to find the one matching `transaction_id`.
///
/// Returns `Ok(None)` — not an error — when nothing matches: the local echo
/// having already disappeared (already discarded, already resolved by a
/// previous resend/discard call, or it just finished sending) is a normal
/// race for callers to treat as a no-op, not a failure. `Err` is reserved
/// for an actual problem talking to the send queue.
async fn find_local_echo_send_handle(
    room: &matrix_sdk::Room,
    transaction_id: &str,
) -> Result<Option<SendHandle>, String> {
    let queue = room.send_queue();
    let (local_echoes, _updates) = queue.subscribe().await.map_err(|e| e.to_string())?;
    let target_transaction_id: OwnedTransactionId = transaction_id.into();

    Ok(local_echoes
        .into_iter()
        .find(|echo| echo.transaction_id == target_transaction_id)
        .and_then(|echo| match echo.content {
            LocalEchoContent::Event { send_handle, .. } => Some(send_handle),
            LocalEchoContent::React { .. } | LocalEchoContent::Redaction { .. } => None,
        }))
}

/// Retries sending a message local echo that's parked in a failed
/// ("wedged") state — Charm 1.0's `onResend` (`message/Message.tsx:666-713`)
/// equivalent. Uses matrix-rust-sdk's own send-queue retry primitive
/// (`SendHandle::unwedge`) rather than re-composing and re-sending new
/// content, so this is the same local echo retried in place, not a
/// duplicate. A no-op from the caller's perspective if the transaction id no
/// longer has a pending local echo (e.g. it was already discarded, or a
/// stale/duplicate `resend` fired after a previous one already succeeded).
#[tauri::command]
pub async fn resend_message(
    state: State<'_, MatrixState>,
    room_id: String,
    transaction_id: String,
) -> Result<(), String> {
    let client = state.require_client().await?;
    resend_message_impl(&client, &room_id, &transaction_id).await
}

/// Core logic behind [`resend_message`].
pub async fn resend_message_impl(
    client: &Client,
    room_id: &str,
    transaction_id: &str,
) -> Result<(), String> {
    let room = get_room(client, room_id)?;
    let Some(send_handle) = find_local_echo_send_handle(&room, transaction_id).await? else {
        return Ok(());
    };
    // The SDK's send-queue loop disables a room's queue after *any* send
    // error (recoverable or not — see its own "Disable the queue for this
    // room after any kind of error happened" comment), which is what wedged
    // this echo in the first place. `unwedge` only marks this one local
    // echo retryable; it doesn't re-enable the queue the background task
    // actually reads from, so without this Resend would silently do
    // nothing.
    room.send_queue().set_enabled(true);
    send_handle.unwedge().await.map_err(|e| e.to_string())
}

/// Discards a failed message local echo — Charm 1.0's `onDeleteFailedSend`
/// (`message/Message.tsx:666-713`) equivalent. Uses
/// `SendHandle::abort`, which cancels the queued send outright (as opposed
/// to `redact_event`, which deletes an already-sent event) since a failed
/// send was never accepted by the homeserver in the first place — there is
/// nothing to redact. Returns whether the local echo was actually removed;
/// `false` means it was already gone (e.g. it just succeeded, or was
/// already discarded by a previous call) — the frontend treats either
/// outcome as "no longer shown as failed" rather than surfacing an error for
/// the harmless race.
#[tauri::command]
pub async fn discard_failed_message(
    state: State<'_, MatrixState>,
    room_id: String,
    transaction_id: String,
) -> Result<bool, String> {
    let client = state.require_client().await?;
    discard_failed_message_impl(&client, &room_id, &transaction_id).await
}

/// Core logic behind [`discard_failed_message`].
pub async fn discard_failed_message_impl(
    client: &Client,
    room_id: &str,
    transaction_id: &str,
) -> Result<bool, String> {
    let room = get_room(client, room_id)?;
    let Some(send_handle) = find_local_echo_send_handle(&room, transaction_id).await? else {
        return Ok(false);
    };
    send_handle.abort().await.map_err(|e| e.to_string())
}

#[cfg(test)]
mod relation_shape_tests {
    use matrix_sdk::ruma::events::reaction::ReactionEventContent;
    use matrix_sdk::ruma::events::relation::Annotation;
    use matrix_sdk::ruma::events::room::message::{
        AddMentions, ForwardThread, ReplacementMetadata, RoomMessageEventContent,
    };
    use matrix_sdk::ruma::events::room::message::{OriginalRoomMessageEvent, ReplyMetadata};
    use matrix_sdk::ruma::{event_id, room_id, user_id, MilliSecondsSinceUnixEpoch};
    use serde_json::to_value;

    #[test]
    fn make_replacement_builds_m_replace_relation_json() {
        let metadata =
            ReplacementMetadata::new(event_id!("$original:example.org").to_owned(), None);
        let content = RoomMessageEventContent::text_plain("hello world").make_replacement(metadata);

        let json = to_value(&content).unwrap();
        assert_eq!(json["m.new_content"]["body"], "hello world");
        assert_eq!(json["m.relates_to"]["rel_type"], "m.replace");
        assert_eq!(json["m.relates_to"]["event_id"], "$original:example.org");
        // Fallback body for clients that don't understand edits.
        assert!(json["body"].as_str().unwrap().starts_with('*'));
    }

    #[test]
    fn make_reply_to_builds_in_reply_to_relation_and_fallback() {
        let metadata = ReplyMetadata::new(
            event_id!("$original:example.org"),
            user_id!("@alice:example.org"),
            None,
        );
        let content = RoomMessageEventContent::text_plain("hi back").make_reply_to(
            metadata,
            ForwardThread::No,
            AddMentions::Yes,
        );

        let json = to_value(&content).unwrap();
        assert_eq!(
            json["m.relates_to"]["m.in_reply_to"]["event_id"],
            "$original:example.org"
        );
        assert!(json["body"].as_str().unwrap().contains("hi back"));
        assert_eq!(json["m.mentions"]["user_ids"][0], "@alice:example.org");
    }

    #[test]
    fn reaction_event_content_builds_m_annotation_relation_json() {
        let content = ReactionEventContent::new(Annotation::new(
            event_id!("$target:example.org").to_owned(),
            "👍".to_string(),
        ));

        let json = to_value(&content).unwrap();
        assert_eq!(json["m.relates_to"]["rel_type"], "m.annotation");
        assert_eq!(json["m.relates_to"]["event_id"], "$target:example.org");
        assert_eq!(json["m.relates_to"]["key"], "👍");
    }

    #[test]
    fn replacement_metadata_from_original_event_uses_its_event_id() {
        let original: OriginalRoomMessageEvent = serde_json::from_value(serde_json::json!({
            "type": "m.room.message",
            "event_id": "$original:example.org",
            "sender": "@alice:example.org",
            "room_id": room_id!("!room:example.org"),
            "origin_server_ts": MilliSecondsSinceUnixEpoch::now(),
            "content": { "msgtype": "m.text", "body": "hello" }
        }))
        .unwrap();

        let metadata = ReplacementMetadata::from(&original);
        let content = RoomMessageEventContent::text_plain("edited").make_replacement(metadata);
        let json = to_value(&content).unwrap();
        assert_eq!(json["m.relates_to"]["event_id"], "$original:example.org");
    }
}

/// Exercises `resend_message`/`discard_failed_message` against a genuinely
/// wedged (failed, unrecoverable-error) local echo, using
/// `matrix-sdk-test`'s `MatrixMockServer` — same pattern as
/// `send::concurrency_tests`. `error_too_large()` is used (rather than
/// `error500()`) because it's reported as an *unrecoverable* error with no
/// built-in retry delay, so the local echo reaches its wedged state
/// deterministically and immediately, without the test needing to wait out
/// a real retry/backoff schedule.
#[cfg(test)]
mod resend_discard_tests {
    use matrix_sdk::ruma::{event_id, room_id};
    use matrix_sdk::test_utils::mocks::MatrixMockServer;

    use super::super::send::build_message_content;
    use super::*;

    /// Queues a message, mocks an unrecoverable `/send` failure, and waits
    /// for the send queue to report the resulting error — leaving the
    /// message's local echo wedged. Returns the transaction id of that echo.
    async fn queue_and_wedge_a_message(
        client: &Client,
        room: &matrix_sdk::Room,
    ) -> OwnedTransactionId {
        let mut errors = client.send_queue().subscribe_errors();

        let content = AnyMessageLikeEventContent::RoomMessage(
            build_message_content("this will fail".to_string(), None, None).unwrap(),
        );
        let transaction_id = send_and_capture_transaction_id_for_test(client, room, content).await;

        // Wait for the send queue to report (and wedge on) the unrecoverable
        // error before touching the local echo — otherwise resend/discard
        // could race the in-flight request.
        let report = tokio::time::timeout(std::time::Duration::from_secs(5), errors.recv())
            .await
            .expect("timed out waiting for the send-queue error report")
            .expect("send-queue error channel closed unexpectedly");
        assert_eq!(report.room_id, room.room_id());
        assert!(!report.is_recoverable);

        transaction_id
    }

    /// Thin wrapper so this test module doesn't need `super::send` in scope
    /// just for its one helper.
    async fn send_and_capture_transaction_id_for_test(
        client: &Client,
        room: &matrix_sdk::Room,
        content: AnyMessageLikeEventContent,
    ) -> OwnedTransactionId {
        let id = super::super::send::send_and_capture_transaction_id(client, room, content)
            .await
            .expect("queuing the message should succeed even though sending it will fail");
        id.into()
    }

    #[tokio::test]
    async fn discard_failed_message_removes_the_wedged_local_echo() {
        let room_id = room_id!("!test:example.org");
        let server = MatrixMockServer::new().await;
        let client = server.client_builder().build().await;

        server.mock_room_state_encryption().plain().mount().await;
        let room = server.sync_joined_room(&client, room_id).await;

        server
            .mock_room_send()
            .error_too_large()
            .mock_once()
            .mount()
            .await;

        let transaction_id = queue_and_wedge_a_message(&client, &room).await;

        let removed =
            discard_failed_message_impl(&client, room_id.as_str(), transaction_id.as_str())
                .await
                .expect("discarding a wedged local echo should succeed");
        assert!(removed, "the wedged local echo should have been removed");

        // A second discard of the same (now-gone) transaction id must not
        // succeed a second time — it's the "already gone" case the doc
        // comment calls out, resolving to `false` rather than an error.
        let result =
            discard_failed_message_impl(&client, room_id.as_str(), transaction_id.as_str()).await;
        assert_eq!(
            result,
            Ok(false),
            "discarding an already-discarded echo has nothing to find, but isn't an error"
        );
    }

    #[tokio::test]
    async fn resend_message_unwedges_and_retries_the_local_echo() {
        let room_id = room_id!("!test:example.org");
        let server = MatrixMockServer::new().await;
        let client = server.client_builder().build().await;

        server.mock_room_state_encryption().plain().mount().await;
        let room = server.sync_joined_room(&client, room_id).await;

        server
            .mock_room_send()
            .error_too_large()
            .mock_once()
            .mount()
            .await;

        let transaction_id = queue_and_wedge_a_message(&client, &room).await;

        // `resend_message_impl` re-enables the room queue itself now (the
        // send error above disabled it, matching
        // `test_unwedge_unrecoverable_errors` in the vendored SDK's own
        // integration tests) — deliberately not doing that here, so this
        // test also covers that fix rather than masking its absence. Mock a
        // successful retry.
        server
            .mock_room_send()
            .ok(event_id!("$resent"))
            .mock_once()
            .mount()
            .await;

        let mut updates = client.send_queue().subscribe();

        resend_message_impl(&client, room_id.as_str(), transaction_id.as_str())
            .await
            .expect("unwedging a failed local echo should succeed");

        // Confirm the retried send actually reaches the mocked "sent" outcome
        // for the same transaction id, not just that `unwedge()` returned Ok.
        let sent = tokio::time::timeout(std::time::Duration::from_secs(5), async {
            loop {
                match updates.recv().await {
                    Ok(update) if update.room_id == *room_id => {
                        if let matrix_sdk::send_queue::RoomSendQueueUpdate::SentEvent {
                            transaction_id: txn,
                            ..
                        } = update.update
                        {
                            if txn == transaction_id {
                                break true;
                            }
                        }
                    }
                    Ok(_) => continue,
                    Err(_) => continue,
                }
            }
        })
        .await
        .expect("timed out waiting for the resent message to be sent");
        assert!(sent);
    }

    #[tokio::test]
    async fn resend_and_discard_are_no_ops_for_an_unknown_transaction_id() {
        let room_id = room_id!("!test:example.org");
        let server = MatrixMockServer::new().await;
        let client = server.client_builder().build().await;

        server.mock_room_state_encryption().plain().mount().await;
        server.sync_joined_room(&client, room_id).await;

        let bogus_txn_id = "not-a-real-transaction-id";

        // No local echo to find isn't an error for either — a stale/
        // duplicate call racing an already-resolved local echo is a normal
        // outcome the frontend treats as "no longer shown as failed", not a
        // failure to surface.
        assert_eq!(
            resend_message_impl(&client, room_id.as_str(), bogus_txn_id).await,
            Ok(())
        );
        assert_eq!(
            discard_failed_message_impl(&client, room_id.as_str(), bogus_txn_id).await,
            Ok(false)
        );
    }
}
