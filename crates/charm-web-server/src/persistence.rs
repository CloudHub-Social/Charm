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
use std::sync::Arc;

use aes_gcm::aead::{Aead, AeadCore, KeyInit, OsRng};
use aes_gcm::{Aes256Gcm, Key, Nonce};
use base64::engine::general_purpose::STANDARD as BASE64;
use base64::Engine;
use matrix_sdk::authentication::matrix::MatrixSession;
use object_store::aws::AmazonS3Builder;
use object_store::local::LocalFileSystem;
use object_store::path::Path as ObjectPath;
use object_store::{ObjectStore, PutPayload};
use serde::{Deserialize, Serialize};

pub const MASTER_KEY_ENV: &str = "CHARM_WEB_SERVER_MASTER_KEY";
pub const DATA_DIR_ENV: &str = "CHARM_WEB_SERVER_DATA_DIR";

/// Set to switch the backing store from the local-disk default (fine for
/// dev/tests and the VPS this crate used to deploy to) to DO Spaces — the
/// deploy target this crate now targets has no persistent volume, so
/// `sessions.enc.json` has to live somewhere that survives a redeploy on its
/// own. All four `*_SPACES_*` vars below are required together once this one
/// is set; see [`PersistenceStore::from_env`].
pub const SPACES_BUCKET_ENV: &str = "CHARM_WEB_SERVER_SPACES_BUCKET";
pub const SPACES_REGION_ENV: &str = "CHARM_WEB_SERVER_SPACES_REGION";
pub const SPACES_ENDPOINT_ENV: &str = "CHARM_WEB_SERVER_SPACES_ENDPOINT";
pub const SPACES_ACCESS_KEY_ID_ENV: &str = "CHARM_WEB_SERVER_SPACES_ACCESS_KEY_ID";
pub const SPACES_SECRET_ACCESS_KEY_ENV: &str = "CHARM_WEB_SERVER_SPACES_SECRET_ACCESS_KEY";

/// Object key the encrypted session blob is stored under, in either backend
/// — same name the local-disk backend has always used.
const SESSIONS_OBJECT_KEY: &str = "sessions.enc.json";

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

/// Builds the DO Spaces (S3-compatible) backend once [`SPACES_BUCKET_ENV`] is
/// set — the other four `*_SPACES_*` vars are then required too, since a
/// bucket name alone isn't enough to reach a non-AWS S3-compatible endpoint
/// or authenticate against it.
fn spaces_store_from_env(bucket: &str) -> Result<object_store::aws::AmazonS3, String> {
    let require = |name: &str| {
        std::env::var(name)
            .map_err(|_| format!("{name} must be set when {SPACES_BUCKET_ENV} is set"))
    };
    // `object_store` requires that, when `with_virtual_hosted_style_request`
    // is enabled, the endpoint it's given already has the bucket name in it
    // (see `AmazonS3Builder::with_virtual_hosted_style_request`'s own doc
    // comment) — it does not insert one itself. `SPACES_ENDPOINT_ENV` is
    // meant to hold the plain *region* endpoint (e.g.
    // `https://tor1.digitaloceanspaces.com`, matching this repo's existing
    // sccache config), so build the actual per-bucket virtual-hosted
    // endpoint here rather than expecting every caller of this env var to
    // already know to include the bucket subdomain themselves.
    let endpoint = virtual_hosted_endpoint(bucket, &require(SPACES_ENDPOINT_ENV)?);
    AmazonS3Builder::new()
        .with_bucket_name(bucket)
        .with_region(require(SPACES_REGION_ENV)?)
        .with_endpoint(endpoint)
        .with_access_key_id(require(SPACES_ACCESS_KEY_ID_ENV)?)
        .with_secret_access_key(require(SPACES_SECRET_ACCESS_KEY_ENV)?)
        .with_virtual_hosted_style_request(true)
        .build()
        .map_err(|e| e.to_string())
}

