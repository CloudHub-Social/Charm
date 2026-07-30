//! Browser-bound unauthenticated Matrix authentication attempts.
//!
//! Registration and password recovery need a trusted owner for Matrix clients,
//! UIA sessions, client secrets, and email-validation sessions before a normal
//! Charm session cookie exists. Routes mint a separate opaque, HttpOnly
//! pre-auth cookie and every method below verifies that owner as well as the
//! public attempt id.

use std::collections::{HashMap, HashSet};
use std::sync::Arc;
use std::time::{Duration, Instant};

use charm_lib::matrix::auth::{
    LoginFlowSummary, LoginIdentityProvider, LoginResponse, PasswordResetChallenge,
    RegisterRequest, RegistrationAuthResponse, RegistrationEmailChallenge, RegistrationFlow,
    RegistrationPolicy, RegistrationStep,
};
use matrix_sdk::ruma::api::client::account::{
    change_password, register, request_password_change_token_via_email,
    request_registration_token_via_email,
};
use matrix_sdk::ruma::api::client::session::get_login_types::v3::LoginType;
use matrix_sdk::ruma::api::client::uiaa::{
    AuthData, AuthType, Dummy, EmailIdentity, LoginTermsParams, Terms, ThirdpartyIdCredentials,
    UiaaInfo,
};
use matrix_sdk::ruma::{ClientSecret, UInt};
use matrix_sdk::Client;
use rand::distr::Alphanumeric;
use rand::RngExt;
use tokio::sync::{Mutex, OwnedSemaphorePermit, Semaphore};
use tokio_util::sync::CancellationToken;

use crate::session::{CryptoStoreHandle, Session};

const ATTEMPT_TTL: Duration = Duration::from_secs(20 * 60);
const MAX_PENDING_AUTH_ATTEMPTS: usize = 64;

type AuthenticatedClient = (
    LoginResponse,
    Session,
    matrix_sdk::sync::SyncResponse,
    String,
);

struct RegistrationEmail {
    client_secret: matrix_sdk::ruma::OwnedClientSecret,
    sid: matrix_sdk::ruma::OwnedSessionId,
    submit_url: Option<reqwest::Url>,
    submitted: bool,
}

struct PendingRegistration {
    _capacity: OwnedSemaphorePermit,
    owner: String,
    client: Client,
    crypto: Option<CryptoStoreHandle>,
    request: RegisterRequest,
    attempt_id: String,
    uiaa: UiaaInfo,
    email: Option<RegistrationEmail>,
    created_at: Instant,
}

struct PendingPasswordReset {
    _capacity: OwnedSemaphorePermit,
    owner: String,
    client: Client,
    client_secret: matrix_sdk::ruma::OwnedClientSecret,
    sid: matrix_sdk::ruma::OwnedSessionId,
    submit_url: Option<reqwest::Url>,
    created_at: Instant,
}

#[derive(Clone)]
pub struct PendingAuthStore {
    registrations: Arc<Mutex<HashMap<String, PendingRegistration>>>,
    password_resets: Arc<Mutex<HashMap<String, PendingPasswordReset>>>,
    cancellations: Arc<Mutex<HashMap<String, (String, CancellationToken)>>>,
    capacity: Arc<Semaphore>,
}

impl Default for PendingAuthStore {
    fn default() -> Self {
        Self {
            registrations: Arc::default(),
            password_resets: Arc::default(),
            cancellations: Arc::default(),
            capacity: Arc::new(Semaphore::new(MAX_PENDING_AUTH_ATTEMPTS)),
        }
    }
}

impl PendingAuthStore {
    pub async fn cancel_owner(&self, owner: &str) {
        let attempt_ids = {
            let guard = self.cancellations.lock().await;
            guard
                .iter()
                .filter(|(_, (attempt_owner, _))| attempt_owner == owner)
                .map(|(attempt_id, _)| attempt_id.clone())
                .collect::<HashSet<_>>()
        };
        for id in attempt_ids {
            self.cancel_token(&id).await;
            if let Some(attempt) = self.registrations.lock().await.remove(&id) {
                crate::auth::cleanup_failed_crypto_store(&attempt.crypto);
            }
            self.password_resets.lock().await.remove(&id);
        }
    }

