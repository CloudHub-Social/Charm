use std::path::{Path, PathBuf};

use matrix_sdk::authentication::matrix::MatrixSession;
use matrix_sdk::authentication::oauth::{ClientId, OAuthSession, UserSession};
use rand::distr::Alphanumeric;
use rand::RngExt;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tauri::{AppHandle, Manager};

/// Single fixed keychain service for this app. Every keychain *account name*
/// below is `<kind>-<account_key>` — see [`account_key`] — so two Matrix
/// accounts signed into the same Charm install never share a passphrase or
/// session entry.
const KEYCHAIN_SERVICE: &str = "social.cloudhub.charm";
const PASSPHRASE_ACCOUNT: &str = "sqlite-store-passphrase";
const SESSION_ACCOUNT: &str = "session";
/// Separate from `SESSION_ACCOUNT`: password/SSO login use matrix-sdk's
/// classic `matrix_auth()` module and its `MatrixSession`, but QR login is
/// OAuth-native (`client.oauth()`) and uses an unrelated `OAuthSession` type
/// — matrix-sdk doesn't unify the two, so neither does this persistence
/// layer. `try_restore_session` checks both accounts.
const OAUTH_SESSION_ACCOUNT: &str = "oauth-session";

/// Prefix marking a `matrix_store/` subdirectory as a not-yet-adopted temp
/// store from an in-progress SSO/QR login (see [`temp_store_key`]) rather
/// than a real per-account store, so [`known_account_keys`] can skip it.
const TEMP_STORE_PREFIX: &str = "tmp-";

fn hex_encode(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

/// Derives a stable, filesystem-safe key from a full MXID (`@user:server`),
/// used both as the per-account store subdirectory name and as the
/// keychain-account suffix for that account's passphrase/session entries.
/// Hashing sidesteps every OS's differing rules on valid filenames/keychain
/// account names (an MXID contains `@`, `:`, and an arbitrary server name)
/// and keeps the raw MXID out of on-disk paths. Deterministic, so
/// `try_restore_session` can recompute it from a saved session's MXID
/// without a separate lookup table.
pub fn account_key(mxid: &str) -> String {
    let digest = Sha256::digest(mxid.as_bytes());
    // 16 bytes (128 bits) of a cryptographic digest — a collision here would
    // silently merge two accounts' stores/keychain entries, reintroducing
    // the exact cross-account collision this module exists to prevent, so
    // this errs well past "practically impossible" rather than minimizing
    // path length.
    hex_encode(&digest[..16])
}

/// A fresh, one-off key for a login attempt that doesn't know its account's
/// MXID yet (SSO/QR): the client is built against this store, and on success
/// [`relocate_store`] moves it (and its passphrase) to the real
/// `account_key` path. Prefixed so it's unambiguously distinct from a real
/// `account_key` (which is a fixed-length hex string with no prefix).
pub fn temp_store_key() -> String {
    let suffix: String = rand::rng()
        .sample_iter(&Alphanumeric)
        .take(16)
        .map(char::from)
        .collect();
    format!("{TEMP_STORE_PREFIX}{suffix}")
}

fn matrix_store_root(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?
        .join("matrix_store");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir)
}

/// Where a single account's (or in-flight login's) SQLCipher-encrypted
/// matrix-rust-sdk store lives on disk, keyed by `store_key` (an
/// [`account_key`] or a [`temp_store_key`]). The encryption key itself never
/// goes anywhere near this path — see `get_or_create_passphrase`.
pub fn store_path(app: &AppHandle, store_key: &str) -> Result<PathBuf, String> {
    store_path_at(&matrix_store_root(app)?, store_key)
}

/// Pure, `AppHandle`-free variant of [`store_path`] — used internally and by
/// integration tests that need to exercise the store layout against a real
/// homeserver without a Tauri app context.
pub fn store_path_at(root: &Path, store_key: &str) -> Result<PathBuf, String> {
    let dir = root.join(store_key);
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir)
}

/// Lists every real per-account store key under `matrix_store/` (i.e. every
/// subdirectory *except* in-flight [`temp_store_key`] ones), for
/// `try_restore_session` to iterate when it doesn't yet know which account's
/// session (if any) is worth restoring.
pub fn known_account_keys(app: &AppHandle) -> Result<Vec<String>, String> {
    known_account_keys_at(&matrix_store_root(app)?)
}

