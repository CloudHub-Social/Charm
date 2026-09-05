//! MSC3381 poll creation, voting, and ending.
//!
//! matrix-sdk-ui owns poll aggregation and timeline updates; this module is
//! deliberately only the outbound command seam around Ruma's maintained
//! unstable poll event types.

use matrix_sdk::ruma::events::poll::{
    start::PollKind,
    unstable_end::UnstablePollEndEventContent,
    unstable_response::UnstablePollResponseEventContent,
    unstable_start::{
        NewUnstablePollStartEventContent, UnstablePollAnswer, UnstablePollAnswers,
        UnstablePollStartContentBlock,
    },
};
use matrix_sdk::ruma::events::AnyMessageLikeEventContent;
use matrix_sdk::ruma::{EventId, RoomId};
use matrix_sdk::send_queue::LocalEchoContent;
use matrix_sdk::Client;
use serde::Serialize;
use std::collections::HashMap;
use std::sync::{Arc, LazyLock, Weak};
use tauri::{Manager, State};
use tokio::sync::Mutex;

use super::actions::{discard_failed_message_impl, resend_message_impl};
use super::send::send_and_capture_transaction_id;
use super::MatrixState;

const MIN_OPTIONS: usize = 2;
const MAX_OPTIONS: usize = 20;
static POLL_MUTATION_LOCKS: LazyLock<Mutex<HashMap<String, Weak<Mutex<()>>>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));
const POLL_END_ACK_PREFIX: &[u8] = b"charm.poll-end-ack.v1\0";

#[derive(Clone, Debug, Serialize)]
pub struct PendingPollEnd {
    transaction_id: String,
    failed: bool,
}

#[derive(Clone, Debug, Serialize)]
pub struct PendingPollVote {
    transaction_id: String,
    answer_id: String,
    failed: bool,
}

fn poll_end_key(client: &Client, room_id: &RoomId, poll_id: &EventId) -> Result<String, String> {
    let user_id = client.user_id().ok_or("No active Matrix account")?;
    let device_id = client.device_id().ok_or("No active Matrix device")?;
    Ok(format!("{user_id}\0{device_id}\0{room_id}\0{poll_id}"))
}

fn poll_end_ack_store_key(key: &str) -> Vec<u8> {
    [POLL_END_ACK_PREFIX, key.as_bytes()].concat()
}

async fn acknowledged_poll_end(client: &Client, key: &str) -> Result<Option<String>, String> {
    let Some(value) = client
        .state_store()
        .get_custom_value(&poll_end_ack_store_key(key))
        .await
        .map_err(|error| error.to_string())?
    else {
        return Ok(None);
    };
    String::from_utf8(value)
        .map(Some)
        .map_err(|_| "Persisted poll-close acknowledgement is invalid UTF-8".to_string())
}

async fn set_acknowledged_poll_end(
    client: &Client,
    key: &str,
    transaction_id: &str,
) -> Result<(), String> {
    client
        .state_store()
        .set_custom_value_no_read(
            &poll_end_ack_store_key(key),
            transaction_id.as_bytes().to_vec(),
        )
        .await
        .map_err(|error| error.to_string())
}

async fn clear_acknowledged_poll_end(client: &Client, key: &str) -> Result<(), String> {
    client
        .state_store()
        .remove_custom_value(&poll_end_ack_store_key(key))
        .await
        .map(|_| ())
        .map_err(|error| error.to_string())
}

async fn poll_mutation_lock(key: &str) -> Arc<Mutex<()>> {
    let mut locks = POLL_MUTATION_LOCKS.lock().await;
    locks.retain(|_, lock| lock.strong_count() > 0);
    if let Some(lock) = locks.get(key).and_then(Weak::upgrade) {
        return lock;
    }
    let lock = Arc::new(Mutex::new(()));
    locks.insert(key.to_owned(), Arc::downgrade(&lock));
    lock
}

async fn reconcile_acknowledged_poll_end(
    client: &Client,
    key: &str,
    pending: &PendingPollEnd,
) -> Result<(), String> {
    if pending.failed {
        clear_acknowledged_poll_end(client, key).await
    } else {
        set_acknowledged_poll_end(client, key, &pending.transaction_id).await
    }
}

