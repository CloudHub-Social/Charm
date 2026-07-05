//! Scan-to-sign-in via [MSC4108](https://github.com/matrix-org/matrix-spec-proposals/pull/4108):
//! Charm (the "new device") generates and displays a QR code; an
//! already-signed-in device (e.g. Element X on a phone) scans it and grants
//! the session. Only supported against a homeserver whose auth is delegated
//! to Matrix Authentication Service (MAS) — plain Matrix login/registration
//! doesn't support QR login at all, which is also why this can't share the
//! local dev/CI Synapse instance `login`/`register`/SSO use (see
//! `dev/synapse/docker-compose.yml`'s `synapse-mas` service).

use futures_util::StreamExt;
use matrix_sdk::authentication::oauth::qrcode::{GeneratedQrProgress, LoginProgress};
use matrix_sdk::authentication::oauth::registration::{
    ApplicationType, ClientMetadata, Localized, OAuthGrantType,
};
use matrix_sdk::authentication::oauth::ClientRegistrationData;
use matrix_sdk::ruma::serde::Raw;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager, State};
use ts_rs::TS;

use super::{persistence, spawn_sync_loop, LoginResponse, MatrixState};

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../src/bindings/")]
#[serde(tag = "state", rename_all = "snake_case")]
pub enum QrLoginProgressEvent {
    /// The QR code is ready to render and display. `qr_code_bytes` is the
    /// raw MSC4108 QR payload — feed it directly to a byte-mode QR code
    /// renderer, don't treat it as text.
    QrReady {
        qr_code_bytes: Vec<u8>,
    },
    /// The other device scanned the QR and connected. It's now showing a
    /// check code — ask the user to enter it via `submit_qr_check_code` so
    /// both sides can confirm they're talking to each other over a secure
    /// channel.
    WaitingForCheckCode,
    /// Waiting for the other device to approve the login.
    WaitingForApproval,
    /// Transferring end-to-end encryption secrets (cross-signing keys, key
    /// backup key) from the other device.
    SyncingSecrets,
    /// Carries the finished session directly, unlike a bare unit variant —
    /// the frontend used to react to `Done` by calling `try_restore_session`
    /// itself, which raced against this task's own persistence/adoption
    /// below and, once that race was fixed by delaying `Done` until after
    /// adoption, would have built and adopted a SECOND redundant client/sync
    /// loop on top of this one. Carrying the response here removes any
    /// reason for the frontend to touch session restoration at all.
    Done {
        session: LoginResponse,
    },
    Cancelled {
        reason: String,
    },
    Error {
        message: String,
    },
}

