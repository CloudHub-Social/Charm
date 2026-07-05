use std::collections::BTreeMap;

use matrix_sdk::deserialized_responses::TimelineEvent;
use matrix_sdk::room::MessagesOptions;
use matrix_sdk::ruma::events::room::message::Relation as MessageRelation;
use matrix_sdk::ruma::events::room::redaction::SyncRoomRedactionEvent;
use matrix_sdk::ruma::events::{AnySyncMessageLikeEvent, AnySyncTimelineEvent};
use matrix_sdk::ruma::{OwnedEventId, OwnedUserId, RoomId};
use serde::{Deserialize, Serialize};
use tauri::State;
use ts_rs::TS;

use super::MatrixState;

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../src/bindings/")]
pub struct ReactionGroup {
    pub key: String,
    // Small counts (aggregated per room, per emoji) stay well within JS's safe-integer
    // range; emit `number` rather than ts-rs's default `bigint`.
    #[ts(type = "number")]
    pub count: u32,
    pub reacted_by_me: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../src/bindings/")]
pub struct ReplyRef {
    pub event_id: String,
    pub sender: String,
    pub preview: String,
}

/// Local send-queue state of a message, folded onto its `RoomMessageSummary`
/// so the frontend can flip a bubble pending -> sent -> error without a full
/// timeline diff. See `send_queue:update` in `actions.rs`, which carries the
/// same shape for out-of-band updates between timeline diffs.
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../src/bindings/")]
#[serde(tag = "state", rename_all = "snake_case")]
pub enum SendState {
    Pending,
    Sent,
    Error { message: String },
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../src/bindings/")]
pub struct RoomMessageSummary {
    pub event_id: String,
    pub sender: String,
    pub body: String,
    /// Reserved: always `None` until the formatted-body/rich-text composition spec lands.
    pub formatted_body: Option<String>,
    // Milliseconds since epoch stays well within JS's safe-integer range; emit `number`
    // rather than ts-rs's default `bigint` so the frontend can use it directly.
    #[ts(type = "number")]
    pub timestamp_ms: u64,
    pub edited: bool,
    pub redacted: bool,
    pub reactions: Vec<ReactionGroup>,
    pub in_reply_to: Option<ReplyRef>,
    pub transaction_id: Option<String>,
    pub send_state: SendState,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../src/bindings/")]
pub struct TimelinePage {
    pub messages: Vec<RoomMessageSummary>,
    /// Pass back as `cursor` to fetch the page further back in history.
    pub next_cursor: Option<String>,
}

/// Pushed to the frontend whenever a sync response brings new timeline events
/// for a room the client is joined to — so a room's message list can update
/// live without the frontend re-fetching a `TimelinePage` after every sync.
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../src/bindings/")]
pub struct RoomTimelineUpdate {
    pub room_id: String,
    pub messages: Vec<RoomMessageSummary>,
}

/// Folds a flat slice of timeline events — original `m.room.message` events,
/// `m.replace` edits, `m.reaction` annotations, and redactions — into
/// per-message summaries with edits/reactions/redactions collapsed onto
/// their target.
///
/// Deviation from the spec's "strongly prefer adopting the SDK's `Timeline`
/// API" guidance: this crate only depends on plain `matrix-sdk`, not
/// `matrix-sdk-ui` (which is where `Timeline`/`EventTimelineItem` actually
/// live). Pulling in `matrix-sdk-ui` here would mean adopting a whole second
/// timeline/pagination subsystem (its own cursor semantics, its own
/// in-memory item cache, a different event-to-frontend bridging story) as a
/// side effect of this spec, which is a much bigger structural change than
/// "add message actions" — so this hand-rolls relation-folding directly over
/// `room.messages()` output instead, per the spec's documented fallback.
/// `get_timeline_page`'s cursor logic (`MessagesOptions::backward()`/`response.end`)
/// is unchanged.
/// `pub` (not `pub(crate)`) so the network-dependent integration test for
/// this lives in `tests/message_actions.rs` rather than the `--lib` unit-test
/// target CI runs without a local Synapse available — same rationale as
/// `resolve_alias`/`discover` elsewhere in this crate.
///
/// Known fast-follow gap from the per-batch folding model: a relation
/// (edit/reaction/redaction) whose *target* isn't in the same batch/page as
/// the relation event itself folds onto nothing and is silently dropped —
/// e.g. reacting to a message from several messages back, once that message
/// has already scrolled out of the current sync batch, won't show up live;
/// it needs a refetch/repagination to appear. Fixing this needs
/// `timeline:update` to carry a refreshed summary for the *target* event
/// (re-fetched with its relations) when a relation event's target isn't in
/// the current batch, plus a frontend merge that replaces in place by
/// timestamp rather than appending. Tracked as a fast-follow rather than
/// blocking this PR on it — see the Spec 03 planning doc.
pub fn events_to_summaries(
    events: &[TimelineEvent],
    own_user_id: Option<&matrix_sdk::ruma::UserId>,
) -> Vec<RoomMessageSummary> {
    // `events` isn't guaranteed to be in any particular chronological order
    // relative to relations — `room.messages()` in particular returns
    // newest-first (backward pagination), so an edit/reaction/redaction
    // routinely appears *before* the original message it targets in the
    // slice. So this is a genuine two-pass fold: pass 1 collects originals
    // and relation events separately without assuming either is present yet,
    // pass 2 applies every relation now that all originals are known.
    let mut order: Vec<OwnedEventId> = Vec::new();
    let mut messages: BTreeMap<OwnedEventId, RoomMessageSummary> = BTreeMap::new();
    // target event id -> (origin_server_ts, new body, edit sender, edit event id)
    // of the newest-by-timestamp m.replace seen for it so far. Slices can
    // arrive in either direction (newest-first on backward pagination,
    // oldest-first on incremental sync), so "last-wins" has to mean "latest
    // timestamp wins", not "last iterated". The sender is kept so an edit can
    // be rejected if it didn't come from the original message's own sender —
    // Matrix edits are only valid from the original sender, but ruma doesn't
    // enforce that when deserializing — and the edit event's own id is kept
    // so a redacted edit (the user withdrew their own edit) can be dropped.
    let mut edits: BTreeMap<OwnedEventId, (u64, String, OwnedUserId, OwnedEventId)> =
        BTreeMap::new();
    // target event id -> reason a redaction targeted it (message or reaction)
    let mut redactions: std::collections::HashSet<OwnedEventId> = std::collections::HashSet::new();
    // reaction target event id -> (key, sender) pairs
    let mut reactions: BTreeMap<OwnedEventId, Vec<(String, OwnedUserId, OwnedEventId)>> =
        BTreeMap::new();
    // reply event id -> target event id it replies to
    let mut reply_targets: BTreeMap<OwnedEventId, OwnedEventId> = BTreeMap::new();

    for event in events {
        let raw = event.kind.raw();
        let deserialized: Result<AnySyncTimelineEvent, _> = raw.deserialize();
        let Ok(deserialized) = deserialized else {
            continue;
        };

        match deserialized {
            AnySyncTimelineEvent::MessageLike(AnySyncMessageLikeEvent::RoomMessage(msg)) => {
                let Some(original) = msg.as_original() else {
                    // Already redacted by the time we fetched it (its own
                    // JSON content is server-stripped to `{}`) — still worth
                    // a placeholder summary so the room shows a tombstone,
                    // and so a *separate* `m.room.redaction` event elsewhere
                    // in this same slice that targets it (order isn't
                    // guaranteed either way) has something to mark redacted.
                    if let matrix_sdk::ruma::events::SyncMessageLikeEvent::Redacted(redacted) = &msg
                    {
                        let event_id = redacted.event_id.clone();
                        messages.insert(
                            event_id.clone(),
                            RoomMessageSummary {
                                event_id: event_id.to_string(),
                                sender: redacted.sender.to_string(),
                                body: String::new(),
                                formatted_body: None,
                                timestamp_ms: redacted.origin_server_ts.0.into(),
                                edited: false,
                                redacted: true,
                                reactions: Vec::new(),
                                in_reply_to: None,
                                transaction_id: None,
                                send_state: SendState::Sent,
                            },
                        );
                        order.push(event_id);
                    }
                    continue;
                };

                // An edit (m.replace) carries its new content in
                // `m.new_content` and targets the original via `relates_to`.
                if let Some(MessageRelation::Replacement(replacement)) =
                    &original.content.relates_to
                {
                    let ts: u64 = original.origin_server_ts.0.into();
                    let body = replacement.new_content.msgtype.body().to_string();
                    let sender = original.sender.clone();
                    let edit_event_id = original.event_id.clone();
                    edits
                        .entry(replacement.event_id.clone())
                        .and_modify(
                            |(existing_ts, existing_body, existing_sender, existing_edit_id)| {
                                if ts >= *existing_ts {
                                    *existing_ts = ts;
                                    *existing_body = body.clone();
                                    *existing_sender = sender.clone();
                                    *existing_edit_id = edit_event_id.clone();
                                }
                            },
                        )
                        .or_insert((ts, body, sender, edit_event_id));
                    continue;
                }

                let event_id = original.event_id.clone();
                if let Some(MessageRelation::Reply(reply)) = &original.content.relates_to {
                    reply_targets.insert(event_id.clone(), reply.in_reply_to.event_id.clone());
                }

                messages.insert(
                    event_id.clone(),
                    RoomMessageSummary {
                        event_id: event_id.to_string(),
                        sender: original.sender.to_string(),
                        body: original.content.body().to_string(),
                        formatted_body: None,
                        timestamp_ms: original.origin_server_ts.0.into(),
                        edited: false,
                        redacted: false,
                        reactions: Vec::new(),
                        in_reply_to: None,
                        // The homeserver echoes back the sender's own send-queue
                        // transaction id in `unsigned.transaction_id` for events
                        // synced back to the sending device (only) — this is
                        // what lets the frontend reconcile a synced event with
                        // the local echo/optimistic bubble that produced it,
                        // instead of the two staying separate forever. Absent
                        // for events other users sent, which is fine: nothing
                        // else needs to reconcile those against a local echo.
                        transaction_id: original
                            .unsigned
                            .transaction_id
                            .as_ref()
                            .map(ToString::to_string),
                        send_state: SendState::Sent,
                    },
                );
                order.push(event_id);
            }
            AnySyncTimelineEvent::MessageLike(AnySyncMessageLikeEvent::Reaction(reaction)) => {
                if let Some(original) = reaction.as_original() {
                    let target = original.content.relates_to.event_id.clone();
                    let key = original.content.relates_to.key.clone();
                    reactions.entry(target).or_default().push((
                        key,
                        original.sender.clone(),
                        original.event_id.clone(),
                    ));
                }
            }
            AnySyncTimelineEvent::MessageLike(AnySyncMessageLikeEvent::RoomRedaction(
                redaction,
            )) => {
                let redacts = match &redaction {
                    SyncRoomRedactionEvent::Original(r) => {
                        r.content.redacts.clone().or_else(|| r.redacts.clone())
                    }
                    SyncRoomRedactionEvent::Redacted(r) => r.content.redacts.clone(),
                };
                if let Some(redacts) = redacts {
                    redactions.insert(redacts);
                }
            }
            _ => {}
        }
    }

    // Apply message-level redactions (distinct from reaction redactions
    // below, which target a reaction event id rather than a message one) —
    // *before* reply-refs and stripping reply fallbacks below, so a reply
    // preview never briefly shows text that's about to be (or already was,
    // in the same batch) redacted.
    for target in &redactions {
        if let Some(message) = messages.get_mut(target) {
            message.redacted = true;
            message.body = String::new();
        }
    }

    // Strip each reply message's *own* rich-reply fallback from its body —
    // as its own pass, before any reply-ref is built from anyone's body.
    // This has to happen up front rather than inline while building a given
    // reply's ref: `reply_targets` folds in arbitrary (BTreeMap-by-event-id)
    // order, so a reply-to-a-reply (C -> B -> A) could otherwise read B's
    // body as its preview before B's own fallback (which can itself quote
    // A) has been stripped, leaking A's raw (possibly-redacted) text into
    // C's preview. Normalizing every reply's body first, independent of
    // resolution order, avoids that entirely.
    //
    // Only strip when the body actually starts with a quote line (`> `) —
    // the rich-reply fallback's own format — rather than unconditionally
    // splitting on the first blank line: a client that doesn't generate
    // fallbacks could send a genuine multi-paragraph reply, and blindly
    // truncating at its first blank line would eat real content that just
    // happens to have the same shape.
    for reply_event_id in reply_targets.keys() {
        if let Some(reply_message) = messages.get_mut(reply_event_id) {
            if reply_message.body.starts_with("> ") {
                if let Some(idx) = reply_message.body.find("\n\n") {
                    reply_message.body = reply_message.body[idx + 2..].to_string();
                }
            }
        }
    }

    // Apply reply-refs *before* edits below, so a reply's quoted preview
    // reflects the message as it read when the reply was sent, not
    // whatever it happens to read after an edit that arrived in the same
    // batch — otherwise the preview would depend on batch-internal
    // ordering rather than showing consistent, edit-independent content.
    for (reply_event_id, target_event_id) in reply_targets {
        let Some(target) = messages.get(&target_event_id) else {
            continue;
        };
        let reply_ref = ReplyRef {
            event_id: target.event_id.clone(),
            sender: target.sender.clone(),
            preview: if target.redacted {
                String::new()
            } else {
                target.body.clone()
            },
        };
        if let Some(reply_message) = messages.get_mut(&reply_event_id) {
            reply_message.in_reply_to = Some(reply_ref);
        }
    }

    // Apply edits — skipping any whose sender doesn't match the original
    // message's sender (Matrix edits are only valid from the original
    // sender), whose edit event was itself redacted (the sender withdrew
    // their own edit), or whose target is already redacted (a redaction
    // withdrawing the message entirely takes precedence over any edit still
    // arriving for it — otherwise the edit's text would land back in the
    // application state a redaction was meant to remove, even though the
    // bubble itself still tombstones on `redacted`). If the newest edit for
    // a target fails any of these checks, this leaves the message as its
    // original (or next-oldest-edit) body rather than falling back to the
    // next-newest edit — a known, narrow limitation of only tracking the
    // single newest edit per target.
    for (target, (_ts, new_body, sender, edit_event_id)) in edits {
        if redactions.contains(&edit_event_id) {
            continue;
        }
        if let Some(message) = messages.get_mut(&target) {
            if message.sender != sender.as_str() || message.redacted {
                continue;
            }
            message.body = new_body;
            message.edited = true;
        }
    }

    // Apply reactions, dropping any individual reaction event that was
    // itself redacted (e.g. via `toggle_reaction`'s "remove" path).
    for (target, entries) in reactions {
        let Some(message) = messages.get_mut(&target) else {
            continue;
        };
        let mut groups: BTreeMap<String, ReactionGroup> = BTreeMap::new();
        // Dedupe by (sender, key): a sender can end up with more than one
        // *active* `m.reaction` for the same emoji (e.g. a double-click
        // racing the first one's local echo before `toggle_reaction` sees
        // it), which should still only count once — not inflate the total
        // or leave a stale extra reaction behind if just one copy is removed.
        let mut seen: std::collections::HashSet<(OwnedUserId, String)> =
            std::collections::HashSet::new();
        for (key, sender, reaction_event_id) in entries {
            if redactions.contains(&reaction_event_id) {
                continue;
            }
            if !seen.insert((sender.clone(), key.clone())) {
                continue;
            }
            let group = groups.entry(key.clone()).or_insert_with(|| ReactionGroup {
                key: key.clone(),
                count: 0,
                reacted_by_me: false,
            });
            group.count += 1;
            if own_user_id.is_some_and(|me| me == sender.as_ref() as &matrix_sdk::ruma::UserId) {
                group.reacted_by_me = true;
            }
        }
        message.reactions = groups.into_values().filter(|g| g.count > 0).collect();
    }

    order
        .into_iter()
        .filter_map(|id| messages.remove(&id))
        .collect()
}

/// Cursor-based pagination over a room's message history, oldest-not-included:
/// each call walks backward from `cursor` (or the live end of the timeline if
/// `cursor` is `None`). Text messages only for this first cut — images/other
/// msgtypes are a later timeline-rendering pass.
#[tauri::command]
pub async fn get_timeline_page(
    state: State<'_, MatrixState>,
    room_id: String,
    cursor: Option<String>,
    limit: Option<u32>,
) -> Result<TimelinePage, String> {
    let client = state.require_client().await?;

    let parsed_room_id = RoomId::parse(&room_id).map_err(|e| e.to_string())?;
    let room = client
        .get_room(&parsed_room_id)
        .ok_or_else(|| format!("room {room_id} not found"))?;

    let mut options = MessagesOptions::backward().from(cursor.as_deref());
    options.limit = limit.unwrap_or(30).into();

    let response = room.messages(options).await.map_err(|e| e.to_string())?;
    let own_user_id = client.user_id().map(|id| id.to_owned());

    Ok(TimelinePage {
        messages: events_to_summaries(&response.chunk, own_user_id.as_deref()),
        next_cursor: response.end,
    })
}

#[cfg(test)]
mod relation_folding_tests {
    use matrix_sdk::deserialized_responses::TimelineEvent;
    use matrix_sdk::ruma::serde::Raw;
    use serde_json::json;

