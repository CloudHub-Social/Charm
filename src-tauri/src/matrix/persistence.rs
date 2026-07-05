use std::path::PathBuf;

use matrix_sdk::authentication::matrix::MatrixSession;
use matrix_sdk::authentication::oauth::{ClientId, OAuthSession, UserSession};
use rand::distr::Alphanumeric;
use rand::RngExt;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};

/// Single fixed keychain service for this app. Account names below distinguish
/// entry types; a `session` entry is per-app not per-account, matching the
/// current single-account scope (see `MatrixState` doc comment).
const KEYCHAIN_SERVICE: &str = "social.cloudhub.charm";
const PASSPHRASE_ACCOUNT: &str = "sqlite-store-passphrase";
const SESSION_ACCOUNT: &str = "session";
/// Separate from `SESSION_ACCOUNT`: password/SSO login use matrix-sdk's
/// classic `matrix_auth()` module and its `MatrixSession`, but QR login is
/// OAuth-native (`client.oauth()`) and uses an unrelated `OAuthSession` type
/// — matrix-sdk doesn't unify the two, so neither does this persistence
/// layer. `try_restore_session` checks both accounts.
const OAUTH_SESSION_ACCOUNT: &str = "oauth-session";

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SavedSession {
    pub homeserver_url: String,
    pub session: MatrixSession,
}

/// `OAuthSession` itself only derives `Debug, Clone` (no `Serialize`), and
/// `ClientId` doesn't round-trip through serde as cleanly as a plain
/// `String` — so this mirrors its shape field-for-field rather than wrapping
/// it directly.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SavedOAuthSession {
    pub homeserver_url: String,
    pub client_id: String,
    pub user: UserSession,
}

impl SavedOAuthSession {
    pub fn from_oauth_session(homeserver_url: &str, session: &OAuthSession) -> Self {
        Self {
            homeserver_url: homeserver_url.to_string(),
            client_id: session.client_id.as_str().to_string(),
            user: session.user.clone(),
        }
    }

    pub fn into_oauth_session(self) -> OAuthSession {
        OAuthSession {
            client_id: ClientId::new(self.client_id),
            user: self.user,
        }
    }
}

/// Where the SQLCipher-encrypted matrix-rust-sdk store lives on disk. The
/// encryption key itself never goes anywhere near this path — see
/// `get_or_create_passphrase`.
pub fn store_path(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?
        .join("matrix_store");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir)
}

/// Fetches the SQLCipher passphrase from the OS keychain, generating and
/// storing a new random one on first run. Never written to disk in plaintext
/// and never stored in the same SQLite file it protects.
pub fn get_or_create_passphrase() -> Result<String, String> {
    let entry =
        keyring::Entry::new(KEYCHAIN_SERVICE, PASSPHRASE_ACCOUNT).map_err(|e| e.to_string())?;

    match entry.get_password() {
        Ok(passphrase) => Ok(passphrase),
        Err(keyring::Error::NoEntry) => {
            let passphrase: String = rand::rng()
                .sample_iter(&Alphanumeric)
                .take(32)
                .map(char::from)
                .collect();
            entry.set_password(&passphrase).map_err(|e| e.to_string())?;
            Ok(passphrase)
        }
        Err(e) => Err(e.to_string()),
    }
}

pub fn save_session(homeserver_url: &str, session: &MatrixSession) -> Result<(), String> {
    let entry =
        keyring::Entry::new(KEYCHAIN_SERVICE, SESSION_ACCOUNT).map_err(|e| e.to_string())?;
    let saved = SavedSession {
        homeserver_url: homeserver_url.to_string(),
        session: session.clone(),
    };
    let json = serde_json::to_string(&saved).map_err(|e| e.to_string())?;
    entry.set_password(&json).map_err(|e| e.to_string())
}

pub fn load_session() -> Result<Option<SavedSession>, String> {
    let entry =
        keyring::Entry::new(KEYCHAIN_SERVICE, SESSION_ACCOUNT).map_err(|e| e.to_string())?;
    match entry.get_password() {
        Ok(json) => serde_json::from_str(&json)
            .map(Some)
            .map_err(|e| e.to_string()),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(e) => Err(e.to_string()),
    }
}

