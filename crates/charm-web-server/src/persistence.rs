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
//!
//! **Known gap: the Olm/Megolm crypto store is not persisted.** This only
//! saves the `MatrixSession` (access/refresh tokens + device id) — on
//! restart, [`restore_one`] rebuilds a fresh in-memory `Client` and restores
//! just that token, so the *cookie* stays valid, but the crypto state that
//! client had learned before the restart (room keys, device/cross-signing
//! trust) is gone. Encrypted-room history a session had already decrypted,
//! and any established verification, don't survive a restart even though
//! the session nominally does. Desktop avoids this because its `Client` is
//! always backed by matrix-sdk's encrypted SQLite store (see
//! `src-tauri/src/matrix/persistence.rs`'s `matrix_store/` layout), which
//! this crate doesn't yet provision per web session. Fixing this properly
//! means giving each persisted session its own encrypted `matrix-sdk-sqlite`
//! store directory (keyed the same way as [`crate::media_cache`], via
//! `charm_lib::matrix::persistence::account_key`) and building the restored
//! `Client` against that store instead of a bare in-memory one — a real
//! slice of work in its own right, not a one-line fix, so it's called out
//! here rather than silently shipped incomplete.

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
    /// SHA-256 hex digest of the plaintext token this blob was saved under
    /// — plaintext on disk (unlike everything else in the blob), but
    /// one-way: it lets [`PersistenceStore::save`]/[`PersistenceStore::
    /// remove`] find *which* blob corresponds to a given token by hashing
    /// that token and comparing, without ever decrypting it (or any other
    /// entry) first. That matters for entries this deployment can no longer
    /// decrypt at all (wrong key after a rotation, bit rot, a truncated
    /// write): without this, `save`/`remove` would have to fall back to
    /// silently dropping every entry they can't read while rewriting the
    /// file for an unrelated token — real, unrecoverable data loss for
    /// every *other* account, just because someone else logged in or out.
    /// Storing the raw token itself here instead (skipping the hash) would
    /// avoid that same problem more simply, but the token *is* the bearer
    /// credential a restored session's cookie carries — reusing it, in
    /// plaintext, as this blob's own index would hand out that same bearer
    /// credential to anyone who can merely read this file, without needing
    /// the master key at all.
    token_hash: String,
    /// base64-encoded 12-byte AES-GCM nonce, fresh per encryption (see
    /// [`PersistenceStore::encrypt`]) — never reused across saves, even for
    /// the same session, which is why the whole blob (not just changed
    /// fields) is re-encrypted on every [`PersistenceStore::save`].
    nonce: String,
    ciphertext: String,
}