    pub async fn begin_registration(
        &self,
        owner: String,
        request: RegisterRequest,
        has_persistence: bool,
    ) -> Result<BeginRegistrationResult, String> {
        let capacity = self.reserve_capacity()?;
        let homeserver_url = request.homeserver_url.clone();
        let (client, crypto) = crate::auth::build_client(&homeserver_url, has_persistence).await?;
        let attempt_id = opaque_id();
        let registration_request = registration_request(&request, None);
        match client.matrix_auth().register(registration_request).await {
            Ok(_) => {
                let completed =
                    crate::auth::finish_authenticated_client(client, crypto, "registration")
                        .await?;
                Ok(BeginRegistrationResult::Complete(Box::new(authenticated(
                    completed,
                    homeserver_url,
                ))))
            }
            Err(error) => {
                let Some(uiaa) = error.as_uiaa_response().cloned() else {
                    crate::auth::cleanup_failed_crypto_store(&crypto);
                    return Err("registration request failed".to_string());
                };
                let step = match registration_challenge(&attempt_id, &client, &uiaa) {
                    Ok(step) => step,
                    Err(error) => {
                        crate::auth::cleanup_failed_crypto_store(&crypto);
                        return Err(error);
                    }
                };
                let cancellation = CancellationToken::new();
                self.cancellations
                    .lock()
                    .await
                    .insert(attempt_id.clone(), (owner.clone(), cancellation));
                self.registrations.lock().await.insert(
                    attempt_id.clone(),
                    PendingRegistration {
                        _capacity: capacity,
                        owner,
                        client,
                        crypto,
                        request,
                        attempt_id: attempt_id.clone(),
                        uiaa,
                        email: None,
                        created_at: Instant::now(),
                    },
                );
                self.spawn_expiry(attempt_id);
                Ok(BeginRegistrationResult::Challenge(step))
            }
        }
    }

    pub async fn request_registration_email(
        &self,
        owner: &str,
        attempt_id: &str,
        email: String,
    ) -> Result<RegistrationEmailChallenge, String> {
        let cancellation = self.owned_cancellation(owner, attempt_id).await?;
        let mut pending = self.take_registration(owner, attempt_id).await?;
        if pending.created_at.elapsed() > ATTEMPT_TTL {
            self.finish_cancelled_registration(attempt_id, pending)
                .await;
            return Err("registration attempt expired; start again".to_string());
        }
        if next_registration_stage(&pending.uiaa)? != AuthType::EmailIdentity.as_str() {
            self.restore_registration(pending).await;
            return Err("registration email is not the current authentication stage".to_string());
        }
        let client_secret = ClientSecret::new();
        let request = request_registration_token_via_email::v3::Request::new(
            client_secret.clone(),
            email,
            UInt::new_saturating(1),
        );
        let response = tokio::select! {
            result = pending.client.send(request) => result,
            () = cancellation.cancelled() => {
                self.finish_cancelled_registration(attempt_id, pending).await;
                return Err("registration cancelled".to_string());
            }
        };
        let response = match response {
            Ok(response) => response,
            Err(_) if cancellation.is_cancelled() => {
                self.finish_cancelled_registration(attempt_id, pending)
                    .await;
                return Err("registration cancelled".to_string());
            }
            Err(_) => {
                self.restore_registration(pending).await;
                return Err("could not send registration verification email".to_string());
            }
        };
        let submit_url = match sanitize_submit_url(
            &pending.client.homeserver(),
            response.submit_url.as_deref(),
            "registration",
        ) {
            Ok(url) => url,
            Err(error) => {
                self.restore_registration(pending).await;
                return Err(error);
            }
        };
        let requires_token = submit_url.is_some();
        pending.email = Some(RegistrationEmail {
            client_secret,
            sid: response.sid,
            submit_url,
            submitted: false,
        });
        if cancellation.is_cancelled() {
            self.finish_cancelled_registration(attempt_id, pending)
                .await;
            return Err("registration cancelled".to_string());
        }
        self.restore_registration(pending).await;
        Ok(RegistrationEmailChallenge { requires_token })
    }

