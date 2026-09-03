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
    sanitized_provider_name, LoginFlowSummary, LoginIdentityProvider, LoginResponse,
    PasswordResetChallenge, RegisterRequest, RegistrationAuthResponse, RegistrationEmailChallenge,
    RegistrationFlow, RegistrationPolicy, RegistrationStep, MAX_IDENTITY_PROVIDERS,
};
use matrix_sdk::config::RequestConfig;
use matrix_sdk::ruma::api::client::account::{
    change_password, register, request_password_change_token_via_email,
    request_registration_token_via_email,
};
use matrix_sdk::ruma::api::client::session::get_login_types::v3::LoginType;
use matrix_sdk::ruma::api::client::uiaa::{
    AuthData, AuthType, Dummy, EmailIdentity, LoginTermsParams, Terms, ThirdpartyIdCredentials,
    UiaaInfo,
};
use matrix_sdk::ruma::api::error::ErrorKind;
use matrix_sdk::ruma::{ClientSecret, UInt};
use matrix_sdk::Client;
use rand::distr::Alphanumeric;
use rand::RngExt;
use sha2::{Digest, Sha256};
use tokio::sync::{Mutex, OwnedSemaphorePermit, Semaphore};
use tokio_util::sync::CancellationToken;

use crate::session::{CryptoStoreHandle, Session};

const ATTEMPT_TTL: Duration = Duration::from_secs(20 * 60);
const MAX_PENDING_AUTH_ATTEMPTS: usize = 64;
const MAIL_QUOTA_WINDOW: Duration = Duration::from_secs(10 * 60);
const MAX_MAILS_PER_SOURCE: usize = 5;
const MAX_MAILS_PER_ADDRESS: usize = 3;
const MAX_MAIL_QUOTA_KEYS: usize = 4096;
const REGISTRATION_EMAIL_RESEND_DELAY: Duration = Duration::from_secs(30);

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
    homeserver: reqwest::Url,
    normalized_email: String,
    send_attempt: u32,
    retry_not_before: Instant,
    submitted: bool,
}

#[derive(Default)]
struct MailQuota {
    by_source: HashMap<String, Vec<Instant>>,
    by_address: HashMap<String, Vec<Instant>>,
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
    synthetic: bool,
    normalized_email: String,
    send_attempt: u32,
    retry_not_before: Instant,
    submitted: bool,
    created_at: Instant,
}

struct PendingSso {
    _capacity: OwnedSemaphorePermit,
    owner: String,
    client: Client,
    crypto: Option<CryptoStoreHandle>,
    homeserver_url: String,
    cancellation: CancellationToken,
    created_at: Instant,
}

enum SsoCompletionResult {
    Success(Box<AuthenticatedClient>),
    Failed(String),
}

struct CompletedSso {
    _capacity: OwnedSemaphorePermit,
    owner: String,
    result: SsoCompletionResult,
    created_at: Instant,
}

async fn discard_completed_sso(completion: CompletedSso) {
    let SsoCompletionResult::Success(completed) = completion.result else {
        return;
    };
    let (_, session, _, _) = *completed;
    let crypto = session.persisted_crypto.clone();
    let _ = session.client.matrix_auth().logout().await;
    drop(session);
    crate::auth::cleanup_failed_crypto_store(&crypto);
}

#[derive(Clone)]
pub struct PendingAuthStore {
    transitions: Arc<Mutex<()>>,
    registrations: Arc<Mutex<HashMap<String, PendingRegistration>>>,
    password_resets: Arc<Mutex<HashMap<String, PendingPasswordReset>>>,
    sso_attempts: Arc<Mutex<HashMap<String, PendingSso>>>,
    completed_sso: Arc<Mutex<HashMap<String, CompletedSso>>>,
    cancellations: Arc<Mutex<HashMap<String, (String, CancellationToken)>>>,
    mail_quota: Arc<Mutex<MailQuota>>,
    mail_quota_salt: Arc<String>,
    capacity: Arc<Semaphore>,
}

/// Server-derived browser ownership, including both pre-auth cookie namespaces.
#[derive(Clone)]
pub struct AuthOwner {
    pub id: String,
    pub superseded: Vec<String>,
}

impl From<String> for AuthOwner {
    fn from(id: String) -> Self {
        Self {
            id,
            superseded: Vec::new(),
        }
    }
}

impl Default for PendingAuthStore {
    fn default() -> Self {
        Self {
            transitions: Arc::default(),
            registrations: Arc::default(),
            password_resets: Arc::default(),
            sso_attempts: Arc::default(),
            completed_sso: Arc::default(),
            cancellations: Arc::default(),
            mail_quota: Arc::default(),
            mail_quota_salt: Arc::new(opaque_id()),
            capacity: Arc::new(Semaphore::new(MAX_PENDING_AUTH_ATTEMPTS)),
        }
    }
}

impl PendingAuthStore {
    async fn admit_owner_attempt(
        &self,
        owner: impl Into<AuthOwner>,
        attempt_id: String,
        cancellation: CancellationToken,
    ) {
        let owner = owner.into();
        let completed = {
            let _transition = self.transitions.lock().await;
            let mut owners = owner.superseded;
            owners.push(owner.id.clone());
            owners.sort_unstable();
            owners.dedup();
            let mut completed = Vec::new();
            for previous in owners {
                completed.extend(self.clear_owner_attempts(&previous).await);
            }
            self.cancellations
                .lock()
                .await
                .insert(attempt_id, (owner.id, cancellation));
            completed
        };
        for completion in completed {
            discard_completed_sso(completion).await;
        }
    }

    pub async fn cancel_owner(&self, owner: &str) {
        self.cancel_owners(&[owner]).await;
    }

    /// Cancels every attempt belonging to the browser's pre-authentication
    /// owner cookies under one transition lock. This prevents a new flow from
    /// being admitted between clearing the discovery and active-flow owners.
    pub async fn cancel_owners(&self, owners: &[&str]) {
        if owners.is_empty() {
            return;
        }
        let completed = {
            let _transition = self.transitions.lock().await;
            let mut unique = HashSet::new();
            let mut completed = Vec::new();
            for owner in owners.iter().copied().filter(|owner| unique.insert(*owner)) {
                completed.extend(self.clear_owner_attempts(owner).await);
            }
            completed
        };
        for completion in completed {
            discard_completed_sso(completion).await;
        }
    }

