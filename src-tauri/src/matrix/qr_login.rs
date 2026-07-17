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

use super::auth::LoginResponse;
use super::sync::spawn_sync_loop;
use super::{persistence, MatrixState, ReservedTempStoreGuard};

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
///
/// Not `_impl`-extracted (see Spec 16 Phase 1): unlike this module's commands
/// operating on an existing session, this one has no `&Client` to extract
/// against — it builds one from `homeserver_url` — and its body is almost
/// entirely `MatrixState`'s single-slot QR-attempt bookkeeping (the
/// synchronous-with-spawn store/compare-and-clear races documented inline
/// above), which a multi-tenant companion server would need to redesign
/// around per-session slots rather than reuse verbatim. Left as a genuine
/// Phase 2 (session store) concern rather than force-fitting a
/// `_impl(client: &Client, ...)` signature that doesn't apply here.
#[tauri::command]
pub async fn start_qr_login(app: AppHandle, homeserver_url: String) -> Result<(), String> {
    // Guards against a double-start (e.g. a double click) leaving two login
    // tasks running concurrently, one of which would hold a stale
    // pending_qr_check_code no longer reachable from the frontend.
    cancel_qr_login(app.clone(), app.state::<MatrixState>()).await?;

    // The account isn't known until the OAuth device-code dance completes —
    // open a temp store now and relocate it once the MXID is known.
    let temp_key = persistence::temp_store_key();
    // See `MatrixState::ReservedTempStoreGuard`'s doc comment (Codex review
    // on #288, P2): reserved before the client-build `.await` below so the
    // delayed sweep pass can't see this store as unprotected for however
    // long that network setup takes — `pending_qr_temp_store_key` itself
    // isn't set until further down.
    let matrix_state = app.state::<MatrixState>();
    let reservation = ReservedTempStoreGuard::new(&matrix_state, temp_key.clone());
    let client = super::auth::build_client(&app, &homeserver_url, &temp_key).await?;
    reservation.defuse();

    // Device-code grant only — this client only ever needs to be the "new
    // device" side of QR login, never a full browser-based OAuth login.
    let metadata = ClientMetadata::new(
        ApplicationType::Native,
        vec![OAuthGrantType::DeviceCode],
        Localized::new(charm_client_uri(), []),
    );
    let metadata: Raw<ClientMetadata> = Raw::new(&metadata).map_err(|e| e.to_string())?;
    let registration_data = ClientRegistrationData::new(metadata);

    // Stored *before* spawning (not after, alongside the task handle below):
    // the spawned task's own error path compares against this key to decide
    // whether to clear it, and on a multi-threaded runtime the task can
    // start running — and hit that error path — before this function gets
    // back around to storing anything post-spawn. Storing it first means
    // the task always finds its own key already present to compare against,
    // rather than racing to write a key the task's cleanup already ran (and
    // skipped) against a not-yet-set `None`.
    let app_for_state = app.clone();
    *app_for_state
        .state::<MatrixState>()
        .pending_qr_temp_store_key
        .lock()
        .unwrap_or_else(|e| e.into_inner()) = Some(temp_key.clone());

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
                // `relocate_store_and_save_oauth_session` leaves `client`
                // (already authenticated against the temp store) valid
                // regardless of whether an account store already existed at
                // this path — see its doc comment in persistence.rs. A fresh
                // QR login always yields a new device_id, so an existing
                // store there can never correctly host this session; the
                // relocation discards it and relocates the temp store in its
                // place instead of trying to restore this session onto it.
                // Relocating and saving the session under the same critical
                // section (rather than two separate calls) prevents a
                // concurrent completion from saving a session that no
                // longer matches the store a *different* completion just
                // relocated.
                let homeserver_url = client.homeserver().to_string();

                // Held for the rest of this branch: see auth.rs's identical
                // guard and `MatrixState::login_completion_lock`'s doc
                // comment for why the whole abort/relocate/adopt sequence
                // needs to be atomic against another completion for the
                // same account (e.g. an overlapping password/SSO login).
                let state = app.state::<MatrixState>();
                let _completion_guard = state.login_completion_lock.lock().await;

                // See auth.rs's identical capture-and-restore-on-failure
                // rationale.
                let previous_client = state.client.lock().await.clone();

                // Stop any sync loop already running for this account
                // before relocating its store — same rationale as the
                // identical step in auth.rs's login/register/
                // complete_sso_login.
                super::sync::abort_current_sync_loop(&app).await;
                if let Err(e) = persistence::relocate_store_and_save_oauth_session(
                    &app,
                    &temp_key,
                    &account_key,
                    &homeserver_url,
                    &session,
                ) {
                    // See auth.rs's identical safe_to_resume_previous check.
                    if e.safe_to_resume_previous {
                        if let Some(previous_client) = previous_client {
                            *state.client.lock().await = Some(previous_client.clone());
                            super::sync::spawn_sync_task(app.clone(), previous_client);
                        }
                    }
                    let _ = app.emit(
                        "qr_login:progress",
                        QrLoginProgressEvent::Error { message: e.into() },
                    );
                    return;
                }

                let response = LoginResponse {
                    user_id: session.user.meta.user_id.to_string(),
                    device_id: session.user.meta.device_id.to_string(),
                };

                // The temp store this attempt opened is gone either way
                // (relocated above) — clear its tracking slot regardless of
                // which completion wins the adoption race below.
                // Compare-and-clear, not an unconditional `= None` — a new
                // `start_qr_login` could already have overwritten this slot
                // with a newer attempt's key by the time this runs (e.g. if
                // this task raced past its last `.await` before a
                // `cancel_qr_login`/restart aborted it), and clobbering that
                // would leave the new attempt's own cleanup with nothing to
                // find.
                {
                    let mut pending_key = state
                        .pending_qr_temp_store_key
                        .lock()
                        .unwrap_or_else(|e| e.into_inner());
                    if pending_key.as_deref() == Some(temp_key.as_str()) {
                        *pending_key = None;
                    }
                }

                // A concurrent completion for the same account (e.g. an
                // overlapping password/SSO login) could have superseded
                // what was just saved above between that call returning and
                // here — if so, step aside rather than clear the other
                // session kind or publish a client for a store that's no
                // longer current; the completion that won already did its
                // own version of this. Deliberately *not* `Done` here even
                // though this device's login did succeed on the homeserver:
                // `QrLoginScreen` treats `Done` as "Rust adopted this exact
                // session" and immediately calls `onSignedIn` with it, which
                // would advance the UI past login with a session/client this
                // backend never actually published.
                if !persistence::oauth_session_is_current(
                    &account_key,
                    session.user.meta.device_id.as_str(),
                ) {
                    // See auth.rs's identical restore-on-failure step.
                    if let Some(previous_client) = previous_client {
                        *state.client.lock().await = Some(previous_client.clone());
                        super::sync::spawn_sync_task(app.clone(), previous_client);
                    }
                    let _ = app.emit(
                        "qr_login:progress",
                        QrLoginProgressEvent::Error {
                            message:
                                "QR login succeeded but was superseded by a concurrent login for the same account"
                                    .to_string(),
                        },
                    );
                    return;
                }
                // Enforces the single-account invariant `try_restore_session`'s
                // doc comment assumes: for *this* account_key, only one
                // session kind should ever be present in the keychain at a
                // time (other accounts' entries are untouched — each is
                // keyed separately). Best-effort — a failure here doesn't
                // roll back the OAuth session that already succeeded and
                // was just saved above.
                let _ = persistence::clear_session(&account_key);

                *state.client.lock().await = Some(client.clone());
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
                let mut pending_key = state
                    .pending_qr_temp_store_key
                    .lock()
                    .unwrap_or_else(|e| e.into_inner());
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

    // Synchronous: no `.await` between `tokio::spawn` returning and this
    // store, so a concurrent `cancel_qr_login` can never observe a moment
    // where this attempt has started but has no stored handle to abort
    // (`pending_qr_temp_store_key` is already set above, before the spawn).
    *app_for_state
        .state::<MatrixState>()
        .pending_qr_login_task
        .lock()
        .unwrap_or_else(|e| e.into_inner()) = Some(task);

    Ok(())
}

