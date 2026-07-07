//! Encrypted-at-rest persistence for logged-in web-client sessions — Spec
//! 16's Design section option 2 (server-side encrypted-at-rest, persisted
//! per logged-in user, survives a restart), replacing sub-PR A's
//! in-memory-only `SessionStore` (option 1).
//!
//! **Data model:** one JSON file (`<data dir>/sessions.enc.json`) holding an
//! AES-256-GCM-encrypted blob per logged-in session, keyed by the same
//! opaque token already issued as the session cookie (see `session.rs`) —
//! so a restart doesn't just avoid dropping the *account* login, it keeps
//! *already-issued browser cookies* valid across it too, with no re-login
//! required.
//!
//! **Key management:** there's no OS keychain to lean on server-side (unlike
//! desktop's `persistence::get_or_create_passphrase` in `src-tauri`), so the
//! encryption key comes from the `CHARM_WEB_SERVER_MASTER_KEY` environment
//! variable — a base64-encoded 32-byte key the deployer generates once
//! (`openssl rand -base64 32`) and injects into the process environment
//! (e.g. via a secrets manager or systemd's `EnvironmentFile=`, matching how
//! `matrix-vps` already provisions Synapse's registration shared secret —
//! see the crate README's Deployment section). This crate never generates,
//! rotates, or stores that key itself; losing it makes every persisted
//! session unrecoverable (same failure mode as losing a desktop keychain),
//! which is an acceptable tradeoff for this deployment's scale rather than
//! standing up a separate secrets-manager integration.
//!
//! Persistence is opt-in: with no `CHARM_WEB_SERVER_MASTER_KEY` set,
//! [`PersistenceStore::from_env`] returns `Ok(None)` and the server falls
//! back to sub-PR A's in-memory-only behavior rather than refusing to start
//! — this keeps local dev and the test suite working with zero setup.

use std::path::PathBuf;

use aes_gcm::aead::{Aead, AeadCore, KeyInit, OsRng};
use aes_gcm::{Aes256Gcm, Key, Nonce};
use base64::engine::general_purpose::STANDARD as BASE64;
use base64::Engine;
use matrix_sdk::authentication::matrix::MatrixSession;
use serde::{Deserialize, Serialize};

pub const MASTER_KEY_ENV: &str = "CHARM_WEB_SERVER_MASTER_KEY";
pub const DATA_DIR_ENV: &str = "CHARM_WEB_SERVER_DATA_DIR";

#[derive(Debug, Clone, Serialize, Deserialize)]
struct PersistedSession {
    token: String,
    homeserver_url: String,
    session: MatrixSession,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct EncryptedBlob {
    /// base64-encoded 12-byte AES-GCM nonce, fresh per encryption (see
    /// [`PersistenceStore::encrypt`]) — never reused across saves, even for
    /// the same session, which is why the whole blob (not just changed
    /// fields) is re-encrypted on every [`PersistenceStore::save`].
    nonce: String,
    ciphertext: String,
}

pub struct PersistenceStore {
    key: Aes256Gcm,
    path: PathBuf,
    /// Serializes read-modify-write cycles against the single shared file —
    /// two concurrent logins racing a read-then-write would otherwise let
    /// the second writer's `write_all` silently clobber the first login's
    /// just-saved entry (last-writer-wins on the *whole file*, not a merge).
    lock: tokio::sync::Mutex<()>,
}

impl PersistenceStore {
    /// See the module doc comment for the env vars this reads. Returns
    /// `Ok(None)`, not an error, when `CHARM_WEB_SERVER_MASTER_KEY` is unset.
    pub fn from_env() -> Result<Option<Self>, String> {
        let Ok(key_b64) = std::env::var(MASTER_KEY_ENV) else {
            return Ok(None);
        };
        Self::with_key_b64_and_dir(
            &key_b64,
            &std::env::var(DATA_DIR_ENV).unwrap_or_else(|_| "./data".to_string()),
        )
        .map(Some)
    }

    fn with_key_b64_and_dir(key_b64: &str, dir: &str) -> Result<Self, String> {
        let key_bytes = BASE64
            .decode(key_b64.trim())
            .map_err(|e| format!("{MASTER_KEY_ENV} is not valid base64: {e}"))?;
        if key_bytes.len() != 32 {
            return Err(format!(
                "{MASTER_KEY_ENV} must decode to exactly 32 bytes (AES-256), got {}",
                key_bytes.len()
            ));
        }
        let key = Aes256Gcm::new(Key::<Aes256Gcm>::from_slice(&key_bytes));

        let dir = PathBuf::from(dir);
        std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;

        Ok(Self {
            key,
            path: dir.join("sessions.enc.json"),
            lock: tokio::sync::Mutex::new(()),
        })
    }

    #[cfg(test)]
    pub fn new_for_test(dir: &std::path::Path, key_bytes: [u8; 32]) -> Self {
        let key = Aes256Gcm::new(Key::<Aes256Gcm>::from_slice(&key_bytes));
        Self {
            key,
            path: dir.join("sessions.enc.json"),
            lock: tokio::sync::Mutex::new(()),
        }
    }