/// Pure, `AppHandle`-free variant of [`known_account_keys`].
pub fn known_account_keys_at(root: &Path) -> Result<Vec<String>, String> {
    let mut keys = Vec::new();
    for entry in std::fs::read_dir(root).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        if !entry.file_type().map_err(|e| e.to_string())?.is_dir() {
            continue;
        }
        let Some(name) = entry.file_name().to_str().map(str::to_string) else {
            continue;
        };
        if !name.starts_with(TEMP_STORE_PREFIX) {
            keys.push(name);
        }
    }
    // `read_dir` order is filesystem-dependent (varies by OS/filesystem and
    // isn't creation order) — sort so callers that iterate multiple known
    // accounts (e.g. `try_restore_session`) get a stable, reproducible
    // choice across launches/platforms rather than whichever the
    // filesystem happens to hand back first.
    keys.sort();
    Ok(keys)
}

/// Whether `account_key` already has a store on disk — i.e. this would be a
/// re-login rather than a first login. Callers that relocate a temp store
/// (see [`relocate_store`]) need to know this *before* relocating: if the
/// account already has a store, relocating just discards the temp one and
/// reuses the existing store, which means the temp-backed `Client` the
/// caller already built can no longer be used (its backing files are gone)
/// — the caller must rebuild against the existing store and restore the
/// session onto that instead.
pub fn account_store_exists(app: &AppHandle, account_key: &str) -> Result<bool, String> {
    Ok(matrix_store_root(app)?.join(account_key).is_dir())
}

/// Best-effort cleanup of every in-flight temp store under `matrix_store/`
/// (i.e. every [`temp_store_key`] directory), run at app startup so a login
/// attempt abandoned by a hard crash (rather than a clean
/// `cancel_sso_login`/`cancel_qr_login`, which clean up their own temp store
/// immediately) doesn't strand its store dir and passphrase entry forever.
pub fn sweep_orphan_temp_stores(app: &AppHandle) -> Result<(), String> {
    sweep_orphan_temp_stores_at(&matrix_store_root(app)?)
}

/// Pure, `AppHandle`-free variant of [`sweep_orphan_temp_stores`].
pub fn sweep_orphan_temp_stores_at(root: &Path) -> Result<(), String> {
    for entry in std::fs::read_dir(root).map_err(|e| e.to_string())? {
        let Ok(entry) = entry else { continue };
        let Ok(file_type) = entry.file_type() else {
            continue;
        };
        if !file_type.is_dir() {
            continue;
        }
        let Some(name) = entry.file_name().to_str().map(str::to_string) else {
            continue;
        };
        if name.starts_with(TEMP_STORE_PREFIX) {
            discard_temp_store(&entry.path(), &name);
        }
    }
    Ok(())
}

fn discard_temp_store(path: &Path, temp_key: &str) {
    let _ = std::fs::remove_dir_all(path);
    if let Ok(entry) = keyring::Entry::new(KEYCHAIN_SERVICE, &passphrase_account(temp_key)) {
        let _ = entry.delete_credential();
    }
}

/// Discards an in-progress login's temp store (dir + passphrase entry),
/// called when the user cancels SSO/QR login before it completes.
pub fn discard_temp_login_store(app: &AppHandle, temp_key: &str) -> Result<(), String> {
    let path = matrix_store_root(app)?.join(temp_key);
    discard_temp_store(&path, temp_key);
    Ok(())
}

