//! Device/session management: list this account's devices with trust
//! status, revoke (sign out) another session, and start an outgoing
//! verification of another of this account's own devices.

use futures_util::StreamExt;
use matrix_sdk::encryption::verification::VerificationRequestState;
use matrix_sdk::ruma::api::client::discovery::get_authorization_server_metadata::v1::AccountManagementActionData;
use matrix_sdk::ruma::api::client::uiaa::{
    AuthData, MatrixUserIdentifier, Password, UserIdentifier,
};
use matrix_sdk::ruma::{DeviceId, OwnedDeviceId};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, State};
use ts_rs::TS;

use super::verification::VerificationRequestSummary;
use super::MatrixState;

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../src/bindings/")]
pub struct DeviceSummary {
    pub device_id: String,
    pub display_name: Option<String>,
    pub last_seen_ip: Option<String>,
    /// Milliseconds since the Unix epoch — some homeservers don't populate
    /// this (see Spec 08's "Risks & open questions"), so the UI must tolerate
    /// `None`.
    #[ts(type = "number | null")]
    pub last_seen_ts: Option<u64>,
    pub is_current: bool,
    /// Cross-signing *or* locally trusted — matrix-rust-sdk's
    /// `Device::is_verified()`, the same signal Element's client uses for a
    /// device's trust badge.
    pub is_verified: bool,
}

/// Lists every device/session registered to this account, cross-referencing
/// each against the crypto store's trust state and marking whichever one
/// this running session is.
#[tauri::command]
pub async fn list_devices(state: State<'_, MatrixState>) -> Result<Vec<DeviceSummary>, String> {
    let client = state.require_client().await?;
    let own_user_id = client
        .user_id()
        .ok_or_else(|| "not logged in".to_string())?
        .to_owned();
    let own_device_id = client
        .device_id()
        .ok_or_else(|| "not logged in".to_string())?
        .to_owned();

    let response = client.devices().await.map_err(|e| e.to_string())?;

    let mut summaries = Vec::with_capacity(response.devices.len());
    for device in response.devices {
        let is_verified = client
            .encryption()
            .get_device(&own_user_id, &device.device_id)
            .await
            .map_err(|e| e.to_string())?
            .is_some_and(|d| d.is_verified());

        summaries.push(DeviceSummary {
            is_current: device.device_id == own_device_id,
            device_id: device.device_id.to_string(),
            display_name: device.display_name,
            last_seen_ip: device.last_seen_ip,
            last_seen_ts: device.last_seen_ts.map(|ts| ts.0.into()),
            is_verified,
        });
    }

    Ok(summaries)
}

/// Revokes (signs out) another of this account's devices. UIA-gated: the
/// first call (no `password`) always fails with a UIA challenge, same retry
/// convention as `account::change_password`. Rejects the current device —
/// the frontend already excludes it from the "Sign out" action (use
/// `account::logout` instead), and revoking your own device out from under
/// `MatrixState.client` here would leave the running session server-revoked
/// but not locally torn down.
#[tauri::command]
pub async fn delete_device(
    state: State<'_, MatrixState>,
    device_id: String,
    password: Option<String>,
) -> Result<(), String> {
    let client = state.require_client().await?;
    let user_id = client
        .user_id()
        .ok_or_else(|| "not logged in".to_string())?
        .to_owned();
    let device_id: OwnedDeviceId = device_id.into();

    if is_current_device(&device_id, client.device_id()) {
        return Err("cannot revoke the current device this way — use logout instead".to_string());
    }

    let auth_data = password.map(|password| {
        AuthData::Password(Password::new(
            UserIdentifier::Matrix(MatrixUserIdentifier::new(user_id.to_string())),
            password,
        ))
    });

    client
        .delete_devices(&[device_id], auth_data)
        .await
        .map_err(|e| e.to_string())?;
    Ok(())
}

/// Pure: whether `device_id` is the session's own device. Factored out of
/// [`delete_device`] so the guard is unit-testable without a running app.
fn is_current_device(device_id: &DeviceId, current: Option<&DeviceId>) -> bool {
    current.is_some_and(|current| current == device_id)
}

