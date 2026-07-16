//! Encrypted-at-rest persistence for logged-in web-client sessions — Spec
//! 16's Design section option 2 (server-side encrypted-at-rest, persisted
//! per logged-in user, survives a restart), replacing sub-PR A's
//! in-memory-only `SessionStore` (option 1).
//!
//! **Data model:** one AES-256-GCM-encrypted object per logged-in session,
//! stored at `sessions/<sha256(token)>.json` under the object store (see
//! backend selection below) — keyed by the same opaque token already issued
//! as the session cookie (see `session.rs`), so a restart doesn't just avoid
//! dropping the *account* login, it keeps *already-issued browser cookies*
//! valid across it too, with no re-login required. One object per session
//! (rather than one shared file/object holding every session, sub-PR B's
//! original design) means an unrelated login/logout is a `put`/`delete`
//! against a completely different key — no shared read-modify-write cycle
//! for two sessions to race on, which matters once a deploy target can run
//! more than one process against the same store at once (see
//! [`PersistenceStore::save`]'s doc comment).
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
//! **The Olm/Megolm crypto store is now also persisted (Spec 25).** Each
//! session's `PersistedSession` additionally carries a `crypto_store_key` /
//! `crypto_passphrase` pair identifying an on-disk `matrix-sdk-sqlite` store
//! (see [`crate::crypto_store`]) — [`restore_one`] rebuilds the `Client`
//! against that store instead of a bare in-memory one, so room keys,
//! cross-signing identity, and device trust survive a restart along with the
//! session token. Both fields are `Option`: `None` for a session persisted
//! before this shipped (falls back to the pre-Spec-25 bare in-memory
//! behavior for that one session, same fail-open tolerance as any other
//! unreadable/corrupt entry) or when persistence was configured without ever
//! successfully opening a store.
//!
//! When [`crate::crypto_backup::CryptoBackupStore`] is configured, the
//! irreplaceable crypto database is also snapshotted to its own private
//! object store under an independently managed encryption key. The local
//! directory remains the live SDK store; snapshots are restored before the
//! SDK opens it after an App Platform redeploy.

use std::collections::HashSet;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};

use aes_gcm::aead::{Aead, AeadCore, KeyInit, OsRng, Payload};
use aes_gcm::{Aes256Gcm, Key, Nonce};
use base64::engine::general_purpose::STANDARD as BASE64;
use base64::Engine;
use futures_util::StreamExt;
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
/// persisted sessions have to live somewhere that survives a redeploy on
/// their own. All four `*_SPACES_*` vars below are required together once
/// this one is set; see [`PersistenceStore::from_env`].
pub const SPACES_BUCKET_ENV: &str = "CHARM_WEB_SERVER_SPACES_BUCKET";
pub const SPACES_REGION_ENV: &str = "CHARM_WEB_SERVER_SPACES_REGION";
pub const SPACES_ENDPOINT_ENV: &str = "CHARM_WEB_SERVER_SPACES_ENDPOINT";
pub const SPACES_ACCESS_KEY_ID_ENV: &str = "CHARM_WEB_SERVER_SPACES_ACCESS_KEY_ID";
pub const SPACES_SECRET_ACCESS_KEY_ENV: &str = "CHARM_WEB_SERVER_SPACES_SECRET_ACCESS_KEY";

/// Prefix every persisted session object lives under, in either backend —
/// one object per session at `<SESSIONS_PREFIX>/<sha256(token)>.json`.
const SESSIONS_PREFIX: &str = "sessions";

/// Bounds how long any single [`restore_one`] call (build a client, restore
/// the session, run an initial `sync_once`) can run before being treated as
/// a failure — shared by [`PersistenceStore::restore_all`] (bounds total
/// startup time against a slow/unreachable homeserver) and
/// [`PersistenceStore::restore_by_token`] (bounds a single request's
/// on-demand restore the same way, so a hung DNS lookup or a homeserver that
/// never responds can't tie up a request — and the connection handling
/// it — indefinitely).
const RESTORE_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(15);
const SNAPSHOT_READY_ATTEMPTS: usize = 5;
const SNAPSHOT_READY_RETRY_DELAY: std::time::Duration = std::time::Duration::from_millis(100);

#[derive(Debug, Clone, Serialize, Deserialize)]
struct PersistedSession {
    token: String,
    homeserver_url: String,
    session: MatrixSession,
    /// Directory key (`crypto_store::generate_store_key`) for this session's
    /// on-disk crypto store — see the module doc comment. `#[serde(default)]`
    /// so a session persisted before Spec 25 shipped deserializes with `None`
    /// here instead of failing to parse at all (requirement 9's backfill).
    #[serde(default)]
    crypto_store_key: Option<String>,
    /// SQLCipher passphrase for the store at `crypto_store_key`. Always
    /// `None` exactly when `crypto_store_key` is `None`, for the same reason.
    #[serde(default)]
    crypto_passphrase: Option<String>,
    /// Unix timestamp of the last time this session was known to be in
    /// active use — either a fresh login/register (`save`, called there) or
    /// an on-demand restore of an idle-evicted session (`touch_last_seen`,
    /// called from `routes::require_session`). Consulted only by
    /// [`PersistenceStore::sweep_expired`] to decide whether a session's
    /// browser cookie has almost certainly already expired
    /// (`SESSION_COOKIE_MAX_AGE_SECS`) and so nothing server-side should go
    /// on trusting it either.
    ///
    /// `Option<u64>`, not a bare `u64` defaulting to "now" at deserialize
    /// time — a session persisted before this field existed has `None` here
    /// on disk, and every *read* of that same object (this crate decrypts
    /// the whole blob fresh each time; there's no in-memory cache to make a
    /// computed default "stick") would otherwise look freshly seen again on
    /// every single sweep forever, never actually aging into
    /// `sweep_expired`'s revoke-and-remove path (Codex review finding on
    /// #280). `sweep_expired` backfills `None` to a concrete `Some(now)` the
    /// first time it encounters one — see that function's doc comment — so
    /// this only ever needs interpreting as "now" once, not on every read.
    #[serde(default)]
    last_seen_unix: Option<u64>,
}

/// Current wall-clock time as a Unix timestamp — clamped to 0 rather than
/// panicking if the system clock is ever set before 1970 (never expected in
/// practice, but a `sweep_expired` comparison degrading to "everything looks
/// ancient" is a far better failure mode than a startup panic).
fn now_unix() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct EncryptedBlob {
    /// Version 0 is the legacy format without associated data. Version 1
    /// binds the ciphertext to its token-derived object path, preventing a
    /// bucket writer from relocating one valid session object onto another
    /// session's path without knowing the encryption key.
    #[serde(default)]
    version: u8,
    /// base64-encoded 12-byte AES-GCM nonce, fresh per encryption (see
    /// [`PersistenceStore::encrypt`]) — never reused across saves, even for
    /// the same session, which is why the whole blob (not just changed
    /// fields) is re-encrypted on every [`PersistenceStore::save`].
    nonce: String,
    ciphertext: String,
}

/// This object's path already encodes which token it belongs to (see
/// [`object_path_for_token`]) — no plaintext token or token hash needs to
/// live inside the blob itself the way sub-PR B's original shared-file
/// format needed one to find the right entry within an array.
fn object_path_for_token(token: &str) -> ObjectPath {
    use sha2::{Digest, Sha256};
    let digest = Sha256::digest(token.as_bytes());
    let hash: String = digest.iter().map(|b| format!("{b:02x}")).collect();
    ObjectPath::from(format!("{SESSIONS_PREFIX}/{hash}.json"))
}

fn session_aad(path: &ObjectPath) -> Vec<u8> {
    format!("charm-web-session:v1:{}", path.as_ref()).into_bytes()
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
    crypto_backup: Option<Arc<crate::crypto_backup::CryptoBackupStore>>,
    /// Serializes [`Self::save`] and [`Self::touch_last_seen`] against each
    /// other, per token — without this, `touch_last_seen`'s read-then-write
    /// (fired detached from `routes::require_session`) can interleave with a
    /// concurrent `save` from `sync_loop`'s `repersist_if_token_changed`
    /// (e.g. an idle-evicted restore whose initial sync refreshes the access
    /// token): whichever write lands second wins the whole object, so a
    /// `touch_last_seen` that read the *pre-refresh* entry before losing the
    /// race would silently put the stale, already-invalidated token pair
    /// back on disk (Codex review finding on #280). Each entry's lock is
    /// only ever held for the few in-process, no-network operations inside
    /// one `save`/`touch_last_seen` call — never across the `Client`
    /// rebuild/homeserver round-trips in `restore_one` or
    /// `restore_client_for_revocation` — so this can't become a bottleneck
    /// or a cross-await deadlock risk. Entries are never removed (a small,
    /// bounded amount of memory per token ever seen, for the process
    /// lifetime) — deliberately, since removing one on `remove()` would
    /// reopen the exact same race against an in-flight `save`/
    /// `touch_last_seen` for that same token that started just before
    /// logout.
    token_write_locks:
        std::sync::Mutex<std::collections::HashMap<String, Arc<tokio::sync::Mutex<()>>>>,
}