/// Turns a plain region endpoint (e.g. `https://tor1.digitaloceanspaces.com`)
/// into the per-bucket virtual-hosted endpoint `object_store` requires when
/// `with_virtual_hosted_style_request(true)` is set (e.g.
/// `https://my-bucket.tor1.digitaloceanspaces.com`).
fn virtual_hosted_endpoint(bucket: &str, region_endpoint: &str) -> String {
    match region_endpoint.split_once("://") {
        Some((scheme, host)) => format!("{scheme}://{bucket}.{host}"),
        None => format!("{bucket}.{region_endpoint}"),
    }
}

pub struct PersistenceStore {
    key: Aes256Gcm,
    store: Arc<dyn ObjectStore>,
    object_path: ObjectPath,
    /// Serializes read-modify-write cycles against the single shared object —
    /// two concurrent logins racing a read-then-write would otherwise let
    /// the second writer's `write_all_raw` silently clobber the first login's
    /// just-saved entry (last-writer-wins on the *whole object*, not a merge).
    lock: tokio::sync::Mutex<()>,
}

impl PersistenceStore {
    /// See the module doc comment for the env vars this reads. Returns
    /// `Ok(None)`, not an error, when `CHARM_WEB_SERVER_MASTER_KEY` is unset.
    ///
    /// Backend selection: [`SPACES_BUCKET_ENV`] set → DO Spaces (the four
    /// `*_SPACES_*` vars are then all required); otherwise local disk under
    /// [`DATA_DIR_ENV`] (default `./data`), same as before this crate could
    /// target a deploy platform with no persistent volume.
    pub fn from_env() -> Result<Option<Self>, String> {
        let Ok(key_b64) = std::env::var(MASTER_KEY_ENV) else {
            return Ok(None);
        };
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

        let store: Arc<dyn ObjectStore> = if let Ok(bucket) = std::env::var(SPACES_BUCKET_ENV) {
            Arc::new(spaces_store_from_env(&bucket)?)
        } else {
            let dir = std::env::var(DATA_DIR_ENV).unwrap_or_else(|_| "./data".to_string());
            let dir = PathBuf::from(dir);
            std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
            Arc::new(LocalFileSystem::new_with_prefix(&dir).map_err(|e| e.to_string())?)
        };

        Ok(Some(Self {
            key,
            store,
            object_path: ObjectPath::from(SESSIONS_OBJECT_KEY),
            lock: tokio::sync::Mutex::new(()),
        }))
    }

    #[cfg(test)]
    pub fn new_for_test(dir: &std::path::Path, key_bytes: [u8; 32]) -> Self {
        let key = Aes256Gcm::new(Key::<Aes256Gcm>::from_slice(&key_bytes));
        let store =
            LocalFileSystem::new_with_prefix(dir).expect("scratch dir must exist for tests");
        Self {
            key,
            store: Arc::new(store),
            object_path: ObjectPath::from(SESSIONS_OBJECT_KEY),
            lock: tokio::sync::Mutex::new(()),
        }
    }

