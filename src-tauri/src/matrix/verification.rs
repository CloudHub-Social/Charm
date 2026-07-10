use futures_util::StreamExt;
use matrix_sdk::encryption::recovery::RecoveryState;
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

pub struct StartedSasVerification {
    pub sas: matrix_sdk::encryption::verification::SasVerification,
    pub accept_after_subscribe: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../src/bindings/")]
pub struct CrossSigningStatusSummary {
    pub has_identity: bool,
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
/// account password if a first attempt without it fails. The error is a
/// structured `UiaCommandError`: `UiaChallenge` means the frontend should
/// prompt for a password and retry; `Other` is a real, unrelated failure
/// that should be surfaced as-is (see `account::UiaCommandError`). Goes
/// through `retry_uia_with_session` (same as `account::change_password`/
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
    .await?;

    if let Some(device) = encryption
        .get_own_device()
        .await
        .map_err(|error| UiaCommandError::Other {
            message: error.to_string(),
        })?
        .filter(|device| !device.is_verified_with_cross_signing())
    {
        device
            .verify()
            .await
            .map_err(|error| UiaCommandError::Other {
                message: error.to_string(),
            })?;
    }

    Ok(())
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
    let user_id = client
        .user_id()
        .ok_or_else(|| "not logged in".to_string())?
        .to_owned();
    let has_identity = match client.encryption().request_user_identity(&user_id).await {
        Ok(Some(_)) => true,
        Ok(None) => false,
        Err(error) => {
            tracing::warn!(
                error = %error,
                "failed to refresh cross-signing identity; falling back to cached status"
            );
            false
        }
    };

    let status = client.encryption().cross_signing_status().await;
    let has_local_keys = status
        .as_ref()
        .is_some_and(|s| s.has_master && s.has_self_signing && s.has_user_signing);