/// Cancels an in-progress QR login: aborts the background task driving
/// `login_with_qr_code` (unlike SSO login, which has nothing running in the
/// background to abort — it just waits on a deep-link callback) and clears
/// any pending check-code sender so a stale one can't be used later.
///
/// Not `_impl`-extracted, same rationale as [`start_qr_login`]: this is
/// `MatrixState`'s single-slot QR bookkeeping end-to-end, with no `Client`
/// to key an extraction on.
#[tauri::command]
pub async fn cancel_qr_login(app: AppHandle, state: State<'_, MatrixState>) -> Result<(), String> {
    let task = state
        .pending_qr_login_task
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .take();
    if let Some(task) = task {
        task.abort();
    }
    *state.pending_qr_check_code.lock().await = None;

    let temp_key = state
        .pending_qr_temp_store_key
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .take();
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
    submit_qr_check_code_impl(sender, code).await
}

/// Core logic behind [`submit_qr_check_code`], taking the already-retrieved
/// `CheckCodeSender` rather than `&MatrixState` — unlike this module's other
/// two commands, this one has no `Client` at all to key an extraction on
/// (`MatrixState.pending_qr_check_code` is single-slot bookkeeping for the
/// one in-flight QR attempt); the plain-args boundary here is the sender
/// itself, once the command wrapper has taken it out of that slot.
pub async fn submit_qr_check_code_impl(
    sender: matrix_sdk::authentication::oauth::qrcode::CheckCodeSender,
    code: u8,
) -> Result<(), String> {
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