/// Starts an outgoing SAS verification of another of this account's own
/// devices ("verify another session"). `VerificationOverlay` is written for
/// the incoming-request flow, where by the time it opens the request is
/// already `Ready` (the other side asked, and accepting is the next step) —
/// reusing it unmodified for this self-initiated flow (see Spec 08 non-goals)
/// means waiting here, in the background, for the *other* device to accept
/// before emitting `verification:request`, so the overlay always opens in the
/// same state regardless of which side started the flow.
///
/// Returns the new flow's id immediately (before the other device has
/// necessarily accepted) so the frontend can subscribe to
/// `verification:sas_update:<flow_id>` right away and know when the flow
/// finishes, without waiting on the `verification:request` event this also
/// emits (see below) to learn the id.
#[tauri::command]
pub async fn request_device_verification(
    app: AppHandle,
    state: State<'_, MatrixState>,
    device_id: String,
) -> Result<String, String> {
    let client = state.require_client().await?;
    let own_user_id = client
        .user_id()
        .ok_or_else(|| "not logged in".to_string())?
        .to_owned();
    let device_id: OwnedDeviceId = device_id.into();

    let device = client
        .encryption()
        .get_device(&own_user_id, &device_id)
        .await
        .map_err(|e| e.to_string())?
        .ok_or_else(|| format!("device {device_id} not found"))?;

    let request = device
        .request_verification()
        .await
        .map_err(|e| e.to_string())?;
    let flow_id = request.flow_id().to_string();

    tokio::spawn(async move {
        let mut changes = request.changes();
        while let Some(request_state) = changes.next().await {
            match request_state {
                VerificationRequestState::Ready { .. } => break,
                VerificationRequestState::Cancelled(_) => return,
                _ => continue,
            }
        }

        let _ = app.emit(
            "verification:request",
            VerificationRequestSummary {
                flow_id: request.flow_id().to_string(),
                other_user_id: own_user_id.to_string(),
                other_device_id: device_id.to_string(),
            },
        );
    });

    Ok(flow_id)
}

/// The OIDC account-management URL for resetting cross-signing, if the
/// homeserver advertises one — `None` for a plain password/SSO session (no
/// OIDC provider at all) or if the homeserver's auth metadata doesn't
/// advertise the action. The frontend only shows a "Reset" link when this is
/// `Some`; per Spec 08, the flow itself is never reimplemented in-app.
#[tauri::command]
pub async fn get_cross_signing_reset_url(
    state: State<'_, MatrixState>,
) -> Result<Option<String>, String> {
    let client = state.require_client().await?;
    if client.matrix_auth().logged_in() {
        return Ok(None);
    }

    let Ok(metadata) = client.oauth().server_metadata().await else {
        return Ok(None);
    };

    Ok(metadata
        .account_management_url_with_action(AccountManagementActionData::CrossSigningReset)
        .map(|url| url.to_string()))
}

#[cfg(test)]
mod tests {
    use matrix_sdk::ruma::owned_device_id;
    use matrix_sdk::test_utils::mocks::MatrixMockServer;
    use serde_json::json;
    use wiremock::matchers::{body_string_contains, method, path};
    use wiremock::{Mock, ResponseTemplate};

    use super::*;

    /// Same two-step UIA dance as `account::tests::mock_uia_dance` — kept
    /// local rather than shared across modules since each only needs it once.
    async fn mock_uia_dance(server: &MatrixMockServer, endpoint_path: &str) {
        Mock::given(method("POST"))
            .and(path(endpoint_path))
            .and(body_string_contains("\"auth\""))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({})))
            .with_priority(1)
            .mount(server.server())
            .await;

        Mock::given(method("POST"))
            .and(path(endpoint_path))
            .respond_with(ResponseTemplate::new(401).set_body_json(json!({
                "errcode": "M_FORBIDDEN",
                "flows": [{ "stages": ["m.login.password"] }],
                "params": {},
                "session": "test-uia-session"
            })))
            .mount(server.server())
            .await;
    }

    #[tokio::test]
    async fn delete_device_needs_a_password_on_first_attempt_then_succeeds() {
        let server = MatrixMockServer::new().await;
        let client = server.client_builder().build().await;
        mock_uia_dance(&server, "/_matrix/client/v3/delete_devices").await;

        let user_id = client.user_id().unwrap().to_owned();
        let target = owned_device_id!("OTHERDEVICE");
        let auth = |password: Option<&str>| {
            password.map(|password| {
                AuthData::Password(Password::new(
                    UserIdentifier::Matrix(MatrixUserIdentifier::new(user_id.to_string())),
                    password.to_string(),
                ))
            })
        };

        let first_attempt = client
            .delete_devices(std::slice::from_ref(&target), auth(None))
            .await;
        assert!(
            first_attempt
                .as_ref()
                .err()
                .is_some_and(|e| e.as_uiaa_response().is_some()),
            "expected a recognizable UIA challenge on the password-less attempt"
        );

        let retry = client
            .delete_devices(
                std::slice::from_ref(&target),
                auth(Some("current-password")),
            )
            .await;
        assert!(
            retry.is_ok(),
            "expected the retry with a password to succeed"
        );
    }

    #[test]
    fn is_current_device_matches_only_the_sessions_own_device() {
        let this_device = owned_device_id!("THISDEVICE");
        let other_device = owned_device_id!("OTHERDEVICE");

        assert!(is_current_device(&this_device, Some(&this_device)));
        assert!(!is_current_device(&other_device, Some(&this_device)));
        assert!(!is_current_device(&this_device, None));
    }
}