impl PersistenceStore {
    /// See the module doc comment for the env vars this reads. Returns
    /// `Ok(None)`, not an error, when neither `CHARM_WEB_SERVER_MASTER_KEY`
    /// nor [`SPACES_BUCKET_ENV`] is set — nothing here to opt into.
    ///
    /// [`SPACES_BUCKET_ENV`] set without `CHARM_WEB_SERVER_MASTER_KEY`,
    /// though, is *not* treated as "persistence not configured": that
    /// combination only arises from a real deployment misconfiguration (see
    /// `.do/app.yaml`, which always sets both together), and silently
    /// falling back to `Ok(None)` would start an in-memory-only server that
    /// looks perfectly healthy — the health check and every unauthenticated
    /// route check still pass — while quietly dropping every browser login
    /// on the next restart instead of persisting to the bucket that was
    /// actually configured for exactly that. Fail loudly at startup instead.
    ///
    /// Backend selection: [`SPACES_BUCKET_ENV`] set → DO Spaces (the four
    /// `*_SPACES_*` vars are then all required); otherwise local disk under
    /// [`DATA_DIR_ENV`] (default `./data`), same as before this crate could
    /// target a deploy platform with no persistent volume.
    pub fn from_env() -> Result<Option<Self>, String> {
        let master_key = std::env::var(MASTER_KEY_ENV);
        let spaces_bucket = std::env::var(SPACES_BUCKET_ENV);

        let key_b64 = match (&master_key, &spaces_bucket) {
            (Err(_), Ok(_)) => {
                return Err(format!(
                    "{SPACES_BUCKET_ENV} is set but {MASTER_KEY_ENV} is not — refusing to \
                     silently fall back to in-memory-only sessions when Spaces persistence was \
                     clearly intended. Set {MASTER_KEY_ENV} too."
                ));
            }
            (Err(_), Err(_)) => return Ok(None),
            (Ok(key_b64), _) => key_b64,
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

        let store: Arc<dyn ObjectStore> = if let Ok(bucket) = spaces_bucket {
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
            crypto_backup: None,
            token_write_locks: std::sync::Mutex::new(std::collections::HashMap::new()),
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
            crypto_backup: None,
            token_write_locks: std::sync::Mutex::new(std::collections::HashMap::new()),
        }
    }

    /// The per-token write lock backing [`Self::save`]/[`Self::touch_last_seen`]'s
    /// serialization — see [`Self::token_write_locks`]'s doc comment for why.
    fn token_write_lock(&self, token: &str) -> Arc<tokio::sync::Mutex<()>> {
        let mut locks = self
            .token_write_locks
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        Arc::clone(
            locks
                .entry(token.to_string())
                .or_insert_with(|| Arc::new(tokio::sync::Mutex::new(()))),
        )
    }

    pub fn with_crypto_backup(
        mut self,
        crypto_backup: Option<Arc<crate::crypto_backup::CryptoBackupStore>>,
    ) -> Self {
        self.crypto_backup = crypto_backup;
        self
    }

    pub async fn snapshot_crypto_store(
        &self,
        token: &str,
        session: &MatrixSession,
        crypto: Option<(&str, &str)>,
    ) -> Result<(), String> {
        self.snapshot_crypto_store_with_mode(token, session, crypto, false)
            .await
    }

    pub async fn snapshot_final_crypto_store(
        &self,
        token: &str,
        session: &MatrixSession,
        crypto: Option<(&str, &str)>,
    ) -> Result<(), String> {
        self.snapshot_crypto_store_with_mode(token, session, crypto, true)
            .await
    }

    async fn snapshot_crypto_store_with_mode(
        &self,
        token: &str,
        session: &MatrixSession,
        crypto: Option<(&str, &str)>,
        final_snapshot: bool,
    ) -> Result<(), String> {
        let (Some(backup), Some((store_key, _passphrase))) = (&self.crypto_backup, crypto) else {
            return Ok(());
        };
        let binding = crate::crypto_backup::CryptoSnapshotBinding::new(token, session, store_key);
        for attempt in 0..SNAPSHOT_READY_ATTEMPTS {
            let result = match crate::crypto_store::existing_store_dir(store_key)? {
                Some(source_dir) if final_snapshot => {
                    backup.snapshot_final(&binding, &source_dir).await
                }
                Some(source_dir) => backup.snapshot(&binding, &source_dir).await,
                None => Err("cannot snapshot a missing crypto store directory".to_string()),
            };
            match result {
                Ok(()) => return Ok(()),
                Err(error)
                    if snapshot_source_is_not_ready(&error)
                        && attempt + 1 < SNAPSHOT_READY_ATTEMPTS =>
                {
                    tokio::time::sleep(SNAPSHOT_READY_RETRY_DELAY).await;
                }
                Err(error) => return Err(error),
            }
        }
        unreachable!("snapshot retry loop always returns on its final attempt")
    }

    /// Decrypts every persisted session object, for the startup-only restore
    /// path ([`Self::restore_all`]) that actually needs live
    /// `PersistedSession` values. A listing failure, a single unreadable
    /// object, or a single undecryptable/corrupt object are all fine to fail
    /// open on here (log and drop just that one) rather than propagating an
    /// error nothing downstream would act on differently — same tolerance
    /// sub-PR B's original shared-file design had for a single bad entry,
    /// just scoped to individual objects instead of individual array
    /// entries within one file.
    async fn read_all(&self) -> Vec<PersistedSession> {
        let prefix = ObjectPath::from(SESSIONS_PREFIX);
        let mut paths = Vec::new();
        let mut listing = self.store.list(Some(&prefix));
        while let Some(entry) = listing.next().await {
            match entry {
                Ok(meta) => paths.push(meta.location),
                Err(e) => tracing::warn!("failed to list a persisted session object: {e}"),
            }
        }

        let attempts = paths.into_iter().map(|path| async move {
            let bytes = match self.store.get(&path).await {
                Ok(result) => match result.bytes().await {
                    Ok(bytes) => bytes,
                    Err(e) => {
                        tracing::warn!("failed to read persisted session object {path}: {e}");
                        return None;
                    }
                },
                Err(e) => {
                    tracing::warn!("failed to read persisted session object {path}: {e}");
                    return None;
                }
            };
            let blob: EncryptedBlob = match serde_json::from_slice(&bytes) {
                Ok(blob) => blob,
                Err(e) => {
                    tracing::warn!("dropping unreadable persisted session object {path}: {e}");
                    return None;
                }
            };
            match self.decrypt(&blob, &path) {
                Ok(session) if object_path_for_token(&session.token) == path => Some(session),
                Ok(_) => {
                    tracing::warn!(
                        "dropping persisted session object {path}: decrypted token does not match object path"
                    );
                    None
                }
                Err(e) => {
                    tracing::warn!("dropping unreadable persisted session object {path}: {e}");
                    None
                }
            }
        });
        futures_util::future::join_all(attempts)
            .await
            .into_iter()
            .flatten()
            .collect()
    }

    /// Single-object counterpart to [`Self::read_all`] — reads and decrypts
    /// just `token`'s object, for [`Self::restore_by_token`]'s on-demand
    /// restore path (an idle session was evicted from `SessionStore` but its
    /// cookie is still valid; see `routes::require_session`). `Ok(None)`
    /// covers "never persisted" the same way [`Self::remove`] treats it as a
    /// no-op rather than an error; any other read/decrypt failure is also
    /// folded into `None` — same fail-open tolerance `read_all` gives a
    /// single bad entry, just scoped to the one object a caller asked for.
    async fn read_one(&self, token: &str) -> Option<PersistedSession> {
        let path = object_path_for_token(token);
        let bytes = match self.store.get(&path).await {
            Ok(result) => match result.bytes().await {
                Ok(bytes) => bytes,
                Err(e) => {
                    tracing::warn!("failed to read persisted session object {path}: {e}");
                    return None;
                }
            },
            Err(object_store::Error::NotFound { .. }) => return None,
            Err(e) => {
                tracing::warn!("failed to read persisted session object {path}: {e}");
                return None;
            }
        };
        let blob: EncryptedBlob = match serde_json::from_slice(&bytes) {
            Ok(blob) => blob,
            Err(e) => {
                tracing::warn!("dropping unreadable persisted session object {path}: {e}");
                return None;
            }
        };
        match self.decrypt(&blob, &path) {
            Ok(session)
                if session.token == token && object_path_for_token(&session.token) == path =>
            {
                Some(session)
            }
            Ok(_) => {
                tracing::warn!(
                    "dropping persisted session object {path}: decrypted token does not match lookup token"
                );
                None
            }
            Err(e) => {
                tracing::warn!("dropping unreadable persisted session object {path}: {e}");
                None
            }
        }
    }

    /// On-demand counterpart to [`Self::restore_all`] — rebuilds a live
    /// `Client` for exactly one token, for the case where a request arrives
    /// with a still-valid session cookie but no matching in-memory
    /// `Session` (evicted for being idle too long — see
    /// `session::SessionStore::sweep_idle` — rather than ever logged out).
    /// Idle eviction deliberately never calls [`Self::remove`] or the
    /// homeserver's own `logout` on the evicted session (that would burn the
    /// refresh token and make this restore permanently impossible) — it
    /// only drops the in-memory `Client`, so the persisted object this reads
    /// is still exactly what a fresh login would have written. Returns
    /// `None` for the same reasons a `restore_all` entry gets dropped
    /// (never persisted, revoked token, homeserver unreachable) — the
    /// caller treats that identically to "unknown session": an ordinary 401
    /// and a re-login, no different from today's behavior for any other
    /// invalid cookie.
    /// `initial_presence`, if given, seeds the freshly built `Session`'s
    /// `sync_presence` *and* the presence this restore's own initial
    /// `sync_once` reports to the homeserver — see `restore_one`'s doc
    /// comment for why sending it as an ordinary follow-up `PUT` only
    /// *after* this call returns would be too late: `restore_one`'s
    /// `sync_once` already completes (as `Online`, `SyncSettings`'s own
    /// default) before this function can return anything for a caller to
    /// act on. Pass `None` for the ordinary "no known prior presence to
    /// restore" case (there's nothing wrong with the homeserver seeing the
    /// default `Online` then).
    pub async fn restore_by_token(
        &self,
        token: &str,
        initial_presence: Option<charm_lib::matrix::presence::PresenceStateDto>,
    ) -> Option<(
        String,
        crate::session::Session,
        matrix_sdk::sync::SyncResponse,
        String,
    )> {
        // A single shared `RESTORE_TIMEOUT` budget for the *whole*
        // operation — `read_one`'s object-store read and `restore_one`'s
        // homeserver round-trip together, not one independent timeout each.
        // Two separate `tokio::time::timeout` calls (an earlier version of
        // this had exactly that, to close the previously-unbounded
        // `read_one` gap) can each legitimately spend the full budget on a
        // bad day, doubling the worst case to 30s despite every doc comment
        // here claiming a single 15s bound.
        let outcome = tokio::time::timeout(RESTORE_TIMEOUT, async {
            let entry = self.read_one(token).await?;
            let originally_persisted_access_token = entry.session.tokens.access_token.clone();
            let user_id = entry.session.meta.user_id.clone();
            match restore_one(&entry, initial_presence, self.crypto_backup.as_deref()).await {
                Ok((session, initial_response)) => Some(Ok((
                    entry.homeserver_url,
                    session,
                    initial_response,
                    originally_persisted_access_token,
                ))),
                Err(e) => Some(Err((user_id, e))),
            }
        })
        .await;

        match outcome {
            Ok(Some(Ok(restored))) => Some(restored),
            Ok(Some(Err((user_id, e)))) => {
                tracing::warn!("dropping persisted session for {user_id}: failed to restore: {e}");
                None
            }
            // Never persisted (or unreadable/corrupt — `read_one` already
            // logged that case itself) — not a timeout, nothing more to log.
            Ok(None) => None,
            Err(_) => {
                tracing::warn!(
                    "dropping restore attempt for a token: timed out after {RESTORE_TIMEOUT:?}"
                );
                None
            }
        }
    }

    /// Lighter counterpart to [`Self::restore_by_token`], for the one case
    /// that doesn't need a working crypto identity at all: revoking a
    /// session's access/refresh token on the homeserver during logout (see
    /// `routes::logout`). Rebuilding a *bare* client and restoring just the
    /// token pair is enough for `matrix_auth().logout()` — no crypto store,
    /// no initial sync, no event handlers. Deliberately bypasses
    /// [`build_client_for_restore`]'s now-fail-closed behavior for a missing/
    /// unopenable crypto store: that behavior exists to stop a *live* session
    /// from silently continuing under a fresh, empty crypto identity, which
    /// doesn't apply here — this client is used once, to revoke, and thrown
    /// away. Skipping that check here specifically avoids reintroducing the
    /// bug it fixed by another path: before this existed, a logout for a
    /// session whose crypto store was lost (e.g. after a redeploy) fell
    /// through `restore_by_token` returning `None`, silently skipping the
    /// homeserver revocation and leaving that access/refresh token valid
    /// indefinitely even though the browser's own logout succeeded.
    pub async fn restore_client_for_revocation(&self, token: &str) -> Option<matrix_sdk::Client> {
        let outcome = tokio::time::timeout(RESTORE_TIMEOUT, async {
            let entry = self.read_one(token).await?;
            // `.homeserver_url(...)`, not `.server_name_or_homeserver_url(...)`
            // (unlike `build_client_for_restore`): `entry.homeserver_url` is
            // already the fully-resolved URL from this session's original
            // login discovery, not a bare server name, so there's no
            // discovery step left to do — skipping it also means this
            // revoke-only path doesn't need a reachable `.well-known` lookup
            // just to build a client whose only job is one `logout()` call.
            let client = matrix_sdk::Client::builder()
                .homeserver_url(&entry.homeserver_url)
                .build()
                .await
                .ok()?;
            client
                .matrix_auth()
                .restore_session(
                    entry.session,
                    matrix_sdk::store::RoomLoadSettings::default(),
                )
                .await
                .ok()?;
            Some(client)
        })
        .await;

        match outcome {
            Ok(client) => client,
            Err(_) => {
                tracing::warn!(
                    "restoring a client for revocation timed out after {RESTORE_TIMEOUT:?}"
                );
                None
            }
        }
    }

    fn decrypt(
        &self,
        blob: &EncryptedBlob,
        expected_path: &ObjectPath,
    ) -> Result<PersistedSession, String> {
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
        let plaintext = match blob.version {
            0 => self
                .key
                .decrypt(Nonce::from_slice(&nonce_bytes), ciphertext.as_ref()),
            1 => self.key.decrypt(
                Nonce::from_slice(&nonce_bytes),
                Payload {
                    msg: ciphertext.as_ref(),
                    aad: &session_aad(expected_path),
                },
            ),
            version => return Err(format!("unsupported encrypted session version {version}")),
        }
        .map_err(|e| e.to_string())?;
        serde_json::from_slice(&plaintext).map_err(|e| e.to_string())
    }

    fn encrypt(
        &self,
        session: &PersistedSession,
        path: &ObjectPath,
    ) -> Result<EncryptedBlob, String> {
        let plaintext = serde_json::to_vec(session).map_err(|e| e.to_string())?;
        let nonce = Aes256Gcm::generate_nonce(&mut OsRng);
        let ciphertext = self
            .key
            .encrypt(
                &nonce,
                Payload {
                    msg: plaintext.as_ref(),
                    aad: &session_aad(path),
                },
            )
            .map_err(|e| e.to_string())?;
        Ok(EncryptedBlob {
            version: 1,
            nonce: BASE64.encode(nonce),
            ciphertext: BASE64.encode(ciphertext),
        })
    }

    /// Persists (or replaces, on re-login) `token`'s session as its own
    /// object at `sessions/<sha256(token)>.json` — a single `put`, no
    /// read-modify-write cycle and no cross-process lock needed. This
    /// matters beyond a single process: App Platform's zero-downtime
    /// deploys briefly run the old and new instance together even at
    /// `instance_count: 1`, so two processes really can call `save`/
    /// `remove` concurrently against the same backing store. Sub-PR B's
    /// original design (every session in one shared file, guarded by an
    /// in-process `tokio::sync::Mutex`) only serialized writes *within* one
    /// process — two processes racing a read-modify-write of that one
    /// shared file could still silently drop each other's just-saved entry.
    /// Per-session objects remove that shared state entirely: an unrelated
    /// login/logout is a `put`/`delete` against a completely different key,
    /// so it can never clobber this token's entry no matter how many
    /// processes are writing concurrently. The one remaining race — two
    /// processes saving the *same* token at the same instant (e.g. a token
    /// refresh racing a fresh login of that exact session during a deploy)
    /// — resolves to last-write-wins on that one object, the same outcome a
    /// single process's own concurrent calls would already have.
    /// `crypto`, when given, is `(store_key, passphrase)` for the session's
    /// on-disk crypto store — see `session::CryptoStoreHandle`. Callers pass
    /// the *same* pair on every re-save of a given token (a token refresh,
    /// an idle-eviction re-save): the live crypto store itself is only ever
    /// created once, at login, and its durable snapshots must keep pointing
    /// at that same identity. Persisting a different pair later would orphan
    /// both the original local store and its remote snapshots.
    pub async fn save(
        &self,
        token: &str,
        homeserver_url: &str,
        session: &MatrixSession,
        crypto: Option<(&str, &str)>,
    ) -> Result<(), String> {
        // See `token_write_locks`'s doc comment — held for this whole call so
        // a concurrent `touch_last_seen` for the same token can't read a
        // stale entry out from under this write and clobber it back on top.
        let lock = self.token_write_lock(token);
        let _guard = lock.lock().await;
        let (crypto_store_key, crypto_passphrase) = match crypto {
            Some((key, passphrase)) => (Some(key.to_string()), Some(passphrase.to_string())),
            None => (None, None),
        };
        let path = object_path_for_token(token);
        let blob = self.encrypt(
            &PersistedSession {
                token: token.to_string(),
                homeserver_url: homeserver_url.to_string(),
                session: session.clone(),
                crypto_store_key,
                crypto_passphrase,
                last_seen_unix: Some(now_unix()),
            },
            &path,
        )?;
        let json = serde_json::to_vec(&blob).map_err(|e| e.to_string())?;
        self.store
            .put(&path, PutPayload::from(json))
            .await
            .map(|_| ())
            .map_err(|e| e.to_string())
    }

    /// Removes `token`'s persisted session (logout) — a no-op, not an error,
    /// if it was never persisted (e.g. persistence was enabled after this
    /// session logged in). Deleting one session's own object can never
    /// affect any other session's, for the same reason [`Self::save`]
    /// doesn't need a lock. Also deletes the session's on-disk crypto store,
    /// if it has one (Open Question 4: an explicit logout shouldn't leave
    /// that directory behind, unboundedly growing the host's local disk over
    /// a long-lived deploy's worth of login/logout cycles) — best-effort,
    /// logged rather than propagated, since the session-token object is the
    /// part that actually matters for correctness (an orphaned crypto store
    /// is disk waste, not a security or correctness issue on its own).
    ///
    /// `live_crypto`, when given, is `(store_key, passphrase)` from the
    /// caller's own still-live `Session::persisted_crypto` — used as a
    /// fallback source for which directory to remove when [`Self::read_one`]
    /// finds no blob to read one from. That gap is real, not hypothetical:
    /// `routes::finish_login`'s own initial `PersistenceStore::save`
    /// explicitly tolerates failing (the session is already usable
    /// in-memory regardless), so a session can have a genuine on-disk crypto
    /// store — created directly by `auth::build_client` at login, before any
    /// blob was ever written — with nothing in the object store for
    /// `read_one` to find it through on logout. Without this fallback, every
    /// login whose *first* persistence save fails (e.g. a transient
    /// object-store outage) leaks one crypto-store directory per logout.
    ///
    /// The token object is deleted *before* the crypto-store directory, not
    /// after: if the crypto-store removal below ran first and then this
    /// object's delete failed, the persisted session would survive pointing
    /// at a now-missing store — a later restore would only discover that via
    /// [`crate::crypto_store::existing_store_dir`] returning `None`, falling
    /// back to a fresh in-memory client (correct, if surprising) rather than
    /// losing anything silently, but there's no reason to accept even that
    /// degraded case when doing the deletes in the other order avoids it: a
    /// failed crypto-store removal after the token object is already gone
    /// just leaves an orphaned directory for the next `remove` of an
    /// unrelated session to no-op past — pure disk waste, not a dangling
    /// reference.
    pub async fn remove(
        &self,
        token: &str,
        live_crypto: Option<(&str, &str)>,
    ) -> Result<(), String> {
        let entry = self.read_one(token).await;

        match self.store.delete(&object_path_for_token(token)).await {
            Ok(()) => {}
            // Backends disagree on whether deleting an absent key errors
            // (`LocalFileSystem`, mirroring POSIX `unlink`) or succeeds
            // silently (S3-compatible `DELETE` is idempotent) — treat both
            // the same, since either way there's nothing left to remove.
            Err(object_store::Error::NotFound { .. }) => {}
            Err(e) => return Err(e.to_string()),
        }

        let store_key = entry
            .and_then(|entry| entry.crypto_store_key)
            .or_else(|| live_crypto.map(|(store_key, _)| store_key.to_string()));
        if let Some(store_key) = store_key {
            if let Some(backup) = &self.crypto_backup {
                if let Err(error) = backup.remove(&store_key).await {
                    tracing::warn!("failed to remove durable crypto snapshot on logout: {error}");
                }
            }
            match crate::crypto_store::existing_store_dir(&store_key) {
                Ok(Some(dir)) => {
                    if let Err(e) = std::fs::remove_dir_all(&dir) {
                        tracing::warn!("failed to remove crypto store directory on logout: {e}");
                    }
                }
                Ok(None) => {}
                Err(e) => tracing::warn!(
                    "failed to resolve crypto store directory for removal on logout: {e}"
                ),
            }
        }
        Ok(())
    }

    /// Best-effort activity-timestamp bump for `token`'s persisted session —
    /// fired (not awaited) from `routes::require_session` whenever a request
    /// restores an idle-evicted session. This is the only reliable "the user
    /// is still around" signal [`Self::sweep_expired`] gets for a session
    /// that isn't continuously resident in `SessionStore` (a long-lived tab
    /// left open never re-triggers this — `sweep_expired`'s own doc comment
    /// covers that case separately). Independent of [`Self::save`]'s
    /// token-pair semantics: reads the current object, rewrites only
    /// `last_seen_unix`, and no-ops (logged) rather than erroring if the
    /// object has since been removed by a racing logout or is otherwise
    /// unreadable — same tolerance `read_one`/`read_all` already give a
    /// single bad or missing entry.
    pub fn touch_last_seen(self: &Arc<Self>, token: &str) {
        let this = Arc::clone(self);
        let token = token.to_string();
        tokio::spawn(async move {
            // See `token_write_locks`'s doc comment — this is the other half
            // of the race `save`'s lock guards against: without holding it
            // for the whole read-modify-write below, a concurrent `save`
            // (e.g. `sync_loop`'s post-refresh repersist) landing between
            // this task's read and its write would get silently overwritten
            // back to the stale, already-invalidated token pair.
            let lock = this.token_write_lock(&token);
            let _guard = lock.lock().await;
            let Some(mut entry) = this.read_one(&token).await else {
                return;
            };
            entry.last_seen_unix = Some(now_unix());
            let path = object_path_for_token(&entry.token);
            let blob = match this.encrypt(&entry, &path) {
                Ok(blob) => blob,
                Err(e) => {
                    tracing::warn!(
                        "failed to bump last-seen timestamp for a persisted session: {e}"
                    );
                    return;
                }
            };
            let json = match serde_json::to_vec(&blob) {
                Ok(json) => json,
                Err(e) => {
                    tracing::warn!(
                        "failed to bump last-seen timestamp for a persisted session: {e}"
                    );
                    return;
                }
            };
            if let Err(e) = this.store.put(&path, PutPayload::from(json)).await {
                tracing::warn!("failed to bump last-seen timestamp for a persisted session: {e}");
            }
        });
    }

    /// Revokes and removes every persisted session whose last recorded
    /// activity is older than `max_age` — the server-side half of
    /// `routes::session_cookie`'s `SESSION_COOKIE_MAX_AGE_SECS`. Without
    /// this, a session whose browser cookie has already expired and been
    /// discarded still leaves its access token valid at the homeserver and
    /// its crypto store sitting on this host's disk indefinitely — nothing
    /// else in this file ever revisits a persisted session once it's no
    /// longer being restored by a live cookie (Codex review finding on
    /// #280).
    ///
    /// `live_tokens` — every token currently resident in `SessionStore` — is
    /// skipped outright rather than checked against `last_seen_unix`: a
    /// session continuously live in memory for the entire `max_age` window
    /// (e.g. a tab left open for weeks against a homeserver that never
    /// rotates its access token) would otherwise never have a reason to
    /// re-trigger [`Self::save`] or [`Self::touch_last_seen`], and so would
    /// look just as stale on disk as one nobody has opened in months. Being
    /// resident in `SessionStore` at all is itself the stronger, provably-
    /// current signal: `session::SessionStore::sweep_idle` would already
    /// have evicted it from memory (though not from persistence) had it
    /// truly gone idle.
    ///
    /// An entry with `last_seen_unix: None` (persisted before that field
    /// existed) is backfilled to `Some(now)` and written back to disk on the
    /// spot, then skipped for this round — not treated as already-expired,
    /// and not left as `None` for the *next* sweep to reinterpret as "now"
    /// all over again (seeing `None` and calling `now_unix()` inline here,
    /// the way [`PersistedSession::last_seen_unix`]'s old always-`now`
    /// serde default used to, would never actually persist a concrete
    /// timestamp, so a legacy session that's never separately re-saved would
    /// look freshly seen on every sweep forever and never reach expiry).
    pub async fn sweep_expired(
        &self,
        max_age: std::time::Duration,
        live_tokens: &HashSet<String>,
    ) -> usize {
        let now = now_unix();
        let max_age_secs = max_age.as_secs();
        let mut swept = 0;
        for entry in self.read_all().await {
            if live_tokens.contains(&entry.token) {
                continue;
            }
            let Some(last_seen_unix) = entry.last_seen_unix else {
                if let Err(e) = self
                    .save(
                        &entry.token,
                        &entry.homeserver_url,
                        &entry.session,
                        persisted_crypto_from_entry(&entry)
                            .as_ref()
                            .map(|c| (c.store_key.as_str(), c.passphrase.as_str())),
                    )
                    .await
                {
                    tracing::warn!(
                        "failed to backfill last-seen timestamp for a legacy persisted \
                         session: {e}"
                    );
                }
                continue;
            };
            if now.saturating_sub(last_seen_unix) < max_age_secs {
                continue;
            }
            if let Some(client) = self.restore_client_for_revocation(&entry.token).await {
                // Bounded, unlike `routes::logout`'s equivalent call (which
                // can afford to `tokio::spawn` it fire-and-forget because
                // there's a live HTTP response to send regardless): this
                // runs serially in a background sweep with nothing else
                // racing it, so an unbounded `await` here would let one
                // slow/unresponsive homeserver stall every other expired
                // session behind it in the same sweep (Codex review finding
                // on #280).
                match tokio::time::timeout(RESTORE_TIMEOUT, client.matrix_auth().logout()).await {
                    Ok(Err(e)) => tracing::warn!(
                        "failed to revoke access token for an expired persisted session: {e}"
                    ),
                    Err(_) => tracing::warn!(
                        "timed out revoking access token for an expired persisted session \
                         after {RESTORE_TIMEOUT:?}"
                    ),
                    Ok(Ok(_)) => {}
                }
            }
            if let Err(e) = self.remove(&entry.token, None).await {
                tracing::warn!("failed to remove an expired persisted session: {e}");
                continue;
            }
            swept += 1;
        }
        swept
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
        let entries = self.read_all().await;
        let attempts = entries.into_iter().map(|entry| async move {
            let originally_persisted_access_token = entry.session.tokens.access_token.clone();
            // `restore_all` only ever runs at startup, right after a
            // process restart — there's no in-memory `evicted_presence` to
            // carry over at that point (the whole point of that map is
            // bridging *this same process's* idle-eviction-then-restore
            // gap), so this always passes `None`: `Online`, `SyncSettings`'s
            // own default, is exactly what a restart already implied before
            // presence-carrying existed.
            let outcome = tokio::time::timeout(
                RESTORE_TIMEOUT,
                restore_one(&entry, None, self.crypto_backup.as_deref()),
            )
            .await;
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

fn snapshot_source_is_not_ready(error: &str) -> bool {
    error == "cannot snapshot a missing crypto store directory"
        || error == "crypto store contained no recognized SQLite databases"
}

/// Builds the `Client` [`restore_one`] restores its session into — backed by
/// `entry`'s crypto store when it has one.
///
/// **A session that was never given a crypto store** (`entry.crypto_store_key`
/// is `None` — a pre-Spec-25 persisted session, requirement 9's backfill)
/// falls back to a bare in-memory `Client`, same as before: there was never
/// any crypto state for it to lose.
///
/// **A session that *was* given a crypto store, but that store can't be
/// opened** (directory missing — e.g. lost on a DO App Platform redeploy, see
/// [`crate::crypto_store`]'s doc comment — or open failed: corrupt,
/// permissions, whatever) now fails this restore outright instead of quietly
/// falling back to a bare in-memory client. An earlier version of this
/// function treated that fallback as fail-open, but it isn't: it hands back a
/// client carrying the *same* `device_id` the homeserver and every peer
/// already know as previously verified, paired with a brand-new, empty local
/// Olm/Megolm store that remembers none of that history — cross-signing
/// trust, room keys, everything. The device looks unverified with no local
/// record of why, and can't decrypt any past message, while still presenting
/// as "this session" rather than a fresh login a user could reasonably expect
/// to re-verify. Failing the restore instead routes back through
/// `routes::require_session`'s existing "unknown or expired session" 401,
/// which forces an honest fresh login — a genuinely new device_id the user
/// verifies once, rather than a zombie identity stuck unverified forever
/// (previously reported as: hard refresh leaves the browser session
/// permanently unable to decrypt, even after re-entering the recovery key,
/// because recovery only ever re-trusts *other* devices — this one was never
/// the same device as before, just wearing its old device_id).
///
/// Deliberately uses [`crate::crypto_store::existing_store_dir`], not a
/// directory-creating variant: silently creating a fresh empty directory here
/// would let `sqlite_store` open it as a legitimate-looking-but-empty store
/// instead of erroring, which would skip this failure path entirely and hand
/// back a client that looks restored but has silently lost all its crypto
/// state.
async fn build_client_for_restore(
    entry: &PersistedSession,
    crypto_backup: Option<&crate::crypto_backup::CryptoBackupStore>,
) -> Result<matrix_sdk::Client, String> {
    let Some((store_key, passphrase)) = entry
        .crypto_store_key
        .as_ref()
        .zip(entry.crypto_passphrase.as_ref())
    else {
        return matrix_sdk::Client::builder()
            .server_name_or_homeserver_url(&entry.homeserver_url)
            .with_encryption_settings(charm_lib::matrix::auth::client_encryption_settings())
            .build()
            .await
            .map_err(|e| e.to_string());
    };

    let dir = match crate::crypto_store::existing_store_dir(store_key) {
        Ok(Some(dir)) => dir,
        Ok(None) => {
            let Some(backup) = crypto_backup else {
                return Err(
                    "crypto store directory is missing and durable crypto backup is not configured — refusing to restore this session with an empty crypto identity"
                        .to_string(),
                );
            };
            let dir = crate::crypto_store::store_dir_path(store_key)?;
            let binding = crate::crypto_backup::CryptoSnapshotBinding::new(
                &entry.token,
                &entry.session,
                store_key,
            );
            match backup.restore(&binding, &dir).await {
                Ok(true) => dir,
                Ok(false) => {
                    return Err(
                        "crypto store directory is missing and no durable snapshot exists"
                            .to_string(),
                    );
                }
                Err(error) => {
                    return Err(format!(
                        "failed to restore durable crypto snapshot: {error}"
                    ));
                }
            }
        }
        Err(e) => return Err(format!("failed to resolve crypto store directory: {e}")),
    };
    matrix_sdk::Client::builder()
        .server_name_or_homeserver_url(&entry.homeserver_url)
        .with_encryption_settings(charm_lib::matrix::auth::client_encryption_settings())
        .sqlite_store(&dir, Some(passphrase.as_str()))
        .build()
        .await
        .map_err(|e| {
            format!(
                "failed to open crypto store, refusing to restore this session with a fresh, \
                 empty crypto identity under its existing device_id: {e}"
            )
        })
}

/// The `Session::persisted_crypto` [`restore_one`] should carry for a
/// restored client — populated from `entry`'s fields whenever *both* exist,
/// unconditionally on whether [`build_client_for_restore`] actually managed
/// to open that store this time (`Session::crypto_store_open` carries that
/// separate signal instead; see its doc comment for why the two must not be
/// conflated — deriving this from "was it opened" instead, as an earlier
/// revision of this function did, would drop the persisted pair to `None` on
/// the very next re-save after a merely transient open failure, permanently
/// orphaning a store that might still be perfectly readable). Pulled out as
/// its own pure function (no `Client`/network involved) so this mapping is
/// unit-testable on its own.
fn persisted_crypto_from_entry(
    entry: &PersistedSession,
) -> Option<crate::session::CryptoStoreHandle> {
    entry
        .crypto_store_key
        .clone()
        .zip(entry.crypto_passphrase.clone())
        .map(
            |(store_key, passphrase)| crate::session::CryptoStoreHandle {
                store_key,
                passphrase,
            },
        )
}

/// `initial_presence`, when given, is applied to the freshly built
/// `Session`'s `sync_presence` *before* the initial `sync_once` below, and
/// used as that same call's own `SyncSettings::set_presence` — not just
/// stored for some later push. Setting it only afterwards (an earlier
/// version of this — see `routes::require_session` — set `sync_presence`
/// only after `restore_by_token` had already returned) would be too late:
/// this function's own initial sync already completes, reporting whatever
/// presence `SyncSettings::default()` implies (`Online`), before a caller
/// ever gets anything back to act on. A restored `unavailable`/`offline`
/// user would therefore flash `Online` to the homeserver for the length of
/// this sync, no matter how quickly the caller corrected `sync_presence`
/// afterward.
async fn restore_one(
    entry: &PersistedSession,
    initial_presence: Option<charm_lib::matrix::presence::PresenceStateDto>,
    crypto_backup: Option<&crate::crypto_backup::CryptoBackupStore>,
) -> Result<(crate::session::Session, matrix_sdk::sync::SyncResponse), String> {
    let client = build_client_for_restore(entry, crypto_backup).await?;
    // `build_client_for_restore` only ever returns `Ok` here when either the
    // session never had a crypto store to begin with (both fields `None`) or
    // that store was actually opened — a store that was expected but
    // couldn't be opened is now an `Err` this function already propagated
    // above, not a silent fallback. So "opened" reduces exactly to "was one
    // configured at all" — checked the same way `build_client_for_restore`
    // itself decides that (`zip`, both fields present), not just
    // `crypto_store_key` alone, so a partially-populated entry (e.g.
    // corrupt/hand-edited persisted JSON with a key but no passphrase) can't
    // disagree with that function about whether a store was configured.
    let crypto_store_opened = entry.crypto_store_key.is_some() && entry.crypto_passphrase.is_some();
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
    let persisted_crypto = persisted_crypto_from_entry(entry);
    let session = crate::session::Session::new(
        client.clone(),
        entry.session.meta.user_id.to_string(),
        persisted_crypto,
        crypto_store_opened,
    );
    if let Some(presence) = initial_presence {
        *session
            .sync_presence
            .lock()
            .unwrap_or_else(|e| e.into_inner()) = presence;
    }
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
    // Reports `initial_presence` right away when given, instead of always
    // `SyncSettings::default()`'s implicit `Online` — see this function's
    // own doc comment for why that timing matters.
    let sync_settings = match initial_presence {
        Some(presence) => matrix_sdk::config::SyncSettings::default().set_presence(presence.into()),
        None => matrix_sdk::config::SyncSettings::default(),
    };
    let initial_response = client
        .sync_once(sync_settings)
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

    /// Full path a given token's object lives at under `dir` — same layout
    /// `object_path_for_token` builds, exposed here so tests can splice in
    /// corrupt entries or read raw bytes back the way they used to against
    /// the old single-shared-file layout.
    fn object_file_path(dir: &std::path::Path, token: &str) -> PathBuf {
        dir.join(object_path_for_token(token).as_ref())
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
                None,
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
    async fn relocating_a_valid_ciphertext_to_another_token_path_is_rejected() {
        let dir = scratch_dir("relocated-ciphertext");
        let store = PersistenceStore::new_for_test(&dir, [17u8; 32]);
        store
            .save(
                "tok-alice",
                "https://example.invalid",
                &dummy_session("@alice:example.invalid"),
                None,
            )
            .await
            .unwrap();

        let ciphertext = tokio::fs::read(object_file_path(&dir, "tok-alice"))
            .await
            .unwrap();
        let relocated = object_file_path(&dir, "tok-bob");
        tokio::fs::create_dir_all(relocated.parent().unwrap())
            .await
            .unwrap();
        tokio::fs::write(relocated, ciphertext).await.unwrap();

        assert!(store.read_one("tok-bob").await.is_none());
        let all = store.read_all().await;
        assert_eq!(all.len(), 1);
        assert_eq!(all[0].token, "tok-alice");
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
                None,
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
    async fn snapshot_crypto_store_retries_until_the_database_is_ready() {
        let _lock = crate::ENV_TEST_LOCK.lock().await;
        let data_dir = scratch_dir("snapshot-retry-data");
        let persistence_dir = scratch_dir("snapshot-retry-persistence");
        let restore_dir = scratch_dir("snapshot-retry-restore");
        std::fs::remove_dir_all(&restore_dir).unwrap();
        let _data_dir = EnvVarGuard::set(DATA_DIR_ENV, data_dir.to_str().unwrap());

        let backup = Arc::new(crate::crypto_backup::CryptoBackupStore::new_for_test(
            [43u8; 32],
        ));
        let store = PersistenceStore::new_for_test(&persistence_dir, [44u8; 32])
            .with_crypto_backup(Some(backup.clone()));
        let matrix_session = dummy_session("@snapshot-retry:example.invalid");
        let store_key = "snapshotretrystore";
        let source_dir = data_dir.join("crypto").join(store_key);

        let create_database = tokio::spawn(async move {
            tokio::time::sleep(std::time::Duration::from_millis(25)).await;
            std::fs::create_dir_all(&source_dir).unwrap();
            rusqlite::Connection::open(source_dir.join("matrix-sdk-crypto.sqlite3"))
                .unwrap()
                .execute_batch("CREATE TABLE example(value TEXT);")
                .unwrap();
        });

        store
            .snapshot_crypto_store(
                "snapshot-retry-token",
                &matrix_session,
                Some((store_key, "unused-passphrase")),
            )
            .await
            .unwrap();
        create_database.await.unwrap();

        let binding = crate::crypto_backup::CryptoSnapshotBinding::new(
            "snapshot-retry-token",
            &matrix_session,
            store_key,
        );
        assert!(backup.restore(&binding, &restore_dir).await.unwrap());
        assert!(restore_dir.join("matrix-sdk-crypto.sqlite3").is_file());
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
                None,
            )
            .await
            .unwrap();

        let raw = tokio::fs::read_to_string(object_file_path(&dir, "tok-secret"))
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
                None,
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
                None,
            )
            .await
            .unwrap();
        store
            .save(
                "tok-b",
                "https://example.invalid",
                &dummy_session("@erin:example.invalid"),
                None,
            )
            .await
            .unwrap();

        store.remove("tok-a", None).await.unwrap();

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
                None,
            )
            .await
            .unwrap();
        store
            .save(
                "tok-a",
                "https://new.example.invalid",
                &dummy_session("@frank:example.invalid"),
                None,
            )
            .await
            .unwrap();

        let all = store.read_all().await;
        assert_eq!(all.len(), 1);
        assert_eq!(all[0].homeserver_url, "https://new.example.invalid");
    }

    /// Regression test: a corrupt object whose decoded nonce isn't exactly
    /// 12 bytes must be dropped as unreadable (see `decrypt`'s length
    /// check), not panic `Nonce::from_slice` and take the whole listing down
    /// with it — `read_all` must still return every *other* valid object.
    #[tokio::test]
    async fn a_malformed_nonce_is_dropped_not_panicked_on() {
        let dir = scratch_dir("malformed-nonce");
        let store = PersistenceStore::new_for_test(&dir, [4u8; 32]);
        store
            .save(
                "tok-good",
                "https://example.invalid",
                &dummy_session("@grace:example.invalid"),
                None,
            )
            .await
            .unwrap();

        // Write a second, corrupt object with a too-short nonce at its own
        // path, bypassing `save`/`encrypt` (which would never produce one)
        // to simulate a truncated/bit-rotted write.
        let corrupt_path = object_file_path(&dir, "tok-corrupt");
        tokio::fs::create_dir_all(corrupt_path.parent().unwrap())
            .await
            .unwrap();
        tokio::fs::write(
            &corrupt_path,
            serde_json::to_vec(&serde_json::json!({
                "nonce": BASE64.encode([0u8; 4]),
                "ciphertext": BASE64.encode([0u8; 16]),
            }))
            .unwrap(),
        )
        .await
        .unwrap();

        let all = store.read_all().await;
        assert_eq!(all.len(), 1, "the corrupt entry must be dropped, not panic");
        assert_eq!(all[0].token, "tok-good");
    }

    /// Regression test for the original data-loss bug fixed by moving to
    /// per-session objects: an undecryptable entry (wrong key after a
    /// rotation, bit rot) must never be dropped by an unrelated session's
    /// save/remove. With per-object storage this holds by construction —
    /// `save`/`remove` only ever touch the one path they're given — but it's
    /// still worth asserting directly rather than trusting the design.
    #[tokio::test]
    async fn save_and_remove_never_touch_an_unrelated_undecryptable_entry() {
        let dir = scratch_dir("undecryptable-survives");
        let store = PersistenceStore::new_for_test(&dir, [6u8; 32]);
        store
            .save(
                "tok-real",
                "https://example.invalid",
                &dummy_session("@henry:example.invalid"),
                None,
            )
            .await
            .unwrap();

        // Write an object this store can never decrypt (wrong-key
        // ciphertext, correct-length nonce) at its own path — simulates a
        // master-key rotation that left one old entry undecryptable rather
        // than a length-corrupt one.
        let corrupt_path = object_file_path(&dir, "tok-undecryptable");
        tokio::fs::create_dir_all(corrupt_path.parent().unwrap())
            .await
            .unwrap();
        let corrupt_bytes = serde_json::to_vec(&serde_json::json!({
            "nonce": BASE64.encode([1u8; 12]),
            "ciphertext": BASE64.encode([2u8; 32]),
        }))
        .unwrap();
        tokio::fs::write(&corrupt_path, &corrupt_bytes)
            .await
            .unwrap();

        // A totally unrelated login...
        store
            .save(
                "tok-other",
                "https://example.invalid",
                &dummy_session("@iris:example.invalid"),
                None,
            )
            .await
            .unwrap();
        // ...and an unrelated logout...
        store.remove("tok-other", None).await.unwrap();

        // ...must never have touched the undecryptable entry.
        let bytes_after = tokio::fs::read(&corrupt_path).await.unwrap();
        assert_eq!(
            bytes_after, corrupt_bytes,
            "the undecryptable entry must survive unrelated save/remove calls untouched"
        );

        // The real, decryptable entry must also still be there.
        let all = store.read_all().await;
        assert!(all.iter().any(|s| s.token == "tok-real"));
    }

    /// Spec 25 requirement 1: a session saved with a crypto-store key/
    /// passphrase must round-trip both fields, not just the token/session
    /// fields the pre-Spec-25 tests above already cover.
    #[tokio::test]
    async fn save_and_reload_round_trips_the_crypto_store_pair() {
        let dir = scratch_dir("crypto-round-trip");
        let store = PersistenceStore::new_for_test(&dir, [10u8; 32]);

        store
            .save(
                "tok-crypto",
                "https://example.invalid",
                &dummy_session("@judy:example.invalid"),
                Some(("store-key-abc", "passphrase-xyz")),
            )
            .await
            .unwrap();

        let all = store.read_all().await;
        assert_eq!(all.len(), 1);
        assert_eq!(all[0].crypto_store_key.as_deref(), Some("store-key-abc"));
        assert_eq!(all[0].crypto_passphrase.as_deref(), Some("passphrase-xyz"));
    }

    /// Spec 25 requirement 9: an entry persisted before this shipped — whose
    /// plaintext JSON has no `crypto_store_key`/`crypto_passphrase` keys at
    /// all, not merely `null` values — must still deserialize (as `None` for
    /// both), not be dropped as unreadable the way
    /// `a_malformed_nonce_is_dropped_*` exercises for genuine corruption.
    /// Encrypts a hand-built plaintext (bypassing `PersistedSession`, which
    /// always has both fields present) to faithfully reproduce the exact
    /// on-disk shape a pre-Spec-25 deploy would have written.
    #[tokio::test]
    async fn a_pre_spec_25_entry_with_no_crypto_fields_still_deserializes() {
        let dir = scratch_dir("legacy-entry");
        let store = PersistenceStore::new_for_test(&dir, [11u8; 32]);

        let legacy_plaintext = serde_json::to_vec(&serde_json::json!({
            "token": "tok-legacy",
            "homeserver_url": "https://example.invalid",
            "session": {
                "user_id": "@legacy:example.invalid",
                "device_id": "TESTDEVICE",
                "access_token": "legacy-access-token",
            },
        }))
        .unwrap();
        let nonce = Aes256Gcm::generate_nonce(&mut OsRng);
        let ciphertext = store
            .key
            .encrypt(&nonce, legacy_plaintext.as_ref())
            .unwrap();
        let blob = EncryptedBlob {
            version: 0,
            nonce: BASE64.encode(nonce),
            ciphertext: BASE64.encode(ciphertext),
        };
        let path = object_file_path(&dir, "tok-legacy");
        tokio::fs::create_dir_all(path.parent().unwrap())
            .await
            .unwrap();
        tokio::fs::write(&path, serde_json::to_vec(&blob).unwrap())
            .await
            .unwrap();

        let all = store.read_all().await;
        assert_eq!(all.len(), 1);
        assert_eq!(all[0].token, "tok-legacy");
        assert_eq!(all[0].crypto_store_key, None);
        assert_eq!(all[0].crypto_passphrase, None);
    }

    /// Open Question 4: an explicit logout (`remove`) must also delete the
    /// session's on-disk crypto-store directory, not just its persisted
    /// token blob — otherwise every login/logout cycle leaks one directory.
    #[tokio::test]
    async fn remove_also_deletes_the_crypto_store_directory() {
        // Held for the *entire* test, not just around `EnvVarGuard::set` —
        // `crypto_store::store_path` reads `DATA_DIR_ENV` fresh on every
        // call (including inside the `.await`ed `save`/`remove` calls
        // below), so releasing the lock right after setup would leave this
        // test's env var value unprotected against a concurrently-running
        // test overwriting it mid-flight. `tokio::sync::Mutex` (not
        // `std::sync::Mutex`) is what makes holding it across those
        // `.await`s sound in the first place — see `ENV_TEST_LOCK`'s own
        // doc comment.
        let _lock = crate::ENV_TEST_LOCK.lock().await;
        let dir = scratch_dir("remove-crypto");
        let data_dir = scratch_dir("remove-crypto-data");
        let _data_dir_env = EnvVarGuard::set(DATA_DIR_ENV, data_dir.to_str().unwrap());
        let store = PersistenceStore::new_for_test(&dir, [12u8; 32]);

        // `save` only ever persists the key/passphrase *pair* into the
        // encrypted blob — it never touches the crypto store directory
        // itself (that's `crypto_store::create_store_dir`, called once at
        // login). Create it here to simulate that, so this test actually
        // exercises "logout removes a real, previously-created directory"
        // rather than trivially passing because nothing existed to begin
        // with.
        let crypto_dir = crate::crypto_store::create_store_dir("storeKeyLogout").unwrap();
        assert!(crypto_dir.exists());
        store
            .save(
                "tok-logout",
                "https://example.invalid",
                &dummy_session("@kevin:example.invalid"),
                Some(("storeKeyLogout", "passphrase-logout")),
            )
            .await
            .unwrap();

        store.remove("tok-logout", None).await.unwrap();

        assert!(
            !crypto_dir.exists(),
            "logout must remove the crypto store directory, not just the session blob"
        );
    }

    /// Codex-flagged gap: a session whose *first* `save` failed (which
    /// `routes::finish_login` explicitly tolerates — see its doc comment)
    /// still has a real on-disk crypto store from `auth::build_client`, but
    /// no blob for `read_one` to find its `crypto_store_key` through.
    /// `remove`'s `live_crypto` parameter must clean that directory up from
    /// the caller's own still-live `Session::persisted_crypto` in exactly
    /// this case — without it, every login whose first persistence save
    /// fails leaks one crypto-store directory per logout.
    #[tokio::test]
    async fn remove_uses_the_live_crypto_fallback_when_no_blob_exists() {
        // See `remove_also_deletes_the_crypto_store_directory`'s matching
        // comment: held for the whole test, not just around setup.
        let _lock = crate::ENV_TEST_LOCK.lock().await;
        let dir = scratch_dir("remove-crypto-no-blob");
        let data_dir = scratch_dir("remove-crypto-no-blob-data");
        let _data_dir_env = EnvVarGuard::set(DATA_DIR_ENV, data_dir.to_str().unwrap());
        let store = PersistenceStore::new_for_test(&dir, [13u8; 32]);

        // Simulates `auth::build_client` having created a store at login,
        // with no matching `save` ever landing (the exact gap this test
        // guards) — deliberately *not* calling `store.save` at all.
        let crypto_dir = crate::crypto_store::create_store_dir("storeKeyNoBlob").unwrap();
        assert!(crypto_dir.exists());

        store
            .remove(
                "tok-never-saved",
                Some(("storeKeyNoBlob", "passphrase-no-blob")),
            )
            .await
            .unwrap();

        assert!(
            !crypto_dir.exists(),
            "remove must fall back to the caller-supplied live crypto handle when no \
             persisted blob exists to read one from"
        );
    }

    // The two `from_env_*` tests below mutate process-wide env vars
    // (`std::env::set_var`/`remove_var`), and `cargo test` runs `#[test]`s
    // concurrently within one process by default — without serializing them
    // against each other, one test's `EnvVarGuard` could restore/clear a var
    // mid-way through the other's `from_env` call. Same problem
    // `tests/http_api.rs`'s `ALLOWED_ORIGIN_ENV_LOCK` exists for. Uses the
    // crate-wide `crate::ENV_TEST_LOCK`, not a module-local static — this
    // module and `crypto_store.rs`'s own tests both mutate `DATA_DIR_ENV`,
    // and two separate, unsynchronized locks (one per module — an earlier
    // revision of this had exactly that) don't serialize against each
    // other at all, which flaked in practice, not just in theory.

    /// Guards a single env var for the lifetime of the guard, restoring
    /// whatever was there before (or unsetting it again) on drop — same
    /// pattern as `tests/http_api.rs`'s `EnvVarGuard`, needed here since
    /// `from_env` reads process env directly and these tests all share one
    /// test binary's process.
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
        let _lock = crate::ENV_TEST_LOCK.blocking_lock();
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
        let _lock = crate::ENV_TEST_LOCK.blocking_lock();
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

    /// Regression test: with `CHARM_WEB_SERVER_SPACES_BUCKET` set but no
    /// master key, `from_env` must fail *before* even reaching the Spaces
    /// branch — silently falling back to `Ok(None)` (in-memory-only) would
    /// mean a misconfigured production deployment starts up looking healthy
    /// (health check and unauthenticated route checks all still pass) while
    /// quietly dropping every session on the next restart instead of
    /// persisting to the configured bucket.
    #[test]
    fn from_env_with_spaces_bucket_but_no_master_key_errors() {
        let _lock = crate::ENV_TEST_LOCK.blocking_lock();
        let _no_master_key = EnvVarGuard::remove(MASTER_KEY_ENV);
        let _bucket = EnvVarGuard::set(SPACES_BUCKET_ENV, "charm-web-server-sessions");

        let err = match PersistenceStore::from_env() {
            Err(e) => e,
            Ok(_) => panic!(
                "a Spaces bucket configured without a master key must fail closed, not \
                 silently fall back to in-memory-only sessions"
            ),
        };
        assert!(err.contains(MASTER_KEY_ENV), "got: {err}");
        assert!(err.contains(SPACES_BUCKET_ENV), "got: {err}");
    }

    /// `restore_by_token` is `require_session`'s on-demand-restore fallback
    /// for a cookie whose session was idle-evicted from `SessionStore` (see
    /// `session::SessionStore::sweep_idle`) — a token that was simply never
    /// persisted (never logged in, or the object was already removed by an
    /// explicit `logout`) must resolve to `None`, the same "unknown session"
    /// outcome `require_session` already gives any other invalid cookie,
    /// not a panic or a spurious restored session.
    #[tokio::test]
    async fn restore_by_token_is_none_for_a_token_that_was_never_persisted() {
        let dir = scratch_dir("restore-missing");
        let store = PersistenceStore::new_for_test(&dir, [11u8; 32]);

        assert!(store.restore_by_token("never-saved", None).await.is_none());
    }

    /// A persisted entry whose homeserver can't actually be reached (dead
    /// domain, network down) must drop out to `None` the same way
    /// `restore_all` drops an unrestorable entry rather than propagating the
    /// error — this crate's test suite has no live homeserver to restore
    /// against, but `example.invalid` (reserved, guaranteed non-resolving —
    /// RFC 2606) exercises the exact same "restore_one failed" path
    /// `restore_by_token` maps to `None`, which is what actually matters
    /// here: `read_one` successfully found and decrypted the object, so this
    /// is testing `restore_one`'s failure handling, not `read_one`'s.
    #[tokio::test]
    async fn restore_by_token_is_none_when_the_homeserver_is_unreachable() {
        let dir = scratch_dir("restore-unreachable");
        let store = PersistenceStore::new_for_test(&dir, [12u8; 32]);
        store
            .save(
                "tok-unreachable",
                "https://example.invalid",
                &dummy_session("@henry:example.invalid"),
                None,
            )
            .await
            .unwrap();

        assert!(store
            .restore_by_token("tok-unreachable", None)
            .await
            .is_none());
    }

    /// Regression test: revocation must still work for a session whose
    /// crypto store is missing — `restore_by_token` (see the test right
    /// below this one) now deliberately fails closed for that case, but
    /// `restore_client_for_revocation` must not, or `routes::logout` would
    /// silently skip revoking the homeserver token for exactly the sessions
    /// this whole fix was about, leaving them valid forever even though the
    /// browser's own logout succeeded.
    #[tokio::test]
    async fn restore_client_for_revocation_succeeds_even_with_a_missing_crypto_store() {
        let dir = scratch_dir("revoke-missing-crypto-store");
        let store = PersistenceStore::new_for_test(&dir, [14u8; 32]);
        store
            .save(
                "tok-revoke-missing-crypto",
                "https://example.invalid",
                &dummy_session("@nadia:example.invalid"),
                Some(("nonexistentstorekey", "some-passphrase")),
            )
            .await
            .unwrap();

        assert!(
            store
                .restore_client_for_revocation("tok-revoke-missing-crypto")
                .await
                .is_some(),
            "revocation must not require a working crypto store"
        );
    }

    #[tokio::test]
    async fn restore_client_for_revocation_is_none_for_a_token_that_was_never_persisted() {
        let dir = scratch_dir("revoke-never-persisted");
        let store = PersistenceStore::new_for_test(&dir, [15u8; 32]);

        assert!(store
            .restore_client_for_revocation("never-saved")
            .await
            .is_none());
    }

    /// Regression test for the hard-refresh-breaks-encryption bug: a session
    /// that *had* a crypto store (`crypto_store_key`/`crypto_passphrase` both
    /// set) but whose directory is gone (e.g. lost on a DO App Platform
    /// redeploy — this crate has no persistent volume) must fail the whole
    /// restore, not silently hand back a working session under the same
    /// `device_id` backed by a fresh, empty crypto identity. The old
    /// behavior looked like a successful restore to the caller while
    /// actually producing a device that's unverified with no way back short
    /// of a fresh login — see `build_client_for_restore`'s doc comment.
    #[tokio::test]
    async fn restore_by_token_is_none_when_the_crypto_store_directory_is_missing() {
        let dir = scratch_dir("restore-missing-crypto-store");
        let store = PersistenceStore::new_for_test(&dir, [13u8; 32]);
        store
            .save(
                "tok-missing-crypto",
                "https://example.invalid",
                &dummy_session("@mallory:example.invalid"),
                Some(("nonexistentstorekey", "some-passphrase")),
            )
            .await
            .unwrap();

        assert!(
            store
                .restore_by_token("tok-missing-crypto", None)
                .await
                .is_none(),
            "restore must fail outright rather than fall back to a fresh in-memory crypto \
             identity under the session's existing device_id"
        );
    }

    /// `persisted_crypto_from_entry` must return `Some` whenever `entry` has
    /// both fields, regardless of whether this particular restore attempt
    /// actually managed to open the store — that's the whole point of
    /// splitting `Session::persisted_crypto` (what to keep re-saving) from
    /// `Session::crypto_store_open` (whether eviction is currently safe): a
    /// Codex-flagged bug in an earlier revision derived the value re-saved
    /// on every token refresh from "was it opened this time", which meant a
    /// merely transient store-open failure (temporary lock, permissions
    /// blip — not the directory being gone for good) would get *permanently*
    /// baked in on the very next re-save, since that re-save would then
    /// overwrite the persisted blob's `crypto_store_key`/`crypto_passphrase`
    /// with `None` even though the on-disk store was still perfectly there.
    #[test]
    fn persisted_crypto_from_entry_is_populated_regardless_of_whether_it_was_opened() {
        let entry = PersistedSession {
            token: "tok-missing-store".to_string(),
            homeserver_url: "https://example.invalid".to_string(),
            session: dummy_session("@laura:example.invalid"),
            crypto_store_key: Some("nonexistentstorekey".to_string()),
            crypto_passphrase: Some("some-passphrase".to_string()),
            last_seen_unix: Some(now_unix()),
        };

        let crypto = persisted_crypto_from_entry(&entry).expect(
            "must be Some whenever the entry carries both fields, independent of whether \
             this restore attempt actually opened the store",
        );
        assert_eq!(crypto.store_key, "nonexistentstorekey");
        assert_eq!(crypto.passphrase, "some-passphrase");
    }

    #[test]
    fn persisted_crypto_from_entry_is_none_when_the_entry_never_had_a_store() {
        let entry = PersistedSession {
            token: "tok-legacy".to_string(),
            homeserver_url: "https://example.invalid".to_string(),
            session: dummy_session("@mallory:example.invalid"),
            crypto_store_key: None,
            crypto_passphrase: None,
            last_seen_unix: Some(now_unix()),
        };

        assert!(persisted_crypto_from_entry(&entry).is_none());
    }

    /// Directly overwrites `token`'s persisted object with a chosen
    /// `last_seen_unix`, bypassing `save`'s always-`now_unix()` timestamp —
    /// the only way these tests can construct a session that looks stale
    /// without waiting real wall-clock time.
    async fn save_with_last_seen(store: &PersistenceStore, token: &str, last_seen_unix: u64) {
        let entry = PersistedSession {
            token: token.to_string(),
            homeserver_url: "https://example.invalid".to_string(),
            session: dummy_session("@sweep-target:example.invalid"),
            crypto_store_key: None,
            crypto_passphrase: None,
            last_seen_unix: Some(last_seen_unix),
        };
        let path = object_path_for_token(token);
        let blob = store.encrypt(&entry, &path).unwrap();
        let json = serde_json::to_vec(&blob).unwrap();
        store
            .store
            .put(&path, PutPayload::from(json))
            .await
            .unwrap();
    }

    #[tokio::test]
    async fn sweep_expired_removes_only_stale_sessions_not_in_live_tokens() {
        let dir = scratch_dir("sweep-expired");
        let store = PersistenceStore::new_for_test(&dir, [42u8; 32]);
        let now = now_unix();
        let one_hour = 60 * 60;
        let sixty_days = 60 * 24 * 60 * 60;

        save_with_last_seen(&store, "tok-stale", now.saturating_sub(sixty_days)).await;
        save_with_last_seen(&store, "tok-fresh", now.saturating_sub(one_hour)).await;
        save_with_last_seen(&store, "tok-stale-but-live", now.saturating_sub(sixty_days)).await;

        let live_tokens = HashSet::from(["tok-stale-but-live".to_string()]);
        let swept = store
            .sweep_expired(
                std::time::Duration::from_secs(30 * 24 * 60 * 60),
                &live_tokens,
            )
            .await;

        assert_eq!(swept, 1);
        let remaining: HashSet<String> = store
            .read_all()
            .await
            .into_iter()
            .map(|entry| entry.token)
            .collect();
        assert_eq!(
            remaining,
            HashSet::from(["tok-fresh".to_string(), "tok-stale-but-live".to_string()])
        );
    }

    #[tokio::test]
    async fn touch_last_seen_updates_the_persisted_timestamp() {
        let dir = scratch_dir("touch-last-seen");
        let store = Arc::new(PersistenceStore::new_for_test(&dir, [43u8; 32]));
        let old = now_unix().saturating_sub(60 * 24 * 60 * 60);
        save_with_last_seen(&store, "tok-touch", old).await;

        store.touch_last_seen("tok-touch");
        // `touch_last_seen` is fire-and-forget (`tokio::spawn`) — give the
        // spawned task a moment to actually run before reading it back.
        tokio::time::sleep(std::time::Duration::from_millis(100)).await;

        let entry = store.read_one("tok-touch").await.unwrap();
        assert!(
            entry.last_seen_unix.unwrap() > old,
            "touch_last_seen should have bumped last_seen_unix forward"
        );
    }

    #[tokio::test]
    async fn sweep_expired_backfills_a_legacy_entry_instead_of_removing_it() {
        let dir = scratch_dir("sweep-expired-legacy-backfill");
        let store = PersistenceStore::new_for_test(&dir, [44u8; 32]);
        let entry = PersistedSession {
            token: "tok-legacy-no-timestamp".to_string(),
            homeserver_url: "https://example.invalid".to_string(),
            session: dummy_session("@legacy:example.invalid"),
            crypto_store_key: None,
            crypto_passphrase: None,
            last_seen_unix: None,
        };
        let path = object_path_for_token(&entry.token);
        let blob = store.encrypt(&entry, &path).unwrap();
        let json = serde_json::to_vec(&blob).unwrap();
        store
            .store
            .put(&path, PutPayload::from(json))
            .await
            .unwrap();

        let swept = store
            .sweep_expired(
                std::time::Duration::from_secs(30 * 24 * 60 * 60),
                &HashSet::new(),
            )
            .await;

        assert_eq!(
            swept, 0,
            "a freshly-backfilled entry must not be swept in the same pass"
        );
        let reloaded = store.read_one("tok-legacy-no-timestamp").await.unwrap();
        assert!(
            reloaded.last_seen_unix.is_some(),
            "sweep_expired must persist a concrete timestamp, not leave it None to be \
             reinterpreted as \"now\" again on the next sweep"
        );
    }
}