    pub async fn continue_registration(
        &self,
        owner: &str,
        attempt_id: &str,
        response: RegistrationAuthResponse,
    ) -> Result<ContinueRegistrationResult, String> {
        let cancellation = self.owned_cancellation(owner, attempt_id).await?;
        let mut pending = self.take_registration(owner, attempt_id).await?;
        if pending.created_at.elapsed() > ATTEMPT_TTL {
            self.finish_cancelled_registration(attempt_id, pending)
                .await;
            return Err("registration attempt expired; start again".to_string());
        }
        let expected_stage = next_registration_stage(&pending.uiaa)?;
        let auth = tokio::select! {
            result = registration_auth_data(
                response,
                &expected_stage,
                &pending.uiaa,
                pending.email.as_mut(),
            ) => result,
            () = cancellation.cancelled() => {
                self.finish_cancelled_registration(attempt_id, pending).await;
                return Err("registration cancelled".to_string());
            }
        };
        let auth = match auth {
            Ok(auth) => auth,
            Err(error) => {
                self.restore_registration(pending).await;
                return Err(error);
            }
        };
        let request = registration_request(&pending.request, Some(auth));
        let matrix_auth = pending.client.matrix_auth();
        let result = tokio::select! {
            result = matrix_auth.register(request) => result,
            () = cancellation.cancelled() => {
                self.finish_cancelled_registration(attempt_id, pending).await;
                return Err("registration cancelled".to_string());
            }
        };
        match result {
            Ok(_) => {
                self.cancellations.lock().await.remove(attempt_id);
                let homeserver_url = pending.request.homeserver_url.clone();
                let completed = crate::auth::finish_authenticated_client(
                    pending.client,
                    pending.crypto,
                    "registration",
                )
                .await?;
                Ok(ContinueRegistrationResult::Complete(Box::new(
                    authenticated(completed, homeserver_url),
                )))
            }
            Err(error) => {
                if let Some(uiaa) = error.as_uiaa_response().cloned() {
                    pending.uiaa = uiaa;
                    if !matches!(
                        next_registration_stage(&pending.uiaa).as_deref(),
                        Ok(stage) if stage == AuthType::EmailIdentity.as_str()
                    ) {
                        pending.email = None;
                    }
                    let step = match registration_challenge(
                        &pending.attempt_id,
                        &pending.client,
                        &pending.uiaa,
                    ) {
                        Ok(step) => step,
                        Err(challenge_error) => {
                            self.finish_cancelled_registration(attempt_id, pending)
                                .await;
                            return Err(challenge_error);
                        }
                    };
                    self.restore_registration(pending).await;
                    Ok(ContinueRegistrationResult::Challenge(step))
                } else {
                    self.restore_registration(pending).await;
                    Err("registration request failed; retry this stage".to_string())
                }
            }
        }
    }

    pub async fn cancel_registration(&self, owner: &str, attempt_id: &str) -> Result<(), String> {
        self.owned_cancellation(owner, attempt_id).await?;
        self.cancel_token(attempt_id).await;
        if let Some(pending) = self.registrations.lock().await.remove(attempt_id) {
            crate::auth::cleanup_failed_crypto_store(&pending.crypto);
        }
        Ok(())
    }

    pub async fn request_password_reset(
        &self,
        owner: String,
        homeserver_url: String,
        email: String,
    ) -> Result<PasswordResetChallenge, String> {
        let capacity = self.reserve_capacity()?;
        let client = Client::builder()
            .server_name_or_homeserver_url(&homeserver_url)
            .build()
            .await
            .map_err(|_| "could not start password reset".to_string())?;
        let client_secret = ClientSecret::new();
        let request = request_password_change_token_via_email::v3::Request::new(
            client_secret.clone(),
            email,
            UInt::new_saturating(1),
        );
        let response = client
            .send(request)
            .await
            .map_err(|_| "could not start password reset".to_string())?;
        let submit_url = sanitize_submit_url(
            &client.homeserver(),
            response.submit_url.as_deref(),
            "password-reset",
        )?;
        let attempt_id = opaque_id();
        self.cancellations.lock().await.insert(
            attempt_id.clone(),
            (owner.clone(), CancellationToken::new()),
        );
        self.password_resets.lock().await.insert(
            attempt_id.clone(),
            PendingPasswordReset {
                _capacity: capacity,
                owner,
                client,
                client_secret,
                sid: response.sid,
                submit_url,
                created_at: Instant::now(),
            },
        );
        self.spawn_expiry(attempt_id.clone());
        Ok(PasswordResetChallenge {
            attempt_id,
            requires_token: response.submit_url.is_some(),
        })
    }

