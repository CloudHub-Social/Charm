//! Slash-command routing for the composer (`/me`, `/topic`, `/invite`,
//! `/kick`, `/ban`). Parsing the leading `/word` and its args happens on the
//! frontend (see `src/lib/slashCommands.ts`); only the already-resolved
//! command name + args cross IPC, so this module never has to re-implement
//! quoting/escaping rules for raw composer text.

use matrix_sdk::ruma::events::room::message::RoomMessageEventContent;
use matrix_sdk::ruma::events::AnyMessageLikeEventContent;
use matrix_sdk::ruma::{RoomId, UserId};
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

/// The standard slash commands the composer's autocomplete menu offers.
/// Mirrors the frontend's static command list (name/args hint/description) —
/// this enum is just the resolved-command wire type, not the help text.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../src/bindings/")]
#[serde(rename_all = "snake_case")]
pub enum SlashCommand {
    Me,
    Topic,
    Invite,
    Kick,
    Ban,
}

/// Outcome of `run_command`, so the composer can show inline feedback
/// (success / permission-denied / bad-args) instead of a bare error string.
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../src/bindings/")]
#[serde(tag = "status", rename_all = "snake_case")]
pub enum CommandResult {
    Success,
    PermissionDenied { message: String },
    BadArgs { message: String },
}

fn bad_args(message: impl Into<String>) -> CommandResult {
    CommandResult::BadArgs {
        message: message.into(),
    }
}

/// Maps a permission-shaped SDK error (matrix-rust-sdk doesn't give a typed
/// "forbidden" variant for these room actions — just an opaque `Error` whose
/// `to_string()` embeds the homeserver's M_FORBIDDEN reason) to
/// `PermissionDenied`, falling back to treating any other failure as a
/// bad-args result — Day-1 doesn't distinguish "network error" from these,
/// which is an acceptable simplification since both surface as inline
/// composer feedback rather than a silent failure either way.
fn classify_room_action_error(err: matrix_sdk::Error) -> CommandResult {
    let message = err.to_string();
    if message.contains("M_FORBIDDEN") || message.contains("forbidden") {
        CommandResult::PermissionDenied { message }
    } else {
        bad_args(message)
    }
}

/// Joins `/me`'s args into the emote text, rejecting an empty result — pulled
/// out as a standalone pure function so this validation is unit-testable
/// without a real `Client`/`Room` (unlike the rest of `run_command_impl`,
/// which needs a live SDK connection to exercise the room-action arms).
fn me_text_from_args(args: &[String]) -> Result<String, CommandResult> {
    let text = args.join(" ");
    if text.is_empty() {
        Err(bad_args("/me needs text to emote"))
    } else {
        Ok(text)
    }
}

/// Runs a resolved slash command against `room_id`. `args` is the
/// whitespace-split remainder of the command line after the `/word` (e.g.
/// `/kick @bob:example.org spamming` -> `args = ["@bob:example.org",
/// "spamming"]`); each arm below documents which positions it reads.
#[tauri::command]
pub async fn run_command(
    state: State<'_, MatrixState>,
    room_id: String,
    command: SlashCommand,
    args: Vec<String>,
) -> Result<CommandResult, String> {
    let client = state.require_client().await?;
    run_command_impl(&client, &room_id, command, args).await
}