    async fn read_all(&self) -> Vec<PersistedSession> {
        let Ok(bytes) = tokio::fs::read(&self.path).await else {
            return Vec::new();
        };
        let Ok(blobs) = serde_json::from_slice::<Vec<EncryptedBlob>>(&bytes) else {
            return Vec::new();
        };
        blobs
            .iter()
            .filter_map(|blob| match self.decrypt(blob) {
                Ok(session) => Some(session),
                Err(e) => {
                    // A corrupt/undecryptable entry (wrong key, truncated
                    // write, bit rot) shouldn't take down every *other*
                    // account's persisted session — skip it, same
                    // fail-open-per-entry tradeoff as desktop's
                    // `try_restore_session` dropping a single dead session.
                    tracing::warn!("dropping unreadable persisted session entry: {e}");
                    None
                }
            })
            .collect()
    }

    fn decrypt(&self, blob: &EncryptedBlob) -> Result<PersistedSession, String> {
        let nonce_bytes = BASE64.decode(&blob.nonce).map_err(|e| e.to_string())?;
        let ciphertext = BASE64.decode(&blob.ciphertext).map_err(|e| e.to_string())?;
        let plaintext = self
            .key
            .decrypt(Nonce::from_slice(&nonce_bytes), ciphertext.as_ref())
            .map_err(|e| e.to_string())?;
        serde_json::from_slice(&plaintext).map_err(|e| e.to_string())
    }

    fn encrypt(&self, session: &PersistedSession) -> Result<EncryptedBlob, String> {
        let plaintext = serde_json::to_vec(session).map_err(|e| e.to_string())?;
        let nonce = Aes256Gcm::generate_nonce(&mut OsRng);
        let ciphertext = self
            .key
            .encrypt(&nonce, plaintext.as_ref())
            .map_err(|e| e.to_string())?;
        Ok(EncryptedBlob {
            nonce: BASE64.encode(nonce),
            ciphertext: BASE64.encode(ciphertext),
        })
    }

    /// Persists (or replaces, on re-login) `token`'s session.
    pub async fn save(
        &self,
        token: &str,
        homeserver_url: &str,
        session: &MatrixSession,
    ) -> Result<(), String> {
        let _guard = self.lock.lock().await;
        let mut all = self.read_all().await;
        all.retain(|s| s.token != token);
        all.push(PersistedSession {
            token: token.to_string(),
            homeserver_url: homeserver_url.to_string(),
            session: session.clone(),
        });
        self.write_all(&all).await
    }

    /// Removes `token`'s persisted session (logout) — a no-op, not an error,
    /// if it was never persisted (e.g. persistence was enabled after this
    /// session logged in).
    pub async fn remove(&self, token: &str) -> Result<(), String> {
        let _guard = self.lock.lock().await;
        let mut all = self.read_all().await;
        all.retain(|s| s.token != token);
        self.write_all(&all).await
    }

    async fn write_all(&self, all: &[PersistedSession]) -> Result<(), String> {
        let blobs: Vec<EncryptedBlob> = all
            .iter()
            .map(|s| self.encrypt(s))
            .collect::<Result<_, _>>()?;
        let json = serde_json::to_vec(&blobs).map_err(|e| e.to_string())?;
        // Write-then-rename (same-volume, atomic on every platform this
        // deploys to) so a crash mid-write never leaves the real file
        // truncated/corrupt for the next startup to choke on.
        let tmp_path = self.path.with_extension("tmp");
        tokio::fs::write(&tmp_path, &json)
            .await
            .map_err(|e| e.to_string())?;
        tokio::fs::rename(&tmp_path, &self.path)
            .await
            .map_err(|e| e.to_string())
    }

    /// Rebuilds a live `Client` (and runs an initial sync, same as
    /// `auth::login`/`auth::register`) for every persisted session, paired
    /// with the token it should be reinserted into `SessionStore` under.
    /// Called once at startup (see `main.rs`), before the HTTP listener
    /// starts accepting connections. A session whose access token the
    /// homeserver has since revoked — or that otherwise fails to restore —
    /// is dropped rather than blocking startup; that browser's next request
    /// with the now-dead cookie gets an ordinary 401 and re-logs-in, same
    /// self-healing tradeoff desktop's `try_restore_session` makes.
    pub async fn restore_all(&self) -> Vec<(String, crate::session::Session)> {
        let mut restored = Vec::new();
        for entry in self.read_all().await {
            match restore_one(&entry).await {
                Ok(session) => restored.push((entry.token, session)),
                Err(e) => {
                    tracing::warn!(
                        "dropping persisted session for {}: failed to restore: {e}",
                        entry.session.meta.user_id
                    );
                }
            }
        }
        restored
    }
}

async fn restore_one(entry: &PersistedSession) -> Result<crate::session::Session, String> {
    let client = matrix_sdk::Client::builder()
        .server_name_or_homeserver_url(&entry.homeserver_url)
        .build()
        .await
        .map_err(|e| e.to_string())?;
    client
        .matrix_auth()
        .restore_session(
            entry.session.clone(),
            matrix_sdk::store::RoomLoadSettings::default(),
        )
        .await
        .map_err(|e| e.to_string())?;

    // Re-establish local room-store state the same way a fresh login does
    // (see `auth::login`'s doc comment) — a restored session with no sync
    // since restart would otherwise 404/empty-out every room route until
    // the sync loop's own first iteration completes.
    client
        .sync_once(matrix_sdk::config::SyncSettings::default())
        .await
        .map_err(|e| e.to_string())?;

    Ok(crate::session::Session::new(
        client,
        entry.session.meta.user_id.to_string(),
    ))
}

#[cfg(test)]
mod tests {
    use super::*;
    use matrix_sdk::authentication::SessionTokens;
    use matrix_sdk::ruma::device_id;
    use matrix_sdk::SessionMeta;

