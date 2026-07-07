use futures_util::StreamExt;
use matrix_sdk::encryption::verification::{Emoji, SasState, Verification};
use matrix_sdk::ruma::events::key::verification::request::ToDeviceKeyVerificationRequestEvent;
use matrix_sdk::Client;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, State};
use ts_rs::TS;

use super::account::{retry_uia_with_session, UiaCommandError};
use super::MatrixState;

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../src/bindings/")]
pub struct VerificationRequestSummary {
    pub flow_id: String,
    pub other_user_id: String,
    pub other_device_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../src/bindings/")]
pub struct EmojiPair {
    pub symbol: String,
    pub description: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../src/bindings/")]
#[serde(tag = "state", rename_all = "snake_case")]
pub enum SasUpdateEvent {
    Started,
    Accepted,
    /// The short auth string is ready to show the user for comparison.
    KeysExchanged {
        emojis: Vec<EmojiPair>,
    },
    Confirmed,
    Done,
    Cancelled {
        reason: String,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../src/bindings/")]
pub struct CrossSigningStatusSummary {
    pub has_master_key: bool,
    pub has_self_signing_key: bool,
    pub has_user_signing_key: bool,
}

/// Registers the handler that turns incoming `m.key.verification.request`
/// to-device events into a `verification:request` push to the frontend.
/// Called once, right after the client is built (login or session restore).
pub fn register_verification_handler(app: AppHandle, client: &Client) {
    client.add_event_handler(
        move |ev: ToDeviceKeyVerificationRequestEvent, client: Client| {
            let app = app.clone();
            async move {
                let Some(request) = client
                    .encryption()
                    .get_verification_request(&ev.sender, ev.content.transaction_id.as_str())
                    .await
                else {
                    return;
                };

                let _ = app.emit(
                    "verification:request",
                    VerificationRequestSummary {
                        flow_id: request.flow_id().to_string(),
                        other_user_id: request.other_user_id().to_string(),
                        other_device_id: ev.content.from_device.to_string(),
                    },
                );
            }
        },
    );
}

/// Bootstraps cross-signing for the current account if it isn't already set
/// up. Most homeservers require a fresh UIA session for this — pass the
/// account password if a first attempt without it fails; the frontend should
/// treat any error here as "prompt for password and retry". Goes through
/// `retry_uia_with_session` (same as `account::change_password`/
/// `deactivate_account`) rather than building `AuthData::Password` directly:
/// a `session: None` retry is treated as a brand-new UIA attempt on
/// homeservers that enforce session continuity across stages, so without
/// threading the real session id through, entering the correct password can
/// still fail to satisfy the challenge.
#[tauri::command]
pub async fn bootstrap_cross_signing(
    state: State<'_, MatrixState>,
    password: Option<String>,
) -> Result<(), UiaCommandError> {
    let client = state.require_client().await?;
    bootstrap_cross_signing_impl(&client, password).await
}

/// Core logic behind [`bootstrap_cross_signing`].
pub async fn bootstrap_cross_signing_impl(
    client: &Client,
    password: Option<String>,
) -> Result<(), UiaCommandError> {
    let user_id = client
        .user_id()
        .ok_or_else(|| "not logged in".to_string())?
        .to_owned();
    let encryption = client.encryption();

    retry_uia_with_session(&user_id, password, |auth| {
        encryption.bootstrap_cross_signing_if_needed(auth)
    })
    .await
}

#[tauri::command]
pub async fn cross_signing_status(
    state: State<'_, MatrixState>,
) -> Result<CrossSigningStatusSummary, String> {
    let client = state.require_client().await?;
    cross_signing_status_impl(&client).await
}

/// Core logic behind [`cross_signing_status`].
pub async fn cross_signing_status_impl(
    client: &Client,
) -> Result<CrossSigningStatusSummary, String> {
    let status = client.encryption().cross_signing_status().await;

    Ok(CrossSigningStatusSummary {
        has_master_key: status.as_ref().is_some_and(|s| s.has_master),
        has_self_signing_key: status.as_ref().is_some_and(|s| s.has_self_signing),
        has_user_signing_key: status.as_ref().is_some_and(|s| s.has_user_signing),
    })
}

#[tauri::command]
pub async fn accept_verification_request(
    state: State<'_, MatrixState>,
    other_user_id: String,
    flow_id: String,
) -> Result<(), String> {
    let client = state.require_client().await?;
    accept_verification_request_impl(&client, &other_user_id, &flow_id).await
}

/// Core logic behind [`accept_verification_request`].
pub async fn accept_verification_request_impl(
    client: &Client,
    other_user_id: &str,
    flow_id: &str,
) -> Result<(), String> {
    let request = get_request(client, other_user_id, flow_id).await?;
    request.accept().await.map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn cancel_verification(
    state: State<'_, MatrixState>,
    other_user_id: String,
    flow_id: String,
) -> Result<(), String> {
    let client = state.require_client().await?;
    cancel_verification_impl(&client, &other_user_id, &flow_id).await
}

/// Core logic behind [`cancel_verification`].
pub async fn cancel_verification_impl(
    client: &Client,
    other_user_id: &str,
    flow_id: &str,
) -> Result<(), String> {
    let request = get_request(client, other_user_id, flow_id).await?;
    request.cancel().await.map_err(|e| e.to_string())
}

/// Starts the SAS (emoji) flow on an already-accepted request and spawns a
/// watcher that pushes `verification:sas_update` events for every state
/// change, including the emoji list once keys are exchanged, until the flow
/// is done or cancelled.
#[tauri::command]
pub async fn start_sas_verification(
    app: AppHandle,
    state: State<'_, MatrixState>,
    other_user_id: String,
    flow_id: String,
) -> Result<(), String> {
    let client = state.require_client().await?;
    let sas = start_sas_verification_impl(&client, &other_user_id, &flow_id).await?;

    let flow_id = flow_id.clone();
    tokio::spawn(async move {
        let mut changes = sas.changes();
        while let Some(sas_state) = changes.next().await {
            let event = match sas_state {
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
                event,
                SasUpdateEvent::Done | SasUpdateEvent::Cancelled { .. }
            );
            let _ = app.emit(&format!("verification:sas_update:{flow_id}"), event);
            if is_terminal {
                break;
            }
        }
    });

    Ok(())
}

/// Core logic behind [`start_sas_verification`]: accepts an already-accepted
/// request into the SAS flow and returns the resulting `SasVerification` so
/// the caller can drive/watch it. The state-change watcher loop itself stays
/// in the command wrapper above since pushing each state as an event is
/// transport-specific (`app.emit` today; a WebSocket push in the companion
/// server later).
pub async fn start_sas_verification_impl(
    client: &Client,
    other_user_id: &str,
    flow_id: &str,
) -> Result<matrix_sdk::encryption::verification::SasVerification, String> {
    let request = get_request(client, other_user_id, flow_id).await?;

    request
        .start_sas()
        .await
        .map_err(|e| e.to_string())?
        .ok_or_else(|| "the other side does not support SAS verification".to_string())
}

#[tauri::command]
pub async fn confirm_sas_verification(
    state: State<'_, MatrixState>,
    other_user_id: String,
    flow_id: String,
) -> Result<(), String> {
    let client = state.require_client().await?;
    confirm_sas_verification_impl(&client, &other_user_id, &flow_id).await
}

/// Core logic behind [`confirm_sas_verification`].
pub async fn confirm_sas_verification_impl(
    client: &Client,
    other_user_id: &str,
    flow_id: &str,
) -> Result<(), String> {
    let sas = get_sas(client, other_user_id, flow_id).await?;
    sas.confirm().await.map_err(|e| e.to_string())
}

async fn get_request(
    client: &Client,
    other_user_id: &str,
    flow_id: &str,
) -> Result<matrix_sdk::encryption::verification::VerificationRequest, String> {
    let user_id = matrix_sdk::ruma::UserId::parse(other_user_id).map_err(|e| e.to_string())?;
    client
        .encryption()
        .get_verification_request(&user_id, flow_id)
        .await
        .ok_or_else(|| "verification request not found".to_string())
}

async fn get_sas(
    client: &Client,
    other_user_id: &str,
    flow_id: &str,
) -> Result<matrix_sdk::encryption::verification::SasVerification, String> {
    let user_id = matrix_sdk::ruma::UserId::parse(other_user_id).map_err(|e| e.to_string())?;
    let verification = client
        .encryption()
        .get_verification(&user_id, flow_id)
        .await
        .ok_or_else(|| "verification not found".to_string())?;
    match verification {
        Verification::SasV1(sas) => Ok(sas),
        #[allow(unreachable_patterns)]
        _ => Err("verification is not a SAS flow".to_string()),
    }
}

fn to_emoji_pair(emoji: Emoji) -> EmojiPair {
    EmojiPair {
        symbol: emoji.symbol.to_string(),
        description: emoji.description.to_string(),
    }
}