    pub async fn confirm_password_reset(
        &self,
        owner: &str,
        attempt_id: &str,
        token: Option<String>,
        new_password: String,
    ) -> Result<(), String> {
        let cancellation = self.owned_cancellation(owner, attempt_id).await?;
        let mut guard = self.password_resets.lock().await;
        let Some(current) = guard.get(attempt_id) else {
            return Err("password reset attempt expired or was cancelled".to_string());
        };
        if current.owner != owner || current.created_at.elapsed() > ATTEMPT_TTL {
            return Err("password reset attempt expired or was cancelled".to_string());
        }
        let pending = guard
            .remove(attempt_id)
            .ok_or_else(|| "password reset attempt expired or was cancelled".to_string())?;
        drop(guard);
        let result = tokio::select! {
            result = complete_password_reset(&pending, token.as_deref(), new_password) => result,
            () = cancellation.cancelled() => {
                Err("password reset attempt expired or was cancelled".to_string())
            }
        };
        if result.is_err()
            && !cancellation.is_cancelled()
            && pending.created_at.elapsed() <= ATTEMPT_TTL
        {
            self.password_resets
                .lock()
                .await
                .insert(attempt_id.to_owned(), pending);
        } else {
            self.cancellations.lock().await.remove(attempt_id);
        }
        result
    }

    pub async fn cancel_password_reset(&self, owner: &str, attempt_id: &str) -> Result<(), String> {
        self.owned_cancellation(owner, attempt_id).await?;
        self.cancel_token(attempt_id).await;
        self.password_resets.lock().await.remove(attempt_id);
        Ok(())
    }

    async fn take_registration(
        &self,
        owner: &str,
        attempt_id: &str,
    ) -> Result<PendingRegistration, String> {
        let mut guard = self.registrations.lock().await;
        if guard
            .get(attempt_id)
            .is_none_or(|attempt| attempt.owner != owner)
        {
            return Err("registration attempt is no longer current".to_string());
        }
        guard
            .remove(attempt_id)
            .ok_or_else(|| "registration attempt is no longer current".to_string())
    }

    fn reserve_capacity(&self) -> Result<OwnedSemaphorePermit, String> {
        self.capacity.clone().try_acquire_owned().map_err(|_| {
            "too many authentication attempts are in progress; try again later".to_string()
        })
    }

    async fn restore_registration(&self, pending: PendingRegistration) {
        let cancellations = self.cancellations.lock().await;
        if cancellations
            .get(&pending.attempt_id)
            .is_some_and(|(_, token)| !token.is_cancelled())
        {
            // Keep the cancellation entry locked through publication. A
            // concurrent cancel must therefore happen entirely before this
            // check (and we clean up) or after the insert (and it removes
            // the restored payload); it cannot miss an in-flight payload
            // and then have that payload reappear behind it.
            self.registrations
                .lock()
                .await
                .insert(pending.attempt_id.clone(), pending);
        } else {
            crate::auth::cleanup_failed_crypto_store(&pending.crypto);
        }
    }

    async fn owned_cancellation(
        &self,
        owner: &str,
        attempt_id: &str,
    ) -> Result<CancellationToken, String> {
        self.cancellations
            .lock()
            .await
            .get(attempt_id)
            .filter(|(attempt_owner, _)| attempt_owner == owner)
            .map(|(_, token)| token.clone())
            .ok_or_else(|| "authentication attempt is no longer current".to_string())
    }

    async fn cancel_token(&self, attempt_id: &str) {
        if let Some((_, token)) = self.cancellations.lock().await.remove(attempt_id) {
            token.cancel();
        }
    }

    async fn finish_cancelled_registration(&self, attempt_id: &str, pending: PendingRegistration) {
        self.cancel_token(attempt_id).await;
        crate::auth::cleanup_failed_crypto_store(&pending.crypto);
    }

    fn spawn_expiry(&self, attempt_id: String) {
        let store = self.clone();
        tokio::spawn(async move {
            tokio::time::sleep(ATTEMPT_TTL).await;
            store.cancel_token(&attempt_id).await;
            if let Some(pending) = store.registrations.lock().await.remove(&attempt_id) {
                crate::auth::cleanup_failed_crypto_store(&pending.crypto);
            }
            store.password_resets.lock().await.remove(&attempt_id);
        });
    }
}