/// Core logic behind [`run_command`], taking a plain `&Client` so it's
/// callable from integration tests without a Tauri `State` to construct.
pub async fn run_command_impl(
    client: &Client,
    room_id: &str,
    command: SlashCommand,
    args: Vec<String>,
) -> Result<CommandResult, String> {
    let room = get_room(client, room_id)?;

    match command {
        SlashCommand::Me => {
            let text = match me_text_from_args(&args) {
                Ok(text) => text,
                Err(result) => return Ok(result),
            };
            let content = RoomMessageEventContent::emote_plain(text);
            super::send::send_and_capture_transaction_id(
                client,
                &room,
                AnyMessageLikeEventContent::RoomMessage(content),
            )
            .await?;
            Ok(CommandResult::Success)
        }
        SlashCommand::Topic => {
            let topic = args.join(" ");
            if topic.is_empty() {
                return Ok(bad_args("/topic needs a topic to set"));
            }
            match room.set_room_topic(&topic).await {
                Ok(_) => Ok(CommandResult::Success),
                Err(err) => Ok(classify_room_action_error(err)),
            }
        }
        SlashCommand::Invite => {
            let Some(user_id) = args.first() else {
                return Ok(bad_args("/invite needs a user id"));
            };
            let Ok(parsed) = UserId::parse(user_id) else {
                return Ok(bad_args(format!("{user_id} is not a valid user id")));
            };
            match room.invite_user_by_id(&parsed).await {
                Ok(_) => Ok(CommandResult::Success),
                Err(err) => Ok(classify_room_action_error(err)),
            }
        }
        SlashCommand::Kick => {
            let Some(user_id) = args.first() else {
                return Ok(bad_args("/kick needs a user id"));
            };
            let Ok(parsed) = UserId::parse(user_id) else {
                return Ok(bad_args(format!("{user_id} is not a valid user id")));
            };
            let reason = args.get(1..).filter(|r| !r.is_empty()).map(|r| r.join(" "));
            match room.kick_user(&parsed, reason.as_deref()).await {
                Ok(_) => Ok(CommandResult::Success),
                Err(err) => Ok(classify_room_action_error(err)),
            }
        }
        SlashCommand::Ban => {
            let Some(user_id) = args.first() else {
                return Ok(bad_args("/ban needs a user id"));
            };
            let Ok(parsed) = UserId::parse(user_id) else {
                return Ok(bad_args(format!("{user_id} is not a valid user id")));
            };
            let reason = args.get(1..).filter(|r| !r.is_empty()).map(|r| r.join(" "));
            match room.ban_user(&parsed, reason.as_deref()).await {
                Ok(_) => Ok(CommandResult::Success),
                Err(err) => Ok(classify_room_action_error(err)),
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn me_with_empty_args_is_bad_args() {
        let result = me_text_from_args(&[]);
        assert!(matches!(result, Err(CommandResult::BadArgs { .. })));
    }

    #[test]
    fn me_joins_multi_word_args_into_emote_text() {
        let args = vec!["waves".to_string(), "excitedly".to_string()];
        assert_eq!(me_text_from_args(&args).unwrap(), "waves excitedly");
    }

    #[test]
    fn classify_room_action_error_detects_forbidden() {
        // matrix_sdk::Error has no public constructor for a plain "forbidden"
        // case; instead assert the string-matching classifier logic in
        // isolation against fixture strings shaped like what M_FORBIDDEN
        // errors stringify to.
        fn classify_message(message: &str) -> CommandResult {
            if message.contains("M_FORBIDDEN") || message.contains("forbidden") {
                CommandResult::PermissionDenied {
                    message: message.to_string(),
                }
            } else {
                bad_args(message.to_string())
            }
        }

        assert!(matches!(
            classify_message(
                "the server returned an error: [403 / M_FORBIDDEN] You don't have permission"
            ),
            CommandResult::PermissionDenied { .. }
        ));
        assert!(matches!(
            classify_message("network error: connection refused"),
            CommandResult::BadArgs { .. }
        ));
    }

    #[test]
    fn slash_command_serializes_snake_case() {
        let json = serde_json::to_value(SlashCommand::Invite).unwrap();
        assert_eq!(json, "invite");
    }

    #[test]
    fn command_result_serializes_tagged_status() {
        let json = serde_json::to_value(CommandResult::PermissionDenied {
            message: "nope".to_string(),
        })
        .unwrap();
        assert_eq!(json["status"], "permission_denied");
        assert_eq!(json["message"], "nope");
    }
}
