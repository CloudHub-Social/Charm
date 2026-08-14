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
use matrix_sdk::Client;
use tauri::State;

use super::send::send_and_capture_transaction_id;
use super::MatrixState;

const MIN_OPTIONS: usize = 2;
const MAX_OPTIONS: usize = 20;

fn normalize_poll(question: String, options: Vec<String>) -> Result<(String, Vec<String>), String> {
    let question = question.trim().to_string();
    if question.is_empty() {
        return Err("Poll question cannot be empty".to_string());
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
    let unique: std::collections::HashSet<&str> = options.iter().map(String::as_str).collect();
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
    if answer_id.is_empty() {
        return Err("Poll answer id cannot be empty".to_string());
    }
    let room = room_for(client, room_id)?;
    let poll_event_id = EventId::parse(poll_event_id).map_err(|error| error.to_string())?;
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

#[cfg(test)]
mod tests {
    use super::*;

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
    }
}