pub enum BeginRegistrationResult {
    Challenge(RegistrationStep),
    Complete(Box<AuthenticatedClient>),
}

pub enum ContinueRegistrationResult {
    Challenge(RegistrationStep),
    Complete(Box<AuthenticatedClient>),
}

fn authenticated(
    value: (LoginResponse, Session, matrix_sdk::sync::SyncResponse),
    homeserver_url: String,
) -> AuthenticatedClient {
    (value.0, value.1, value.2, homeserver_url)
}

pub async fn get_login_flows(homeserver_url: &str) -> Result<LoginFlowSummary, String> {
    let client = Client::builder()
        .server_name_or_homeserver_url(homeserver_url)
        .build()
        .await
        .map_err(|_| "could not discover login options for this homeserver".to_string())?;
    let response = client
        .matrix_auth()
        .get_login_types()
        .await
        .map_err(|_| "could not discover login options for this homeserver".to_string())?;
    Ok(summarize_login_flows(response.flows))
}

pub async fn login_with_token(
    homeserver_url: String,
    token: String,
    has_persistence: bool,
) -> Result<AuthenticatedClient, String> {
    let (client, crypto) = crate::auth::build_client(&homeserver_url, has_persistence).await?;
    let flows = match client.matrix_auth().get_login_types().await {
        Ok(flows) => flows,
        Err(_) => {
            crate::auth::cleanup_failed_crypto_store(&crypto);
            return Err("could not verify token login support".to_string());
        }
    };
    if !flows
        .flows
        .iter()
        .any(|flow| matches!(flow, LoginType::Token(_)))
    {
        crate::auth::cleanup_failed_crypto_store(&crypto);
        return Err("this homeserver does not advertise token login".to_string());
    }
    if client
        .matrix_auth()
        .login_token(&token)
        .initial_device_display_name("Charm")
        .send()
        .await
        .is_err()
    {
        crate::auth::cleanup_failed_crypto_store(&crypto);
        return Err("token login failed".to_string());
    }
    let completed = crate::auth::finish_authenticated_client(client, crypto, "token login").await?;
    Ok(authenticated(completed, homeserver_url))
}

fn registration_request(
    request: &RegisterRequest,
    auth: Option<AuthData>,
) -> register::v3::Request {
    let mut registration = register::v3::Request::new();
    registration.username = Some(request.username.clone());
    registration.password = Some(request.password.clone());
    registration.auth = auth;
    registration
}

fn opaque_id() -> String {
    rand::rng()
        .sample_iter(&Alphanumeric)
        .take(48)
        .map(char::from)
        .collect()
}

fn next_registration_stage(uiaa: &UiaaInfo) -> Result<String, String> {
    let completed = uiaa
        .completed
        .iter()
        .map(AuthType::as_str)
        .collect::<HashSet<_>>();
    uiaa.flows
        .iter()
        .filter_map(|flow| {
            let remaining = flow
                .stages
                .iter()
                .filter(|stage| !completed.contains(stage.as_str()))
                .collect::<Vec<_>>();
            remaining
                .first()
                .map(|next| (remaining.len(), next.as_str()))
        })
        .min_by_key(|(remaining, _)| *remaining)
        .map(|(_, stage)| stage.to_owned())
        .ok_or_else(|| "homeserver returned no incomplete registration stage".to_string())
}

