use std::path::{Path, PathBuf};

use matrix_sdk::authentication::matrix::MatrixSession;
use matrix_sdk::authentication::oauth::{ClientId, OAuthSession, UserSession};
use rand::distr::Alphanumeric;
use rand::RngExt;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tauri::{AppHandle, Manager};

use super::secret_store::{SecretEntry, SecretStoreError};

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

/// Suffix marking a `matrix_store/` subdirectory as a stale store
/// [`relocate_store_at_locked`] has moved aside pending discard, rather than
/// a real per-account store — so [`known_account_keys`] must skip it too
/// (otherwise a leftover backup, from e.g. its best-effort final cleanup
/// failing, would be treated as a real account and `try_restore_session`
/// would attempt — and fail — to restore a session for it on every launch).
const STALE_BACKUP_SUFFIX: &str = ".stale-backup";

/// Marker file written inside an account's store directory only once a
/// superseding [`relocate_store_at_locked_with`] call has *fully* committed
/// — the directory rename *and* `on_commit` (typically the session save)
/// have both succeeded. `account_path` starts existing as soon as the
/// rename completes, before `on_commit` runs, so its mere existence isn't
/// proof the whole relocation finished — [`recover_or_discard_stale_backup`]
/// checks for this marker instead, so a crash in that narrow window (new
/// store installed, but the keychain still holds the *old* session) is
/// treated the same as a crash before the rename at all: the new,
/// not-actually-committed store is discarded and the backup — which still
/// correctly pairs with whatever's in the keychain, since `on_commit` never
/// ran to change it — is restored instead.
const COMMIT_MARKER_FILENAME: &str = ".relocation-committed";

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
    matrix_store_root_at(&app.path().app_data_dir().map_err(|e| e.to_string())?)
}

/// Pure, `AppHandle`-free variant of [`matrix_store_root`] — used by the
/// Android cold-start push receiver, which has an Android `Context` but no
/// running Tauri app lifecycle.
pub fn matrix_store_root_at(app_data_dir: &Path) -> Result<PathBuf, String> {
    let dir = app_data_dir.join("matrix_store");
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
        if !name.starts_with(TEMP_STORE_PREFIX) && !name.ends_with(STALE_BACKUP_SUFFIX) {
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

/// Best-effort cleanup of every in-flight temp store under `matrix_store/`
/// (i.e. every [`temp_store_key`] directory), run at app startup so a login
/// attempt abandoned by a hard crash (rather than a clean
/// `cancel_sso_login`/`cancel_qr_login`, which clean up their own temp store
/// immediately) doesn't strand its store dir and passphrase entry forever.
/// Also sweeps any [`STALE_BACKUP_SUFFIX`] directory left behind by a
/// [`relocate_store_at_locked`] whose final best-effort backup removal
/// failed — same "leftover from an interrupted run" shape, so it's handled
/// alongside orphan temp stores rather than via a separate startup hook.
pub fn sweep_orphan_temp_stores(app: &AppHandle) -> Result<(), String> {
    sweep_orphan_temp_stores_at(&matrix_store_root(app)?)
}

static STARTUP_SWEEP_READY: std::sync::OnceLock<(
    tokio::sync::watch::Sender<bool>,
    tokio::sync::watch::Receiver<bool>,
)> = std::sync::OnceLock::new();

fn startup_sweep_channel() -> &'static (
    tokio::sync::watch::Sender<bool>,
    tokio::sync::watch::Receiver<bool>,
) {
    STARTUP_SWEEP_READY.get_or_init(|| tokio::sync::watch::channel(false))
}

/// Called once by `lib.rs`'s `.setup()` after the background
/// `sweep_orphan_temp_stores` task finishes (success or failure — a failed
/// sweep still shouldn't leave startup restore waiting forever). See
/// [`wait_for_startup_sweep`].
pub fn mark_startup_sweep_complete() {
    let _ = startup_sweep_channel().0.send(true);
}

/// `try_restore_session` awaits this before iterating `known_account_keys`
/// (Codex review on #288, P1): that sweep is also what recovers a
/// [`STALE_BACKUP_SUFFIX`] directory left by a crash mid-relocation, and
/// `known_account_keys` skips such directories entirely — if restore ran
/// first, it would see no store at all for that account and skip it, even
/// though the account has a perfectly recoverable session. Bounded so a
/// sweep that panics or never runs (there's no other caller of
/// `mark_startup_sweep_complete`) can't hang startup restore forever; a
/// timeout is logged and restore proceeds with whatever's on disk, same as
/// before this coordination existed.
pub async fn wait_for_startup_sweep(timeout: std::time::Duration) {
    let mut rx = startup_sweep_channel().1.clone();
    if *rx.borrow() {
        return;
    }
    if tokio::time::timeout(timeout, rx.changed()).await.is_err() {
        eprintln!("timed out waiting for startup orphan-temp-store sweep before restoring session");
    }
}

/// A `tmp-*` directory younger than this is never swept, regardless of how
/// long the sweep itself has been running (Codex review on #288, P1). This
/// sweep now runs as a spawned background task rather than blocking window
/// creation (see its call site in `lib.rs`'s `.setup()`), so it can still be
/// mid-`read_dir` when a login/register/SSO/QR flow creates its own `tmp-*`
/// store — the sweep has no way to distinguish "orphaned by a past crash"
/// from "a login in progress right now" other than age. `login`/`register`
/// additionally hold `restore_store_lock` for their whole duration as a
/// second, redundant guard (belt-and-suspenders, and documents intent at
/// those call sites), but SSO and QR login can't reasonably do the same —
/// their temp store's lifetime spans a separate long-running task waiting on
/// a browser redirect or QR scan, potentially minutes, and holding this lock
/// for that whole window would block anything else that needs it for no
/// benefit (the sweep only ever runs once, in the first few seconds after
/// launch). This grace period is the fix that actually covers all four
/// flows uniformly: a store created moments ago is essentially always still
/// in active use, however long its owning flow ultimately takes to finish —
/// old enough to have survived from a *previous* session (which is the only
/// thing this sweep is meant to clean up) reliably means older than this by
/// a huge margin. 5 minutes is generous slack for a slow/busy launch (many
/// stale directories, a loaded disk) while still being far shorter than any
/// realistic previous-session gap.
const ORPHAN_TEMP_STORE_MIN_AGE: std::time::Duration = std::time::Duration::from_secs(5 * 60);

/// Pure, `AppHandle`-free variant of [`sweep_orphan_temp_stores`].
pub fn sweep_orphan_temp_stores_at(root: &Path) -> Result<(), String> {
    sweep_orphan_temp_stores_at_with_min_age(root, ORPHAN_TEMP_STORE_MIN_AGE)
}

/// Core logic behind [`sweep_orphan_temp_stores_at`], taking the minimum age
/// explicitly so tests can use a near-zero threshold instead of waiting on
/// real wall-clock time.
fn sweep_orphan_temp_stores_at_with_min_age(
    root: &Path,
    min_age: std::time::Duration,
) -> Result<(), String> {
    let now = std::time::SystemTime::now();
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
            // Best-effort, with two distinct failure modes handled
            // differently:
            // - mtime unreadable at all: err toward sweeping it, matching
            //   the pre-existing behavior for every other failure mode in
            //   this best-effort cleanup pass — an unreadable mtime is
            //   itself unusual enough to suggest genuine filesystem trouble
            //   rather than a live directory.
            // - mtime reads as *later* than `now` (clock skew, or a write
            //   landing between reading `now` and stat'ing this entry): err
            //   toward treating it as fresh — `duration_since` returning
            //   `Err` here means "younger than `now`, however you slice it,"
            //   which is the one thing this check exists to protect against
            //   sweeping.
            let is_fresh = match entry.metadata().and_then(|metadata| metadata.modified()) {
                Ok(modified) => match now.duration_since(modified) {
                    Ok(age) => age < min_age,
                    Err(_) => true,
                },
                Err(_) => false,
            };
            if is_fresh {
                continue;
            }
            discard_temp_store(&entry.path(), &name);
        } else if let Some(account_key) = name.strip_suffix(STALE_BACKUP_SUFFIX) {
            recover_or_discard_stale_backup(root, account_key, &name, &entry.path());
        }
    }
    Ok(())
}