async fn pending_poll_end(
    room: &matrix_sdk::Room,
    poll_id: &EventId,
) -> Result<Option<PendingPollEnd>, String> {
    let (echoes, _) = room
        .send_queue()
        .subscribe()
        .await
        .map_err(|e| e.to_string())?;
    Ok(echoes.into_iter().find_map(|echo| {
        let LocalEchoContent::Event {
            serialized_event,
            send_error,
            ..
        } = echo.content
        else {
            return None;
        };
        let Ok(AnyMessageLikeEventContent::UnstablePollEnd(content)) =
            serialized_event.deserialize()
        else {
            return None;
        };
        (content.relates_to.event_id.as_str() == poll_id.as_str()).then(|| PendingPollEnd {
            transaction_id: echo.transaction_id.to_string(),
            failed: send_error.is_some(),
        })
    }))
}

async fn pending_poll_vote(
    room: &matrix_sdk::Room,
    poll_id: &EventId,
) -> Result<Option<PendingPollVote>, String> {
    let (echoes, _) = room
        .send_queue()
        .subscribe()
        .await
        .map_err(|error| error.to_string())?;
    Ok(echoes.into_iter().find_map(|echo| {
        let LocalEchoContent::Event {
            serialized_event,
            send_error,
            ..
        } = echo.content
        else {
            return None;
        };
        let Ok(AnyMessageLikeEventContent::UnstablePollResponse(content)) =
            serialized_event.deserialize()
        else {
            return None;
        };
        if content.relates_to.event_id.as_str() != poll_id.as_str() {
            return None;
        }
        content
            .poll_response
            .answers
            .first()
            .cloned()
            .map(|answer_id| PendingPollVote {
                transaction_id: echo.transaction_id.to_string(),
                answer_id,
                failed: send_error.is_some(),
            })
    }))
}

pub async fn pending_poll_vote_impl(
    client: &Client,
    room_id: &str,
    poll_event_id: &str,
) -> Result<Option<PendingPollVote>, String> {
    let room = room_for(client, room_id)?;
    let poll_event_id = EventId::parse(poll_event_id).map_err(|error| error.to_string())?;
    let close_key = poll_end_key(client, room.room_id(), &poll_event_id)?;
    let mutation_lock = poll_mutation_lock(&close_key).await;
    let _guard = mutation_lock.lock().await;
    pending_poll_vote(&room, &poll_event_id).await
}

pub async fn pending_poll_end_impl(
    client: &Client,
    room_id: &str,
    poll_event_id: &str,
) -> Result<Option<PendingPollEnd>, String> {
    let room = room_for(client, room_id)?;
    let poll_event_id = EventId::parse(poll_event_id).map_err(|error| error.to_string())?;
    let close_key = poll_end_key(client, room.room_id(), &poll_event_id)?;
    let mutation_lock = poll_mutation_lock(&close_key).await;
    let _guard = mutation_lock.lock().await;
    pending_poll_end_locked(client, &room, &poll_event_id, &close_key).await
}

async fn pending_poll_end_locked(
    client: &Client,
    room: &matrix_sdk::Room,
    poll_event_id: &EventId,
    close_key: &str,
) -> Result<Option<PendingPollEnd>, String> {
    if let Some(pending) = pending_poll_end(room, poll_event_id).await? {
        reconcile_acknowledged_poll_end(client, close_key, &pending).await?;
        return Ok(Some(pending));
    }
    Ok(acknowledged_poll_end(client, close_key)
        .await?
        .map(|transaction_id| PendingPollEnd {
            transaction_id,
            failed: false,
        }))
}

pub async fn confirm_poll_end_synced_impl(
    client: &Client,
    room_id: &str,
    poll_event_id: &str,
) -> Result<(), String> {
    let room_id = RoomId::parse(room_id).map_err(|error| error.to_string())?;
    let poll_event_id = EventId::parse(poll_event_id).map_err(|error| error.to_string())?;
    let close_key = poll_end_key(client, &room_id, &poll_event_id)?;
    let mutation_lock = poll_mutation_lock(&close_key).await;
    let _guard = mutation_lock.lock().await;
    clear_acknowledged_poll_end(client, &close_key).await
}