async fn registration_auth_data(
    response: RegistrationAuthResponse,
    expected_stage: &str,
    uiaa: &UiaaInfo,
    email: Option<&mut RegistrationEmail>,
) -> Result<AuthData, String> {
    let session = uiaa
        .session
        .clone()
        .ok_or_else(|| "homeserver omitted the registration UIA session".to_string())?;
    match response {
        RegistrationAuthResponse::AcceptTerms if expected_stage == AuthType::Terms.as_str() => {
            let mut terms = Terms::new();
            terms.session = Some(session);
            Ok(AuthData::Terms(terms))
        }
        RegistrationAuthResponse::CompleteDummy if expected_stage == AuthType::Dummy.as_str() => {
            let mut dummy = Dummy::new();
            dummy.session = Some(session);
            Ok(AuthData::Dummy(dummy))
        }
        RegistrationAuthResponse::CompleteEmail { token }
            if expected_stage == AuthType::EmailIdentity.as_str() =>
        {
            let validation = email
                .ok_or_else(|| "request a registration verification email first".to_string())?;
            if !validation.submitted {
                if let Some(submit_url) = &validation.submit_url {
                    let token = token
                        .as_deref()
                        .filter(|token| !token.is_empty())
                        .ok_or_else(|| {
                            "enter the token from your registration email".to_string()
                        })?;
                    submit_email(
                        submit_url,
                        &validation.sid,
                        &validation.client_secret,
                        token,
                        "registration",
                    )
                    .await?;
                    validation.submitted = true;
                }
            }
            let credentials = ThirdpartyIdCredentials::new(
                validation.sid.clone(),
                validation.client_secret.clone(),
            );
            let mut identity: EmailIdentity = serde_json::from_value(serde_json::json!({
                "threepid_creds": credentials,
            }))
            .map_err(|_| "could not confirm registration email".to_string())?;
            identity.session = Some(session);
            Ok(AuthData::EmailIdentity(identity))
        }
        RegistrationAuthResponse::AcknowledgeFallback { stage } if stage == expected_stage => {
            Ok(AuthData::fallback_acknowledgement(session))
        }
        _ => Err(format!(
            "registration response does not match the required stage {expected_stage}"
        )),
    }
}

fn registration_challenge(
    attempt_id: &str,
    client: &Client,
    uiaa: &UiaaInfo,
) -> Result<RegistrationStep, String> {
    let session = uiaa
        .session
        .clone()
        .ok_or_else(|| "homeserver omitted the registration UIA session".to_string())?;
    let next_stage = next_registration_stage(uiaa)?;
    let fallback_url = registration_fallback_url(client, &next_stage, &session)?;
    Ok(RegistrationStep::Challenge {
        attempt_id: attempt_id.to_owned(),
        completed: uiaa
            .completed
            .iter()
            .map(|stage| stage.as_str().to_owned())
            .collect(),
        flows: uiaa
            .flows
            .iter()
            .map(|flow| RegistrationFlow {
                stages: flow
                    .stages
                    .iter()
                    .map(|stage| stage.as_str().to_owned())
                    .collect(),
            })
            .collect(),
        next_stage,
        fallback_url,
        policies: sanitized_policies(uiaa),
    })
}

fn registration_fallback_url(
    client: &Client,
    stage: &str,
    session: &str,
) -> Result<String, String> {
    let mut url = client.homeserver().clone();
    url.set_query(None);
    url.path_segments_mut()
        .map_err(|_| "homeserver URL cannot host a registration fallback".to_string())?
        .pop_if_empty()
        .extend(["_matrix", "client", "v3", "auth", stage, "fallback", "web"]);
    url.query_pairs_mut().append_pair("session", session);
    Ok(url.to_string())
}

fn sanitized_policies(uiaa: &UiaaInfo) -> Vec<RegistrationPolicy> {
    let Ok(Some(params)) = uiaa.params::<LoginTermsParams>(&AuthType::Terms) else {
        return Vec::new();
    };
    params
        .policies
        .into_iter()
        .flat_map(|(id, policy)| {
            let version = policy.version;
            policy
                .translations
                .into_iter()
                .filter_map(move |(language, info)| {
                    let url = reqwest::Url::parse(&info.url).ok()?;
                    matches!(url.scheme(), "http" | "https").then(|| RegistrationPolicy {
                        id: id.clone(),
                        version: version.clone(),
                        language,
                        name: info.name,
                        url: url.to_string(),
                    })
                })
        })
        .collect()
}

fn sanitize_submit_url(
    homeserver: &reqwest::Url,
    submit_url: Option<&str>,
    flow: &str,
) -> Result<Option<reqwest::Url>, String> {
    let Some(submit_url) = submit_url else {
        return Ok(None);
    };
    let parsed = homeserver
        .join(submit_url)
        .map_err(|_| format!("this homeserver returned an unsupported {flow} flow"))?;
    if !(matches!(parsed.scheme(), "https")
        || parsed.scheme() == "http" && parsed.origin() == homeserver.origin())
        || !parsed.username().is_empty()
        || parsed.password().is_some()
    {
        return Err(format!(
            "this homeserver returned an unsupported {flow} flow"
        ));
    }
    Ok(Some(parsed))
}