    use super::events_to_summaries;

    fn event(json: serde_json::Value) -> TimelineEvent {
        TimelineEvent::from_plaintext(Raw::new(&json).unwrap().cast_unchecked())
    }

    /// Regression test for the send/timeline reconciliation bug: a synced
    /// event for something the current device sent carries the send-queue's
    /// transaction id in `unsigned.transaction_id`. That's the only thing
    /// that lets the frontend match this real event back to the optimistic
    /// echo it created (which has an entirely different, temporary "event
    /// id") — so it has to survive the fold, not get dropped as `None`.
    #[test]
    fn own_message_carries_its_send_queue_transaction_id() {
        let own_message = event(json!({
            "type": "m.room.message",
            "event_id": "$real:example.org",
            "sender": "@me:example.org",
            "origin_server_ts": 1000,
            "content": { "msgtype": "m.text", "body": "hello" },
            "unsigned": { "transaction_id": "txn-1" }
        }));

        let summaries = events_to_summaries(&[own_message], None);

        assert_eq!(summaries.len(), 1);
        assert_eq!(summaries[0].transaction_id.as_deref(), Some("txn-1"));
    }

    #[test]
    fn edit_collapses_onto_target_with_edited_flag() {
        let original = event(json!({
            "type": "m.room.message",
            "event_id": "$original",
            "sender": "@alice:example.org",
            "origin_server_ts": 1000,
            "content": { "msgtype": "m.text", "body": "hello" }
        }));
        let edit = event(json!({
            "type": "m.room.message",
            "event_id": "$edit",
            "sender": "@alice:example.org",
            "origin_server_ts": 2000,
            "content": {
                "msgtype": "m.text",
                "body": "* hello world",
                "m.new_content": { "msgtype": "m.text", "body": "hello world" },
                "m.relates_to": { "rel_type": "m.replace", "event_id": "$original" }
            }
        }));

        let summaries = events_to_summaries(&[original, edit], None);

        assert_eq!(summaries.len(), 1);
        assert_eq!(summaries[0].event_id, "$original");
        assert_eq!(summaries[0].body, "hello world");
        assert!(summaries[0].edited);
    }

