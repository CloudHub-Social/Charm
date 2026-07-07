pub mod auth;
pub mod routes;
pub mod session;

use session::SessionStore;

#[derive(Clone, Default)]
pub struct AppState {
    pub sessions: SessionStore,
}
