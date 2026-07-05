//! Message-action commands: edit, redact, react, reply.
//!
//! Edit/react/reply all route through the room's send queue, same as
//! `send::send_message`, for consistent local-echo/retry/offline behavior.
//! Redact does not — see the doc comment on `redact_event` for why.

use matrix_sdk::ruma::events::reaction::ReactionEventContent;
use matrix_sdk::ruma::events::relation::Annotation;
use matrix_sdk::ruma::events::room::message::{
    AddMentions, ForwardThread, ReplacementMetadata, RoomMessageEventContent,
};
use matrix_sdk::ruma::events::room::power_levels::RoomPowerLevelsEventContent;
use matrix_sdk::ruma::events::{AnyMessageLikeEventContent, AnySyncMessageLikeEvent};
use matrix_sdk::ruma::{EventId, OwnedEventId, RoomId};
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

/// Pushed whenever a queued send changes state — a new local echo, a
/// successful send, or an error — so the frontend can flip a bubble
/// pending -> sent -> error without waiting for (or in addition to) a full
/// `timeline:update` diff. Spawned once at login/session-restore time from a
/// `room.send_queue()` (global `SendQueue::subscribe`) listener.
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../src/bindings/")]
pub struct SendQueueUpdateEvent {
    pub room_id: String,
    pub transaction_id: String,
    pub send_state: super::timeline::SendState,
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
    let original = room
        .event(&parsed_event_id, None)
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

    room.send_queue()
        .send(AnyMessageLikeEventContent::RoomMessage(content))
        .await
        .map_err(|e| e.to_string())?;

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
        room.send_queue()
            .send(AnyMessageLikeEventContent::Reaction(content))
            .await
            .map_err(|e| e.to_string())?;
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
    let target_event = room
        .event(&parsed_target, None)
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
