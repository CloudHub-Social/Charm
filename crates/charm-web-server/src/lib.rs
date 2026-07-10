pub mod auth;
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