async fn submit_email(
    submit_url: &reqwest::Url,
    sid: &matrix_sdk::ruma::OwnedSessionId,
    client_secret: &matrix_sdk::ruma::OwnedClientSecret,
    token: &str,
    flow: &str,
) -> Result<(), String> {
    let response = email_submission_client(submit_url)
        .await
        .map_err(|_| format!("could not confirm {flow} email"))?
        .post(submit_url.clone())
        .json(&serde_json::json!({
            "sid": sid,
            "client_secret": client_secret,
            "token": token,
        }))
        .send()
        .await
        .map_err(|_| format!("could not confirm {flow} email"))?;
    if !response.status().is_success() {
        return Err(format!("could not confirm {flow} email"));
    }
    Ok(())
}

async fn email_submission_client(submit_url: &reqwest::Url) -> Result<reqwest::Client, String> {
    let host = submit_url
        .host_str()
        .ok_or_else(|| "email submission URL has no host".to_string())?;
    let port = submit_url
        .port_or_known_default()
        .ok_or_else(|| "email submission URL has no port".to_string())?;
    let addresses = tokio::net::lookup_host((host, port))
        .await
        .map_err(|_| "could not resolve email submission host".to_string())?
        .collect::<Vec<_>>();
    if addresses.is_empty()
        || (!cfg!(test)
            && addresses
                .iter()
                .any(|address| !is_public_network_ip(address.ip())))
    {
        return Err("email submission host is not public".to_string());
    }

    reqwest::Client::builder()
        // Resolve exactly once, validate every answer, then pin those
        // addresses so a controlled hostname cannot rebind between this
        // check and reqwest's connection.
        .resolve_to_addrs(host, &addresses)
        .redirect(reqwest::redirect::Policy::none())
        .timeout(Duration::from_secs(15))
        .build()
        .map_err(|_| "could not build email submission client".to_string())
}

fn is_public_network_ip(ip: std::net::IpAddr) -> bool {
    match ip {
        std::net::IpAddr::V4(ip) => {
            let [a, b, c, _] = ip.octets();
            !(a == 0
                || a == 10
                || a == 127
                || (a == 100 && (64..=127).contains(&b))
                || (a == 169 && b == 254)
                || (a == 172 && (16..=31).contains(&b))
                || (a == 192 && b == 0 && c == 0)
                || (a == 192 && b == 0 && c == 2)
                || (a == 192 && b == 168)
                || (a == 198 && (b == 18 || b == 19))
                || (a == 198 && b == 51 && c == 100)
                || (a == 203 && b == 0 && c == 113)
                || a >= 224)
        }
        std::net::IpAddr::V6(ip) => {
            if let Some(mapped) = ip.to_ipv4_mapped() {
                return is_public_network_ip(mapped.into());
            }
            let segments = ip.segments();
            !(ip.is_unspecified()
                || ip.is_loopback()
                || ip.is_multicast()
                || (segments[0] & 0xfe00) == 0xfc00
                || (segments[0] & 0xffc0) == 0xfe80
                || (segments[0] == 0x2001 && segments[1] == 0x0db8)
                || (segments[0] == 0x0100 && segments[1..4] == [0, 0, 0]))
        }
    }
}

async fn complete_password_reset(
    pending: &PendingPasswordReset,
    token: Option<&str>,
    new_password: String,
) -> Result<(), String> {
    if let Some(submit_url) = &pending.submit_url {
        let token = token
            .filter(|token| !token.is_empty())
            .ok_or_else(|| "enter the token from your password-reset email".to_string())?;
        submit_email(
            submit_url,
            &pending.sid,
            &pending.client_secret,
            token,
            "password-reset",
        )
        .await
        .map_err(|_| "could not confirm password reset".to_string())?;
    }
    let credentials =
        ThirdpartyIdCredentials::new(pending.sid.clone(), pending.client_secret.clone());
    let identity: EmailIdentity = serde_json::from_value(serde_json::json!({
        "threepid_creds": credentials,
    }))
    .map_err(|_| "could not confirm password reset".to_string())?;
    let mut request = change_password::v3::Request::new(new_password);
    request.auth = Some(AuthData::EmailIdentity(identity));
    pending
        .client
        .send(request)
        .await
        .map(|_| ())
        .map_err(|_| "could not confirm password reset".to_string())
}