pub(super) fn notifications_enabled(app: &tauri::AppHandle) -> bool {
    app.path().app_data_dir().is_ok_and(|directory| {
        crate::feature_flags::flag(&directory, crate::feature_flags::FeatureFlagKey::Polls)
    })
}

fn normalize_poll(question: String, options: Vec<String>) -> Result<(String, Vec<String>), String> {
    let question = question.trim().to_string();
    if question.is_empty() {
        return Err("Poll question cannot be empty".to_string());
    }
    // Match HTML maxlength's UTF-16 units at the native/shared HTTP boundary.
    if question.encode_utf16().count() > 500 {
        return Err("Poll question is too long".to_string());
    }
    if options.len() < MIN_OPTIONS || options.len() > MAX_OPTIONS {
        return Err(format!(
            "Polls require between {MIN_OPTIONS} and {MAX_OPTIONS} options"
        ));
    }

    let options: Vec<String> = options
        .into_iter()
        .map(|option| option.trim().to_string())
        .collect();
    if options.iter().any(String::is_empty) {
        return Err("Poll options cannot be empty".to_string());
    }
    if options
        .iter()
        .any(|option| option.encode_utf16().count() > 200)
    {
        return Err("Poll option is too long".to_string());
    }
    let unique: std::collections::HashSet<String> =
        options.iter().map(|option| option.to_lowercase()).collect();
    if unique.len() != options.len() {
        return Err("Poll options must be unique".to_string());
    }

    Ok((question, options))
}

fn poll_start_content(
    question: String,
    options: Vec<String>,
    disclosed: bool,
) -> Result<AnyMessageLikeEventContent, String> {
    let (question, options) = normalize_poll(question, options)?;
    let fallback = format!("Poll: {question}\n{}", options.join("\n"));
    let answers = options
        .into_iter()
        .enumerate()
        .map(|(index, text)| UnstablePollAnswer::new(index.to_string(), text))
        .collect::<Vec<_>>();
    let answers = UnstablePollAnswers::try_from(answers).map_err(|error| error.to_string())?;
    let mut poll = UnstablePollStartContentBlock::new(question, answers);
    poll.kind = if disclosed {
        PollKind::Disclosed
    } else {
        PollKind::Undisclosed
    };

    Ok(AnyMessageLikeEventContent::UnstablePollStart(
        NewUnstablePollStartEventContent::plain_text(fallback, poll).into(),
    ))
}

fn room_for(client: &Client, room_id: &str) -> Result<matrix_sdk::Room, String> {
    let parsed_room_id = RoomId::parse(room_id).map_err(|error| error.to_string())?;
    client
        .get_room(&parsed_room_id)
        .ok_or_else(|| format!("room {room_id} not found"))
}

pub async fn create_poll_impl(
    client: &Client,
    room_id: &str,
    question: String,
    options: Vec<String>,
    disclosed: bool,
) -> Result<String, String> {
    let room = room_for(client, room_id)?;
    let content = poll_start_content(question, options, disclosed)?;
    send_and_capture_transaction_id(client, &room, content).await
}

pub async fn vote_on_poll_impl(
    client: &Client,
    room_id: &str,
    poll_event_id: &str,
    answer_id: String,
) -> Result<String, String> {
    if answer_id.is_empty() || answer_id.len() > 4096 {
        return Err("Poll answer id is empty or too long".to_string());
    }
    let room = room_for(client, room_id)?;
    let poll_event_id = EventId::parse(poll_event_id).map_err(|error| error.to_string())?;
    let close_key = poll_end_key(client, room.room_id(), &poll_event_id)?;
    let mutation_lock = poll_mutation_lock(&close_key).await;
    let _guard = mutation_lock.lock().await;
    if pending_poll_end_locked(client, &room, &poll_event_id, &close_key)
        .await?
        .is_some()
    {
        return Err("This poll has a queued close. Wait for it to settle before voting.".into());
    }
    if pending_poll_vote(&room, &poll_event_id).await?.is_some() {
        return Err("This poll already has a queued vote. Wait for it to settle first.".into());
    }
    let content = UnstablePollResponseEventContent::new(vec![answer_id], poll_event_id);
    send_and_capture_transaction_id(
        client,
        &room,
        AnyMessageLikeEventContent::UnstablePollResponse(content),
    )
    .await
}

