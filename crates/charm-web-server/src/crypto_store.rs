//! Per-session on-disk Olm/Megolm crypto store for `charm-web-server` —
//! Spec 25's fix for the "every restart wipes crypto state" gap
//! `persistence.rs`'s module doc comment used to flag.
//!
//! **Local disk only, not `object_store`/DO-Spaces-backed** (unlike the
//! session-token blob in `persistence.rs`): matrix-sdk-sqlite writes a
//! directory of files (main db + WAL), and `object_store` only speaks flat
//! blobs with no directory-sync primitive. On DO App Platform's
//! no-persistent-volume Web Service tier this means a *redeploy* (not an
//! ordinary process restart) still loses crypto state — degrading to the
//! existing fail-open recovery-key re-prompt (`persistence.rs`'s restore
//! path), not a hard failure. Extending this to `object_store`-backed
//! durability is a tracked follow-up, deliberately not attempted here — see
//! the Charm 2.0 vault's 2026-07-10 raw-capture note.
//!
//! **Keyed by a random per-session directory, not [`account_key`].** Unlike
//! `media_cache.rs` (which must be *looked up* by account+device before any
//! persisted session record exists), every lookup here starts from an
//! already-decrypted `PersistedSession`, which carries this directory's key
//! directly — so there's no need to derive it from the account's mxid, and
//! no chicken-and-egg problem building the very first login's `Client`
//! (which needs a store path before the homeserver has even confirmed what
//! that mxid is).
//!
//! [`account_key`]: charm_lib::matrix::persistence::account_key

use rand::distr::Alphanumeric;
use rand::RngExt;
use std::path::PathBuf;

/// Fresh, unique key for a session's crypto-store directory — generated once
/// per login/registration and persisted (see `persistence.rs`'s
/// `PersistedSession::crypto_store_key`) so a restart can find the same
/// directory again.
pub fn generate_store_key() -> String {
    rand::rng()
        .sample_iter(&Alphanumeric)
        .take(24)
        .map(char::from)
        .collect()
}

/// Fresh SQLCipher passphrase for a session's crypto store. No OS keychain
/// server-side (see `persistence.rs`'s module doc comment on
/// `CHARM_WEB_SERVER_MASTER_KEY`), so this is generated once per session and
/// persisted encrypted alongside the session token — the same AES-256-GCM
/// blob, the same key-management model, rather than a separate secrets
/// surface. Same length/charset as desktop's `get_or_create_passphrase`.
pub fn generate_passphrase() -> String {
    rand::rng()
        .sample_iter(&Alphanumeric)
        .take(32)
        .map(char::from)
        .collect()
}

/// Where a session's crypto store lives on disk, keyed by
/// [`generate_store_key`]'s output. Mirrors `media_cache.rs`'s use of
/// [`crate::persistence::DATA_DIR_ENV`] for the same base directory.
pub fn store_dir(store_key: &str) -> Result<PathBuf, String> {
    let base =
        std::env::var(crate::persistence::DATA_DIR_ENV).unwrap_or_else(|_| "./data".to_string());
    let dir = PathBuf::from(base).join("crypto").join(store_key);
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir)
}