    async fn clear_owner_attempts(&self, owner: &str) -> Vec<CompletedSso> {
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
            if let Some(pending) = self.sso_attempts.lock().await.remove(&id) {
                crate::auth::cleanup_failed_crypto_store(&pending.crypto);
            }
        }
        {
            let mut guard = self.completed_sso.lock().await;
            let attempt_ids = guard
                .iter()
                .filter(|(_, completion)| completion.owner == owner)
                .map(|(attempt_id, _)| attempt_id.clone())
                .collect::<Vec<_>>();
            attempt_ids
                .into_iter()
                .filter_map(|attempt_id| guard.remove(&attempt_id))
                .collect::<Vec<_>>()
        }
    }

    pub async fn start_sso(
        &self,
        owner: impl Into<AuthOwner>,
        homeserver_url: String,
        idp_id: Option<String>,
        callback_url: String,
        has_persistence: bool,
    ) -> Result<(String, String), String> {
        let owner = owner.into();
        let capacity = self.reserve_capacity()?;
        let attempt_id = opaque_id();
        let cancellation = CancellationToken::new();
        self.admit_owner_attempt(owner.clone(), attempt_id.clone(), cancellation.clone())
            .await;
        let owner = owner.id;
        let (client, crypto) = match tokio::select! {
            result = crate::auth::build_client(&homeserver_url, has_persistence) => result,
            () = cancellation.cancelled() => {
                Err("single sign-on setup expired or was cancelled".to_string())
            }
        } {
            Ok(value) => value,
            Err(error) => {
                self.finish_attempt(&attempt_id).await;
                return Err(error);
            }
        };
        let matrix_auth = client.matrix_auth();
        let flows = match tokio::select! {
            result = matrix_auth.get_login_types() => result,
            () = cancellation.cancelled() => {
                crate::auth::cleanup_failed_crypto_store(&crypto);
                self.finish_attempt(&attempt_id).await;
                return Err("single sign-on setup expired or was cancelled".to_string());
            }
        } {
            Ok(flows) => flows.flows,
            Err(_) => {
                crate::auth::cleanup_failed_crypto_store(&crypto);
                self.finish_attempt(&attempt_id).await;
                return Err("could not verify single sign-on support".to_string());
            }
        };
        let (sso_advertised, provider_allowed) =
            sso_selection_is_advertised(&flows, idp_id.as_deref());
        if !sso_advertised || !provider_allowed {
            crate::auth::cleanup_failed_crypto_store(&crypto);
            self.finish_attempt(&attempt_id).await;
            return Err(if sso_advertised {
                "this identity provider is not advertised by the homeserver".to_string()
            } else {
                "this homeserver does not advertise single sign-on".to_string()
            });
        }
        let mut callback_url = match reqwest::Url::parse(&callback_url) {
            Ok(url) => url,
            Err(_) => {
                crate::auth::cleanup_failed_crypto_store(&crypto);
                self.finish_attempt(&attempt_id).await;
                return Err("browser single sign-on is not configured".to_string());
            }
        };
        callback_url
            .query_pairs_mut()
            .append_pair("state", &attempt_id);
        let redirect_url = match client
            .matrix_auth()
            .get_sso_login_url(callback_url.as_str(), idp_id.as_deref())
            .await
        {
            Ok(url) => url,
            Err(_) => {
                crate::auth::cleanup_failed_crypto_store(&crypto);
                self.finish_attempt(&attempt_id).await;
                return Err("could not start single sign-on".to_string());
            }
        };
        let _transition = self.transitions.lock().await;
        let active = self
            .cancellations
            .lock()
            .await
            .get(&attempt_id)
            .is_some_and(|(attempt_owner, token)| attempt_owner == &owner && !token.is_cancelled());
        if !active {
            crate::auth::cleanup_failed_crypto_store(&crypto);
            return Err("single sign-on setup expired or was cancelled".to_string());
        }
        self.sso_attempts.lock().await.insert(
            attempt_id.clone(),
            PendingSso {
                _capacity: capacity,
                owner,
                client,
                crypto,
                homeserver_url,
                cancellation,
                created_at: Instant::now(),
            },
        );
        drop(_transition);
        self.spawn_expiry(attempt_id.clone());
        Ok((attempt_id, redirect_url))
    }

    pub async fn complete_sso_callback(
        &self,
        attempt_id: &str,
        login_token: String,
    ) -> Result<(), String> {
        let Some(pending) = self.sso_attempts.lock().await.remove(attempt_id) else {
            return Err("single sign-on attempt expired or was already used".to_string());
        };
        let PendingSso {
            _capacity,
            owner,
            client,
            crypto,
            homeserver_url,
            cancellation,
            created_at,
        } = pending;
        if cancellation.is_cancelled() || created_at.elapsed() > ATTEMPT_TTL {
            crate::auth::cleanup_failed_crypto_store(&crypto);
            self.finish_attempt(attempt_id).await;
            return Err("single sign-on attempt expired or was already used".to_string());
        }
        let cleanup_crypto = crypto.clone();
        let result = async {
            client
                .matrix_auth()
                .login_token(&login_token)
                .initial_device_display_name("Charm")
                .send()
                .await
                .map_err(|_| "single sign-on failed".to_string())?;
            let completed =
                crate::auth::finish_authenticated_client(client, crypto, "sso login").await?;
            Ok(Box::new(authenticated(completed, homeserver_url)))
        }
        .await;
        let failed = result.is_err();
        if failed {
            crate::auth::cleanup_failed_crypto_store(&cleanup_crypto);
        }
        let completion = CompletedSso {
            _capacity,
            owner,
            result: match result {
                Ok(completed) => SsoCompletionResult::Success(completed),
                Err(error) => SsoCompletionResult::Failed(error),
            },
            created_at: Instant::now(),
        };
        // Serialize ownership transitions without nesting the payload locks.
        // If cancellation already won, discard a successfully authenticated
        // Matrix session immediately.
        let _transition = self.transitions.lock().await;
        let active = self.cancellations.lock().await.get(attempt_id).is_some_and(
            |(attempt_owner, token)| attempt_owner == &completion.owner && !token.is_cancelled(),
        );
        if !active {
            drop(_transition);
            discard_completed_sso(completion).await;
            return Err("single sign-on attempt expired or was already used".to_string());
        }
        if failed {
            self.cancellations.lock().await.remove(attempt_id);
        }
        self.completed_sso
            .lock()
            .await
            .insert(attempt_id.to_owned(), completion);
        drop(_transition);
        let store = self.clone();
        let completed_attempt_id = attempt_id.to_owned();
        tokio::spawn(async move {
            tokio::time::sleep(ATTEMPT_TTL).await;
            let completion = store
                .completed_sso
                .lock()
                .await
                .remove(&completed_attempt_id);
            if let Some(completion) = completion {
                discard_completed_sso(completion).await;
            }
        });
        Ok(())
    }

    pub async fn poll_sso(&self, owner: &str, attempt_id: &str) -> PollSsoResult {
        let mut completed = self.completed_sso.lock().await;
        if let Some(completion) = completed.get(attempt_id) {
            if completion.owner != owner || completion.created_at.elapsed() > ATTEMPT_TTL {
                return PollSsoResult::Expired;
            }
            let completion = completed
                .remove(attempt_id)
                .expect("completion checked above");
            return match completion.result {
                SsoCompletionResult::Success(completed) => PollSsoResult::Complete {
                    completed,
                    _capacity: completion._capacity,
                },
                SsoCompletionResult::Failed(error) => PollSsoResult::Failed(error),
            };
        }
        drop(completed);
        if self
            .sso_attempts
            .lock()
            .await
            .get(attempt_id)
            .is_some_and(|pending| pending.owner == owner)
            || self
                .cancellations
                .lock()
                .await
                .get(attempt_id)
                .is_some_and(|(attempt_owner, _)| attempt_owner == owner)
        {
            // The callback removes the pending client before exchanging the
            // single-use login token. The cancellation entry deliberately
            // spans that gap so a concurrent browser poll stays pending
            // instead of falsely reporting an expired attempt.
            PollSsoResult::Pending
        } else {
            PollSsoResult::Expired
        }
    }

    pub async fn login_with_token(
        &self,
        owner: impl Into<AuthOwner>,
        homeserver_url: String,
        token: String,
        has_persistence: bool,
    ) -> Result<(AuthenticatedClient, String), String> {
        let _capacity = self.reserve_capacity()?;
        let attempt_id = opaque_id();
        let cancellation = CancellationToken::new();
        self.admit_owner_attempt(owner, attempt_id.clone(), cancellation.clone())
            .await;
        self.spawn_expiry(attempt_id.clone());
        match login_with_token_inner(homeserver_url, token, has_persistence, &cancellation).await {
            Ok(completed) => Ok((completed, attempt_id)),
            Err(error) => {
                self.finish_attempt(&attempt_id).await;
                Err(error)
            }
        }
    }

    pub async fn begin_registration(
        &self,
        owner: impl Into<AuthOwner>,
        request: RegisterRequest,
        has_persistence: bool,
    ) -> Result<BeginRegistrationResult, String> {
        let owner = owner.into();
        let capacity = self.reserve_capacity()?;
        let created_at = Instant::now();
        let attempt_id = opaque_id();
        let cancellation = CancellationToken::new();
        self.admit_owner_attempt(owner.clone(), attempt_id.clone(), cancellation.clone())
            .await;
        let owner = owner.id;
        self.spawn_expiry(attempt_id.clone());
        let homeserver_url = request.homeserver_url.clone();
        let build_result = tokio::select! {
            result = crate::auth::build_client(&homeserver_url, has_persistence) => result,
            () = cancellation.cancelled() => {
                return Err("registration attempt expired or was cancelled".to_string());
            }
        };
        let (client, crypto) = match build_result {
            Ok(result) => result,
            Err(error) => {
                self.finish_attempt(&attempt_id).await;
                return Err(error);
            }
        };
        let registration_request = registration_request(&request, None);
        let matrix_auth = client.matrix_auth();
        let registration_result = tokio::select! {
            result = matrix_auth.register(registration_request) => result,
            () = cancellation.cancelled() => {
                crate::auth::cleanup_failed_crypto_store(&crypto);
                return Err("registration attempt expired or was cancelled".to_string());
            }
        };
        match registration_result {
            Ok(_) => {
                let cleanup_crypto = crypto.clone();
                let completed = tokio::select! {
                    completed = crate::auth::finish_authenticated_client(
                        client,
                        crypto,
                        "registration",
                    ) => completed,
                    () = cancellation.cancelled() => {
                        crate::auth::cleanup_failed_crypto_store(&cleanup_crypto);
                        return Err("registration attempt expired or was cancelled".to_string());
                    }
                }?;
                if cancellation.is_cancelled() {
                    crate::auth::cleanup_failed_crypto_store(&cleanup_crypto);
                    return Err("registration attempt expired or was cancelled".to_string());
                }
                Ok(BeginRegistrationResult::Complete {
                    completed: Box::new(authenticated(completed, homeserver_url)),
                    attempt_id,
                })
            }
            Err(error) => {
                let Some(uiaa) = error.as_uiaa_response().cloned() else {
                    self.finish_attempt(&attempt_id).await;
                    crate::auth::cleanup_failed_crypto_store(&crypto);
                    return Err("registration request failed".to_string());
                };
                let step = match registration_challenge(&attempt_id, &client, &uiaa) {
                    Ok(step) => step,
                    Err(error) => {
                        self.finish_attempt(&attempt_id).await;
                        crate::auth::cleanup_failed_crypto_store(&crypto);
                        return Err(error);
                    }
                };
                let restored = self
                    .restore_registration(PendingRegistration {
                        _capacity: capacity,
                        owner,
                        client,
                        crypto,
                        request,
                        attempt_id: attempt_id.clone(),
                        uiaa,
                        email: None,
                        created_at,
                    })
                    .await;
                if !restored {
                    return Err("registration attempt expired or was cancelled".to_string());
                }
                Ok(BeginRegistrationResult::Challenge(step))
            }
        }
    }

    pub async fn request_registration_email(
        &self,
        source: &str,
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
            let _ = self.restore_registration(pending).await;
            return Err("registration email is not the current authentication stage".to_string());
        }
        let delivery_email = email.trim().to_owned();
        let Some((local_part, domain)) = delivery_email.rsplit_once('@') else {
            let _ = self.restore_registration(pending).await;
            return Err("enter an email address".to_string());
        };
        if local_part.is_empty() || domain.is_empty() {
            let _ = self.restore_registration(pending).await;
            return Err("enter an email address".to_string());
        }
        let address_key = format!("{local_part}@{}", domain.to_lowercase());
        let (client_secret, send_attempt) = if let Some(validation) = &pending.email {
            if validation.normalized_email != address_key {
                let _ = self.restore_registration(pending).await;
                return Err(
                    "cancel this registration and start again to use a different email address"
                        .to_string(),
                );
            }
            if validation.send_attempt >= MAX_MAILS_PER_ADDRESS as u32 {
                let _ = self.restore_registration(pending).await;
                return Err("registration email resend limit reached; start again".to_string());
            }
            if Instant::now() < validation.retry_not_before {
                let _ = self.restore_registration(pending).await;
                return Err("wait before requesting another registration email".to_string());
            }
            (
                validation.client_secret.clone(),
                validation.send_attempt + 1,
            )
        } else {
            (ClientSecret::new(), 1)
        };
        if let Err(error) = self.check_mail_quota(source, &address_key).await {
            let _ = self.restore_registration(pending).await;
            return Err(error);
        }
        let request = request_registration_token_via_email::v3::Request::new(
            client_secret.clone(),
            delivery_email,
            UInt::new_saturating(send_attempt.into()),
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
                let _ = self.restore_registration(pending).await;
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
                let _ = self.restore_registration(pending).await;
                return Err(error);
            }
        };
        let requires_token = submit_url.is_some();
        pending.email = Some(RegistrationEmail {
            client_secret,
            sid: response.sid,
            submit_url,
            homeserver: pending.client.homeserver(),
            normalized_email: address_key,
            send_attempt,
            retry_not_before: Instant::now() + REGISTRATION_EMAIL_RESEND_DELAY,
            submitted: false,
        });
        if cancellation.is_cancelled() {
            self.finish_cancelled_registration(attempt_id, pending)
                .await;
            return Err("registration cancelled".to_string());
        }
        let _ = self.restore_registration(pending).await;
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
                let _ = self.restore_registration(pending).await;
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
                let homeserver_url = pending.request.homeserver_url.clone();
                let cleanup_crypto = pending.crypto.clone();
                let completed = tokio::select! {
                    completed = crate::auth::finish_authenticated_client(
                    pending.client,
                    pending.crypto,
                    "registration",
                    ) => completed,
                    () = cancellation.cancelled() => {
                        crate::auth::cleanup_failed_crypto_store(&cleanup_crypto);
                        self.finish_attempt(attempt_id).await;
                        return Err("registration cancelled".to_string());
                    }
                }?;
                if cancellation.is_cancelled() {
                    crate::auth::cleanup_failed_crypto_store(&cleanup_crypto);
                    self.finish_attempt(attempt_id).await;
                    return Err("registration cancelled".to_string());
                }
                Ok(ContinueRegistrationResult::Complete {
                    completed: Box::new(authenticated(completed, homeserver_url)),
                    attempt_id: attempt_id.to_owned(),
                })
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
                    let _ = self.restore_registration(pending).await;
                    Ok(ContinueRegistrationResult::Challenge(step))
                } else if registration_error_allows_retry(&error) {
                    let _ = self.restore_registration(pending).await;
                    Err("registration request failed; retry this stage".to_string())
                } else {
                    self.finish_cancelled_registration(attempt_id, pending)
                        .await;
                    Err("registration ended: restart and review the account details".to_string())
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

    pub async fn commit_attempt(&self, owner: &str, attempt_id: &str) -> bool {
        let mut cancellations = self.cancellations.lock().await;
        let Some((attempt_owner, token)) = cancellations.remove(attempt_id) else {
            return false;
        };
        if attempt_owner != owner {
            cancellations.insert(attempt_id.to_owned(), (attempt_owner, token));
            return false;
        }
        !token.is_cancelled()
    }

    pub async fn request_password_reset(
        &self,
        source: String,
        owner: impl Into<AuthOwner>,
        homeserver_url: String,
        email: String,
    ) -> Result<PasswordResetChallenge, String> {
        let owner = owner.into();
        let capacity = self.reserve_capacity()?;
        let delivery_email = email.trim().to_owned();
        let Some((local_part, domain)) = delivery_email.rsplit_once('@') else {
            return Err("enter an email address".to_string());
        };
        if local_part.is_empty() || domain.is_empty() {
            return Err("enter an email address".to_string());
        }
        let address_key = format!("{local_part}@{}", domain.to_lowercase());
        let created_at = Instant::now();
        let attempt_id = opaque_id();
        let cancellation = CancellationToken::new();
        self.admit_owner_attempt(owner.clone(), attempt_id.clone(), cancellation.clone())
            .await;
        let owner = owner.id;
        self.spawn_expiry(attempt_id.clone());
        let client_result = tokio::select! {
            result = async {
                let (homeserver, http_client) =
                    crate::auth::validated_homeserver_client(&homeserver_url).await?;
                Client::builder()
                    .homeserver_url(homeserver)
                    .http_client(http_client)
                    .build()
                    .await
                    .map_err(|_| "could not start password reset".to_string())
            } => result,
            () = cancellation.cancelled() => {
                return Err("password reset attempt expired or was cancelled".to_string());
            }
        };
        let client = match client_result {
            Ok(client) => client,
            Err(_) => {
                self.finish_attempt(&attempt_id).await;
                return Err("could not start password reset".to_string());
            }
        };
        let oauth = client.oauth();
        let delegated = tokio::select! {
            result = oauth.server_metadata() => result.is_ok(),
            () = cancellation.cancelled() => {
                return Err("password reset attempt expired or was cancelled".to_string());
            }
        };
        if delegated {
            self.finish_attempt(&attempt_id).await;
            return Err(
                "password recovery is managed by this homeserver's identity provider".to_string(),
            );
        }
        self.check_mail_quota(&source, &address_key).await?;
        let client_secret = ClientSecret::new();
        let request = request_password_change_token_via_email::v3::Request::new(
            client_secret.clone(),
            delivery_email,
            UInt::new_saturating(1),
        );
        let response_result = tokio::select! {
            result = client.send(request) => result,
            () = cancellation.cancelled() => {
                return Err("password reset attempt expired or was cancelled".to_string());
            }
        };
        let (sid, submit_url, requires_token, synthetic) = match response_result {
            Ok(response) => {
                let submit_url = match sanitize_submit_url(
                    &client.homeserver(),
                    response.submit_url.as_deref(),
                    "password-reset",
                ) {
                    Ok(url) => url,
                    Err(error) => {
                        self.finish_attempt(&attempt_id).await;
                        return Err(error);
                    }
                };
                let requires_token = submit_url.is_some();
                (response.sid, submit_url, requires_token, false)
            }
            Err(_) => {
                // Keep an unknown-address rejection indistinguishable from a
                // sent email through confirmation as well as this response.
                let sid = serde_json::from_value(serde_json::json!(opaque_id()))
                    .map_err(|_| "could not start password reset".to_string())?;
                (sid, None, false, true)
            }
        };
        let restored = self
            .restore_password_reset(
                attempt_id.clone(),
                PendingPasswordReset {
                    _capacity: capacity,
                    owner,
                    client,
                    client_secret,
                    sid,
                    submit_url,
                    synthetic,
                    normalized_email: address_key,
                    send_attempt: 1,
                    retry_not_before: Instant::now() + REGISTRATION_EMAIL_RESEND_DELAY,
                    submitted: false,
                    created_at,
                },
            )
            .await;
        if !restored {
            return Err("password reset attempt expired or was cancelled".to_string());
        }
        Ok(PasswordResetChallenge {
            attempt_id,
            requires_token,
        })
    }

    pub async fn resend_password_reset(
        &self,
        source: &str,
        owner: &str,
        attempt_id: &str,
    ) -> Result<PasswordResetChallenge, String> {
        let cancellation = self
            .owned_cancellation(owner, attempt_id)
            .await
            .map_err(|_| "password reset attempt expired or was cancelled".to_string())?;
        let mut guard = self.password_resets.lock().await;
        let Some(current) = guard.get(attempt_id) else {
            return Err("password reset attempt expired or was cancelled".to_string());
        };
        if current.owner != owner || current.created_at.elapsed() > ATTEMPT_TTL {
            return Err("password reset attempt expired or was cancelled".to_string());
        }
        if current.send_attempt >= MAX_MAILS_PER_ADDRESS as u32 {
            return Err("password reset email resend limit reached; start again".to_string());
        }
        if Instant::now() < current.retry_not_before {
            return Err("wait before requesting another password reset email".to_string());
        }
        let mut pending = guard
            .remove(attempt_id)
            .ok_or_else(|| "password reset attempt expired or was cancelled".to_string())?;
        drop(guard);
        if let Err(error) = self
            .check_mail_quota(source, &pending.normalized_email)
            .await
        {
            let _ = self
                .restore_password_reset(attempt_id.to_owned(), pending)
                .await;
            return Err(error);
        }
        let send_attempt = pending.send_attempt + 1;
        let request = request_password_change_token_via_email::v3::Request::new(
            pending.client_secret.clone(),
            pending.normalized_email.clone(),
            UInt::new_saturating(send_attempt.into()),
        );
        let response = tokio::select! {
            response = pending.client.send(request) => response,
            () = cancellation.cancelled() => {
                return Err("password reset attempt expired or was cancelled".to_string());
            }
        };
        let response = match response {
            Ok(response) => response,
            Err(_) => {
                pending.send_attempt = send_attempt;
                pending.retry_not_before = Instant::now() + REGISTRATION_EMAIL_RESEND_DELAY;
                let requires_token = pending.submit_url.is_some();
                if !self
                    .restore_password_reset(attempt_id.to_owned(), pending)
                    .await
                {
                    return Err("password reset attempt expired or was cancelled".to_string());
                }
                return Ok(PasswordResetChallenge {
                    attempt_id: attempt_id.to_owned(),
                    requires_token,
                });
            }
        };
        let submit_url = match sanitize_submit_url(
            &pending.client.homeserver(),
            response.submit_url.as_deref(),
            "password-reset",
        ) {
            Ok(submit_url) => submit_url,
            Err(_) => {
                pending.send_attempt = send_attempt;
                pending.retry_not_before = Instant::now() + REGISTRATION_EMAIL_RESEND_DELAY;
                let requires_token = pending.submit_url.is_some();
                if !self
                    .restore_password_reset(attempt_id.to_owned(), pending)
                    .await
                {
                    return Err("password reset attempt expired or was cancelled".to_string());
                }
                return Ok(PasswordResetChallenge {
                    attempt_id: attempt_id.to_owned(),
                    requires_token,
                });
            }
        };
        pending.submit_url = submit_url;
        pending.sid = response.sid;
        pending.synthetic = false;
        pending.send_attempt = send_attempt;
        pending.retry_not_before = Instant::now() + REGISTRATION_EMAIL_RESEND_DELAY;
        pending.submitted = false;
        let requires_token = pending.submit_url.is_some();
        if !self
            .restore_password_reset(attempt_id.to_owned(), pending)
            .await
        {
            return Err("password reset attempt expired or was cancelled".to_string());
        }
        Ok(PasswordResetChallenge {
            attempt_id: attempt_id.to_owned(),
            requires_token,
        })
    }

    pub async fn confirm_password_reset(
        &self,
        owner: &str,
        attempt_id: &str,
        token: Option<String>,
        new_password: String,
    ) -> Result<(), String> {
        let cancellation = self
            .owned_cancellation(owner, attempt_id)
            .await
            .map_err(|_| "password reset attempt expired or was cancelled".to_string())?;
        let mut guard = self.password_resets.lock().await;
        let Some(current) = guard.get(attempt_id) else {
            return Err("password reset attempt expired or was cancelled".to_string());
        };
        if current.owner != owner || current.created_at.elapsed() > ATTEMPT_TTL {
            return Err("password reset attempt expired or was cancelled".to_string());
        }
        let mut pending = guard
            .remove(attempt_id)
            .ok_or_else(|| "password reset attempt expired or was cancelled".to_string())?;
        drop(guard);
        let result = tokio::select! {
            result = complete_password_reset(&mut pending, token.as_deref(), new_password) => result,
            () = cancellation.cancelled() => {
                Err("password reset attempt expired or was cancelled".to_string())
            }
        };
        if result.is_err() && pending.created_at.elapsed() <= ATTEMPT_TTL {
            if !self
                .restore_password_reset(attempt_id.to_owned(), pending)
                .await
            {
                self.finish_attempt(attempt_id).await;
            }
        } else {
            self.finish_attempt(attempt_id).await;
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

    async fn restore_registration(&self, pending: PendingRegistration) -> bool {
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
            true
        } else {
            crate::auth::cleanup_failed_crypto_store(&pending.crypto);
            false
        }
    }

    async fn restore_password_reset(
        &self,
        attempt_id: String,
        pending: PendingPasswordReset,
    ) -> bool {
        let cancellations = self.cancellations.lock().await;
        if cancellations
            .get(&attempt_id)
            .is_some_and(|(_, token)| !token.is_cancelled())
        {
            self.password_resets
                .lock()
                .await
                .insert(attempt_id, pending);
            true
        } else {
            false
        }
    }

    async fn check_mail_quota(&self, source_key: &str, email: &str) -> Result<(), String> {
        let address_key = email.trim();
        if address_key.is_empty() {
            return Err("enter an email address".to_string());
        }
        let mut hasher = Sha256::new();
        hasher.update(self.mail_quota_salt.as_bytes());
        hasher.update(address_key.as_bytes());
        let address_key = hasher
            .finalize()
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect::<String>();
        let cutoff = Instant::now() - MAIL_QUOTA_WINDOW;
        let now = Instant::now();
        let mut quota = self.mail_quota.lock().await;
        quota.by_source.retain(|_, attempts| {
            attempts.retain(|at| *at >= cutoff);
            !attempts.is_empty()
        });
        quota.by_address.retain(|_, attempts| {
            attempts.retain(|at| *at >= cutoff);
            !attempts.is_empty()
        });
        if (!quota.by_source.contains_key(source_key)
            && quota.by_source.len() >= MAX_MAIL_QUOTA_KEYS)
            || (!quota.by_address.contains_key(&address_key)
                && quota.by_address.len() >= MAX_MAIL_QUOTA_KEYS)
        {
            return Err("too many verification emails; try again later".to_string());
        }
        {
            let source = quota.by_source.entry(source_key.to_owned()).or_default();
            if source.len() >= MAX_MAILS_PER_SOURCE {
                return Err("too many verification emails; try again later".to_string());
            }
        }
        {
            let address = quota.by_address.entry(address_key.clone()).or_default();
            if address.len() >= MAX_MAILS_PER_ADDRESS {
                return Err("too many verification emails; try again later".to_string());
            }
        }
        quota
            .by_source
            .entry(source_key.to_owned())
            .or_default()
            .push(now);
        quota.by_address.entry(address_key).or_default().push(now);
        Ok(())
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

    async fn finish_attempt(&self, attempt_id: &str) {
        self.cancel_token(attempt_id).await;
    }

    async fn finish_cancelled_registration(&self, attempt_id: &str, pending: PendingRegistration) {
        self.cancel_token(attempt_id).await;
        crate::auth::cleanup_failed_crypto_store(&pending.crypto);
    }

    fn spawn_expiry(&self, attempt_id: String) {
        let store = self.clone();
        tokio::spawn(async move {
            let Some(cancellation) = store
                .cancellations
                .lock()
                .await
                .get(&attempt_id)
                .map(|(_, token)| token.clone())
            else {
                return;
            };
            tokio::select! {
                () = tokio::time::sleep(ATTEMPT_TTL) => {}
                () = cancellation.cancelled() => return,
            }
            let completion = {
                let _transition = store.transitions.lock().await;
                store.cancel_token(&attempt_id).await;
                if let Some(pending) = store.registrations.lock().await.remove(&attempt_id) {
                    crate::auth::cleanup_failed_crypto_store(&pending.crypto);
                }
                store.password_resets.lock().await.remove(&attempt_id);
                if let Some(pending) = store.sso_attempts.lock().await.remove(&attempt_id) {
                    crate::auth::cleanup_failed_crypto_store(&pending.crypto);
                }
                store.completed_sso.lock().await.remove(&attempt_id)
            };
            if let Some(completion) = completion {
                discard_completed_sso(completion).await;
            }
        });
    }
}

fn registration_error_allows_retry(error: &matrix_sdk::Error) -> bool {
    matches!(
        error.client_api_error_kind(),
        None | Some(ErrorKind::LimitExceeded(_))
    )
}

pub enum BeginRegistrationResult {
    Challenge(RegistrationStep),
    Complete {
        completed: Box<AuthenticatedClient>,
        attempt_id: String,
    },
}

pub enum ContinueRegistrationResult {
    Challenge(RegistrationStep),
    Complete {
        completed: Box<AuthenticatedClient>,
        attempt_id: String,
    },
}

pub enum PollSsoResult {
    Pending,
    Complete {
        completed: Box<AuthenticatedClient>,
        _capacity: OwnedSemaphorePermit,
    },
    Failed(String),
    Expired,
}

fn authenticated(
    value: (LoginResponse, Session, matrix_sdk::sync::SyncResponse),
    homeserver_url: String,
) -> AuthenticatedClient {
    (value.0, value.1, value.2, homeserver_url)
}

pub async fn get_login_flows(homeserver_url: &str) -> Result<LoginFlowSummary, String> {
    let (homeserver, http_client) =
        crate::auth::validated_homeserver_client(homeserver_url).await?;
    let client = Client::builder()
        .homeserver_url(homeserver)
        .http_client(http_client)
        .build()
        .await
        .map_err(|_| "could not discover login options for this homeserver".to_string())?;
    let response = client
        .matrix_auth()
        .get_login_types()
        .await
        .map_err(|_| "could not discover login options for this homeserver".to_string())?;
    let mut summary = summarize_login_flows(response.flows);
    if let Ok(metadata) = client.oauth().server_metadata().await {
        summary.delegated_auth = true;
        summary.account_management_url = metadata
            .account_management_uri
            .filter(|url| {
                url.scheme() == "https" && url.username().is_empty() && url.password().is_none()
            })
            .map(|url| url.to_string());
    }
    Ok(summary)
}

async fn login_with_token_inner(
    homeserver_url: String,
    token: String,
    has_persistence: bool,
    cancellation: &CancellationToken,
) -> Result<AuthenticatedClient, String> {
    let (client, crypto) = tokio::select! {
        result = crate::auth::build_client(&homeserver_url, has_persistence) => result?,
        () = cancellation.cancelled() => {
            return Err("token login expired or was cancelled".to_string());
        }
    };
    let matrix_auth = client.matrix_auth();
    let flow_request = matrix_auth.get_login_types();
    let flows = match tokio::select! {
        result = flow_request => result,
        () = cancellation.cancelled() => {
            crate::auth::cleanup_failed_crypto_store(&crypto);
            return Err("token login expired or was cancelled".to_string());
        }
    } {
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
    let login = client
        .matrix_auth()
        .login_token(&token)
        .initial_device_display_name("Charm")
        .send();
    if tokio::select! {
        result = login => result.is_err(),
        () = cancellation.cancelled() => true,
    } {
        crate::auth::cleanup_failed_crypto_store(&crypto);
        return Err(if cancellation.is_cancelled() {
            "token login expired or was cancelled".to_string()
        } else {
            "token login failed".to_string()
        });
    }
    let cleanup_crypto = crypto.clone();
    let completed = tokio::select! {
        result = crate::auth::finish_authenticated_client(client, crypto, "token login") => result,
        () = cancellation.cancelled() => {
            crate::auth::cleanup_failed_crypto_store(&cleanup_crypto);
            return Err("token login expired or was cancelled".to_string());
        }
    }?;
    if cancellation.is_cancelled() {
        crate::auth::cleanup_failed_crypto_store(&cleanup_crypto);
        return Err("token login expired or was cancelled".to_string());
    }
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
    match response {
        RegistrationAuthResponse::AcceptTerms if expected_stage == AuthType::Terms.as_str() => {
            let mut terms = Terms::new();
            terms.session = uiaa.session.clone();
            Ok(AuthData::Terms(terms))
        }
        RegistrationAuthResponse::CompleteDummy if expected_stage == AuthType::Dummy.as_str() => {
            let mut dummy = Dummy::new();
            dummy.session = uiaa.session.clone();
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
                        &validation.homeserver,
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
            identity.session = uiaa.session.clone();
            Ok(AuthData::EmailIdentity(identity))
        }
        RegistrationAuthResponse::AcknowledgeFallback { stage } if stage == expected_stage => {
            let session = uiaa
                .session
                .clone()
                .ok_or_else(|| "homeserver omitted the registration UIA session".to_string())?;
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
    let next_stage = next_registration_stage(uiaa)?;
    let fallback_url = match uiaa.session.as_deref() {
        Some(session) => registration_fallback_url(client, &next_stage, session)?,
        None if matches!(
            next_stage.as_str(),
            stage if stage == AuthType::Terms.as_str()
                || stage == AuthType::Dummy.as_str()
                || stage == AuthType::EmailIdentity.as_str()
        ) =>
        {
            String::new()
        }
        None => return Err("homeserver omitted the registration UIA session".to_string()),
    };
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
    homeserver: &reqwest::Url,
    sid: &matrix_sdk::ruma::OwnedSessionId,
    client_secret: &matrix_sdk::ruma::OwnedClientSecret,
    token: &str,
    flow: &str,
) -> Result<(), String> {
    let response = email_submission_client(submit_url, homeserver)
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
    let accepted = response
        .json::<serde_json::Value>()
        .await
        .ok()
        .and_then(|body| body.get("success").and_then(serde_json::Value::as_bool))
        .unwrap_or(false);
    if !accepted {
        return Err(format!("could not confirm {flow} email"));
    }
    Ok(())
}

async fn email_submission_client(
    submit_url: &reqwest::Url,
    homeserver: &reqwest::Url,
) -> Result<reqwest::Client, String> {
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
    // Plain HTTP submission URLs were already constrained to the
    // homeserver's exact origin by `sanitize_submit_url`. Permit their
    // private/loopback address only when the companion's documented local
    // insecure mode is explicitly enabled.
    let explicitly_local_same_origin = submit_url.origin() == homeserver.origin()
        && (host.eq_ignore_ascii_case("localhost") || host.parse::<std::net::IpAddr>().is_ok());
    let allow_insecure_local = submit_url.scheme() == "http"
        && explicitly_local_same_origin
        && std::env::var("CHARM_WEB_SERVER_INSECURE_COOKIES").as_deref() == Ok("1");
    if addresses.is_empty()
        || (!allow_insecure_local
            && !cfg!(test)
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
        .no_proxy()
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
                || (segments[0] & 0xffc0) == 0xfec0
                || (segments[0] == 0x0064 && segments[1] == 0xff9b && segments[2] == 0x0001)
                || (segments[0] == 0x2001 && segments[1] == 0x0db8)
                || (segments[0] == 0x0100 && segments[1..4] == [0, 0, 0]))
        }
    }
}

async fn complete_password_reset(
    pending: &mut PendingPasswordReset,
    token: Option<&str>,
    new_password: String,
) -> Result<(), String> {
    if let Some(submit_url) = &pending.submit_url {
        // The token may be single-use. A retry after the password-change
        // request fails must not submit it again.
        if !pending.submitted {
            let token = token
                .filter(|token| !token.is_empty())
                .ok_or_else(|| "enter the token from your password-reset email".to_string())?;
            submit_email(
                submit_url,
                &pending.client.homeserver(),
                &pending.sid,
                &pending.client_secret,
                token,
                "password-reset",
            )
            .await
            .map_err(|_| "could not confirm password reset".to_string())?;
            pending.submitted = true;
        }
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
        .with_request_config(RequestConfig::new().skip_auth())
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
        delegated_auth: false,
        account_management_url: None,
    };
    for flow in flows {
        match flow {
            LoginType::Password(_) => summary.password = true,
            LoginType::Token(_) => summary.token = true,
            LoginType::Sso(sso) => {
                summary.sso = true;
                for provider in sso.identity_providers {
                    if summary.identity_providers.len() >= MAX_IDENTITY_PROVIDERS
                        || summary
                            .identity_providers
                            .iter()
                            .any(|existing| existing.id == provider.id)
                    {
                        continue;
                    }
                    summary.identity_providers.push(LoginIdentityProvider {
                        id: provider.id,
                        name: sanitized_provider_name(&provider.name),
                        brand: provider.brand.map(|brand| brand.as_str().to_owned()),
                        icon: provider.icon.map(|icon| icon.to_string()),
                    });
                }
            }
            _ => {}
        }
    }
    summary
}

fn sso_selection_is_advertised(flows: &[LoginType], selected: Option<&str>) -> (bool, bool) {
    let sso_advertised = flows.iter().any(|flow| matches!(flow, LoginType::Sso(_)));
    let provider_allowed = selected.is_none_or(|selected| {
        flows.iter().any(|flow| {
            matches!(flow, LoginType::Sso(sso) if sso.identity_providers.iter().any(|provider| provider.id == selected))
        })
    });
    (sso_advertised, provider_allowed)
}

#[cfg(test)]
mod tests {
    use super::{
        is_public_network_ip, sanitize_submit_url, sso_selection_is_advertised,
        summarize_login_flows, PendingAuthStore, PendingPasswordReset, PendingSso, PollSsoResult,
        MAX_PENDING_AUTH_ATTEMPTS,
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

    async fn reset_store_for_resend(synthetic: bool) -> PendingAuthStore {
        let store = PendingAuthStore::default();
        let attempt_id = "reset-attempt".to_owned();
        let owner = "browser-a".to_owned();
        store.cancellations.lock().await.insert(
            attempt_id.clone(),
            (owner.clone(), CancellationToken::new()),
        );
        let client = matrix_sdk::Client::builder()
            .homeserver_url("http://127.0.0.1:9")
            .build()
            .await
            .expect("client");
        let sid =
            serde_json::from_value(serde_json::json!("reset-session")).expect("valid session id");
        store.password_resets.lock().await.insert(
            attempt_id,
            PendingPasswordReset {
                _capacity: store.reserve_capacity().expect("capacity"),
                owner,
                client,
                client_secret: matrix_sdk::ruma::ClientSecret::new(),
                sid,
                submit_url: None,
                synthetic,
                normalized_email: "alice@example.org".to_owned(),
                send_attempt: 1,
                retry_not_before: std::time::Instant::now(),
                submitted: false,
                created_at: std::time::Instant::now(),
            },
        );
        store
    }

    #[tokio::test]
    async fn synthetic_password_reset_resend_retries_upstream_with_generic_success() {
        let store = reset_store_for_resend(true).await;

        let challenge = store
            .resend_password_reset("source-a", "browser-a", "reset-attempt")
            .await
            .expect("synthetic resend stays generic");

        assert!(!challenge.requires_token);
        assert_eq!(
            store.password_resets.lock().await["reset-attempt"].send_attempt,
            2
        );
    }

    #[tokio::test]
    async fn upstream_password_reset_resend_failure_remains_generic_success() {
        let store = reset_store_for_resend(false).await;

        let challenge = store
            .resend_password_reset("source-a", "browser-a", "reset-attempt")
            .await
            .expect("upstream resend failure stays generic");

        assert!(!challenge.requires_token);
        assert_eq!(
            store.password_resets.lock().await["reset-attempt"].send_attempt,
            2
        );
    }

    #[tokio::test]
    async fn sso_callback_is_single_use_and_completion_is_owner_bound() {
        let homeserver_url = "http://127.0.0.1:9";
        let client = matrix_sdk::Client::builder()
            .homeserver_url(homeserver_url)
            .build()
            .await
            .expect("client");
        let store = PendingAuthStore::default();
        let cancellation = CancellationToken::new();
        store.cancellations.lock().await.insert(
            "sso-state".to_owned(),
            ("browser-a".to_owned(), cancellation.clone()),
        );
        store.sso_attempts.lock().await.insert(
            "sso-state".to_owned(),
            PendingSso {
                _capacity: store.reserve_capacity().expect("capacity"),
                owner: "browser-a".to_owned(),
                client,
                crypto: None,
                homeserver_url: homeserver_url.to_owned(),
                cancellation,
                created_at: std::time::Instant::now(),
            },
        );

        store
            .complete_sso_callback("sso-state", "invalid-login-token".to_owned())
            .await
            .expect("the callback is consumed even when token login fails");
        assert!(
            store.cancellations.lock().await.is_empty(),
            "a failed callback must not leave a stale in-flight marker"
        );
        assert!(matches!(
            store.poll_sso("browser-b", "sso-state").await,
            PollSsoResult::Expired
        ));
        assert!(matches!(
            store.poll_sso("browser-a", "sso-state").await,
            PollSsoResult::Failed(_)
        ));
        assert!(store
            .complete_sso_callback("sso-state", "replayed-token".to_owned())
            .await
            .is_err());
    }

    #[tokio::test]
    async fn sso_poll_stays_pending_while_the_callback_exchanges_its_token() {
        let store = PendingAuthStore::default();
        store.cancellations.lock().await.insert(
            "callback-in-flight".to_owned(),
            ("browser-a".to_owned(), CancellationToken::new()),
        );

        assert!(matches!(
            store.poll_sso("browser-a", "callback-in-flight").await,
            PollSsoResult::Pending
        ));
        assert!(matches!(
            store.poll_sso("browser-b", "callback-in-flight").await,
            PollSsoResult::Expired
        ));
    }

    #[tokio::test]
    async fn superseding_login_cleans_an_owned_sso_payload() {
        let homeserver_url = "http://127.0.0.1:9";
        let client = matrix_sdk::Client::builder()
            .homeserver_url(homeserver_url)
            .build()
            .await
            .expect("client");
        let store = PendingAuthStore::default();
        let old_cancellation = CancellationToken::new();
        store.cancellations.lock().await.insert(
            "old-sso".to_owned(),
            ("browser-a".to_owned(), old_cancellation.clone()),
        );
        store.sso_attempts.lock().await.insert(
            "old-sso".to_owned(),
            PendingSso {
                _capacity: store.reserve_capacity().expect("capacity"),
                owner: "browser-a".to_owned(),
                client,
                crypto: None,
                homeserver_url: homeserver_url.to_owned(),
                cancellation: old_cancellation.clone(),
                created_at: std::time::Instant::now(),
            },
        );

        store
            .admit_owner_attempt(
                "browser-a".to_owned(),
                "new-token-login".to_owned(),
                CancellationToken::new(),
            )
            .await;

        assert!(old_cancellation.is_cancelled());
        assert!(!store.sso_attempts.lock().await.contains_key("old-sso"));
        assert!(store
            .cancellations
            .lock()
            .await
            .contains_key("new-token-login"));
    }

    #[tokio::test]
    async fn owner_admission_waits_for_the_multi_owner_transition() {
        let store = PendingAuthStore::default();
        let transition = store.transitions.lock().await;
        let admission = store.admit_owner_attempt(
            "owner".to_owned(),
            "attempt".to_owned(),
            CancellationToken::new(),
        );
        tokio::pin!(admission);
        tokio::select! {
            biased;
            () = &mut admission => panic!("admission bypassed transition lock"),
            () = std::future::ready(()) => {}
        }
        assert!(store.cancellations.lock().await.is_empty());
        drop(transition);
        admission.await;
        assert!(store.cancellations.lock().await.contains_key("attempt"));
    }

    #[tokio::test]
    async fn replacement_admission_cancels_both_cookie_owners() {
        let store = PendingAuthStore::default();
        let preauth = CancellationToken::new();
        let discovery = CancellationToken::new();
        store
            .admit_owner_attempt("preauth".to_owned(), "old-a".to_owned(), preauth.clone())
            .await;
        store
            .admit_owner_attempt(
                "discovery".to_owned(),
                "old-b".to_owned(),
                discovery.clone(),
            )
            .await;
        let replacement = CancellationToken::new();
        store
            .admit_owner_attempt(
                AuthOwner {
                    id: "preauth".to_owned(),
                    superseded: vec!["preauth".to_owned(), "discovery".to_owned()],
                },
                "replacement".to_owned(),
                replacement.clone(),
            )
            .await;
        assert!(preauth.is_cancelled());
        assert!(discovery.is_cancelled());
        assert!(!replacement.is_cancelled());
        let cancellations = store.cancellations.lock().await;
        assert_eq!(cancellations.len(), 1);
        assert!(cancellations.contains_key("replacement"));
    }

    #[test]
    fn browser_sso_accepts_only_freshly_advertised_providers() {
        let flows = serde_json::from_value::<
            Vec<matrix_sdk::ruma::api::client::session::get_login_types::v3::LoginType>,
        >(serde_json::json!([{
            "type": "m.login.sso",
            "identity_providers": [{"id": "company", "name": "Company SSO"}]
        }]))
        .expect("login flows");

        assert_eq!(sso_selection_is_advertised(&flows, None), (true, true));
        assert_eq!(
            sso_selection_is_advertised(&flows, Some("company")),
            (true, true)
        );
        assert_eq!(
            sso_selection_is_advertised(&flows, Some("forged")),
            (true, false)
        );
        assert_eq!(sso_selection_is_advertised(&[], None), (false, true));
    }

    #[test]
    fn browser_login_summary_bounds_deduplicates_and_sanitizes_providers() {
        let providers = (0..40)
            .map(|index| {
                serde_json::json!({
                    "id": format!("provider-{index}"),
                    "name": format!("\u{202e}Provider {index}\n{}", "x".repeat(100)),
                })
            })
            .chain(std::iter::once(serde_json::json!({
                "id": "provider-0",
                "name": "duplicate",
            })))
            .collect::<Vec<_>>();
        let flows = serde_json::from_value(serde_json::json!([{
            "type": "m.login.sso",
            "identity_providers": providers,
        }]))
        .expect("login flows");

        let summary = summarize_login_flows(flows);

        assert_eq!(summary.identity_providers.len(), 32);
        assert_eq!(summary.identity_providers[0].id, "provider-0");
        assert!(!summary.identity_providers[0].name.contains('\u{202e}'));
        assert!(summary.identity_providers[0].name.len() <= 80);
    }

    #[tokio::test]
    async fn registration_commit_linearizes_against_cancellation() {
        let store = PendingAuthStore::default();
        store.cancellations.lock().await.insert(
            "winning-attempt".to_owned(),
            ("browser-a".to_owned(), CancellationToken::new()),
        );
        let cancelled = CancellationToken::new();
        cancelled.cancel();
        store.cancellations.lock().await.insert(
            "cancelled-attempt".to_owned(),
            ("browser-a".to_owned(), cancelled),
        );

        assert!(store.commit_attempt("browser-a", "winning-attempt").await);
        assert!(!store.commit_attempt("browser-a", "cancelled-attempt").await);
        assert!(!store.commit_attempt("browser-b", "cancelled-attempt").await);
        assert!(
            store.cancellations.lock().await.is_empty(),
            "commit must consume both successful and already-cancelled attempts"
        );
        assert!(
            store
                .owned_cancellation("browser-a", "winning-attempt")
                .await
                .is_err(),
            "a committed attempt must no longer be cancellable"
        );
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

    #[tokio::test]
    async fn browser_owner_cancellation_supersedes_both_cookie_namespaces() {
        let store = PendingAuthStore::default();
        let preauth = CancellationToken::new();
        let discovery = CancellationToken::new();
        {
            let mut cancellations = store.cancellations.lock().await;
            cancellations.insert(
                "preauth-attempt".to_owned(),
                ("preauth-owner".to_owned(), preauth.clone()),
            );
            cancellations.insert(
                "discovery-attempt".to_owned(),
                ("discovery-owner".to_owned(), discovery.clone()),
            );
        }

        store
            .cancel_owners(&["preauth-owner", "discovery-owner"])
            .await;

        assert!(preauth.is_cancelled());
        assert!(discovery.is_cancelled());
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
            "fec0::1",
            "64:ff9b:1::1",
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