/// Starts a QR login attempt: builds a client against `homeserver_url`,
/// generates a QR code, and spawns a background task that drives the login
/// to completion (or failure) while pushing `qr_login:progress` events.
/// Returns immediately — the frontend should render the login screen from
/// those events, not from this command's (empty) return value.
#[tauri::command]
pub async fn start_qr_login(app: AppHandle, homeserver_url: String) -> Result<(), String> {
    // Guards against a double-start (e.g. a double click) leaving two login
    // tasks running concurrently, one of which would hold a stale
    // pending_qr_check_code no longer reachable from the frontend.
    cancel_qr_login(app.clone(), app.state::<MatrixState>()).await?;

    // The account isn't known until the OAuth device-code dance completes —
    // open a temp store now and relocate it once the MXID is known.
    let temp_key = persistence::temp_store_key();
    let client = super::build_client(&app, &homeserver_url, &temp_key).await?;

    // Device-code grant only — this client only ever needs to be the "new
    // device" side of QR login, never a full browser-based OAuth login.
    let metadata = ClientMetadata::new(
        ApplicationType::Native,
        vec![OAuthGrantType::DeviceCode],
        Localized::new(charm_client_uri(), []),
    );
    let metadata: Raw<ClientMetadata> = Raw::new(&metadata).map_err(|e| e.to_string())?;
    let registration_data = ClientRegistrationData::new(metadata);

    let app_for_state = app.clone();
    let temp_key_for_task = temp_key.clone();
    let task = tokio::spawn(async move {
        let temp_key = temp_key_for_task;
        let oauth = client.oauth();
        let login = oauth
            .login_with_qr_code(Some(&registration_data))
            .generate();
        let mut progress = login.subscribe_to_progress();

        // `State<'_, MatrixState>` isn't `'static` and can't be moved into a
        // spawned task, so each side re-derives it from the (Clone + Send +
        // 'static) AppHandle instead of capturing the command's own `state`
        // argument.
        let progress_task = tokio::spawn({
            let app = app.clone();
            async move {
                while let Some(update) = progress.next().await {
                    let event = match update {
                        LoginProgress::Starting => continue,
                        LoginProgress::EstablishingSecureChannel(GeneratedQrProgress::QrReady(
                            qr_code_data,
                        )) => QrLoginProgressEvent::QrReady {
                            qr_code_bytes: qr_code_data.to_bytes(),
                        },
                        LoginProgress::EstablishingSecureChannel(
                            GeneratedQrProgress::QrScanned(sender),
                        ) => {
                            let state = app.state::<MatrixState>();
                            *state.pending_qr_check_code.lock().await = Some(sender);
                            QrLoginProgressEvent::WaitingForCheckCode
                        }
                        LoginProgress::WaitingForToken { .. } => {
                            QrLoginProgressEvent::WaitingForApproval
                        }
                        LoginProgress::SyncingSecrets => QrLoginProgressEvent::SyncingSecrets,
                        // Deliberately NOT forwarded as QrLoginProgressEvent::Done:
                        // the SDK considers the OAuth dance itself done here, but
                        // the session isn't saved or adopted into MatrixState yet
                        // (that happens below, after `login.await` returns). The
                        // frontend reacts to "done" by immediately restoring the
                        // session, so emitting it this early raced ahead of
                        // persistence and could show "signed in, but no session
                        // was found". The real completion event is emitted after
                        // persistence succeeds, further down.
                        LoginProgress::Done => continue,
                    };
                    let _ = app.emit("qr_login:progress", event);
                }
            }
        });

        let result = login.await;
        progress_task.abort();

        match result {
            Ok(()) => {
                // QR login is OAuth-native (client.oauth()), unlike
                // password/SSO login's client.matrix_auth() — an entirely
                // separate session representation matrix-sdk doesn't unify,
                // so it needs its own persistence path too (see
                // persistence::SavedOAuthSession).
                let Some(session) = client.oauth().full_session() else {
                    let _ = app.emit(
                        "qr_login:progress",
                        QrLoginProgressEvent::Error {
                            message: "QR login succeeded but no session was returned".to_string(),
                        },
                    );
                    return;
                };
                let account_key = persistence::account_key(session.user.meta.user_id.as_str());
                if let Err(e) = persistence::relocate_store(&app, &temp_key, &account_key) {
                    let _ = app.emit(
                        "qr_login:progress",
                        QrLoginProgressEvent::Error { message: e },
                    );
                    return;
                }
                if let Err(e) = persistence::save_oauth_session(
                    &account_key,
                    client.homeserver().as_ref(),
                    &session,
                ) {
                    let _ = app.emit(
                        "qr_login:progress",
                        QrLoginProgressEvent::Error { message: e },
                    );
                    return;
                }
                // Enforces the single-account invariant `try_restore_session`'s
                // doc comment assumes: only one session kind should ever be
                // present in the keychain at a time. Best-effort — a failure
                // here doesn't roll back the OAuth session that already
                // succeeded and was just saved above.
                let _ = persistence::clear_session(&account_key);

                let response = LoginResponse {
                    user_id: session.user.meta.user_id.to_string(),
                    device_id: session.user.meta.device_id.to_string(),
                };

                let state = app.state::<MatrixState>();
                *state.client.lock().await = Some(client.clone());
                *state.pending_qr_temp_store_key.lock().unwrap() = None;
                spawn_sync_loop(app.clone(), client);

                // The app-level completion event, emitted only now that the
                // session is actually saved and adopted — see the comment on
                // LoginProgress::Done above.
                let _ = app.emit(
                    "qr_login:progress",
                    QrLoginProgressEvent::Done { session: response },
                );
            }
            Err(e) => {
                // The device-code dance itself failed (not cancelled) — no
                // account was ever learned, so clean up the temp store here
                // rather than leaving it for a future cancel/start to find.
                // Uses the `temp_key` this task already captured, not a
                // fresh read of `pending_qr_temp_store_key` — a concurrent
                // `cancel_qr_login`/new `start_qr_login` could have already
                // taken (and be relying on) that shared slot by the time
                // this arm runs.
                let _ = persistence::discard_temp_login_store(&app, &temp_key);
                // Compare-and-clear, not an unconditional `= None`: a
                // concurrent `start_qr_login` could already have overwritten
                // this slot with a newer attempt's key by the time this
                // arm runs, and clobbering that would leave the new
                // attempt's own cleanup with nothing to find.
                let state = app.state::<MatrixState>();
                let mut pending_key = state.pending_qr_temp_store_key.lock().unwrap();
                if pending_key.as_deref() == Some(temp_key.as_str()) {
                    *pending_key = None;
                }
                drop(pending_key);
                let _ = app.emit(
                    "qr_login:progress",
                    QrLoginProgressEvent::Error {
                        message: e.to_string(),
                    },
                );
            }
        }
    });

    // Synchronous: no `.await` between `tokio::spawn` returning and these
    // stores, so a concurrent `cancel_qr_login` can never observe a moment
    // where this attempt has started but has no stored handle/key to clean
    // up.
    let matrix_state = app_for_state.state::<MatrixState>();
    *matrix_state.pending_qr_login_task.lock().unwrap() = Some(task);
    *matrix_state.pending_qr_temp_store_key.lock().unwrap() = Some(temp_key);

    Ok(())
}