pub async fn end_poll_impl(
    client: &Client,
    room_id: &str,
    poll_event_id: &str,
) -> Result<String, String> {
    let room = room_for(client, room_id)?;
    let poll_event_id = EventId::parse(poll_event_id).map_err(|error| error.to_string())?;
    let close_key = poll_end_key(client, room.room_id(), &poll_event_id)?;
    let mutation_lock = poll_mutation_lock(&close_key).await;
    let _guard = mutation_lock.lock().await;
    if let Some(pending) =
        pending_poll_end_locked(client, &room, &poll_event_id, &close_key).await?
    {
        return Ok(pending.transaction_id);
    }
    if pending_poll_vote(&room, &poll_event_id).await?.is_some() {
        return Err("This poll has a queued vote. Wait for it to settle before closing.".into());
    }
    let content = UnstablePollEndEventContent::new("Poll ended", poll_event_id);
    let transaction_id = send_and_capture_transaction_id(
        client,
        &room,
        AnyMessageLikeEventContent::UnstablePollEnd(content),
    )
    .await?;
    set_acknowledged_poll_end(client, &close_key, &transaction_id).await?;
    Ok(transaction_id)
}

pub async fn retry_poll_end_impl(
    client: &Client,
    room_id: &str,
    poll_event_id: &str,
    transaction_id: &str,
) -> Result<bool, String> {
    let room = room_for(client, room_id)?;
    let poll_event_id = EventId::parse(poll_event_id).map_err(|error| error.to_string())?;
    let close_key = poll_end_key(client, room.room_id(), &poll_event_id)?;
    let mutation_lock = poll_mutation_lock(&close_key).await;
    let _guard = mutation_lock.lock().await;
    let Some(pending) = pending_poll_end(&room, &poll_event_id).await? else {
        clear_acknowledged_poll_end(client, &close_key).await?;
        return Ok(false);
    };
    if pending.transaction_id != transaction_id || !pending.failed {
        return Ok(false);
    }
    // Persist the mutation lock before retrying. The SDK may remove a sent
    // echo before the next timeline sync; a process crash in that interval
    // must still leave voting and duplicate closes disabled after restart.
    set_acknowledged_poll_end(client, &close_key, transaction_id).await?;
    let retried = match resend_message_impl(client, room_id, transaction_id).await {
        Ok(retried) => retried,
        Err(error) => {
            clear_acknowledged_poll_end(client, &close_key).await?;
            return Err(error);
        }
    };
    if retried {
        set_acknowledged_poll_end(client, &close_key, transaction_id).await?;
    } else {
        clear_acknowledged_poll_end(client, &close_key).await?;
    }
    Ok(retried)
}

pub async fn retry_poll_vote_impl(
    client: &Client,
    room_id: &str,
    poll_event_id: &str,
    transaction_id: &str,
) -> Result<bool, String> {
    let room = room_for(client, room_id)?;
    let poll_event_id = EventId::parse(poll_event_id).map_err(|error| error.to_string())?;
    let close_key = poll_end_key(client, room.room_id(), &poll_event_id)?;
    let mutation_lock = poll_mutation_lock(&close_key).await;
    let _guard = mutation_lock.lock().await;
    let Some(pending) = pending_poll_vote(&room, &poll_event_id).await? else {
        return Ok(false);
    };
    if pending.transaction_id != transaction_id || !pending.failed {
        return Ok(false);
    }
    resend_message_impl(client, room_id, transaction_id).await
}