    /// Regression test: incremental sync delivers events oldest-first (unlike
    /// backward pagination's newest-first), so two edits to the same message
    /// arriving in the same sync batch must resolve to the *chronologically*
    /// latest one — not whichever happens to be seen first while folding.
    #[test]
    fn newest_edit_wins_regardless_of_slice_order() {
        let original = event(json!({
            "type": "m.room.message",
            "event_id": "$original",
            "sender": "@alice:example.org",
            "origin_server_ts": 1000,
            "content": { "msgtype": "m.text", "body": "hello" }
        }));
        let older_edit = event(json!({
            "type": "m.room.message",
            "event_id": "$edit1",
            "sender": "@alice:example.org",
            "origin_server_ts": 2000,
            "content": {
                "msgtype": "m.text",
                "body": "* first edit",
                "m.new_content": { "msgtype": "m.text", "body": "first edit" },
                "m.relates_to": { "rel_type": "m.replace", "event_id": "$original" }
            }
        }));
        let newer_edit = event(json!({
            "type": "m.room.message",
            "event_id": "$edit2",
            "sender": "@alice:example.org",
            "origin_server_ts": 3000,
            "content": {
                "msgtype": "m.text",
                "body": "* second edit",
                "m.new_content": { "msgtype": "m.text", "body": "second edit" },
                "m.relates_to": { "rel_type": "m.replace", "event_id": "$original" }
            }
        }));

        // Oldest-first order, as incremental sync delivers it.
        let summaries = events_to_summaries(
            &[original.clone(), older_edit.clone(), newer_edit.clone()],
            None,
        );
        assert_eq!(summaries[0].body, "second edit");

        // Newest-first order, as backward pagination delivers it — same result.
        let summaries = events_to_summaries(&[newer_edit, older_edit, original], None);
        assert_eq!(summaries[0].body, "second edit");
    }