/// One-time dev-only migration for the pre-Spec-15 layout, where
/// `matrix_store/` *was* a single account's SQLCipher store directly (no
/// per-account subdirectory) and its passphrase/session/oauth-session
/// entries had no account suffix. Charm 2.0 is pre-release with no real
/// users, so rather than attempt to recover which account that legacy store
/// belonged to, this just wipes it — the account can freely log back in and
/// gets a fresh, correctly-isolated per-account store. Detected by the
/// presence of any *file* directly under `matrix_store/` (a per-account
/// layout only ever has subdirectories there).
pub fn migrate_legacy_single_account_store(app: &AppHandle) -> Result<(), String> {
    let root = matrix_store_root(app)?;
    let has_legacy_files = std::fs::read_dir(&root)
        .map_err(|e| e.to_string())?
        .filter_map(Result::ok)
        .any(|entry| entry.file_type().map(|t| t.is_file()).unwrap_or(false));

    if !has_legacy_files {
        return Ok(());
    }

    std::fs::remove_dir_all(&root).map_err(|e| e.to_string())?;
    std::fs::create_dir_all(&root).map_err(|e| e.to_string())?;

    for legacy_account in [PASSPHRASE_ACCOUNT, SESSION_ACCOUNT, OAUTH_SESSION_ACCOUNT] {
        if let Ok(entry) = keyring::Entry::new(KEYCHAIN_SERVICE, legacy_account) {
            let _ = entry.delete_credential();
        }
    }

    Ok(())
}

fn passphrase_account(store_key: &str) -> String {
    format!("{PASSPHRASE_ACCOUNT}-{store_key}")
}

fn session_account(account_key: &str) -> String {
    format!("{SESSION_ACCOUNT}-{account_key}")
}

fn oauth_session_account(account_key: &str) -> String {
    format!("{OAUTH_SESSION_ACCOUNT}-{account_key}")
}

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

/// Fetches the SQLCipher passphrase for `store_key` (an [`account_key`] or a
/// [`temp_store_key`]) from the OS keychain, generating and storing a new
/// random one on first use. Never written to disk in plaintext and never
/// stored in the same SQLite file it protects.
pub fn get_or_create_passphrase(store_key: &str) -> Result<String, String> {
    let entry = keyring::Entry::new(KEYCHAIN_SERVICE, &passphrase_account(store_key))
        .map_err(|e| e.to_string())?;

    match entry.get_password() {
        Ok(passphrase) => Ok(passphrase),
        Err(keyring::Error::NoEntry) => {
            let passphrase: String = rand::rng()
                .sample_iter(&Alphanumeric)
                .take(32)
                .map(char::from)
                .collect();
            // Two callers can both observe `NoEntry` and race to create the
            // entry (e.g. two Tauri commands, or two tests, touching the
            // same account concurrently) — the OS keychain isn't a
            // check-then-set-atomic API. If `set_password` loses that race,
            // fetch whatever the winner just wrote instead of failing.
            if let Err(e) = entry.set_password(&passphrase) {
                return entry.get_password().map_err(|_| e.to_string());
            }
            Ok(passphrase)
        }
        Err(e) => Err(e.to_string()),
    }
}

/// Atomically relocates a completed SSO/QR login's temp store to its real
/// per-account path, once the flow has yielded a `user_id` and its
/// `account_key` can finally be computed. If a store for that account
/// already exists (a re-login), the existing store is kept and the temp one
/// is discarded instead — matrix-rust-sdk binds a store to whichever
/// account first opened it, so relocating on top of a differently-bound
/// existing store would just recreate the very collision this feature
/// fixes.
///
/// Sequenced for crash safety per the passphrase-then-dir-then-cleanup order
/// in the spec: the new passphrase entry is written *before* the directory
/// is renamed, and the temp passphrase entry is only deleted *after* the
/// rename succeeds. A crash between those steps leaves either two valid
/// passphrase entries pointing at the (still temp-located) store, or a
/// relocated store with a leftover unused temp passphrase entry — never an
/// undecryptable store.
pub fn relocate_store(
    app: &AppHandle,
    temp_key: &str,
    account_key: &str,
) -> Result<PathBuf, String> {
    relocate_store_at(&matrix_store_root(app)?, temp_key, account_key)
}