pub async fn discard_poll_vote_impl(
    client: &Client,
    room_id: &str,
    poll_event_id: &str,
    transaction_id: &str,
) -> Result<bool, String> {
    let room = room_for(client, room_id)?;
    let poll_event_id = EventId::parse(poll_event_id).map_err(|error| error.to_string())?;
    let close_key = poll_end_key(client, room.room_id(), &poll_event_id)?;
    let mutation_lock = poll_mutation_lock(&close_key).await;
    let _guard = mutation_lock.lock().await;
    let Some(pending) = pending_poll_vote(&room, &poll_event_id).await? else {
        return Ok(false);
    };
    if pending.transaction_id != transaction_id || !pending.failed {
        return Ok(false);
    }
    discard_failed_message_impl(client, room_id, transaction_id).await
}

pub async fn discard_poll_end_impl(
    client: &Client,
    room_id: &str,
    poll_event_id: &str,
    transaction_id: &str,
) -> Result<bool, String> {
    let room = room_for(client, room_id)?;
    let poll_event_id = EventId::parse(poll_event_id).map_err(|error| error.to_string())?;
    let close_key = poll_end_key(client, room.room_id(), &poll_event_id)?;
    let mutation_lock = poll_mutation_lock(&close_key).await;
    let _guard = mutation_lock.lock().await;
    let Some(pending) = pending_poll_end(&room, &poll_event_id).await? else {
        return Ok(false);
    };
    if pending.transaction_id != transaction_id || !pending.failed {
        return Ok(false);
    }
    let discarded = discard_failed_message_impl(client, room_id, transaction_id).await?;
    if discarded {
        clear_acknowledged_poll_end(client, &close_key).await?;
    }
    Ok(discarded)
}

#[tauri::command]
pub async fn create_poll(
    state: State<'_, MatrixState>,
    room_id: String,
    question: String,
    options: Vec<String>,
    disclosed: bool,
) -> Result<String, String> {
    let client = state.require_client().await?;
    create_poll_impl(&client, &room_id, question, options, disclosed).await
}

#[tauri::command]
pub async fn vote_on_poll(
    state: State<'_, MatrixState>,
    room_id: String,
    poll_event_id: String,
    answer_id: String,
) -> Result<String, String> {
    let client = state.require_client().await?;
    vote_on_poll_impl(&client, &room_id, &poll_event_id, answer_id).await
}

#[tauri::command]
pub async fn end_poll(
    state: State<'_, MatrixState>,
    room_id: String,
    poll_event_id: String,
) -> Result<String, String> {
    let client = state.require_client().await?;
    end_poll_impl(&client, &room_id, &poll_event_id).await
}

#[tauri::command]
pub async fn retry_poll_end(
    state: State<'_, MatrixState>,
    room_id: String,
    poll_event_id: String,
    transaction_id: String,
) -> Result<bool, String> {
    let client = state.require_client().await?;
    retry_poll_end_impl(&client, &room_id, &poll_event_id, &transaction_id).await
}

#[tauri::command]
pub async fn retry_poll_vote(
    state: State<'_, MatrixState>,
    room_id: String,
    poll_event_id: String,
    transaction_id: String,
) -> Result<bool, String> {
    let client = state.require_client().await?;
    retry_poll_vote_impl(&client, &room_id, &poll_event_id, &transaction_id).await
}

#[tauri::command]
pub async fn discard_poll_vote(
    state: State<'_, MatrixState>,
    room_id: String,
    poll_event_id: String,
    transaction_id: String,
) -> Result<bool, String> {
    let client = state.require_client().await?;
    discard_poll_vote_impl(&client, &room_id, &poll_event_id, &transaction_id).await
}

#[tauri::command]
pub async fn discard_poll_end(
    state: State<'_, MatrixState>,
    room_id: String,
    poll_event_id: String,
    transaction_id: String,
) -> Result<bool, String> {
    let client = state.require_client().await?;
    discard_poll_end_impl(&client, &room_id, &poll_event_id, &transaction_id).await
}

#[tauri::command]
pub async fn get_pending_poll_vote(
    state: State<'_, MatrixState>,
    room_id: String,
    poll_event_id: String,
) -> Result<Option<PendingPollVote>, String> {
    let client = state.require_client().await?;
    pending_poll_vote_impl(&client, &room_id, &poll_event_id).await
}

#[tauri::command]
pub async fn get_pending_poll_end(
    state: State<'_, MatrixState>,
    room_id: String,
    poll_event_id: String,
) -> Result<Option<PendingPollEnd>, String> {
    let client = state.require_client().await?;
    pending_poll_end_impl(&client, &room_id, &poll_event_id).await
}