    #[test]
    fn redaction_clears_body_and_sets_redacted() {
        let original = event(json!({
            "type": "m.room.message",
            "event_id": "$original",
            "sender": "@alice:example.org",
            "origin_server_ts": 1000,
            "content": { "msgtype": "m.text", "body": "hello" }
        }));
        let redaction = event(json!({
            "type": "m.room.redaction",
            "event_id": "$redaction",
            "sender": "@alice:example.org",
            "origin_server_ts": 2000,
            "redacts": "$original",
            "content": { "redacts": "$original" }
        }));

        let summaries = events_to_summaries(&[original, redaction], None);

        assert_eq!(summaries.len(), 1);
        assert!(summaries[0].redacted);
        assert_eq!(summaries[0].body, "");
    }

    #[test]
    fn two_reactions_aggregate_into_one_group_with_count_two() {
        let original = event(json!({
            "type": "m.room.message",
            "event_id": "$original",
            "sender": "@alice:example.org",
            "origin_server_ts": 1000,
            "content": { "msgtype": "m.text", "body": "hello" }
        }));
        let reaction_a = event(json!({
            "type": "m.reaction",
            "event_id": "$r1",
            "sender": "@alice:example.org",
            "origin_server_ts": 1500,
            "content": {
                "m.relates_to": { "rel_type": "m.annotation", "event_id": "$original", "key": "👍" }
            }
        }));
        let reaction_b = event(json!({
            "type": "m.reaction",
            "event_id": "$r2",
            "sender": "@bob:example.org",
            "origin_server_ts": 1600,
            "content": {
                "m.relates_to": { "rel_type": "m.annotation", "event_id": "$original", "key": "👍" }
            }
        }));

        let alice = matrix_sdk::ruma::user_id!("@alice:example.org");
        let summaries = events_to_summaries(&[original, reaction_a, reaction_b], Some(alice));

        assert_eq!(summaries.len(), 1);
        assert_eq!(summaries[0].reactions.len(), 1);
        assert_eq!(summaries[0].reactions[0].key, "👍");
        assert_eq!(summaries[0].reactions[0].count, 2);
        assert!(summaries[0].reactions[0].reacted_by_me);
    }

