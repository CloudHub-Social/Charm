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
use std::sync::LazyLock;
use tauri::{Manager, State};

use super::send::send_and_capture_transaction_id;
use super::MatrixState;

const MIN_OPTIONS: usize = 2;
const MAX_OPTIONS: usize = 20;
static POLL_MUTATION_LOCK: LazyLock<tokio::sync::Mutex<()>> =
    LazyLock::new(|| tokio::sync::Mutex::new(()));

#[derive(Clone, Debug, Serialize)]
pub struct PendingPollEnd {
    transaction_id: String,
    failed: bool,
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

pub async fn pending_poll_end_impl(
    client: &Client,
    room_id: &str,
    poll_event_id: &str,
) -> Result<Option<PendingPollEnd>, String> {
    let room = room_for(client, room_id)?;
    let poll_event_id = EventId::parse(poll_event_id).map_err(|error| error.to_string())?;
    pending_poll_end(&room, &poll_event_id).await
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
    let _guard = POLL_MUTATION_LOCK.lock().await;
    if answer_id.is_empty() || answer_id.len() > 4096 {
        return Err("Poll answer id is empty or too long".to_string());
    }
    let room = room_for(client, room_id)?;
    let poll_event_id = EventId::parse(poll_event_id).map_err(|error| error.to_string())?;
    if pending_poll_end(&room, &poll_event_id).await?.is_some() {
        return Err("This poll has a queued close. Wait for it to settle before voting.".into());
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
    let _guard = POLL_MUTATION_LOCK.lock().await;
    let room = room_for(client, room_id)?;
    let poll_event_id = EventId::parse(poll_event_id).map_err(|error| error.to_string())?;
    if let Some(pending) = pending_poll_end(&room, &poll_event_id).await? {
        return Ok(pending.transaction_id);
    }
    let content = UnstablePollEndEventContent::new("Poll ended", poll_event_id);
    send_and_capture_transaction_id(
        client,
        &room,
        AnyMessageLikeEventContent::UnstablePollEnd(content),
    )
    .await
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
pub async fn get_pending_poll_end(
    state: State<'_, MatrixState>,
    room_id: String,
    poll_event_id: String,
) -> Result<Option<PendingPollEnd>, String> {
    let client = state.require_client().await?;
    pending_poll_end_impl(&client, &room_id, &poll_event_id).await
}

#[cfg(test)]
mod tests {
    use super::*;

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