/// Removes the saved session, e.g. after a restore attempt fails because the
/// homeserver revoked the access token — without this, every future launch
/// would keep retrying the same dead session.
pub fn clear_session() -> Result<(), String> {
    let entry =
        keyring::Entry::new(KEYCHAIN_SERVICE, SESSION_ACCOUNT).map_err(|e| e.to_string())?;
    match entry.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) => Err(e.to_string()),
    }
}

pub fn save_oauth_session(homeserver_url: &str, session: &OAuthSession) -> Result<(), String> {
    let entry =
        keyring::Entry::new(KEYCHAIN_SERVICE, OAUTH_SESSION_ACCOUNT).map_err(|e| e.to_string())?;
    let saved = SavedOAuthSession::from_oauth_session(homeserver_url, session);
    let json = serde_json::to_string(&saved).map_err(|e| e.to_string())?;
    entry.set_password(&json).map_err(|e| e.to_string())
}

pub fn load_oauth_session() -> Result<Option<SavedOAuthSession>, String> {
    let entry =
        keyring::Entry::new(KEYCHAIN_SERVICE, OAUTH_SESSION_ACCOUNT).map_err(|e| e.to_string())?;
    match entry.get_password() {
        Ok(json) => serde_json::from_str(&json)
            .map(Some)
            .map_err(|e| e.to_string()),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(e) => Err(e.to_string()),
    }
}

pub fn clear_oauth_session() -> Result<(), String> {
    let entry =
        keyring::Entry::new(KEYCHAIN_SERVICE, OAUTH_SESSION_ACCOUNT).map_err(|e| e.to_string())?;
    match entry.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) => Err(e.to_string()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use matrix_sdk::authentication::SessionTokens;
    use matrix_sdk::ruma::{device_id, user_id};
    use matrix_sdk::SessionMeta;

    fn dummy_session() -> MatrixSession {
        MatrixSession {
            meta: SessionMeta {
                user_id: user_id!("@charm-persistence-test:localhost").to_owned(),
                device_id: device_id!("TESTDEVICE").to_owned(),
            },
            tokens: SessionTokens {
                access_token: "test-access-token".to_string(),
                refresh_token: None,
            },
        }
    }

    /// Exercises the real OS keychain, not a mock — this is the actual
    /// security-relevant boundary (passphrase and tokens never touching disk
    /// in plaintext), so a test that doesn't hit it wouldn't prove much.
    #[test]
    fn session_round_trips_through_keychain() {
        clear_session().unwrap();
        assert!(load_session().unwrap().is_none());

        let session = dummy_session();
        save_session("https://example.invalid", &session).unwrap();

        let loaded = load_session().unwrap().expect("session was just saved");
        assert_eq!(loaded.homeserver_url, "https://example.invalid");
        assert_eq!(loaded.session.meta.user_id, session.meta.user_id);
        assert_eq!(
            loaded.session.tokens.access_token,
            session.tokens.access_token
        );

        clear_session().unwrap();
        assert!(load_session().unwrap().is_none());
    }

    fn dummy_oauth_session() -> OAuthSession {
        OAuthSession {
            client_id: ClientId::new("test-client-id".to_string()),
            user: UserSession {
                meta: SessionMeta {
                    user_id: user_id!("@charm-persistence-test:localhost").to_owned(),
                    device_id: device_id!("TESTDEVICE").to_owned(),
                },
                tokens: SessionTokens {
                    access_token: "test-oauth-access-token".to_string(),
                    refresh_token: None,
                },
            },
        }
    }

    #[test]
    fn oauth_session_round_trips_through_keychain() {
        clear_oauth_session().unwrap();
        assert!(load_oauth_session().unwrap().is_none());

        let session = dummy_oauth_session();
        save_oauth_session("https://example.invalid", &session).unwrap();

        let loaded = load_oauth_session()
            .unwrap()
            .expect("session was just saved");
        assert_eq!(loaded.homeserver_url, "https://example.invalid");
        assert_eq!(loaded.client_id, session.client_id.as_str());
        assert_eq!(loaded.user.meta.user_id, session.user.meta.user_id);
        assert_eq!(
            loaded.user.tokens.access_token,
            session.user.tokens.access_token
        );

        clear_oauth_session().unwrap();
        assert!(load_oauth_session().unwrap().is_none());
    }

    #[test]
    fn passphrase_is_stable_across_calls() {
        let first = get_or_create_passphrase().unwrap();
        let second = get_or_create_passphrase().unwrap();
        assert_eq!(first, second);
        assert_eq!(first.len(), 32);
    }
}