    fn scratch_dir(name: &str) -> PathBuf {
        let suffix: String = format!("{:x}", rand::random::<u64>());
        let path =
            std::env::temp_dir().join(format!("charm-web-server-persistence-{name}-{suffix}"));
        std::fs::create_dir_all(&path).unwrap();
        path
    }

    fn dummy_session(mxid: &str) -> MatrixSession {
        MatrixSession {
            meta: SessionMeta {
                user_id: matrix_sdk::ruma::UserId::parse(mxid).unwrap(),
                device_id: device_id!("TESTDEVICE").to_owned(),
            },
            tokens: SessionTokens {
                access_token: "test-access-token".to_string(),
                refresh_token: None,
            },
        }
    }

    #[tokio::test]
    async fn save_and_reload_round_trips_under_the_same_token() {
        let dir = scratch_dir("round-trip");
        let store = PersistenceStore::new_for_test(&dir, [7u8; 32]);

        store
            .save(
                "tok-a",
                "https://example.invalid",
                &dummy_session("@alice:example.invalid"),
            )
            .await
            .unwrap();

        let all = store.read_all().await;
        assert_eq!(all.len(), 1);
        assert_eq!(all[0].token, "tok-a");
        assert_eq!(all[0].homeserver_url, "https://example.invalid");
        assert_eq!(
            all[0].session.meta.user_id.as_str(),
            "@alice:example.invalid"
        );
    }

    #[tokio::test]
    async fn on_disk_file_never_carries_plaintext_secrets() {
        let dir = scratch_dir("no-plaintext");
        let store = PersistenceStore::new_for_test(&dir, [3u8; 32]);
        store
            .save(
                "tok-secret",
                "https://example.invalid",
                &dummy_session("@bob:example.invalid"),
            )
            .await
            .unwrap();

        let raw = tokio::fs::read_to_string(dir.join("sessions.enc.json"))
            .await
            .unwrap();
        assert!(!raw.contains("test-access-token"));
        assert!(!raw.contains("@bob:example.invalid"));
    }

    #[tokio::test]
    async fn wrong_key_cannot_decrypt_another_deployments_data() {
        let dir = scratch_dir("wrong-key");
        let writer = PersistenceStore::new_for_test(&dir, [1u8; 32]);
        writer
            .save(
                "tok-a",
                "https://example.invalid",
                &dummy_session("@carol:example.invalid"),
            )
            .await
            .unwrap();

        let reader = PersistenceStore::new_for_test(&dir, [2u8; 32]);
        assert!(reader.read_all().await.is_empty());
    }

    #[tokio::test]
    async fn remove_drops_only_the_matching_token() {
        let dir = scratch_dir("remove");
        let store = PersistenceStore::new_for_test(&dir, [9u8; 32]);
        store
            .save(
                "tok-a",
                "https://example.invalid",
                &dummy_session("@dave:example.invalid"),
            )
            .await
            .unwrap();
        store
            .save(
                "tok-b",
                "https://example.invalid",
                &dummy_session("@erin:example.invalid"),
            )
            .await
            .unwrap();

        store.remove("tok-a").await.unwrap();

        let remaining = store.read_all().await;
        assert_eq!(remaining.len(), 1);
        assert_eq!(remaining[0].token, "tok-b");
    }

    #[tokio::test]
    async fn re_saving_the_same_token_replaces_rather_than_duplicates() {
        let dir = scratch_dir("resave");
        let store = PersistenceStore::new_for_test(&dir, [5u8; 32]);
        store
            .save(
                "tok-a",
                "https://old.example.invalid",
                &dummy_session("@frank:example.invalid"),
            )
            .await
            .unwrap();
        store
            .save(
                "tok-a",
                "https://new.example.invalid",
                &dummy_session("@frank:example.invalid"),
            )
            .await
            .unwrap();

        let all = store.read_all().await;
        assert_eq!(all.len(), 1);
        assert_eq!(all[0].homeserver_url, "https://new.example.invalid");
    }
}