    #[test]
    fn reply_carries_a_reply_ref_to_the_target() {
        let original = event(json!({
            "type": "m.room.message",
            "event_id": "$original",
            "sender": "@alice:example.org",
            "origin_server_ts": 1000,
            "content": { "msgtype": "m.text", "body": "hello" }
        }));
        let reply = event(json!({
            "type": "m.room.message",
            "event_id": "$reply",
            "sender": "@bob:example.org",
            "origin_server_ts": 2000,
            "content": {
                "msgtype": "m.text",
                "body": "> hello\n\nhi back",
                "m.relates_to": { "m.in_reply_to": { "event_id": "$original" } }
            }
        }));

        let summaries = events_to_summaries(&[original, reply], None);

        assert_eq!(summaries.len(), 2);
        let reply_summary = &summaries[1];
        let reply_ref = reply_summary.in_reply_to.as_ref().expect("has a reply ref");
        assert_eq!(reply_ref.event_id, "$original");
        assert_eq!(reply_ref.sender, "@alice:example.org");
        assert_eq!(reply_ref.preview, "hello");
        // The rich-reply fallback quote is stripped from the rendered body —
        // `ReplyPreview` already shows the quoted original via `in_reply_to`.
        assert_eq!(reply_summary.body, "hi back");
    }

