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

        Ok(Some(Self { key, store }))
    }

    #[cfg(test)]
    pub fn new_for_test(dir: &std::path::Path, key_bytes: [u8; 32]) -> Self {
        let key = Aes256Gcm::new(Key::<Aes256Gcm>::from_slice(&key_bytes));
        let store =
            LocalFileSystem::new_with_prefix(dir).expect("scratch dir must exist for tests");
        Self {
            key,
            store: Arc::new(store),
        }
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
            match self.decrypt(&blob) {
                Ok(session) => Some(session),
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
        match self.decrypt(&blob) {
            Ok(session) => Some(session),
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
            match restore_one(&entry, initial_presence).await {
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
    pub async fn save(
        &self,
        token: &str,
        homeserver_url: &str,
        session: &MatrixSession,
    ) -> Result<(), String> {
        let blob = self.encrypt(&PersistedSession {
            token: token.to_string(),
            homeserver_url: homeserver_url.to_string(),
            session: session.clone(),
        })?;
        let json = serde_json::to_vec(&blob).map_err(|e| e.to_string())?;
        self.store
            .put(&object_path_for_token(token), PutPayload::from(json))
            .await
            .map(|_| ())
            .map_err(|e| e.to_string())
    }

    /// Removes `token`'s persisted session (logout) — a no-op, not an error,
    /// if it was never persisted (e.g. persistence was enabled after this
    /// session logged in). Deleting one session's own object can never
    /// affect any other session's, for the same reason [`Self::save`]
    /// doesn't need a lock.
    pub async fn remove(&self, token: &str) -> Result<(), String> {
        match self.store.delete(&object_path_for_token(token)).await {
            Ok(()) => Ok(()),
            // Backends disagree on whether deleting an absent key errors
            // (`LocalFileSystem`, mirroring POSIX `unlink`) or succeeds
            // silently (S3-compatible `DELETE` is idempotent) — treat both
            // the same, since either way there's nothing left to remove.
            Err(object_store::Error::NotFound { .. }) => Ok(()),
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
            let outcome = tokio::time::timeout(RESTORE_TIMEOUT, restore_one(&entry, None)).await;
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
            )
            .await
            .unwrap();
        // ...and an unrelated logout...
        store.remove("tok-other").await.unwrap();

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

    // The two `from_env_*` tests below mutate process-wide env vars
    // (`std::env::set_var`/`remove_var`), and `cargo test` runs `#[test]`s
    // concurrently within one process by default — without serializing them
    // against each other, one test's `EnvVarGuard` could restore/clear a var
    // mid-way through the other's `from_env` call. Same problem
    // `tests/http_api.rs`'s `ALLOWED_ORIGIN_ENV_LOCK` exists for.
    static ENV_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

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

    /// Regression test: with `CHARM_WEB_SERVER_SPACES_BUCKET` set but no
    /// master key, `from_env` must fail *before* even reaching the Spaces
    /// branch — silently falling back to `Ok(None)` (in-memory-only) would
    /// mean a misconfigured production deployment starts up looking healthy
    /// (health check and unauthenticated route checks all still pass) while
    /// quietly dropping every session on the next restart instead of
    /// persisting to the configured bucket.
    #[test]
    fn from_env_with_spaces_bucket_but_no_master_key_errors() {
        let _lock = ENV_LOCK.lock().unwrap_or_else(|e| e.into_inner());
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
            )
            .await
            .unwrap();

        assert!(store
            .restore_by_token("tok-unreachable", None)
            .await
            .is_none());
    }
}
