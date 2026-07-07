//! Generic Matrix global account-data read/write.
//!
//! Introduced for Spec 12 (first-run onboarding), which needs a small
//! account-wide flag (`social.cloudhub.charm.onboarding`) that syncs across
//! devices — but the two commands here aren't special-cased to that one
//! event type, so a future feature needing the same "small JSON blob, keyed
//! by event type, synced via account data" shape can reuse them instead of
//! hand-rolling another `Raw<...>` plumbing path.

use matrix_sdk::ruma::events::{AnyGlobalAccountDataEventContent, GlobalAccountDataEventType};
use matrix_sdk::ruma::serde::Raw;
use matrix_sdk::Client;
use serde_json::Value;
use tauri::{AppHandle, State};

use super::persistence;
use super::MatrixState;

/// Reads a global account-data event straight from the server (not the
/// local sync store): onboarding's gate check needs to see a flag set from
/// *another* device even before this device's own `/sync` has caught up
/// (see Spec 12 acceptance criterion 4), which a store-backed read can't
/// guarantee.
#[tauri::command]
pub async fn get_account_data(
    state: State<'_, MatrixState>,
    event_type: String,
) -> Result<Option<Value>, String> {
    let client = state.require_client().await?;
    get_account_data_impl(&client, event_type).await
}

pub async fn get_account_data_impl(
    client: &Client,
    event_type: String,
) -> Result<Option<Value>, String> {
    let raw = client
        .account()
        .fetch_account_data(GlobalAccountDataEventType::from(event_type))
        .await
        .map_err(|e| e.to_string())?;

    raw.map(|raw| {
        raw.deserialize_as_unchecked::<Value>()
            .map_err(|e| e.to_string())
    })
    .transpose()
}

#[tauri::command]
pub async fn set_account_data(
    state: State<'_, MatrixState>,
    event_type: String,
    content: Value,
) -> Result<(), String> {
    let client = state.require_client().await?;
    set_account_data_impl(&client, event_type, content).await
}

pub async fn set_account_data_impl(
    client: &Client,
    event_type: String,
    content: Value,
) -> Result<(), String> {
    let raw: Raw<AnyGlobalAccountDataEventContent> = Raw::new(&content)
        .map_err(|e| e.to_string())?
        .cast_unchecked();

    client
        .account()
        .set_account_data_raw(GlobalAccountDataEventType::from(event_type), raw)
        .await
        .map_err(|e| e.to_string())?;

    Ok(())
}

/// The local (non-account-data) half of Spec 12's onboarding-flag
/// precedence: a fast, offline-available check for "have we already decided
/// this account is done with onboarding", so `useOnboardingGate` doesn't
/// have to wait on a network round trip (or flash the onboarding screen for
/// one frame) before rendering. See `persistence::has_onboarding_flag`'s doc
/// comment for why this isn't keychain-backed like the session data.
#[tauri::command]
pub async fn get_local_onboarding_flag(
    app: AppHandle,
    state: State<'_, MatrixState>,
) -> Result<bool, String> {
    let client = state.require_client().await?;
    let user_id = client
        .user_id()
        .ok_or_else(|| "not logged in".to_string())?;
    persistence::has_onboarding_flag(&app, &persistence::account_key(user_id.as_str()))
}

#[tauri::command]
pub async fn set_local_onboarding_flag(
    app: AppHandle,
    state: State<'_, MatrixState>,
) -> Result<(), String> {
    let client = state.require_client().await?;
    let user_id = client
        .user_id()
        .ok_or_else(|| "not logged in".to_string())?;
    persistence::save_onboarding_flag(&app, &persistence::account_key(user_id.as_str()))
}

#[cfg(test)]
mod tests {
    use matrix_sdk::test_utils::mocks::MatrixMockServer;
    use serde_json::json;
    use wiremock::matchers::{method, path};
    use wiremock::{Mock, ResponseTemplate};

    use super::*;

    #[tokio::test]
    async fn set_then_get_round_trips_the_same_content() {
        let server = MatrixMockServer::new().await;
        let client = server.client_builder().build().await;
        let user_id = client.user_id().unwrap();

        Mock::given(method("PUT"))
            .and(path(format!(
                "/_matrix/client/v3/user/{user_id}/account_data/social.cloudhub.charm.onboarding"
            )))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({})))
            .mount(server.server())
            .await;

        Mock::given(method("GET"))
            .and(path(format!(
                "/_matrix/client/v3/user/{user_id}/account_data/social.cloudhub.charm.onboarding"
            )))
            .respond_with(
                ResponseTemplate::new(200)
                    .set_body_json(json!({ "completed_at": 42, "version": 1 })),
            )
            .mount(server.server())
            .await;

        set_account_data_impl(
            &client,
            "social.cloudhub.charm.onboarding".to_string(),
            json!({ "completed_at": 42, "version": 1 }),
        )
        .await
        .expect("set_account_data should succeed");

        let fetched =
            get_account_data_impl(&client, "social.cloudhub.charm.onboarding".to_string())
                .await
                .expect("get_account_data should succeed");

        assert_eq!(fetched, Some(json!({ "completed_at": 42, "version": 1 })));
    }

    #[tokio::test]
    async fn get_returns_none_when_the_event_was_never_set() {
        let server = MatrixMockServer::new().await;
        let client = server.client_builder().build().await;
        let user_id = client.user_id().unwrap();

        Mock::given(method("GET"))
            .and(path(format!(
                "/_matrix/client/v3/user/{user_id}/account_data/social.cloudhub.charm.onboarding"
            )))
            .respond_with(ResponseTemplate::new(404).set_body_json(json!({
                "errcode": "M_NOT_FOUND",
                "error": "Account data not found."
            })))
            .mount(server.server())
            .await;

        let fetched =
            get_account_data_impl(&client, "social.cloudhub.charm.onboarding".to_string())
                .await
                .expect("get_account_data should succeed");

        assert_eq!(fetched, None);
    }
}