    #[test]
    fn edit_from_a_different_sender_than_the_original_is_rejected() {
        let original = event(json!({
            "type": "m.room.message",
            "event_id": "$original",
            "sender": "@alice:example.org",
            "origin_server_ts": 1000,
            "content": { "msgtype": "m.text", "body": "hello" }
        }));
        let malicious_edit = event(json!({
            "type": "m.room.message",
            "event_id": "$edit",
            "sender": "@mallory:example.org",
            "origin_server_ts": 2000,
            "content": {
                "msgtype": "m.text",
                "body": "* pwned",
                "m.new_content": { "msgtype": "m.text", "body": "pwned" },
                "m.relates_to": { "rel_type": "m.replace", "event_id": "$original" }
            }
        }));

        let summaries = events_to_summaries(&[original, malicious_edit], None);

        assert_eq!(summaries.len(), 1);
        assert_eq!(summaries[0].body, "hello");
        assert!(!summaries[0].edited);
    }

    #[test]
    fn a_redacted_edit_event_is_not_applied() {
        let original = event(json!({
            "type": "m.room.message",
            "event_id": "$original",
            "sender": "@alice:example.org",
            "origin_server_ts": 1000,
            "content": { "msgtype": "m.text", "body": "hello" }
        }));
        let edit = event(json!({
            "type": "m.room.message",
            "event_id": "$edit",
            "sender": "@alice:example.org",
            "origin_server_ts": 2000,
            "content": {
                "msgtype": "m.text",
                "body": "* withdrawn",
                "m.new_content": { "msgtype": "m.text", "body": "withdrawn" },
                "m.relates_to": { "rel_type": "m.replace", "event_id": "$original" }
            }
        }));
        let redact_the_edit = event(json!({
            "type": "m.room.redaction",
            "event_id": "$redaction",
            "sender": "@alice:example.org",
            "origin_server_ts": 3000,
            "redacts": "$edit",
            "content": { "redacts": "$edit" }
        }));

        let summaries = events_to_summaries(&[original, edit, redact_the_edit], None);

        assert_eq!(summaries.len(), 1);
        assert_eq!(summaries[0].body, "hello");
        assert!(!summaries[0].edited);
    }