fn token_hash(token: &str) -> String {
    use sha2::{Digest, Sha256};
    let digest = Sha256::digest(token.as_bytes());
    digest.iter().map(|b| format!("{b:02x}")).collect()
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

    /// Every blob on disk, undecrypted — the only representation `save`/
    /// `remove` ever read or write, so an entry neither of them touches
    /// (any token but the one being saved/removed) round-trips byte-for-byte
    /// even if this deployment could no longer decrypt it at all.
    async fn read_all_raw(&self) -> Vec<EncryptedBlob> {
        let Ok(bytes) = tokio::fs::read(&self.path).await else {
            return Vec::new();
        };
        // Per-entry, not per-file: deserializing the whole array in one
        // shot means a single entry missing/mistyping a field (an old file
        // format, a hand-edited/bit-rotted byte) would fail the *entire*
        // array and silently return nothing — every other account's still-
        // perfectly-good blob along with it. Parsing into loosely-typed
        // `Value`s first and converting each independently keeps that
        // failure scoped to the one bad entry, same as `read_all`'s
        // per-entry decrypt failures below.
        let Ok(values) = serde_json::from_slice::<Vec<serde_json::Value>>(&bytes) else {
            return Vec::new();
        };
        values
            .into_iter()
            .filter_map(|value| serde_json::from_value(value).ok())
            .collect()
    }

    /// Decrypts every blob, for the startup-only restore path
    /// ([`Self::restore_all`]) that actually needs live `PersistedSession`
    /// values — an entry that fails to decrypt here is dropped with a
    /// warning (see [`Self::restore_all`]'s doc comment for why that
    /// particular tradeoff, unlike `save`/`remove`, is fine: it only ever
    /// *reads*, never rewrites the file other entries live in).
    async fn read_all(&self) -> Vec<PersistedSession> {
        self.read_all_raw()
            .await
            .iter()
            .filter_map(|blob| match self.decrypt(blob) {
                Ok(session) => Some(session),
                Err(e) => {
                    tracing::warn!("dropping unreadable persisted session entry: {e}");
                    None
                }
            })
            .collect()
    }

    fn decrypt(&self, blob: &EncryptedBlob) -> Result<PersistedSession, String> {
        let nonce_bytes = BASE64.decode(&blob.nonce).map_err(|e| e.to_string())?;
        // `Nonce::from_slice` panics (doesn't error) on a slice that isn't
        // exactly 12 bytes — a corrupt/truncated on-disk entry must not be
        // able to take the whole process down via that panic, so validate
        // the length ourselves and return an `Err` instead, which
        // `read_all` already treats as "drop this one entry, keep going".
        if nonce_bytes.len() != 12 {
            return Err(format!(
                "corrupt session entry: nonce is {} bytes, expected 12",
                nonce_bytes.len()
            ));
        }
        let ciphertext = BASE64.decode(&blob.ciphertext).map_err(|e| e.to_string())?;
        let plaintext = self
            .key
            .decrypt(Nonce::from_slice(&nonce_bytes), ciphertext.as_ref())
            .map_err(|e| e.to_string())?;
        serde_json::from_slice(&plaintext).map_err(|e| e.to_string())
    }

    fn encrypt(&self, token: &str, session: &PersistedSession) -> Result<EncryptedBlob, String> {
        let plaintext = serde_json::to_vec(session).map_err(|e| e.to_string())?;
        let nonce = Aes256Gcm::generate_nonce(&mut OsRng);
        let ciphertext = self
            .key
            .encrypt(&nonce, plaintext.as_ref())
            .map_err(|e| e.to_string())?;
        Ok(EncryptedBlob {
            token_hash: token_hash(token),
            nonce: BASE64.encode(nonce),
            ciphertext: BASE64.encode(ciphertext),
        })
    }

    /// Persists (or replaces, on re-login) `token`'s session. Only ever
    /// touches the one blob whose `token_hash` matches — every other entry
    /// is carried through untouched (not decrypted, not re-encrypted), so a
    /// blob this deployment can no longer decrypt at all still survives a
    /// concurrent login/logout for a completely different account.
    pub async fn save(
        &self,
        token: &str,
        homeserver_url: &str,
        session: &MatrixSession,
    ) -> Result<(), String> {
        let _guard = self.lock.lock().await;
        let hash = token_hash(token);
        let mut blobs = self.read_all_raw().await;
        blobs.retain(|b| b.token_hash != hash);
        blobs.push(self.encrypt(
            token,
            &PersistedSession {
                token: token.to_string(),
                homeserver_url: homeserver_url.to_string(),
                session: session.clone(),
            },
        )?);
        self.write_all_raw(&blobs).await
    }

    /// Removes `token`'s persisted session (logout) — a no-op, not an error,
    /// if it was never persisted (e.g. persistence was enabled after this
    /// session logged in). Same untouched-unless-matching-hash guarantee as
    /// [`Self::save`].
    pub async fn remove(&self, token: &str) -> Result<(), String> {
        let _guard = self.lock.lock().await;
        let hash = token_hash(token);
        let mut blobs = self.read_all_raw().await;
        blobs.retain(|b| b.token_hash != hash);
        self.write_all_raw(&blobs).await
    }

    async fn write_all_raw(&self, blobs: &[EncryptedBlob]) -> Result<(), String> {
        let json = serde_json::to_vec(blobs).map_err(|e| e.to_string())?;
        // Write-then-rename (same-volume, atomic on every platform this
        // deploys to) so a crash mid-write never leaves the real file
        // truncated/corrupt for the next startup to choke on.
        let tmp_path = self.path.with_extension("tmp");
        tokio::fs::write(&tmp_path, &json)
            .await
            .map_err(|e| e.to_string())?;
        // Unlike POSIX, `rename` on Windows fails with `AlreadyExists`
        // rather than atomically replacing an existing destination — this
        // deploys to Linux (`matrix-vps`) in practice, but falling back to
        // remove-then-rename keeps this correct cross-platform rather than
        // silently relying on a POSIX-only guarantee.
        match tokio::fs::rename(&tmp_path, &self.path).await {
            Ok(()) => Ok(()),
            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => {
                tokio::fs::remove_file(&self.path)
                    .await
                    .map_err(|e| e.to_string())?;
                tokio::fs::rename(&tmp_path, &self.path)
                    .await
                    .map_err(|e| e.to_string())
            }
            Err(e) => Err(e.to_string()),
        }
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
    pub async fn restore_all(
        &self,
    ) -> Vec<(
        String,
        String,
        crate::session::Session,
        matrix_sdk::sync::SyncResponse,
    )> {
        let mut restored = Vec::new();
        for entry in self.read_all().await {
            match restore_one(&entry).await {
                Ok((session, initial_response)) => {
                    restored.push((entry.token, entry.homeserver_url, session, initial_response))
                }
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

async fn restore_one(
    entry: &PersistedSession,
) -> Result<(crate::session::Session, matrix_sdk::sync::SyncResponse), String> {
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
    // (see `auth::login`'s doc comment, including why the response is
    // returned rather than discarded — `sync_loop::spawn` reuses it as its
    // own initial state instead of long-polling a second, redundant sync).
    let initial_response = client
        .sync_once(matrix_sdk::config::SyncSettings::default())
        .await
        .map_err(|e| e.to_string())?;

    Ok((
        crate::session::Session::new(client, entry.session.meta.user_id.to_string()),
        initial_response,
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

    /// Regression test: a corrupt entry whose decoded nonce isn't exactly 12
    /// bytes must be dropped as unreadable (see `decrypt`'s length check),
    /// not panic `Nonce::from_slice` and take the whole read down with it —
    /// `read_all` must still return every *other* valid entry.
    #[tokio::test]
    async fn a_malformed_nonce_is_dropped_not_panicked_on() {
        let dir = scratch_dir("malformed-nonce");
        let store = PersistenceStore::new_for_test(&dir, [4u8; 32]);
        store
            .save(
                "tok-good",
                "https://example.invalid",
                &dummy_session("@grace:example.invalid"),
            )
            .await
            .unwrap();

        // Splice in a second, corrupt entry with a too-short nonce, bypassing
        // `save`/`encrypt` (which would never produce one) to simulate a
        // truncated/bit-rotted on-disk write.
        let raw = tokio::fs::read_to_string(dir.join("sessions.enc.json"))
            .await
            .unwrap();
        let mut blobs: Vec<serde_json::Value> = serde_json::from_str(&raw).unwrap();
        blobs.push(serde_json::json!({
            "token_hash": token_hash("tok-corrupt"),
            "nonce": BASE64.encode([0u8; 4]),
            "ciphertext": BASE64.encode([0u8; 16]),
        }));
        tokio::fs::write(
            dir.join("sessions.enc.json"),
            serde_json::to_vec(&blobs).unwrap(),
        )
        .await
        .unwrap();

        let all = store.read_all().await;
        assert_eq!(all.len(), 1, "the corrupt entry must be dropped, not panic");
        assert_eq!(all[0].token, "tok-good");
    }

    /// Regression test for the actual data-loss bug: `save`/`remove` used
    /// to go through `read_all` (decrypt-everything, drop what fails) and
    /// write back only what survived — so an entry this deployment could no
    /// longer decrypt at all (wrong key after rotation, bit rot) was
    /// permanently deleted the next time *any* unrelated account logged in
    /// or out. `save`/`remove` now key off a plaintext `token_hash` and
    /// never decrypt/rewrite an entry they're not targeting — an
    /// undecryptable blob must round-trip through both operations
    /// byte-for-byte.
    #[tokio::test]
    async fn save_and_remove_never_drop_an_undecryptable_unrelated_entry() {
        let dir = scratch_dir("undecryptable-survives");
        let store = PersistenceStore::new_for_test(&dir, [6u8; 32]);
        store
            .save(
                "tok-real",
                "https://example.invalid",
                &dummy_session("@henry:example.invalid"),
            )
            .await
            .unwrap();

        // Splice in a blob this store can never decrypt (wrong-key
        // ciphertext, correct-length nonce) under its own token — simulates
        // a master-key rotation that left one old entry undecryptable
        // rather than a length-corrupt one.
        let corrupt_blob = serde_json::json!({
            "token_hash": token_hash("tok-undecryptable"),
            "nonce": BASE64.encode([1u8; 12]),
            "ciphertext": BASE64.encode([2u8; 32]),
        });
        let raw = tokio::fs::read_to_string(dir.join("sessions.enc.json"))
            .await
            .unwrap();
        let mut blobs: Vec<serde_json::Value> = serde_json::from_str(&raw).unwrap();
        blobs.push(corrupt_blob.clone());
        tokio::fs::write(
            dir.join("sessions.enc.json"),
            serde_json::to_vec(&blobs).unwrap(),
        )
        .await
        .unwrap();

        // A totally unrelated login...
        store
            .save(
                "tok-other",
                "https://example.invalid",
                &dummy_session("@iris:example.invalid"),
            )
            .await
            .unwrap();
        // ...and an unrelated logout...
        store.remove("tok-other").await.unwrap();

        // ...must never have touched the undecryptable entry.
        let raw_after = tokio::fs::read_to_string(dir.join("sessions.enc.json"))
            .await
            .unwrap();
        let blobs_after: Vec<serde_json::Value> = serde_json::from_str(&raw_after).unwrap();
        assert!(
            blobs_after.contains(&corrupt_blob),
            "the undecryptable entry must survive unrelated save/remove calls untouched"
        );

        // The real, decryptable entry must also still be there.
        let all = store.read_all().await;
        assert!(all.iter().any(|s| s.token == "tok-real"));
    }
}