    /// Every blob on disk, undecrypted — the only representation `save`/
    /// `remove` ever read or write, so an entry neither of them touches
    /// (any token but the one being saved/removed) round-trips byte-for-byte
    /// even if this deployment could no longer decrypt it at all.
    /// `Ok(vec![])` when the file simply doesn't exist yet (first run —
    /// nothing to preserve). `Err` when it exists but its *top-level* JSON
    /// is invalid (truncated write, hand-edited into garbage, disk
    /// corruption) — as opposed to a single malformed entry *within* an
    /// otherwise-valid array, which is scoped to that one entry below and
    /// never surfaces as an error here. The distinction is load-bearing for
    /// [`Self::save`]/[`Self::remove`]: they must *never* treat "I
    /// couldn't parse what's there" the same as "there's nothing there" —
    /// doing so would make an unrelated login/logout permanently overwrite
    /// a merely-unreadable-right-now file with just the one new/removed
    /// entry, destroying every other still-possibly-recoverable session in
    /// it.
    async fn read_all_raw(&self) -> Result<Vec<EncryptedBlob>, String> {
        let bytes = match self.store.get(&self.object_path).await {
            Ok(result) => result.bytes().await.map_err(|e| e.to_string())?,
            Err(object_store::Error::NotFound { .. }) => return Ok(Vec::new()),
            Err(e) => return Err(e.to_string()),
        };
        // Per-entry, not per-file, *within* the array: deserializing the
        // whole array in one shot means a single entry missing/mistyping a
        // field (an old file format, a hand-edited/bit-rotted byte) would
        // fail the *entire* array and be indistinguishable from "nothing
        // ever written here" — every other account's still-perfectly-good
        // blob along with it. Parsing into loosely-typed `Value`s first and
        // converting each independently keeps that failure scoped to the
        // one bad entry, same as `read_all`'s per-entry decrypt failures
        // below. The *outer* `Vec<Value>` parse failing, though (not valid
        // JSON at all) is exactly the top-level-corruption case this
        // function must report as `Err`, not silently swallow.
        let values: Vec<serde_json::Value> =
            serde_json::from_slice(&bytes).map_err(|e| e.to_string())?;
        Ok(values
            .into_iter()
            .filter_map(|value| serde_json::from_value(value).ok())
            .collect())
    }

    /// Decrypts every blob, for the startup-only restore path
    /// ([`Self::restore_all`]) that actually needs live `PersistedSession`
    /// values. Unlike `save`/`remove`, this only ever *reads* — it never
    /// rewrites the file other entries live in — so both an unreadable
    /// top-level file and a single unreadable entry within it are fine to
    /// fail open here (log and treat as "nothing more to restore") rather
    /// than propagating an error nothing downstream would act on
    /// differently.
    async fn read_all(&self) -> Vec<PersistedSession> {
        let blobs = match self.read_all_raw().await {
            Ok(blobs) => blobs,
            Err(e) => {
                tracing::warn!("sessions.enc.json is unreadable, restoring nothing: {e}");
                return Vec::new();
            }
        };
        blobs
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
        let mut blobs = self.read_all_raw().await?;
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
        let mut blobs = self.read_all_raw().await?;
        blobs.retain(|b| b.token_hash != hash);
        self.write_all_raw(&blobs).await
    }