    #[test]
    fn duplicate_active_reactions_from_the_same_sender_count_once() {
        let original = event(json!({
            "type": "m.room.message",
            "event_id": "$original",
            "sender": "@alice:example.org",
            "origin_server_ts": 1000,
            "content": { "msgtype": "m.text", "body": "hi" }
        }));
        let reaction = |evt: &str| {
            json!({
                "type": "m.reaction",
                "event_id": evt,
                "sender": "@bob:example.org",
                "origin_server_ts": 2000,
                "content": {
                    "m.relates_to": { "rel_type": "m.annotation", "event_id": "$original", "key": "👍" }
                }
            })
        };

        let summaries = events_to_summaries(
            &[original, event(reaction("$r1")), event(reaction("$r2"))],
            None,
        );

        assert_eq!(summaries[0].reactions.len(), 1);
        assert_eq!(summaries[0].reactions[0].count, 1);
    }

    #[test]
    fn reply_preview_is_empty_for_a_redacted_target() {
        let original = event(json!({
            "type": "m.room.message",
            "event_id": "$original",
            "sender": "@alice:example.org",
            "origin_server_ts": 1000,
            "content": { "msgtype": "m.text", "body": "sensitive" }
        }));
        let redaction = event(json!({
            "type": "m.room.redaction",
            "event_id": "$redaction",
            "sender": "@alice:example.org",
            "origin_server_ts": 1500,
            "redacts": "$original",
            "content": { "redacts": "$original" }
        }));
        let reply = event(json!({
            "type": "m.room.message",
            "event_id": "$reply",
            "sender": "@bob:example.org",
            "origin_server_ts": 2000,
            "content": {
                "msgtype": "m.text",
                "body": "> sensitive\n\nhi back",
                "m.relates_to": { "m.in_reply_to": { "event_id": "$original" } }
            }
        }));

        let summaries = events_to_summaries(&[original, redaction, reply], None);

        let reply_summary = summaries.iter().find(|m| m.event_id == "$reply").unwrap();
        let reply_ref = reply_summary.in_reply_to.as_ref().expect("has a reply ref");
        assert_eq!(reply_ref.preview, "");
    }

    #[test]
    fn reply_preview_shows_the_original_body_not_a_same_batch_edit() {
        let original = event(json!({
            "type": "m.room.message",
            "event_id": "$original",
            "sender": "@alice:example.org",
            "origin_server_ts": 1000,
            "content": { "msgtype": "m.text", "body": "original text" }
        }));
        let edit = event(json!({
            "type": "m.room.message",
            "event_id": "$edit",
            "sender": "@alice:example.org",
            "origin_server_ts": 1500,
            "content": {
                "msgtype": "m.text",
                "body": "* edited text",
                "m.new_content": { "msgtype": "m.text", "body": "edited text" },
                "m.relates_to": { "rel_type": "m.replace", "event_id": "$original" }
            }
        }));
        let reply = event(json!({
            "type": "m.room.message",
            "event_id": "$reply",
            "sender": "@bob:example.org",
            "origin_server_ts": 2000,
            "content": {
                "msgtype": "m.text",
                "body": "> original text\n\nhi back",
                "m.relates_to": { "m.in_reply_to": { "event_id": "$original" } }
            }
        }));

        let summaries = events_to_summaries(&[original, edit, reply], None);

        let original_summary = summaries
            .iter()
            .find(|m| m.event_id == "$original")
            .unwrap();
        assert_eq!(original_summary.body, "edited text");
        assert!(original_summary.edited);

        let reply_summary = summaries.iter().find(|m| m.event_id == "$reply").unwrap();
        let reply_ref = reply_summary.in_reply_to.as_ref().expect("has a reply ref");
        assert_eq!(reply_ref.preview, "original text");
    }