fn summarize_login_flows(flows: Vec<LoginType>) -> LoginFlowSummary {
    let mut summary = LoginFlowSummary {
        password: false,
        token: false,
        sso: false,
        identity_providers: Vec::new(),
    };
    for flow in flows {
        match flow {
            LoginType::Password(_) => summary.password = true,
            LoginType::Token(_) => summary.token = true,
            LoginType::Sso(sso) => {
                summary.sso = true;
                summary
                    .identity_providers
                    .extend(sso.identity_providers.into_iter().map(|provider| {
                        LoginIdentityProvider {
                            id: provider.id,
                            name: provider.name,
                            brand: provider.brand.map(|brand| brand.as_str().to_owned()),
                        }
                    }));
            }
            _ => {}
        }
    }
    summary
}

#[cfg(test)]
mod tests {
    use super::{
        is_public_network_ip, sanitize_submit_url, PendingAuthStore, MAX_PENDING_AUTH_ATTEMPTS,
    };
    use tokio_util::sync::CancellationToken;

    #[tokio::test]
    async fn preauth_owner_cannot_use_another_browsers_attempt() {
        let store = PendingAuthStore::default();
        store.cancellations.lock().await.insert(
            "attempt".to_owned(),
            ("browser-a".to_owned(), CancellationToken::new()),
        );

        assert!(store
            .owned_cancellation("browser-a", "attempt")
            .await
            .is_ok());
        assert!(store
            .owned_cancellation("browser-b", "attempt")
            .await
            .is_err());
    }

    #[test]
    fn unauthenticated_pending_attempts_are_globally_bounded() {
        let store = PendingAuthStore::default();
        let permits = (0..MAX_PENDING_AUTH_ATTEMPTS)
            .map(|_| store.reserve_capacity().expect("capacity available"))
            .collect::<Vec<_>>();

        assert!(store.reserve_capacity().is_err());
        drop(permits);
        assert!(store.reserve_capacity().is_ok());
    }

    #[tokio::test]
    async fn owner_cancellation_reaches_an_attempt_while_its_payload_is_in_flight() {
        let store = PendingAuthStore::default();
        let cancellation = CancellationToken::new();
        store.cancellations.lock().await.insert(
            "attempt".to_owned(),
            ("browser-a".to_owned(), cancellation.clone()),
        );

        store.cancel_owner("browser-a").await;

        assert!(cancellation.is_cancelled());
        assert!(store.cancellations.lock().await.is_empty());
    }

    #[test]
    fn email_submission_urls_require_https_or_same_origin_http() {
        let homeserver =
            reqwest::Url::parse("https://matrix.example/base/").expect("homeserver URL");
        assert_eq!(
            sanitize_submit_url(
                &homeserver,
                Some("/_matrix/client/v3/validate/email/submitToken"),
                "registration",
            )
            .expect("safe URL")
            .expect("submission URL")
            .as_str(),
            "https://matrix.example/_matrix/client/v3/validate/email/submitToken"
        );
        assert!(sanitize_submit_url(
            &homeserver,
            Some("http://127.0.0.1/internal"),
            "registration"
        )
        .is_err());
        assert_eq!(
            sanitize_submit_url(
                &homeserver,
                Some("https://identity.example/submit"),
                "registration",
            )
            .expect("delegated HTTPS URL")
            .expect("submission URL")
            .host_str(),
            Some("identity.example")
        );
    }

    #[test]
    fn email_submission_rejects_non_public_addresses() {
        for address in [
            "127.0.0.1",
            "10.0.0.1",
            "169.254.169.254",
            "192.168.1.2",
            "198.51.100.1",
            "::1",
            "fc00::1",
            "fe80::1",
            "2001:db8::1",
            "::ffff:127.0.0.1",
        ] {
            assert!(
                !is_public_network_ip(address.parse().expect("valid IP")),
                "{address} must not be treated as public"
            );
        }
        assert!(is_public_network_ip(
            "1.1.1.1".parse().expect("valid public IP")
        ));
    }
}