/// Pure, `AppHandle`-free variant of [`relocate_store`].
pub fn relocate_store_at(
    root: &Path,
    temp_key: &str,
    account_key: &str,
) -> Result<PathBuf, String> {
    let temp_path = root.join(temp_key);
    let account_path = root.join(account_key);

    if account_path.exists() {
        discard_temp_store(&temp_path, temp_key);
        return Ok(account_path);
    }

    let passphrase = get_or_create_passphrase(temp_key)?;
    let account_entry = keyring::Entry::new(KEYCHAIN_SERVICE, &passphrase_account(account_key))
        .map_err(|e| e.to_string())?;
    account_entry
        .set_password(&passphrase)
        .map_err(|e| e.to_string())?;

    std::fs::rename(&temp_path, &account_path).map_err(|e| e.to_string())?;

    if let Ok(temp_entry) = keyring::Entry::new(KEYCHAIN_SERVICE, &passphrase_account(temp_key)) {
        let _ = temp_entry.delete_credential();
    }

    Ok(account_path)
}

pub fn save_session(
    account_key: &str,
    homeserver_url: &str,
    session: &MatrixSession,
) -> Result<(), String> {
    let entry = keyring::Entry::new(KEYCHAIN_SERVICE, &session_account(account_key))
        .map_err(|e| e.to_string())?;
    let saved = SavedSession {
        homeserver_url: homeserver_url.to_string(),
        session: session.clone(),
    };
    let json = serde_json::to_string(&saved).map_err(|e| e.to_string())?;
    entry.set_password(&json).map_err(|e| e.to_string())
}

pub fn load_session(account_key: &str) -> Result<Option<SavedSession>, String> {
    let entry = keyring::Entry::new(KEYCHAIN_SERVICE, &session_account(account_key))
        .map_err(|e| e.to_string())?;
    match entry.get_password() {
        Ok(json) => serde_json::from_str(&json)
            .map(Some)
            .map_err(|e| e.to_string()),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(e) => Err(e.to_string()),
    }
}

/// Removes the saved session for `account_key`, e.g. after a restore attempt
/// fails because the homeserver revoked the access token — without this,
/// every future launch would keep retrying the same dead session. Leaves
/// that account's store (and passphrase) in place for a fast re-login; see
/// Spec 08 (logout).
pub fn clear_session(account_key: &str) -> Result<(), String> {
    let entry = keyring::Entry::new(KEYCHAIN_SERVICE, &session_account(account_key))
        .map_err(|e| e.to_string())?;
    match entry.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) => Err(e.to_string()),
    }
}

pub fn save_oauth_session(
    account_key: &str,
    homeserver_url: &str,
    session: &OAuthSession,
) -> Result<(), String> {
    let entry = keyring::Entry::new(KEYCHAIN_SERVICE, &oauth_session_account(account_key))
        .map_err(|e| e.to_string())?;
    let saved = SavedOAuthSession::from_oauth_session(homeserver_url, session);
    let json = serde_json::to_string(&saved).map_err(|e| e.to_string())?;
    entry.set_password(&json).map_err(|e| e.to_string())
}

pub fn load_oauth_session(account_key: &str) -> Result<Option<SavedOAuthSession>, String> {
    let entry = keyring::Entry::new(KEYCHAIN_SERVICE, &oauth_session_account(account_key))
        .map_err(|e| e.to_string())?;
    match entry.get_password() {
        Ok(json) => serde_json::from_str(&json)
            .map(Some)
            .map_err(|e| e.to_string()),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(e) => Err(e.to_string()),
    }
}