    #[test]
    fn does_not_truncate_a_genuine_multi_paragraph_reply_without_a_fallback() {
        let original = event(json!({
            "type": "m.room.message",
            "event_id": "$original",
            "sender": "@alice:example.org",
            "origin_server_ts": 1000,
            "content": { "msgtype": "m.text", "body": "hello" }
        }));
        // A reply from a client that doesn't generate rich-reply fallbacks —
        // the body is a genuine two-paragraph message, not a quote + reply.
        let reply = event(json!({
            "type": "m.room.message",
            "event_id": "$reply",
            "sender": "@bob:example.org",
            "origin_server_ts": 2000,
            "content": {
                "msgtype": "m.text",
                "body": "first paragraph\n\nsecond paragraph",
                "m.relates_to": { "m.in_reply_to": { "event_id": "$original" } }
            }
        }));

        let summaries = events_to_summaries(&[original, reply], None);

        let reply_summary = summaries.iter().find(|m| m.event_id == "$reply").unwrap();
        assert_eq!(reply_summary.body, "first paragraph\n\nsecond paragraph");
    }

    #[test]
    fn reply_to_a_reply_does_not_leak_a_redacted_grandparents_text() {
        // A (redacted) <- B (reply to A, itself has a raw un-stripped
        // fallback quoting A) <- C (reply to B). If B's own fallback isn't
        // stripped before C reads B's body as its preview, C's preview would
        // leak A's now-redacted text — regardless of reply_targets' fold
        // order, which is why the fallback-stripping pass has to run before
        // any reply-ref is built, not interleaved with building them.
        let a = event(json!({
            "type": "m.room.message",
            "event_id": "$a",
            "sender": "@alice:example.org",
            "origin_server_ts": 1000,
            "content": { "msgtype": "m.text", "body": "sensitive original" }
        }));
        let redact_a = event(json!({
            "type": "m.room.redaction",
            "event_id": "$redact_a",
            "sender": "@alice:example.org",
            "origin_server_ts": 1100,
            "redacts": "$a",
            "content": { "redacts": "$a" }
        }));
        let b = event(json!({
            "type": "m.room.message",
            "event_id": "$b",
            "sender": "@bob:example.org",
            "origin_server_ts": 1200,
            "content": {
                "msgtype": "m.text",
                "body": "> sensitive original\n\nreply to a",
                "m.relates_to": { "m.in_reply_to": { "event_id": "$a" } }
            }
        }));
        let c = event(json!({
            "type": "m.room.message",
            "event_id": "$c",
            "sender": "@carol:example.org",
            "origin_server_ts": 1300,
            "content": {
                "msgtype": "m.text",
                "body": "> reply to a\n\nreply to b",
                "m.relates_to": { "m.in_reply_to": { "event_id": "$b" } }
            }
        }));

        let summaries = events_to_summaries(&[a, redact_a, b, c], None);

        let c_summary = summaries.iter().find(|m| m.event_id == "$c").unwrap();
        let c_reply_ref = c_summary.in_reply_to.as_ref().expect("has a reply ref");
        assert_eq!(c_reply_ref.preview, "reply to a");
    }

    #[test]
    fn skips_an_edit_targeting_an_already_redacted_message() {
        let original = event(json!({
            "type": "m.room.message",
            "event_id": "$original",
            "sender": "@alice:example.org",
            "origin_server_ts": 1000,
            "content": { "msgtype": "m.text", "body": "hello" }
        }));
        let redaction = event(json!({
            "type": "m.room.redaction",
            "event_id": "$redaction",
            "sender": "@alice:example.org",
            "origin_server_ts": 1500,
            "redacts": "$original",
            "content": { "redacts": "$original" }
        }));
        let edit = event(json!({
            "type": "m.room.message",
            "event_id": "$edit",
            "sender": "@alice:example.org",
            "origin_server_ts": 2000,
            "content": {
                "msgtype": "m.text",
                "body": "* resurrected",
                "m.new_content": { "msgtype": "m.text", "body": "resurrected" },
                "m.relates_to": { "rel_type": "m.replace", "event_id": "$original" }
            }
        }));

        let summaries = events_to_summaries(&[original, redaction, edit], None);

        assert_eq!(summaries.len(), 1);
        assert!(summaries[0].redacted);
        assert_eq!(summaries[0].body, "");
    }
}