/// Cancels an in-progress QR login: aborts the background task driving
/// `login_with_qr_code` (unlike SSO login, which has nothing running in the
/// background to abort — it just waits on a deep-link callback) and clears
/// any pending check-code sender so a stale one can't be used later.
#[tauri::command]
pub async fn cancel_qr_login(app: AppHandle, state: State<'_, MatrixState>) -> Result<(), String> {
    let task = state.pending_qr_login_task.lock().unwrap().take();
    if let Some(task) = task {
        task.abort();
    }
    *state.pending_qr_check_code.lock().await = None;

    let temp_key = state.pending_qr_temp_store_key.lock().unwrap().take();
    if let Some(temp_key) = temp_key {
        let _ = persistence::discard_temp_login_store(&app, &temp_key);
    }

    Ok(())
}

/// Sends the check code the user read off the other device and typed in,
/// confirming the secure channel established during QR login is genuine.
#[tauri::command]
pub async fn submit_qr_check_code(state: State<'_, MatrixState>, code: u8) -> Result<(), String> {
    let sender = state
        .pending_qr_check_code
        .lock()
        .await
        .take()
        .ok_or_else(|| "no QR login is waiting for a check code".to_string())?;
    sender.send(code).await.map_err(|e| e.to_string())
}

/// `pub` so `tests/qr_login.rs` (the "already signed in" grant side) can
/// build an equivalent client for the flow's other end, since that role
/// isn't otherwise exposed as a Tauri command — Charm only ever plays the
/// "new device" role generating the QR code.
pub async fn grant_client_metadata() -> ClientMetadata {
    ClientMetadata::new(
        ApplicationType::Native,
        vec![OAuthGrantType::AuthorizationCode {
            redirect_uris: vec!["http://localhost:0/callback".parse().expect("valid URL")],
        }],
        Localized::new(charm_client_uri(), []),
    )
}

fn charm_client_uri() -> url::Url {
    "https://charm.cloudhub.social/".parse().expect("valid URL")
}