    async fn write_all_raw(&self, blobs: &[EncryptedBlob]) -> Result<(), String> {
        let json = serde_json::to_vec(blobs).map_err(|e| e.to_string())?;
        // A single whole-object `put` — every backend `object_store` gives us
        // here (S3-compatible Spaces, and its own `LocalFileSystem`, which
        // itself writes via a temp-file-then-rename under the hood) already
        // makes this atomic, so a crash mid-write can never leave a reader
        // seeing a truncated/corrupt object, without this module hand-rolling
        // that guarantee itself.
        self.store
            .put(&self.object_path, PutPayload::from(json))
            .await
            .map(|_| ())
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
    /// Tuple order: `(token, homeserver_url, session, initial_response,
    /// originally_persisted_access_token)`. The last field is what was
    /// actually on disk *before* `restore_one`'s own `sync_once` ran —
    /// deliberately not re-read from the just-restored `Session`'s client,
    /// since that `sync_once` can itself trigger a token refresh; see
    /// `sync_loop::PersistHandle::initial_access_token`'s doc comment for
    /// why that distinction matters.
    pub async fn restore_all(
        &self,
    ) -> Vec<(
        String,
        String,
        crate::session::Session,
        matrix_sdk::sync::SyncResponse,
        String,
    )> {
        // Concurrent, not one-at-a-time: each entry's `restore_one` makes a
        // real network call (build a client, restore the session, run an
        // initial `sync_once`), so restoring serially means one slow or
        // unreachable homeserver — or simply having many saved sessions —
        // blocks every *other*, perfectly-healthy account's restore behind
        // it, and this whole function runs before `main.rs` starts
        // accepting connections. `RESTORE_TIMEOUT` bounds how long any
        // single entry can hold up the rest: a homeserver that never
        // responds at all can't block startup indefinitely either.
        const RESTORE_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(15);

        let entries = self.read_all().await;
        let attempts = entries.into_iter().map(|entry| async move {
            let originally_persisted_access_token = entry.session.tokens.access_token.clone();
            let outcome = tokio::time::timeout(RESTORE_TIMEOUT, restore_one(&entry)).await;
            (entry, originally_persisted_access_token, outcome)
        });
        let outcomes = futures_util::future::join_all(attempts).await;

        let mut restored = Vec::new();
        for (entry, originally_persisted_access_token, outcome) in outcomes {
            match outcome {
                Ok(Ok((session, initial_response))) => restored.push((
                    entry.token,
                    entry.homeserver_url,
                    session,
                    initial_response,
                    originally_persisted_access_token,
                )),
                Ok(Err(e)) => {
                    tracing::warn!(
                        "dropping persisted session for {}: failed to restore: {e}",
                        entry.session.meta.user_id
                    );
                }
                Err(_) => {
                    tracing::warn!(
                        "dropping persisted session for {}: restore timed out after {RESTORE_TIMEOUT:?}",
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

    // Session (and its event handlers) built before the sync below, not
    // after — see `sync_loop::register_event_handlers`'s doc comment for
    // why: a to-device verification event landing in this restore's own
    // initial sync is processed synchronously as part of it and never
    // replayed later, so the handler must already be registered.
    let session =
        crate::session::Session::new(client.clone(), entry.session.meta.user_id.to_string());
    crate::sync_loop::register_event_handlers(
        &client,
        session.events.clone(),
        session.pending_verification_events.clone(),
        session.profile_and_presence_snapshots(),
    );

    // Re-establish local room-store state the same way a fresh login does
    // (see `auth::login`'s doc comment, including why the response is
    // returned rather than discarded — `sync_loop::spawn` reuses it as its
    // own initial state instead of long-polling a second, redundant sync).
    let initial_response = client
        .sync_once(matrix_sdk::config::SyncSettings::default())
        .await
        .map_err(|e| e.to_string())?;

    Ok((session, initial_response))
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
    async fn reconstructed_store_restores_session_from_same_disk_file() {
        let dir = scratch_dir("restart-survival");
        let key = [8u8; 32];
        let writer = PersistenceStore::new_for_test(&dir, key);

        writer
            .save(
                "tok-restart",
                "https://example.invalid",
                &dummy_session("@restart:example.invalid"),
            )
            .await
            .unwrap();

        drop(writer);

        let reader = PersistenceStore::new_for_test(&dir, key);
        let all = reader.read_all().await;

        assert_eq!(all.len(), 1);
        assert_eq!(all[0].token, "tok-restart");
        assert_eq!(all[0].homeserver_url, "https://example.invalid");
        assert_eq!(
            all[0].session.meta.user_id.as_str(),
            "@restart:example.invalid"
        );
        assert_eq!(all[0].session.tokens.access_token, "test-access-token");
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

    /// Guards a single env var for the lifetime of the guard, restoring
    /// whatever was there before (or unsetting it again) on drop — same
    /// pattern as `tests/http_api.rs`'s `EnvVarGuard`, needed here since
    /// `from_env` reads process env directly and these tests all share one
    /// test binary's process.
    // The two `from_env_*` tests below mutate process-wide env vars
    // (`std::env::set_var`/`remove_var`), and `cargo test` runs `#[test]`s
    // concurrently within one process by default — without serializing them
    // against each other, one test's `EnvVarGuard` could restore/clear a var
    // mid-way through the other's `from_env` call. Same problem
    // `tests/http_api.rs`'s `ALLOWED_ORIGIN_ENV_LOCK` exists for.
    static ENV_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

    struct EnvVarGuard {
        key: &'static str,
        previous: Option<String>,
    }

    impl EnvVarGuard {
        fn set(key: &'static str, value: &str) -> Self {
            let previous = std::env::var(key).ok();
            std::env::set_var(key, value);
            Self { key, previous }
        }

        fn remove(key: &'static str) -> Self {
            let previous = std::env::var(key).ok();
            std::env::remove_var(key);
            Self { key, previous }
        }
    }

    impl Drop for EnvVarGuard {
        fn drop(&mut self) {
            match &self.previous {
                Some(value) => std::env::set_var(self.key, value),
                None => std::env::remove_var(self.key),
            }
        }
    }

    /// Regression test: `object_store`'s `AmazonS3Builder` does not insert
    /// the bucket name into a custom endpoint on its own even with
    /// `with_virtual_hosted_style_request(true)` — a prior version of
    /// `spaces_store_from_env` passed the bare region endpoint straight
    /// through, which would have made every Spaces request fail once
    /// deployed (never caught locally since these tests never exercised the
    /// Spaces backend against a real or mocked S3 endpoint).
    #[test]
    fn virtual_hosted_endpoint_inserts_bucket_as_subdomain() {
        assert_eq!(
            virtual_hosted_endpoint("my-bucket", "https://tor1.digitaloceanspaces.com"),
            "https://my-bucket.tor1.digitaloceanspaces.com"
        );
    }

    /// No `SPACES_BUCKET_ENV` set → `from_env` must still build the
    /// local-disk backend it always has, not silently do nothing or error.
    #[test]
    fn from_env_without_spaces_bucket_uses_local_disk() {
        let _lock = ENV_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let dir = scratch_dir("from-env-local");
        let _master_key = EnvVarGuard::set(MASTER_KEY_ENV, &BASE64.encode([1u8; 32]));
        let _data_dir = EnvVarGuard::set(DATA_DIR_ENV, dir.to_str().unwrap());
        let _no_bucket = EnvVarGuard::remove(SPACES_BUCKET_ENV);

        let store = PersistenceStore::from_env().unwrap();
        assert!(
            store.is_some(),
            "a master key alone must be enough to opt in"
        );
    }

    /// `SPACES_BUCKET_ENV` set without its sibling `*_SPACES_*` vars must
    /// fail closed with a clear error rather than silently falling back to
    /// local disk (which would mean "configured for Spaces" deployments
    /// quietly writing to an ephemeral filesystem instead) or panicking.
    #[test]
    fn from_env_with_spaces_bucket_but_missing_credentials_errors() {
        let _lock = ENV_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let _master_key = EnvVarGuard::set(MASTER_KEY_ENV, &BASE64.encode([1u8; 32]));
        let _bucket = EnvVarGuard::set(SPACES_BUCKET_ENV, "charm-web-server-sessions");
        let _no_region = EnvVarGuard::remove(SPACES_REGION_ENV);
        let _no_endpoint = EnvVarGuard::remove(SPACES_ENDPOINT_ENV);
        let _no_access_key = EnvVarGuard::remove(SPACES_ACCESS_KEY_ID_ENV);
        let _no_secret_key = EnvVarGuard::remove(SPACES_SECRET_ACCESS_KEY_ENV);

        let err = match PersistenceStore::from_env() {
            Err(e) => e,
            Ok(_) => panic!(
                "a bucket with no region/endpoint/credentials must fail closed, not fall back"
            ),
        };
        // Whichever of the four missing vars this happens to check first
        // (not asserting a specific one — that's an implementation detail
        // of `spaces_store_from_env`'s field-building order, not a contract
        // worth pinning down here).
        assert!(
            [
                SPACES_REGION_ENV,
                SPACES_ENDPOINT_ENV,
                SPACES_ACCESS_KEY_ID_ENV,
                SPACES_SECRET_ACCESS_KEY_ENV
            ]
            .iter()
            .any(|name| err.contains(name)),
            "got: {err}"
        );
    }
}