#[tauri::command]
pub async fn confirm_poll_end_synced(
    state: State<'_, MatrixState>,
    room_id: String,
    poll_event_id: String,
) -> Result<(), String> {
    let client = state.require_client().await?;
    confirm_poll_end_synced_impl(&client, &room_id, &poll_event_id).await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn mutation_locks_are_shared_per_poll_without_serializing_other_polls() {
        let first = poll_mutation_lock("@alice:example.org\0!room:example.org\0$first").await;
        let same = poll_mutation_lock("@alice:example.org\0!room:example.org\0$first").await;
        let other = poll_mutation_lock("@alice:example.org\0!room:example.org\0$other").await;

        assert!(Arc::ptr_eq(&first, &same));
        assert!(!Arc::ptr_eq(&first, &other));
    }

    #[tokio::test]
    async fn failed_close_clears_the_acknowledged_fallback() {
        use matrix_sdk::test_utils::mocks::MatrixMockServer;
        let server = MatrixMockServer::new().await;
        let client = server.client_builder().build().await;
        let key = "@failed:example.org\0TESTDEVICE\0!failed:example.org\0$failed";
        let acknowledged = PendingPollEnd {
            transaction_id: "close-transaction".into(),
            failed: false,
        };
        reconcile_acknowledged_poll_end(&client, key, &acknowledged)
            .await
            .unwrap();
        assert_eq!(
            acknowledged_poll_end(&client, key)
                .await
                .unwrap()
                .as_deref(),
            Some("close-transaction"),
        );

        reconcile_acknowledged_poll_end(
            &client,
            key,
            &PendingPollEnd {
                transaction_id: "close-transaction".into(),
                failed: true,
            },
        )
        .await
        .unwrap();
        assert!(acknowledged_poll_end(&client, key).await.unwrap().is_none());
    }

    #[tokio::test]
    async fn offline_close_is_deduplicated_and_blocks_later_votes() {
        use matrix_sdk::ruma::{event_id, room_id};
        use matrix_sdk::test_utils::mocks::MatrixMockServer;
        let server = MatrixMockServer::new().await;
        let client = server.client_builder().build().await;
        server.mock_room_state_encryption().plain().mount().await;
        let room_id = room_id!("!poll:example.org");
        let poll_id = event_id!("$poll:example.org");
        let room = server.sync_joined_room(&client, room_id).await;
        room.send_queue().set_enabled(false);
        let (first, second) = tokio::join!(
            end_poll_impl(&client, room_id.as_str(), poll_id.as_str()),
            end_poll_impl(&client, room_id.as_str(), poll_id.as_str()),
        );
        assert_eq!(first.unwrap(), second.unwrap());
        assert!(
            vote_on_poll_impl(&client, room_id.as_str(), poll_id.as_str(), "0".into())
                .await
                .is_err()
        );
        let (echoes, _) = room.send_queue().subscribe().await.unwrap();
        assert_eq!(echoes.len(), 1);
    }

    #[tokio::test]
    async fn offline_vote_blocks_duplicate_votes_and_close_until_reconciled() {
        use matrix_sdk::ruma::{event_id, room_id};
        use matrix_sdk::test_utils::mocks::MatrixMockServer;
        let server = MatrixMockServer::new().await;
        let client = server.client_builder().build().await;
        server.mock_room_state_encryption().plain().mount().await;
        let room_id = room_id!("!vote:example.org");
        let poll_id = event_id!("$vote:example.org");
        let room = server.sync_joined_room(&client, room_id).await;
        room.send_queue().set_enabled(false);

        vote_on_poll_impl(&client, room_id.as_str(), poll_id.as_str(), "0".into())
            .await
            .unwrap();
        assert!(
            vote_on_poll_impl(&client, room_id.as_str(), poll_id.as_str(), "1".into())
                .await
                .is_err()
        );
        assert!(
            end_poll_impl(&client, room_id.as_str(), poll_id.as_str())
                .await
                .is_err()
        );
        let pending = pending_poll_vote_impl(&client, room_id.as_str(), poll_id.as_str())
            .await
            .unwrap()
            .unwrap();
        assert_eq!(pending.answer_id, "0");
        let (echoes, _) = room.send_queue().subscribe().await.unwrap();
        assert_eq!(echoes.len(), 1);
    }

    #[tokio::test]
    async fn acknowledged_close_is_shared_until_timeline_confirmation() {
        use matrix_sdk::ruma::{event_id, room_id};
        use matrix_sdk::test_utils::mocks::MatrixMockServer;
        let server = MatrixMockServer::new().await;
        let client = server.client_builder().build().await;
        server.mock_room_state_encryption().plain().mount().await;
        let room_id = room_id!("!shared-poll:example.org");
        let poll_id = event_id!("$shared-poll:example.org");
        server.sync_joined_room(&client, room_id).await;
        let close_key = poll_end_key(&client, room_id, poll_id).unwrap();
        set_acknowledged_poll_end(&client, &close_key, "shared-transaction")
            .await
            .unwrap();

        let pending = pending_poll_end_impl(&client, room_id.as_str(), poll_id.as_str())
            .await
            .unwrap()
            .unwrap();
        assert_eq!(pending.transaction_id, "shared-transaction");
        confirm_poll_end_synced_impl(&client, room_id.as_str(), poll_id.as_str())
            .await
            .unwrap();
        assert!(
            pending_poll_end_impl(&client, room_id.as_str(), poll_id.as_str())
                .await
                .unwrap()
                .is_none()
        );
    }

    #[tokio::test]
    async fn acknowledged_close_is_stored_in_the_matrix_state_store() {
        use matrix_sdk::ruma::{event_id, room_id};
        use matrix_sdk::test_utils::mocks::MatrixMockServer;
        let server = MatrixMockServer::new().await;
        let client = server.client_builder().build().await;
        server.mock_room_state_encryption().plain().mount().await;
        let room_id = room_id!("!logout-poll:example.org");
        let poll_id = event_id!("$logout-poll:example.org");
        server.sync_joined_room(&client, room_id).await;
        let key = poll_end_key(&client, room_id, poll_id).unwrap();
        set_acknowledged_poll_end(&client, &key, "persisted-transaction")
            .await
            .unwrap();

        let raw = client
            .state_store()
            .get_custom_value(&poll_end_ack_store_key(&key))
            .await
            .unwrap();
        assert_eq!(raw.as_deref(), Some("persisted-transaction".as_bytes()),);
    }

    #[test]
    fn validates_and_builds_single_select_poll() {
        let content = poll_start_content(
            " Lunch? ".to_string(),
            vec![" Pizza ".to_string(), "Tacos".to_string()],
            true,
        )
        .expect("valid poll");

        let AnyMessageLikeEventContent::UnstablePollStart(content) = content else {
            panic!("expected poll start");
        };
        let poll = content.poll_start();
        assert_eq!(poll.question.text, "Lunch?");
        assert!(matches!(poll.kind, PollKind::Disclosed));
        assert_eq!(poll.answers[0].id, "0");
        assert_eq!(poll.answers[0].text, "Pizza");
        assert_eq!(u64::from(poll.max_selections), 1);
    }

    #[test]
    fn rejects_duplicate_or_too_few_options() {
        assert!(poll_start_content("Q".into(), vec!["A".into()], false).is_err());
        assert!(poll_start_content("Q".into(), vec!["A".into(), " A ".into()], false).is_err());
        assert!(
            poll_start_content("Q".into(), vec!["Pizza".into(), "pizza".into()], false).is_err()
        );
    }

    #[test]
    fn enforces_ui_text_bounds_for_direct_command_callers() {
        let options = vec!["A".to_string(), "B".to_string()];
        assert!(super::normalize_poll("x".repeat(501), options.clone()).is_err());
        assert!(super::normalize_poll("😀".repeat(251), options.clone()).is_err());
        assert!(super::normalize_poll("😀".repeat(250), options).is_ok());
        assert!(super::normalize_poll("Q".into(), vec!["x".repeat(201), "B".into()]).is_err());
    }
}