    Ok(CrossSigningStatusSummary {
        has_identity: has_identity || has_local_keys,
        has_master_key: status.as_ref().is_some_and(|s| s.has_master),
        has_self_signing_key: status.as_ref().is_some_and(|s| s.has_self_signing),
        has_user_signing_key: status.as_ref().is_some_and(|s| s.has_user_signing),
    })
}

/// A device's key-backup/secret-storage ("4S") recovery state, exposed to
/// the frontend so it knows whether to prompt for a recovery key.
/// `incomplete` is the state this feature exists for: secrets/backup exist
/// on the server (some other session set them up), but this device — e.g. a
/// `charm-web-server` session that just lost its in-memory crypto store to a
/// restart, see `crates/charm-web-server/src/persistence.rs`'s module doc
/// comment — doesn't have them locally, so previously-decrypted room
/// history is unreadable until the user enters their recovery key.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../src/bindings/")]
#[serde(rename_all = "snake_case")]
pub enum RecoveryStatusSummary {
    Unknown,
    Enabled,
    Disabled,
    Incomplete,
}

impl From<RecoveryState> for RecoveryStatusSummary {
    fn from(state: RecoveryState) -> Self {
        match state {
            RecoveryState::Unknown => Self::Unknown,
            RecoveryState::Enabled => Self::Enabled,
            RecoveryState::Disabled => Self::Disabled,
            RecoveryState::Incomplete => Self::Incomplete,
        }
    }
}

#[tauri::command]
pub async fn recovery_status(
    state: State<'_, MatrixState>,
) -> Result<RecoveryStatusSummary, String> {
    let client = state.require_client().await?;
    Ok(recovery_status_impl(&client))
}

/// Core logic behind [`recovery_status`].
pub fn recovery_status_impl(client: &Client) -> RecoveryStatusSummary {
    client.encryption().recovery().state().into()
}

/// Restores this device's secrets (cross-signing keys, and the key-backup
/// decryption key) from server-side secret storage using the account's
/// recovery key. On success, matrix-sdk-crypto's backup machinery can start
/// downloading and decrypting room keys from the server-side backup as
/// needed — no separate "download history" step. No UIA/password challenge
/// involved (unlike [`bootstrap_cross_signing`]): the recovery key itself is
/// the proof of possession, so a wrong key just surfaces as an ordinary
/// error rather than a retryable challenge.
#[tauri::command]
pub async fn recover_from_key(
    state: State<'_, MatrixState>,
    recovery_key: String,
) -> Result<(), String> {
    let client = state.require_client().await?;
    recover_from_key_impl(&client, &recovery_key).await
}

/// Core logic behind [`recover_from_key`].
pub async fn recover_from_key_impl(client: &Client, recovery_key: &str) -> Result<(), String> {
    client
        .encryption()
        .recovery()
        .recover(recovery_key)
        .await
        .map_err(|error| error.to_string())
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
    let StartedSasVerification {
        sas,
        accept_after_subscribe,
    } = start_sas_verification_impl(&client, &other_user_id, &flow_id).await?;

    let watcher_sas = sas.clone();
    let mut changes = watcher_sas.changes();
    if accept_after_subscribe {
        sas.accept().await.map_err(|e| e.to_string())?;
    }

    let flow_id = flow_id.clone();
    tokio::spawn(async move {
        if emit_sas_update(&app, &flow_id, watcher_sas.state()) {
            return;
        }

        while let Some(sas_state) = changes.next().await {
            if emit_sas_update(&app, &flow_id, sas_state) {
                break;
            }
        }
    });

    Ok(())
}

/// Core logic behind [`start_sas_verification`]: starts or finds the SAS flow
/// and tells the command whether it must accept after subscribing to changes.
/// The state-change watcher loop itself stays in the command wrapper above
/// since pushing each state as an event is transport-specific (`app.emit`
/// today; a WebSocket push in the companion server later).
pub async fn start_sas_verification_impl(
    client: &Client,
    other_user_id: &str,
    flow_id: &str,
) -> Result<StartedSasVerification, String> {
    let user_id = matrix_sdk::ruma::UserId::parse(other_user_id).map_err(|e| e.to_string())?;
    if let Some(Verification::SasV1(sas)) = client
        .encryption()
        .get_verification(&user_id, flow_id)
        .await
    {
        return Ok(StartedSasVerification {
            sas,
            accept_after_subscribe: true,
        });
    }

    let request = get_request(client, other_user_id, flow_id).await?;

    let sas = request
        .start_sas()
        .await
        .map_err(|e| e.to_string())?
        .ok_or_else(|| "the other side does not support SAS verification".to_string())?;

    Ok(StartedSasVerification {
        sas,
        accept_after_subscribe: false,
    })
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

fn emit_sas_update(app: &AppHandle, flow_id: &str, sas_state: SasState) -> bool {
    let Some(event) = sas_state_to_update(sas_state) else {
        return false;
    };
    let is_terminal = matches!(
        event,
        SasUpdateEvent::Done | SasUpdateEvent::Cancelled { .. }
    );
    let _ = app.emit(&format!("verification:sas_update:{flow_id}"), event);
    is_terminal
}

pub fn sas_state_to_update(sas_state: SasState) -> Option<SasUpdateEvent> {
    match sas_state {
        SasState::Started { .. } => Some(SasUpdateEvent::Started),
        SasState::Accepted { .. } => Some(SasUpdateEvent::Accepted),
        SasState::KeysExchanged { emojis, .. } => Some(SasUpdateEvent::KeysExchanged {
            emojis: emojis
                .map(|e| e.emojis.into_iter().map(to_emoji_pair).collect())
                .unwrap_or_default(),
        }),
        SasState::Confirmed => Some(SasUpdateEvent::Confirmed),
        SasState::Done { .. } => Some(SasUpdateEvent::Done),
        SasState::Cancelled(info) => Some(SasUpdateEvent::Cancelled {
            reason: info.reason().to_string(),
        }),
        SasState::Created { .. } => None,
    }
}
