pub mod auth;
pub mod crypto_store;
pub mod events;
pub mod media_cache;
pub mod observability;
pub mod persistence;
pub mod routes;
pub mod session;
pub mod sync_loop;

use std::sync::Arc;

use persistence::PersistenceStore;
use session::SessionStore;

#[derive(Clone, Default)]
pub struct AppState {
    pub sessions: SessionStore,
    /// `None` when `CHARM_WEB_SERVER_MASTER_KEY` isn't set — sessions then
    /// behave exactly like sub-PR A (in-memory only, dropped on restart).
    /// See `persistence.rs`'s module doc comment.
    pub persistence: Option<Arc<PersistenceStore>>,
}

/// Test-only, crate-wide lock for tests that read/write process env vars
/// (`persistence::DATA_DIR_ENV`, `persistence::MASTER_KEY_ENV`, etc.).
/// `cargo test` runs `#[test]`s concurrently within one process by default,
/// and these vars are process-wide — a *single* shared lock is required
/// here, not one static per module: `persistence.rs`'s and
/// `crypto_store.rs`'s own test modules both mutate `DATA_DIR_ENV`, and two
/// separate, unsynchronized `Mutex`es (an earlier revision of this had
/// exactly that, one static per module) don't serialize against each other
/// at all — confirmed to actually flake in practice, not just in theory.
///
/// `tokio::sync::Mutex`, not `std::sync::Mutex`: an env-mutating test needs
/// this held for its *entire* body, not just around the initial `set_var`
/// call — the var is read fresh by production code on every use
/// (`crypto_store::store_path` reads it on every call, not once at process
/// start), so a guard released right after setup (an earlier revision of
/// this did exactly that, to satisfy clippy's `await_holding_lock` lint on a
/// `std::sync::Mutex`) leaves the rest of the test's `.await`ed work
/// unprotected against a *different* concurrently-running test overwriting
/// the same var in between — confirmed to actually flake, not just in
/// theory. `tokio::sync::Mutex` is safe to hold across an `.await`, so
/// `#[tokio::test]`s can take it via `.lock().await` and keep it for the
/// whole test; plain synchronous `#[test]`s (no tokio runtime running) use
/// `.blocking_lock()` instead.
#[cfg(test)]
pub(crate) static ENV_TEST_LOCK: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());
