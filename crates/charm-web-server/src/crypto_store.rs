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

/// Computes (but never creates) where a session's crypto store lives on
/// disk, keyed by [`generate_store_key`]'s output. Mirrors `media_cache.rs`'s
/// use of [`crate::persistence::DATA_DIR_ENV`] for the same base directory.
///
/// Rejects a `store_key` containing anything other than ASCII alphanumerics
/// — every key this module itself generates already satisfies that (see
/// [`generate_store_key`]), but `store_key` also round-trips through
/// encrypted-at-rest persisted state (`persistence.rs`'s
/// `PersistedSession::crypto_store_key`), so a corrupted or (if ever
/// generalized) externally-influenced value must never reach
/// `PathBuf::join` unvalidated — same reasoning `media_cache.rs` hashes a
/// homeserver-controlled device id for before using it as a path component.
fn store_path(store_key: &str) -> Result<PathBuf, String> {
    if store_key.is_empty() || !store_key.chars().all(|c| c.is_ascii_alphanumeric()) {
        return Err(format!("invalid crypto store key: {store_key:?}"));
    }
    let base =
        std::env::var(crate::persistence::DATA_DIR_ENV).unwrap_or_else(|_| "./data".to_string());
    Ok(PathBuf::from(base).join("crypto").join(store_key))
}

/// The directory for a *new* session's crypto store, creating it if
/// necessary — only called when establishing a fresh store at login/
/// registration (see `auth.rs::build_client`), where "doesn't exist yet" is
/// the expected, correct state to create it from.
pub fn create_store_dir(store_key: &str) -> Result<PathBuf, String> {
    let dir = store_path(store_key)?;
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir)
}

/// The directory for a previously-established session's crypto store —
/// `Ok(None)` (not an error, and never created) if it isn't there. Used by
/// restore (a missing directory, e.g. lost on a DO App Platform redeploy —
/// see this module's doc comment — must fall back to a fresh in-memory
/// client, never silently open/create an empty store in its place and have
/// that look like a legitimately-empty-but-real crypto store) and by logout
/// cleanup (nothing to remove if it was never there).
pub fn existing_store_dir(store_key: &str) -> Result<Option<PathBuf>, String> {
    let dir = store_path(store_key)?;
    Ok(dir.is_dir().then_some(dir))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn scratch_data_dir(name: &str) -> std::path::PathBuf {
        let suffix: String = format!("{:x}", rand::random::<u64>());
        let path =
            std::env::temp_dir().join(format!("charm-web-server-crypto-store-{name}-{suffix}"));
        std::fs::create_dir_all(&path).unwrap();
        path
    }

    /// Regression test for the Sentry-flagged bug this split fixed:
    /// `existing_store_dir` must never create the directory it reports on —
    /// unlike the old, single `store_dir` (which always `create_dir_all`'d,
    /// even when just checking for restore/logout), a directory that
    /// genuinely doesn't exist yet must come back as `Ok(None)` with nothing
    /// left behind on disk afterward.
    #[test]
    fn existing_store_dir_never_creates_a_missing_directory() {
        let _lock = crate::ENV_TEST_LOCK.blocking_lock();
        let data_dir = scratch_data_dir("missing");
        std::env::set_var(crate::persistence::DATA_DIR_ENV, data_dir.to_str().unwrap());

        let result = existing_store_dir("somemissingstorekey").unwrap();

        assert!(result.is_none());
        assert!(
            !data_dir.join("crypto").exists(),
            "existing_store_dir must not create the crypto/ directory as a side effect"
        );
        std::env::remove_var(crate::persistence::DATA_DIR_ENV);
    }

    /// The counterpart: once `create_store_dir` has actually established a
    /// store, `existing_store_dir` must find it.
    #[test]
    fn existing_store_dir_finds_a_directory_create_store_dir_made() {
        let _lock = crate::ENV_TEST_LOCK.blocking_lock();
        let data_dir = scratch_data_dir("present");
        std::env::set_var(crate::persistence::DATA_DIR_ENV, data_dir.to_str().unwrap());

        let created = create_store_dir("somepresentstorekey").unwrap();
        let found = existing_store_dir("somepresentstorekey").unwrap();

        assert_eq!(found, Some(created));
        std::env::remove_var(crate::persistence::DATA_DIR_ENV);
    }

    #[test]
    fn store_path_rejects_non_alphanumeric_keys() {
        assert!(existing_store_dir("../../etc/passwd").is_err());
        assert!(existing_store_dir("has spaces").is_err());
        assert!(existing_store_dir("").is_err());
    }
}