pub fn clear_oauth_session(account_key: &str) -> Result<(), String> {
    let entry = keyring::Entry::new(KEYCHAIN_SERVICE, &oauth_session_account(account_key))
        .map_err(|e| e.to_string())?;
    match entry.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) => Err(e.to_string()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use matrix_sdk::authentication::SessionTokens;
    use matrix_sdk::ruma::device_id;
    use matrix_sdk::SessionMeta;

    const TEST_MXID_A: &str = "@charm-persistence-test-a:localhost";
    const TEST_MXID_B: &str = "@charm-persistence-test-b:localhost";

    /// A scratch `matrix_store/`-equivalent directory for tests that need a
    /// real filesystem root, cleaned up on drop so parallel `cargo test`
    /// runs of these functions never share (or fight over) state.
    struct ScratchRoot(PathBuf);

    impl ScratchRoot {
        fn new(name: &str) -> Self {
            let suffix: String = rand::rng()
                .sample_iter(&Alphanumeric)
                .take(12)
                .map(char::from)
                .collect();
            let path = std::env::temp_dir().join(format!("charm-persistence-test-{name}-{suffix}"));
            std::fs::create_dir_all(&path).unwrap();
            Self(path)
        }
    }

    impl Drop for ScratchRoot {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
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

    #[test]
    fn account_key_is_deterministic_and_filesystem_safe() {
        let key_a = account_key(TEST_MXID_A);
        let key_a_again = account_key(TEST_MXID_A);
        let key_b = account_key(TEST_MXID_B);

        assert_eq!(key_a, key_a_again);
        assert_ne!(key_a, key_b);
        assert!(key_a
            .chars()
            .all(|c| c.is_ascii_hexdigit() && !c.is_ascii_uppercase()));
        assert!(!key_a.contains('@'));
        assert!(!key_a.contains(':'));
    }

    #[test]
    fn temp_store_key_is_distinguishable_from_an_account_key() {
        let temp = temp_store_key();
        assert!(temp.starts_with(TEMP_STORE_PREFIX));
        assert_ne!(temp, account_key(TEST_MXID_A));
    }

    /// Exercises the real OS keychain, not a mock — this is the actual
    /// security-relevant boundary (passphrase and tokens never touching disk
    /// in plaintext), so a test that doesn't hit it wouldn't prove much.
    #[test]
    fn session_round_trips_through_keychain_per_account() {
        let key_a = account_key(TEST_MXID_A);
        let key_b = account_key(TEST_MXID_B);
        clear_session(&key_a).unwrap();
        clear_session(&key_b).unwrap();
        assert!(load_session(&key_a).unwrap().is_none());

        let session_a = dummy_session(TEST_MXID_A);
        save_session(&key_a, "https://example.invalid", &session_a).unwrap();

        // A different account's session entry is untouched.
        assert!(load_session(&key_b).unwrap().is_none());

        let loaded = load_session(&key_a)
            .unwrap()
            .expect("session was just saved");
        assert_eq!(loaded.homeserver_url, "https://example.invalid");
        assert_eq!(loaded.session.meta.user_id, session_a.meta.user_id);
        assert_eq!(
            loaded.session.tokens.access_token,
            session_a.tokens.access_token
        );

        clear_session(&key_a).unwrap();
        assert!(load_session(&key_a).unwrap().is_none());
    }

    fn dummy_oauth_session(mxid: &str) -> OAuthSession {
        OAuthSession {
            client_id: ClientId::new("test-client-id".to_string()),
            user: UserSession {
                meta: SessionMeta {
                    user_id: matrix_sdk::ruma::UserId::parse(mxid).unwrap(),
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
    fn oauth_session_round_trips_through_keychain_per_account() {
        let key_a = account_key(TEST_MXID_A);
        clear_oauth_session(&key_a).unwrap();
        assert!(load_oauth_session(&key_a).unwrap().is_none());

        let session = dummy_oauth_session(TEST_MXID_A);
        save_oauth_session(&key_a, "https://example.invalid", &session).unwrap();

        let loaded = load_oauth_session(&key_a)
            .unwrap()
            .expect("session was just saved");
        assert_eq!(loaded.homeserver_url, "https://example.invalid");
        assert_eq!(loaded.client_id, session.client_id.as_str());
        assert_eq!(loaded.user.meta.user_id, session.user.meta.user_id);
        assert_eq!(
            loaded.user.tokens.access_token,
            session.user.tokens.access_token
        );

        clear_oauth_session(&key_a).unwrap();
        assert!(load_oauth_session(&key_a).unwrap().is_none());
    }

    #[test]
    fn passphrase_is_stable_across_calls_and_isolated_per_key() {
        let key_a = account_key(TEST_MXID_A);
        let key_b = account_key(TEST_MXID_B);

        let first = get_or_create_passphrase(&key_a).unwrap();
        let second = get_or_create_passphrase(&key_a).unwrap();
        assert_eq!(first, second);
        assert_eq!(first.len(), 32);

        let other_account = get_or_create_passphrase(&key_b).unwrap();
        assert_ne!(first, other_account);
    }

    #[test]
    fn relocate_store_moves_dir_and_passphrase_in_lockstep() {
        let root = ScratchRoot::new("relocate");
        let temp_key = temp_store_key();
        let account_key = account_key(TEST_MXID_A);

        let temp_path = store_path_at(&root.0, &temp_key).unwrap();
        std::fs::write(temp_path.join("marker.txt"), b"hello").unwrap();
        let temp_passphrase = get_or_create_passphrase(&temp_key).unwrap();

        let relocated = relocate_store_at(&root.0, &temp_key, &account_key).unwrap();

        assert_eq!(relocated, root.0.join(&account_key));
        assert!(relocated.join("marker.txt").exists());
        assert!(!temp_path.exists());
        assert_eq!(
            get_or_create_passphrase(&account_key).unwrap(),
            temp_passphrase
        );
        // The temp passphrase entry was deleted, not just orphaned.
        let temp_entry =
            keyring::Entry::new(KEYCHAIN_SERVICE, &passphrase_account(&temp_key)).unwrap();
        assert!(matches!(
            temp_entry.get_password(),
            Err(keyring::Error::NoEntry)
        ));

        if let Ok(entry) = keyring::Entry::new(KEYCHAIN_SERVICE, &passphrase_account(&account_key))
        {
            let _ = entry.delete_credential();
        }
    }

    #[test]
    fn relocate_store_reuses_existing_account_store_and_discards_temp() {
        let root = ScratchRoot::new("relocate-reuse");
        let account_key = account_key(TEST_MXID_B);

        // Simulate an account that already has a store from a prior login.
        let existing_path = store_path_at(&root.0, &account_key).unwrap();
        std::fs::write(existing_path.join("existing.txt"), b"pre-existing").unwrap();
        let existing_passphrase = get_or_create_passphrase(&account_key).unwrap();

        let temp_key = temp_store_key();
        let temp_path = store_path_at(&root.0, &temp_key).unwrap();
        std::fs::write(temp_path.join("marker.txt"), b"temp").unwrap();
        let _ = get_or_create_passphrase(&temp_key).unwrap();

        let relocated = relocate_store_at(&root.0, &temp_key, &account_key).unwrap();

        assert_eq!(relocated, existing_path);
        assert!(relocated.join("existing.txt").exists());
        assert!(!relocated.join("marker.txt").exists());
        assert!(!temp_path.exists());
        assert_eq!(
            get_or_create_passphrase(&account_key).unwrap(),
            existing_passphrase
        );
        let temp_entry =
            keyring::Entry::new(KEYCHAIN_SERVICE, &passphrase_account(&temp_key)).unwrap();
        assert!(matches!(
            temp_entry.get_password(),
            Err(keyring::Error::NoEntry)
        ));

        if let Ok(entry) = keyring::Entry::new(KEYCHAIN_SERVICE, &passphrase_account(&account_key))
        {
            let _ = entry.delete_credential();
        }
    }

    #[test]
    fn known_account_keys_excludes_temp_stores() {
        let root = ScratchRoot::new("known-keys");
        let account_key = account_key("@charm-persistence-test-known:localhost");
        let temp_key = temp_store_key();

        store_path_at(&root.0, &account_key).unwrap();
        store_path_at(&root.0, &temp_key).unwrap();

        let keys = known_account_keys_at(&root.0).unwrap();
        assert!(keys.contains(&account_key));
        assert!(!keys.contains(&temp_key));
    }

    #[test]
    fn sweep_orphan_temp_stores_removes_temp_dirs_and_passphrases() {
        let root = ScratchRoot::new("sweep");
        let account_key = account_key("@charm-persistence-test-sweep:localhost");
        let temp_key = temp_store_key();

        store_path_at(&root.0, &account_key).unwrap();
        let temp_path = store_path_at(&root.0, &temp_key).unwrap();
        let _ = get_or_create_passphrase(&temp_key).unwrap();

        sweep_orphan_temp_stores_at(&root.0).unwrap();

        assert!(!temp_path.exists());
        assert!(root.0.join(&account_key).exists());
        let temp_entry =
            keyring::Entry::new(KEYCHAIN_SERVICE, &passphrase_account(&temp_key)).unwrap();
        assert!(matches!(
            temp_entry.get_password(),
            Err(keyring::Error::NoEntry)
        ));
    }
}