fn discard_temp_store(path: &Path, temp_key: &str) {
    let _ = std::fs::remove_dir_all(path);
    if let Ok(entry) = SecretEntry::new(KEYCHAIN_SERVICE, &passphrase_account(temp_key)) {
        let _ = entry.delete_credential();
    }
}

/// Handles a leftover `[account_key].stale-backup` directory found at
/// startup, or found by a fresh relocation attempt about to reuse the same
/// `backup_key`. Three ways it can exist: (1) [`relocate_store_at_locked_with`]
/// fully committed a relocation (rename *and* `on_commit` both succeeded,
/// marked by [`COMMIT_MARKER_FILENAME`]) but its own final best-effort
/// backup removal failed — `account_key`'s path has a real, current,
/// correctly-paired store, and the backup is genuinely safe to discard — or
/// (2) the process crashed before the rename, or between the rename and
/// `on_commit` succeeding — either way there's no fully-committed store at
/// `account_key`'s path (in case (2)'s "between" scenario, whatever's there
/// is a store the keychain's saved session was never updated to match), and
/// this backup — which the keychain's *current* saved session still
/// correctly pairs with, since `on_commit` never ran to change it — must be
/// restored instead, or the account's data (and a matching session for it)
/// is lost. Checking the marker rather than mere directory existence is
/// what distinguishes case (1) from the "rename succeeded, `on_commit`
/// didn't" half of case (2) — both leave a directory at `account_key`'s
/// path, but only one of them is actually paired with what's in the
/// keychain.
///
/// Returns whether the leftover was actually resolved (discarded or
/// restored) — `false` means it's still sitting there unresolved (e.g. a
/// transient keychain failure mid-recovery). Callers about to reuse the
/// same `backup_key` themselves (a fresh relocation superseding this same
/// account) must check this and bail rather than proceed: an unresolved
/// leftover backup is the account's only copy of *something* (either the
/// data or the credential needed to read it), and blindly overwriting
/// `backup_path` out from under it would destroy that before it was ever
/// actually recovered.
fn recover_or_discard_stale_backup(
    root: &Path,
    account_key: &str,
    backup_key: &str,
    backup_path: &Path,
) -> bool {
    let account_path = root.join(account_key);
    let backup_passphrase_entry =
        SecretEntry::new(KEYCHAIN_SERVICE, &passphrase_account(backup_key));

    if account_path.join(COMMIT_MARKER_FILENAME).exists() {
        let _ = std::fs::remove_dir_all(backup_path);
        if let Ok(entry) = backup_passphrase_entry {
            let _ = entry.delete_credential();
        }
        return true;
    }

    let restored = (|| -> Option<()> {
        // Not (fully) committed — discard whatever's at `account_path` (it
        // might not exist at all, or might be an uncommitted store whose
        // session was never saved) before doing anything else. Checked here
        // (not `let _ =` best-effort), and the whole recovery bails if it
        // doesn't actually succeed: proceeding to write the account's
        // keychain passphrase to the *backup's* value while stale content
        // is still sitting at `account_path` would pair that passphrase
        // with the wrong store — the uncommitted one, not the backup.
        match std::fs::remove_dir_all(&account_path) {
            Ok(()) => {}
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
            Err(_) => return None,
        }

        let backup_entry = backup_passphrase_entry.ok()?;
        let passphrase = backup_entry.get_password().ok()?;
        // Account passphrase entry *first*, directory swap only *after* —
        // if the keychain write fails transiently, `backup_path` is still
        // untouched and the next startup sweep can retry this whole
        // recovery from scratch. The reverse order would leave nothing to
        // retry: if the rename ran first and *then* the passphrase write
        // failed, `backup_path` would already be gone with no directory
        // left for a future sweep to find. Safe either way for
        // `account_path` itself: it's confirmed empty above, so there's no
        // window where a mismatched passphrase pairs with real data.
        let account_entry =
            SecretEntry::new(KEYCHAIN_SERVICE, &passphrase_account(account_key)).ok()?;
        account_entry.set_password(&passphrase).ok()?;
        std::fs::rename(backup_path, &account_path).ok()?;
        let _ = backup_entry.delete_credential();
        Some(())
    })();

    if restored.is_none() {
        eprintln!(
            "sweep_orphan_temp_stores: found an orphaned stale-backup for {account_key} at {} with no recoverable passphrase — leaving it in place rather than discarding possibly-unrecoverable data",
            backup_path.display()
        );
    }
    restored.is_some()
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
/// presence of one of matrix-rust-sdk's own SQLite store files (e.g.
/// `matrix-sdk-state.sqlite3`) directly under `matrix_store/` — not just
/// "any file", which would also match a stray `.DS_Store` or similar and
/// wipe an otherwise-healthy per-account layout for no reason.
pub fn migrate_legacy_single_account_store(app: &AppHandle) -> Result<(), String> {
    let root = matrix_store_root(app)?;
    let has_legacy_files = std::fs::read_dir(&root)
        .map_err(|e| e.to_string())?
        .filter_map(Result::ok)
        .any(|entry| {
            entry.file_type().map(|t| t.is_file()).unwrap_or(false)
                && entry
                    .file_name()
                    .to_str()
                    .is_some_and(|name| name.starts_with("matrix-sdk-") && name.contains("sqlite"))
        });

    if !has_legacy_files {
        return Ok(());
    }

    std::fs::remove_dir_all(&root).map_err(|e| e.to_string())?;
    std::fs::create_dir_all(&root).map_err(|e| e.to_string())?;

    for legacy_account in [PASSPHRASE_ACCOUNT, SESSION_ACCOUNT, OAUTH_SESSION_ACCOUNT] {
        if let Ok(entry) = SecretEntry::new(KEYCHAIN_SERVICE, legacy_account) {
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
    let entry = SecretEntry::new(KEYCHAIN_SERVICE, &passphrase_account(store_key))
        .map_err(|e| e.to_string())?;

    match entry.get_password() {
        Ok(passphrase) => Ok(passphrase),
        Err(SecretStoreError::NotFound) => {
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

/// What [`relocate_store`] actually did. Both variants leave the temp-backed
/// `Client` that was already using it valid — a fresh interactive login
/// (password/SSO/QR) always mints a brand-new `device_id` from the
/// homeserver, and matrix-sdk-crypto binds a crypto store to whichever
/// device first opened it, so the just-authenticated session can never
/// correctly bind to a *different*, pre-existing store. There is no case
/// where restoring the new session onto an old store is the right move —
/// see [`Superseded`](RelocateOutcome::Superseded).
///
/// Deliberately the *only* source of truth for this — a caller checking
/// whether the account store exists itself beforehand and separately
/// calling [`relocate_store`] would race: a concurrent login for the same
/// account could create the account store in between those two checks, so
/// the caller's stale pre-check result wouldn't match what this function
/// actually did.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RelocateOutcome {
    /// No store existed at `account_key`'s path yet — the temp store was
    /// renamed there.
    Relocated(PathBuf),
    /// `account_key` already had a store — most commonly just a repeated
    /// login for the same account (every interactive login mints a new
    /// `device_id`, so this is a routine, non-error outcome), but also
    /// reachable via a store orphaned by an incomplete previous
    /// login/logout. Either way it was discarded and the temp store was
    /// renamed into its place instead. [`relocate_store_at`] logs this case,
    /// since it means a pre-existing store's data was just discarded — safe
    /// only under the "always a new device" assumption documented on
    /// [`relocate_store`].
    Superseded(PathBuf),
}

impl RelocateOutcome {
    pub fn path(&self) -> &Path {
        match self {
            RelocateOutcome::Relocated(path) | RelocateOutcome::Superseded(path) => path,
        }
    }
}

/// Atomically relocates a completed login's temp store to its real
/// per-account path, once the flow has yielded a `user_id` and its
/// `account_key` can finally be computed. If a store for that account
/// already exists, it is treated as stale and discarded, and the temp store
/// (bound to the session that was *just* authenticated) is relocated in its
/// place instead — matrix-sdk-crypto binds a crypto store to whichever device
/// first opened it, and an interactive login always yields a new device, so
/// keeping the old store and trying to restore the new session onto it
/// would fail with "the account in the store doesn't match the account in
/// the constructor" (matrix-sdk-crypto correctly refusing to bind a second
/// device to an already-bound store). The client already authenticated
/// against the temp store remains valid and needs no rebuild — regardless
/// of which [`RelocateOutcome`] variant is returned.
///
/// Sequenced for crash safety, and for rollback safety if a later fallible
/// step fails (including, via [`relocate_store_and_save_session`] /
/// [`relocate_store_and_save_oauth_session`], the session save that follows
/// relocation — see [`relocate_store_at_locked_with`]): any stale existing
/// store is first *moved aside* to a backup path (not deleted), and its
/// original passphrase captured, before the account's keychain entry is
/// overwritten — this doubles as the same-volume `rename` that also
/// guarantees `account_path` is clear for the final rename below. Only once
/// the new account passphrase entry is written, the temp passphrase entry is
/// deleted, the temp store is renamed into `account_path`, and any commit
/// hook succeeds — i.e. the new store is fully installed and its session (if
/// any) saved — is the backup actually discarded. If any of those steps
/// fails first, the *entire* relocation rolls back: the newly-installed
/// store (if any) is removed, the backup directory is renamed back to
/// `account_path`, and its original passphrase is restored to the keychain —
/// so the account ends up either fully on the new store or fully back on the
/// old one, never a fully-installed new store paired with the old session
/// (or vice versa). A crash — as opposed to a clean `Err` return, which the
/// rollback above already handles — after the backup rename but before the
/// final rename leaves `account_path` empty with both the backup and the
/// temp store (plus its keychain entry) intact; the next relocation attempt
/// finds no store at `account_path` and proceeds via the plain first-time
/// path, leaking the backup directory (recoverable manually, never silently
/// merged or overwritten, and eventually swept by
/// [`sweep_orphan_temp_stores`]) rather than losing data. A crash after
/// writing the account entry but before deleting the temp one leaves two
/// valid entries pointing at the same (still temp-located) store — never an
/// undecryptable one. A crash after deleting the temp entry but before the
/// final rename leaves the temp directory in place with no keychain entry
/// pointing at it; [`sweep_orphan_temp_stores`] finds and discards that
/// directory on the next startup (its `discard_temp_store` no-ops on the
/// already-gone keychain entry), so nothing is orphaned in the keychain.
/// Deliberately *not* the reverse order (final rename, then delete the temp
/// entry): a crash in that gap left the *directory* gone but the temp
/// keychain entry still present with nothing left to associate it with —
/// `sweep_orphan_temp_stores` only scans directories by name, so that entry
/// would accumulate in the keychain forever instead of ever being cleaned
/// up.
pub fn relocate_store(
    app: &AppHandle,
    temp_key: &str,
    account_key: &str,
) -> Result<RelocateOutcome, String> {
    let _guard = RELOCATE_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    relocate_store_at_locked(&matrix_store_root(app)?, temp_key, account_key)
}

/// Runs `relocate_store_at`'s relocation and then `save_session` under the
/// *same* [`RELOCATE_LOCK`] critical section — without this, a losing
/// concurrent completion (e.g. a double-submitted login) could still write
/// its session to the keychain after a winning completion has already
/// superseded the store with a different one, leaving the saved session
/// pointing at a store that no longer matches it (the exact crypto-mismatch
/// this module exists to prevent, just relocated to the session/store
/// pairing instead of the relocation itself). If `save_session` fails, the
/// whole relocation is rolled back (see [`relocate_store_at_locked_with`])
/// rather than leaving a fully-installed new store paired with whatever
/// session was previously saved (which — if this was a supersede — is a
/// *different* device's session than the one now installed).
pub fn relocate_store_and_save_session(
    app: &AppHandle,
    temp_key: &str,
    account_key: &str,
    homeserver_url: &str,
    session: &MatrixSession,
) -> Result<RelocateOutcome, RelocationFailure> {
    let _guard = RELOCATE_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    relocate_store_at_locked_with(
        &matrix_store_root(app).map_err(RelocationFailure::safe)?,
        temp_key,
        account_key,
        || save_session(account_key, homeserver_url, session),
    )
}

/// OAuth-session counterpart of [`relocate_store_and_save_session`], for the
/// QR login flow (see [`OAUTH_SESSION_ACCOUNT`]'s doc comment for why the
/// two session kinds are separate).
pub fn relocate_store_and_save_oauth_session(
    app: &AppHandle,
    temp_key: &str,
    account_key: &str,
    homeserver_url: &str,
    session: &OAuthSession,
) -> Result<RelocateOutcome, RelocationFailure> {
    let _guard = RELOCATE_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    relocate_store_at_locked_with(
        &matrix_store_root(app).map_err(RelocationFailure::safe)?,
        temp_key,
        account_key,
        || save_oauth_session(account_key, homeserver_url, session),
    )
}

/// Error from a failed [`relocate_store_and_save_session`]/
/// [`relocate_store_and_save_oauth_session`] call, carrying whether it's
/// safe for the caller to keep using/resume a previously-active `Client`
/// for this account afterward — see each construction site for what makes
/// a given failure safe or not.
pub struct RelocationFailure {
    pub message: String,
    /// `true` if the account's on-disk store ended up in a state consistent
    /// with whatever a previously-active client already has open: either
    /// nothing was touched (the failure happened before any existing store
    /// was moved), or an in-process rollback fully restored the original
    /// store and its passphrase. `false` means the swap or its rollback
    /// left things inconsistent (e.g. couldn't remove the newly-installed
    /// store because the caller's client still had it open, or couldn't
    /// restore the old passphrase) — resuming a previous client in that
    /// case would paper over on-disk state nothing can reliably decrypt.
    pub safe_to_resume_previous: bool,
}

impl RelocationFailure {
    fn safe(message: impl ToString) -> Self {
        Self {
            message: message.to_string(),
            safe_to_resume_previous: true,
        }
    }
}

impl From<RelocationFailure> for String {
    fn from(e: RelocationFailure) -> String {
        e.message
    }
}

/// Serializes [`relocate_store_at_locked`] (and, transitively, the session
/// save that follows it — see [`relocate_store_and_save_session`]) process-
/// wide. Without this, two concurrent *first-time* relocations for the same
/// `account_key` (e.g. a double-submitted password login) could both pass
/// the `account_path` existence check before either has renamed its temp
/// directory into place, and both then write the account's keychain
/// passphrase entry — whichever writes last wins, leaving the *other* one's
/// now-relocated (or about-to-be-relocated) store encrypted with a
/// passphrase that's no longer what's saved in the keychain. Relocation
/// isn't a hot path (it happens once per login), so a single global lock —
/// rather than a per-account one — is the simplest correct fix.
static RELOCATE_LOCK: std::sync::LazyLock<std::sync::Mutex<()>> =
    std::sync::LazyLock::new(|| std::sync::Mutex::new(()));

/// Pure, `AppHandle`-free variant of [`relocate_store`]. Also acquires
/// [`RELOCATE_LOCK`] — kept as a separate public entry point (rather than
/// folded into [`relocate_store_at_locked`]) for the unit tests below, which
/// exercise this function directly without going through an `AppHandle`.
pub fn relocate_store_at(
    root: &Path,
    temp_key: &str,
    account_key: &str,
) -> Result<RelocateOutcome, String> {
    // Poison recovery, not `.unwrap()`: the critical section below is plain
    // filesystem/keychain I/O with no partially-mutated shared state to
    // distrust if some *other* call panicked mid-lock, so a poisoned lock
    // shouldn't permanently wedge every future relocation.
    let _guard = RELOCATE_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    relocate_store_at_locked(root, temp_key, account_key)
}

/// The guts of [`relocate_store_at`], assuming [`RELOCATE_LOCK`] is already
/// held by the caller. Delegates to [`relocate_store_at_locked_with`] with a
/// no-op commit hook — split out so [`relocate_store_and_save_session`] and
/// [`relocate_store_and_save_oauth_session`] can run the session save inside
/// the same critical section (and same rollback-on-failure guarantee)
/// without deadlocking on a non-reentrant mutex.
fn relocate_store_at_locked(
    root: &Path,
    temp_key: &str,
    account_key: &str,
) -> Result<RelocateOutcome, String> {
    relocate_store_at_locked_with(root, temp_key, account_key, || Ok(())).map_err(String::from)
}

/// Relocates the temp store to `account_key`'s path, then runs `on_commit`
/// (e.g. saving the just-authenticated session) before treating the
/// relocation as final. If a stale store already existed and `on_commit`
/// fails, the *entire* relocation is rolled back — the newly-installed store
/// is removed, the stale store and its original passphrase are restored —
/// rather than leaving a fully-installed new store paired with whatever
/// session was previously saved for this account (a different device's
/// session, in the supersede case, which is exactly the crypto-mismatch this
/// module exists to prevent). If no stale store existed, there's nothing to
/// roll back to, so `on_commit` failing just surfaces its error with the
/// newly-relocated store left in place — a first-time relocation has no
/// prior state to preserve.
fn relocate_store_at_locked_with(
    root: &Path,
    temp_key: &str,
    account_key: &str,
    on_commit: impl FnOnce() -> Result<(), String>,
) -> Result<RelocateOutcome, RelocationFailure> {
    let temp_path = root.join(temp_key);
    let account_path = root.join(account_key);
    let backup_key = format!("{account_key}{STALE_BACKUP_SUFFIX}");
    let backup_path = root.join(&backup_key);

    // A leftover backup from a *previous* relocation attempt that never
    // fully cleaned up (e.g. its rollback couldn't remove the just-installed
    // store because the caller's `Client` still had it open) might be the
    // account's only genuinely valid store — resolve that ambiguity the
    // same way the startup sweep would, before this attempt's own logic
    // (below) reuses (and would otherwise overwrite) the same `backup_key`.
    // Not just an optimization: without this, a same-process retry could
    // permanently discard the one store still paired with whatever session
    // is currently saved, before ever giving `sweep_orphan_temp_stores` a
    // chance to recover it. If recovery itself couldn't finish (e.g. a
    // transient keychain failure), abort here rather than proceed — this
    // attempt overwriting the still-unresolved leftover would destroy it
    // for good.
    if backup_path.exists()
        && !recover_or_discard_stale_backup(root, account_key, &backup_key, &backup_path)
    {
        // Safe: this attempt hasn't touched `account_path` at all yet.
        return Err(RelocationFailure::safe(format!(
            "a leftover stale-backup for {account_key} could not be resolved — aborting rather than risk overwriting it"
        )));
    }

    let account_passphrase_entry =
        SecretEntry::new(KEYCHAIN_SERVICE, &passphrase_account(account_key))
            .map_err(RelocationFailure::safe)?;
    let backup_passphrase_entry =
        SecretEntry::new(KEYCHAIN_SERVICE, &passphrase_account(&backup_key))
            .map_err(RelocationFailure::safe)?;

    // A stale store from an incomplete previous login/logout can never
    // correctly host the session that was just authenticated (see this
    // function's doc comment) — move it aside rather than deleting it
    // outright, so a later fallible step (keychain write, the final rename,
    // `on_commit`) failing doesn't leave the account with neither store.
    // Capture its passphrase too, since the next step overwrites this same
    // keychain entry — restoring the directory without also restoring the
    // passphrase that decrypts it would leave a rolled-back store nothing
    // can open. A read failure here is treated as a hard error rather than
    // silently proceeding with no captured passphrase: every real account
    // store has one (`get_or_create_passphrase` guarantees it), so a read
    // failure means something's transiently wrong with the keychain itself
    // — overwriting that same entry next without a captured original would
    // make any later rollback restore a directory nothing can decrypt.
    // Clear any leftover backup from a previous crashed attempt first — if
    // we're here again, that backup is superseded by *this* attempt's stale
    // store.
    let existed = account_path.exists();
    let original_passphrase = if existed {
        // Safe: nothing has been touched yet.
        Some(account_passphrase_entry.get_password().map_err(|e| {
            RelocationFailure::safe(format!(
                "failed to read existing passphrase for {account_key}: {e}"
            ))
        })?)
    } else {
        None
    };
    if existed {
        // Written *before* the directory move below, not after: this way a
        // crash between the two can never land in a gap where the backup
        // directory exists but its durable passphrase doesn't yet — either
        // the write hasn't happened and neither has the rename (nothing to
        // recover, the account's original store is exactly where it always
        // was), or both have happened (the durable entry is guaranteed
        // present for anything `recover_or_discard_stale_backup` might find
        // afterward). A *hard* requirement, not best-effort: if this write
        // fails, bail before touching anything else — no rollback machinery
        // needed for a step this early, since nothing has moved yet (safe).
        if let Some(ref passphrase) = original_passphrase {
            backup_passphrase_entry
                .set_password(passphrase)
                .map_err(|e| {
                    RelocationFailure::safe(format!(
                    "failed to durably save the existing store's passphrase for {account_key}: {e}"
                ))
                })?;
        }

        if backup_path.exists() {
            let _ = std::fs::remove_dir_all(&backup_path);
        }
        if let Err(e) = std::fs::rename(&account_path, &backup_path) {
            let _ = backup_passphrase_entry.delete_credential();
            // Safe: the rename itself failed, so account_path's original
            // content never moved.
            return Err(RelocationFailure::safe(format!(
                "failed to back up stale store for {account_key} at {}: {e}",
                account_path.display()
            )));
        }
    }

    // Best-effort: restores the backed-up store and its original passphrase
    // if one existed, so a failure anywhere below leaves the account back in
    // its pre-relocation state instead of stranded between two half-installed
    // stores.
    let roll_back = |err: String| -> RelocationFailure {
        let mut fully_restored = !existed;
        if existed {
            // The just-authenticated `Client` the caller is still holding
            // is (at the OS level) whatever's currently at `account_path` —
            // the earlier rename made that so — and this function has no
            // way to know if it's still open. Deliberately gate restoring
            // the *passphrase* on the *directory* rollback actually
            // succeeding, rather than doing both unconditionally: if
            // `remove_dir_all` fails (e.g. the new store's files are still
            // open and this is a platform where that blocks removal), the
            // real new store is still sitting at `account_path` — resetting
            // the keychain entry back to the *old* passphrase in that case
            // would leave a real store on disk that its own saved passphrase
            // can no longer decrypt. Leaving the entry as the new
            // passphrase instead keeps it consistent with whatever's
            // actually still on disk either way. If the removal succeeds
            // but the rename-back fails, `account_path` ends up empty with
            // the backup (and its durable passphrase entry) intact —
            // `sweep_orphan_temp_stores` recovers that combination on the
            // next startup exactly like an interrupted crash would.
            //
            // A missing `account_path` (failures *before* the final rename,
            // e.g. a transient keychain error in `get_or_create_passphrase`
            // or the account-entry `set_password`) counts as "removed" here,
            // not as a rollback failure — nothing was ever installed there
            // to remove, so there's nothing blocking the rename-back, and
            // this is in fact the easy, always-safe case this whole
            // mechanism exists for.
            let removed_or_absent = match std::fs::remove_dir_all(&account_path) {
                Ok(()) => true,
                Err(e) => e.kind() == std::io::ErrorKind::NotFound,
            };
            if removed_or_absent {
                // Passphrase restore *first*, directory rename only *after*
                // — if the keychain write fails transiently, `backup_path`
                // (and its still-intact durable passphrase entry) are left
                // completely untouched, so the next startup sweep can
                // retry this whole rollback from scratch. The reverse order
                // would leave nothing to retry: once the rename consumes
                // `backup_path`, only the durable `<account>.stale-backup`
                // *credential* remains, but the startup sweep only scans
                // for `.stale-backup` *directories* — an orphaned credential
                // with no directory is invisible to it forever.
                let passphrase_restored = match &original_passphrase {
                    Some(passphrase) => account_passphrase_entry.set_password(passphrase).is_ok(),
                    None => true,
                };
                if passphrase_restored && std::fs::rename(&backup_path, &account_path).is_ok() {
                    let _ = backup_passphrase_entry.delete_credential();
                    fully_restored = true;
                }
            }
        }
        RelocationFailure {
            message: err,
            safe_to_resume_previous: fully_restored,
        }
    };

    let passphrase = match get_or_create_passphrase(temp_key) {
        Ok(passphrase) => passphrase,
        Err(e) => return Err(roll_back(e)),
    };
    if let Err(e) = account_passphrase_entry.set_password(&passphrase) {
        return Err(roll_back(e.to_string()));
    }

    if let Ok(temp_entry) = SecretEntry::new(KEYCHAIN_SERVICE, &passphrase_account(temp_key)) {
        let _ = temp_entry.delete_credential();
    }

    // `fs::rename` on the same volume (both under `matrix_store/`) is
    // atomic and, on POSIX, fails with `ENOTEMPTY`/`EEXIST` rather than
    // silently merging if `account_path` was recreated concurrently between
    // the backup rename above and here — surfacing as an `Err` rather than
    // silently losing data either way.
    if let Err(e) = std::fs::rename(&temp_path, &account_path) {
        return Err(roll_back(e.to_string()));
    }

    // The store swap itself is done, but `on_commit` (typically saving the
    // just-authenticated session) hasn't run yet — roll back rather than
    // leave the new store installed with a mismatched (or absent) session.
    if let Err(e) = on_commit() {
        return Err(roll_back(e));
    }

    // See `COMMIT_MARKER_FILENAME`'s doc comment: `account_path` already
    // existed before `on_commit` ran, so its presence alone can't tell a
    // startup sweep whether the whole relocation actually finished. Written
    // unconditionally (not just when `existed`) for consistency, though it's
    // only load-bearing in the supersede case — a first-time relocation has
    // no backup for `recover_or_discard_stale_backup` to make a decision
    // about in the first place.
    //
    // Retried rather than a single best-effort attempt: `on_commit` has
    // already durably succeeded (e.g. the new session is already saved to
    // the keychain) by this point, so a transient write failure here is a
    // real gap — without the marker, a crash before it's retried and the
    // backup gets discarded below would make the *next* startup wrongly
    // restore the backup over this now-correctly-committed store, pairing
    // the just-saved new session with the *old* device's crypto store
    // (exactly the mismatch this module exists to prevent, just reached via
    // a different path than the one this PR originally fixed). Not a hard
    // failure even after retries exhaust, though: rolling back at this
    // point — after `on_commit` already succeeded — would strand the
    // just-saved new session against the *old* store instead, which is
    // strictly worse than the narrow, already-logged risk of proceeding.
    let mut marker_written = false;
    for attempt in 0..3 {
        if attempt > 0 {
            std::thread::sleep(std::time::Duration::from_millis(20));
        }
        if std::fs::write(account_path.join(COMMIT_MARKER_FILENAME), []).is_ok() {
            marker_written = true;
            break;
        }
    }
    if !marker_written {
        eprintln!(
            "relocate_store: failed to write commit marker for {account_key} at {} after retries — a crash before the next successful startup sweep could incorrectly restore the superseded backup",
            account_path.display()
        );
    }

    if existed {
        // Everything is fully committed at this point, so the backup (both
        // its directory and its durable passphrase entry) is safe to
        // discard. Best-effort: failing to reclaim disk space or a keychain
        // entry shouldn't turn an otherwise-successful login into an error.
        if let Err(e) = std::fs::remove_dir_all(&backup_path) {
            eprintln!(
                "relocate_store: failed to remove backup of superseded store for {account_key} at {}: {e}",
                backup_path.display()
            );
        } else {
            eprintln!(
                "relocate_store: discarded stale store for {account_key} at {} (superseded by a fresh login)",
                account_path.display()
            );
        }
        let _ = backup_passphrase_entry.delete_credential();
    }

    Ok(if existed {
        RelocateOutcome::Superseded(account_path)
    } else {
        RelocateOutcome::Relocated(account_path)
    })
}

pub fn save_session(
    account_key: &str,
    homeserver_url: &str,
    session: &MatrixSession,
) -> Result<(), String> {
    let entry = SecretEntry::new(KEYCHAIN_SERVICE, &session_account(account_key))
        .map_err(|e| e.to_string())?;
    let saved = SavedSession {
        homeserver_url: homeserver_url.to_string(),
        session: session.clone(),
    };
    let json = serde_json::to_string(&saved).map_err(|e| e.to_string())?;
    entry.set_password(&json).map_err(|e| e.to_string())
}

pub fn load_session(account_key: &str) -> Result<Option<SavedSession>, String> {
    let entry = SecretEntry::new(KEYCHAIN_SERVICE, &session_account(account_key))
        .map_err(|e| e.to_string())?;
    match entry.get_password() {
        Ok(json) => serde_json::from_str(&json)
            .map(Some)
            .map_err(|e| e.to_string()),
        Err(SecretStoreError::NotFound) => Ok(None),
        Err(e) => Err(e.to_string()),
    }
}

/// Removes the saved session for `account_key`, e.g. after a restore attempt
/// fails because the homeserver revoked the access token — without this,
/// every future launch would keep retrying the same dead session. Leaves
/// that account's store (and passphrase) in place for a fast re-login; see
/// Spec 08 (logout).
pub fn clear_session(account_key: &str) -> Result<(), String> {
    let entry = SecretEntry::new(KEYCHAIN_SERVICE, &session_account(account_key))
        .map_err(|e| e.to_string())?;
    match entry.delete_credential() {
        Ok(()) | Err(SecretStoreError::NotFound) => Ok(()),
        Err(e) => Err(e.to_string()),
    }
}

pub fn save_oauth_session(
    account_key: &str,
    homeserver_url: &str,
    session: &OAuthSession,
) -> Result<(), String> {
    let entry = SecretEntry::new(KEYCHAIN_SERVICE, &oauth_session_account(account_key))
        .map_err(|e| e.to_string())?;
    let saved = SavedOAuthSession::from_oauth_session(homeserver_url, session);
    let json = serde_json::to_string(&saved).map_err(|e| e.to_string())?;
    entry.set_password(&json).map_err(|e| e.to_string())
}

pub fn load_oauth_session(account_key: &str) -> Result<Option<SavedOAuthSession>, String> {
    let entry = SecretEntry::new(KEYCHAIN_SERVICE, &oauth_session_account(account_key))
        .map_err(|e| e.to_string())?;
    match entry.get_password() {
        Ok(json) => serde_json::from_str(&json)
            .map(Some)
            .map_err(|e| e.to_string()),
        Err(SecretStoreError::NotFound) => Ok(None),
        Err(e) => Err(e.to_string()),
    }
}

pub fn clear_oauth_session(account_key: &str) -> Result<(), String> {
    let entry = SecretEntry::new(KEYCHAIN_SERVICE, &oauth_session_account(account_key))
        .map_err(|e| e.to_string())?;
    match entry.delete_credential() {
        Ok(()) | Err(SecretStoreError::NotFound) => Ok(()),
        Err(e) => Err(e.to_string()),
    }
}

/// True if `account_key`'s currently-saved [`MatrixSession`] is the one this
/// caller just relocated/saved (matched by `device_id`) — used right after
/// [`relocate_store_and_save_session`] returns, before a login flow adopts
/// its `Client` and clears the other session kind, to check whether a
/// concurrent completion for the *same* account (e.g. a double-submitted
/// login) has already superseded it since. Now that every caller holds
/// `MatrixState::login_completion_lock` across its whole completion
/// sequence, no concurrent completion can actually be running at this
/// point — this is defense-in-depth, not load-bearing synchronization
/// (see that lock's doc comment for what closed the actual race).
///
/// A `load_session` *error* (a transient keychain read glitch, a corrupt
/// saved-JSON blob) is treated as "still current" — `true` — rather than
/// "superseded": with the lock in place, there is no legitimate scenario
/// where this call fails to *read* what this same completion just wrote a
/// moment ago, so an `Err` here almost certainly means a flaky read, not an
/// actual supersession. Treating it as superseded would tell the frontend a
/// login that fully succeeded and committed did not, discarding a good
/// session over a glitch in a check that's now just a sanity net.
///
/// A clean `Ok(None)` — the entry is verifiably *absent*, not just
/// unreadable — is a different story and is treated as "superseded"
/// (`false`): unlike a read error, this has a real, reachable, non-glitch
/// cause `login_completion_lock` does *not* guard against — `clear_session`
/// (logout/deactivate) isn't itself gated by that lock, so a user logging
/// out while a completion for the same account is between saving its
/// session and reaching this check can legitimately delete the very entry
/// this is looking for. Proceeding to adopt a client in that case would
/// leave the app signed in only in memory, with no persisted session behind
/// it — undone the moment the process restarts, without ever having told
/// the user their logout raced a login.
pub fn session_is_current(account_key: &str, device_id: &str) -> bool {
    match load_session(account_key) {
        Ok(Some(saved)) => saved.session.meta.device_id.as_str() == device_id,
        Ok(None) => false,
        Err(_) => true,
    }
}

/// OAuth-session counterpart of [`session_is_current`], for the QR login
/// flow. See its doc comment for the same "read error counts as still
/// current, but a clean absence counts as superseded" rationale.
pub fn oauth_session_is_current(account_key: &str, device_id: &str) -> bool {
    match load_oauth_session(account_key) {
        Ok(Some(saved)) => saved.user.meta.device_id.as_str() == device_id,
        Ok(None) => false,
        Err(_) => true,
    }
}

/// Where the local first-run-onboarding marker for `account_key` lives — a
/// bare empty file, not keychain-backed: unlike a session/passphrase this
/// carries no secret, and it only exists as a fast-path so `useOnboardingGate`
/// doesn't flash the onboarding screen for one frame while the account-data
/// flag (the cross-device source of truth — see Spec 12) is still syncing.
fn onboarding_flag_path(app: &AppHandle, account_key: &str) -> Result<PathBuf, String> {
    onboarding_flag_path_at(
        &app.path().app_data_dir().map_err(|e| e.to_string())?,
        account_key,
    )
}

fn onboarding_flag_path_at(root: &Path, account_key: &str) -> Result<PathBuf, String> {
    let dir = root.join("onboarding_flags");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir.join(account_key))
}

pub fn save_onboarding_flag(app: &AppHandle, account_key: &str) -> Result<(), String> {
    std::fs::write(onboarding_flag_path(app, account_key)?, "").map_err(|e| e.to_string())
}

pub fn has_onboarding_flag(app: &AppHandle, account_key: &str) -> Result<bool, String> {
    Ok(onboarding_flag_path(app, account_key)?.exists())
}

#[cfg(test)]
mod tests {
    use super::*;
    use matrix_sdk::authentication::SessionTokens;
    use matrix_sdk::ruma::device_id;
    use matrix_sdk::SessionMeta;

    const TEST_MXID_A: &str = "@charm-persistence-test-a:localhost";
    const TEST_MXID_B: &str = "@charm-persistence-test-b:localhost";
    // Every keychain-touching test below gets its own dedicated MXID pair
    // (rather than reusing TEST_MXID_A/B) — `cargo test --lib` runs tests in
    // parallel, and two tests racing to save/clear/read the *same* keychain
    // entry (e.g. one clearing what another just set) is a real source of
    // flakiness, not just a theoretical one. TEST_MXID_A/B stay reserved for
    // the two pure tests just below that never touch the keychain at all.
    const TEST_MXID_SESSION_A: &str = "@charm-persistence-test-session-a:localhost";
    const TEST_MXID_SESSION_B: &str = "@charm-persistence-test-session-b:localhost";
    const TEST_MXID_OAUTH: &str = "@charm-persistence-test-oauth:localhost";
    const TEST_MXID_PASSPHRASE_A: &str = "@charm-persistence-test-passphrase-a:localhost";
    const TEST_MXID_PASSPHRASE_B: &str = "@charm-persistence-test-passphrase-b:localhost";
    const TEST_MXID_RELOCATE: &str = "@charm-persistence-test-relocate:localhost";
    const TEST_MXID_RELOCATE_REUSE: &str = "@charm-persistence-test-relocate-reuse:localhost";

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
        let key_a = account_key(TEST_MXID_SESSION_A);
        let key_b = account_key(TEST_MXID_SESSION_B);
        clear_session(&key_a).unwrap();
        clear_session(&key_b).unwrap();
        assert!(load_session(&key_a).unwrap().is_none());

        let session_a = dummy_session(TEST_MXID_SESSION_A);
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
        let key_a = account_key(TEST_MXID_OAUTH);
        clear_oauth_session(&key_a).unwrap();
        assert!(load_oauth_session(&key_a).unwrap().is_none());

        let session = dummy_oauth_session(TEST_MXID_OAUTH);
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
        let key_a = account_key(TEST_MXID_PASSPHRASE_A);
        let key_b = account_key(TEST_MXID_PASSPHRASE_B);

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
        let account_key = account_key(TEST_MXID_RELOCATE);

        let temp_path = store_path_at(&root.0, &temp_key).unwrap();
        std::fs::write(temp_path.join("marker.txt"), b"hello").unwrap();
        let temp_passphrase = get_or_create_passphrase(&temp_key).unwrap();

        let outcome = relocate_store_at(&root.0, &temp_key, &account_key).unwrap();

        let RelocateOutcome::Relocated(relocated) = outcome else {
            panic!("expected Relocated, got {outcome:?}");
        };
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
    fn relocate_store_supersedes_stale_existing_account_store_with_temp() {
        let root = ScratchRoot::new("relocate-supersede");
        let account_key = account_key(TEST_MXID_RELOCATE_REUSE);

        // Simulate a stale store orphaned by an incomplete previous
        // login/logout — a fresh interactive login always mints a new
        // device_id, so this store can never correctly host the session
        // that's about to relocate on top of it.
        let existing_path = store_path_at(&root.0, &account_key).unwrap();
        std::fs::write(existing_path.join("existing.txt"), b"pre-existing").unwrap();
        let _ = get_or_create_passphrase(&account_key).unwrap();

        let temp_key = temp_store_key();
        let temp_path = store_path_at(&root.0, &temp_key).unwrap();
        std::fs::write(temp_path.join("marker.txt"), b"temp").unwrap();
        let temp_passphrase = get_or_create_passphrase(&temp_key).unwrap();

        let outcome = relocate_store_at(&root.0, &temp_key, &account_key).unwrap();

        let RelocateOutcome::Superseded(relocated) = outcome else {
            panic!("expected Superseded, got {outcome:?}");
        };
        assert_eq!(relocated, existing_path);
        // The stale store is gone; the temp store (the just-authenticated
        // session's) is what's actually at the account path now.
        assert!(!relocated.join("existing.txt").exists());
        assert!(relocated.join("marker.txt").exists());
        assert!(!temp_path.exists());
        assert_eq!(
            get_or_create_passphrase(&account_key).unwrap(),
            temp_passphrase
        );
        let temp_entry =
            keyring::Entry::new(KEYCHAIN_SERVICE, &passphrase_account(&temp_key)).unwrap();
        assert!(matches!(
            temp_entry.get_password(),
            Err(keyring::Error::NoEntry)
        ));
        // The durable backup-passphrase entry (written before the account
        // entry was overwritten, so a crash could still recover the old
        // store) is cleaned up too, once the relocation fully committed.
        let backup_entry = keyring::Entry::new(
            KEYCHAIN_SERVICE,
            &passphrase_account(&format!("{account_key}{STALE_BACKUP_SUFFIX}")),
        )
        .unwrap();
        assert!(matches!(
            backup_entry.get_password(),
            Err(keyring::Error::NoEntry)
        ));

        if let Ok(entry) = keyring::Entry::new(KEYCHAIN_SERVICE, &passphrase_account(&account_key))
        {
            let _ = entry.delete_credential();
        }
    }

    #[test]
    fn relocate_store_rolls_back_stale_store_and_passphrase_when_commit_fails() {
        let root = ScratchRoot::new("relocate-rollback");
        let account_key = account_key("@charm-persistence-test-relocate-rollback:localhost");

        // A pre-existing store this attempt is about to (attempt to)
        // supersede — mirrors the stale-store setup in the `Superseded` test
        // above.
        let existing_path = store_path_at(&root.0, &account_key).unwrap();
        std::fs::write(existing_path.join("existing.txt"), b"pre-existing").unwrap();
        let existing_passphrase = get_or_create_passphrase(&account_key).unwrap();

        let temp_key = temp_store_key();
        let temp_path = store_path_at(&root.0, &temp_key).unwrap();
        std::fs::write(temp_path.join("marker.txt"), b"temp").unwrap();
        let _ = get_or_create_passphrase(&temp_key).unwrap();

        // Simulate the session-save step (or any other commit hook) failing
        // after the store swap itself has already succeeded.
        let result = relocate_store_at_locked_with(&root.0, &temp_key, &account_key, || {
            Err("simulated session save failure".to_string())
        });

        let err = result.expect_err("expected rollback to surface the commit failure");
        assert_eq!(err.message, "simulated session save failure");
        // The rollback fully succeeded (old store + passphrase restored), so
        // it's safe for a caller to resume using a previously-active client.
        assert!(err.safe_to_resume_previous);

        // The account is back on its original store, not the new one, and
        // not stranded with neither.
        assert!(existing_path.join("existing.txt").exists());
        assert!(!existing_path.join("marker.txt").exists());
        assert_eq!(
            get_or_create_passphrase(&account_key).unwrap(),
            existing_passphrase
        );
        // No leftover backup directory or stray temp directory.
        assert!(!root
            .0
            .join(format!("{account_key}{STALE_BACKUP_SUFFIX}"))
            .exists());
        assert!(!temp_path.exists());
        // The durable backup-passphrase entry is cleaned up on rollback too
        // — restored into the account entry, not left as a second copy.
        let backup_entry = keyring::Entry::new(
            KEYCHAIN_SERVICE,
            &passphrase_account(&format!("{account_key}{STALE_BACKUP_SUFFIX}")),
        )
        .unwrap();
        assert!(matches!(
            backup_entry.get_password(),
            Err(keyring::Error::NoEntry)
        ));

        if let Ok(entry) = keyring::Entry::new(KEYCHAIN_SERVICE, &passphrase_account(&account_key))
        {
            let _ = entry.delete_credential();
        }
    }

    #[test]
    fn known_account_keys_excludes_temp_stores_and_stale_backups() {
        let root = ScratchRoot::new("known-keys");
        let account_key = account_key("@charm-persistence-test-known:localhost");
        let temp_key = temp_store_key();
        let backup_key = format!("{account_key}{STALE_BACKUP_SUFFIX}");

        store_path_at(&root.0, &account_key).unwrap();
        store_path_at(&root.0, &temp_key).unwrap();
        std::fs::create_dir_all(root.0.join(&backup_key)).unwrap();

        let keys = known_account_keys_at(&root.0).unwrap();
        assert!(keys.contains(&account_key));
        assert!(!keys.contains(&temp_key));
        assert!(!keys.contains(&backup_key));
    }

    #[test]
    fn sweep_orphan_temp_stores_removes_temp_dirs_and_committed_stale_backups() {
        let root = ScratchRoot::new("sweep");
        let account_key = account_key("@charm-persistence-test-sweep:localhost");
        let temp_key = temp_store_key();
        let backup_key = format!("{account_key}{STALE_BACKUP_SUFFIX}");
        let backup_path = root.0.join(&backup_key);

        // A real, current, *fully committed* store at `account_key` — the
        // relocation that created this backup ran the rename and its commit
        // hook to completion (marked by COMMIT_MARKER_FILENAME); only its
        // own best-effort backup removal failed.
        let account_path = store_path_at(&root.0, &account_key).unwrap();
        std::fs::write(account_path.join(COMMIT_MARKER_FILENAME), []).unwrap();
        let temp_path = store_path_at(&root.0, &temp_key).unwrap();
        let _ = get_or_create_passphrase(&temp_key).unwrap();
        std::fs::create_dir_all(&backup_path).unwrap();
        let _ = get_or_create_passphrase(&backup_key).unwrap();

        sweep_orphan_temp_stores_at_with_min_age(&root.0, std::time::Duration::ZERO).unwrap();

        assert!(!temp_path.exists());
        assert!(!backup_path.exists());
        assert!(root.0.join(&account_key).exists());
        let temp_entry =
            keyring::Entry::new(KEYCHAIN_SERVICE, &passphrase_account(&temp_key)).unwrap();
        assert!(matches!(
            temp_entry.get_password(),
            Err(keyring::Error::NoEntry)
        ));
        let backup_entry =
            keyring::Entry::new(KEYCHAIN_SERVICE, &passphrase_account(&backup_key)).unwrap();
        assert!(matches!(
            backup_entry.get_password(),
            Err(keyring::Error::NoEntry)
        ));
    }

    #[test]
    fn sweep_orphan_temp_stores_skips_a_temp_dir_younger_than_the_min_age() {
        // Codex review on #288, P1: a `tmp-*` directory created moments ago
        // is almost certainly a login/register/SSO/QR flow still in
        // progress, not something orphaned by a past crash — sweeping it
        // anyway raced exactly this scenario for SSO/QR, whose temp store
        // outlives a separate long-running task this sweep has no way to
        // see. A generous min_age (real-world: `ORPHAN_TEMP_STORE_MIN_AGE`)
        // protects any freshly-created store regardless of which flow made
        // it or how long that flow ultimately takes to finish.
        let root = ScratchRoot::new("sweep-fresh");
        let temp_key = temp_store_key();
        let temp_path = store_path_at(&root.0, &temp_key).unwrap();
        let _ = get_or_create_passphrase(&temp_key).unwrap();

        sweep_orphan_temp_stores_at_with_min_age(&root.0, std::time::Duration::from_secs(300))
            .unwrap();

        assert!(
            temp_path.exists(),
            "a freshly-created temp store must survive the sweep"
        );
        let temp_entry =
            keyring::Entry::new(KEYCHAIN_SERVICE, &passphrase_account(&temp_key)).unwrap();
        assert!(
            temp_entry.get_password().is_ok(),
            "its passphrase must survive the sweep too"
        );
    }

    #[test]
    fn sweep_orphan_temp_stores_restores_uncommitted_stale_backup() {
        let root = ScratchRoot::new("sweep-restore");
        let account_key = account_key("@charm-persistence-test-sweep-restore:localhost");
        let account_path = root.0.join(&account_key);
        let backup_key = format!("{account_key}{STALE_BACKUP_SUFFIX}");
        let backup_path = root.0.join(&backup_key);

        // No store at `account_key` — mirrors a crash between the backup
        // rename and the final commit in `relocate_store_at_locked_with`:
        // this backup is the account's only surviving store, and its
        // passphrase was durably saved (under the backup's own keychain
        // entry) before the account's entry got overwritten.
        std::fs::create_dir_all(&backup_path).unwrap();
        std::fs::write(backup_path.join("existing.txt"), b"recoverable").unwrap();
        let backup_passphrase = get_or_create_passphrase(&backup_key).unwrap();

        sweep_orphan_temp_stores_at_with_min_age(&root.0, std::time::Duration::ZERO).unwrap();

        // The backup is restored to the account's path, not discarded.
        assert!(!backup_path.exists());
        assert!(account_path.join("existing.txt").exists());
        assert_eq!(
            get_or_create_passphrase(&account_key).unwrap(),
            backup_passphrase
        );
        let backup_entry =
            keyring::Entry::new(KEYCHAIN_SERVICE, &passphrase_account(&backup_key)).unwrap();
        assert!(matches!(
            backup_entry.get_password(),
            Err(keyring::Error::NoEntry)
        ));

        if let Ok(entry) = keyring::Entry::new(KEYCHAIN_SERVICE, &passphrase_account(&account_key))
        {
            let _ = entry.delete_credential();
        }
    }

    #[test]
    fn sweep_orphan_temp_stores_restores_backup_over_uncommitted_renamed_store() {
        let root = ScratchRoot::new("sweep-restore-uncommitted");
        let account_key =
            account_key("@charm-persistence-test-sweep-restore-uncommitted:localhost");
        let account_path = root.0.join(&account_key);
        let backup_key = format!("{account_key}{STALE_BACKUP_SUFFIX}");
        let backup_path = root.0.join(&backup_key);

        // A store *does* exist at `account_key` — the final rename in
        // `relocate_store_at_locked_with` succeeded — but it has no
        // COMMIT_MARKER_FILENAME, mirroring a crash between that rename and
        // `on_commit` (the session save) actually running: the keychain's
        // saved session was never updated, so it still only pairs correctly
        // with the *backup*, not this uncommitted new store.
        std::fs::create_dir_all(&account_path).unwrap();
        std::fs::write(account_path.join("uncommitted.txt"), b"wrong device").unwrap();
        std::fs::create_dir_all(&backup_path).unwrap();
        std::fs::write(backup_path.join("existing.txt"), b"recoverable").unwrap();
        let backup_passphrase = get_or_create_passphrase(&backup_key).unwrap();

        sweep_orphan_temp_stores_at_with_min_age(&root.0, std::time::Duration::ZERO).unwrap();

        // The uncommitted store is discarded; the backup takes its place.
        assert!(!backup_path.exists());
        assert!(!account_path.join("uncommitted.txt").exists());
        assert!(account_path.join("existing.txt").exists());
        assert_eq!(
            get_or_create_passphrase(&account_key).unwrap(),
            backup_passphrase
        );

        if let Ok(entry) = keyring::Entry::new(KEYCHAIN_SERVICE, &passphrase_account(&account_key))
        {
            let _ = entry.delete_credential();
        }
    }

    #[test]
    fn onboarding_flag_is_absent_until_saved_and_isolated_per_account() {
        let root = ScratchRoot::new("onboarding-flag");
        let account_key_a = account_key("@charm-persistence-test-onboarding-a:localhost");
        let account_key_b = account_key("@charm-persistence-test-onboarding-b:localhost");

        assert!(!onboarding_flag_path_at(&root.0, &account_key_a)
            .unwrap()
            .exists());

        std::fs::write(
            onboarding_flag_path_at(&root.0, &account_key_a).unwrap(),
            "",
        )
        .unwrap();

        assert!(onboarding_flag_path_at(&root.0, &account_key_a)
            .unwrap()
            .exists());
        assert!(!onboarding_flag_path_at(&root.0, &account_key_b)
            .unwrap()
            .exists());
    }
}
