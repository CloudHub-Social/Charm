//! Companion Matrix server for Charm's web client (Spec 16). Sub-PR A
//! shipped the HTTP router and an ephemeral in-memory session store; this
//! sub-PR (B) adds a per-session WebSocket event channel (`routes::ws_handler`
//! / `sync_loop.rs`) and encrypted-at-rest session persistence
//! (`persistence.rs`) that survives a restart. See `README.md`.

use std::sync::Arc;

use charm_web_server::{persistence::PersistenceStore, routes, sync_loop, AppState};

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    tracing_subscriber::fmt::init();

    let persistence = PersistenceStore::from_env()
        .map_err(|e| format!("invalid session persistence configuration: {e}"))?
        .map(Arc::new);

    let state = AppState {
        persistence: persistence.clone(),
        ..AppState::default()
    };

    if let Some(persistence) = &persistence {
        let restored = persistence.restore_all().await;
        tracing::info!("restored {} persisted session(s)", restored.len());
        for (token, homeserver_url, session, initial_response, initial_access_token) in restored {
            let persist = Some(sync_loop::PersistHandle {
                store: Arc::clone(persistence),
                token: token.clone(),
                homeserver_url,
                initial_access_token,
            });
            let handle = sync_loop::spawn(
                session.client.clone(),
                session.events.clone(),
                session.sync_presence.clone(),
                persist,
                initial_response,
                session.last_snapshot.clone(),
            );
            *session
                .sync_handle
                .lock()
                .unwrap_or_else(|e| e.into_inner()) = Some(handle);
            state.sessions.insert(token, session).await;
        }
    } else {
        tracing::warn!(
            "{} not set — sessions are in-memory only and will not survive a restart",
            charm_web_server::persistence::MASTER_KEY_ENV
        );
    }

    let addr =
        std::env::var("CHARM_WEB_SERVER_ADDR").unwrap_or_else(|_| "0.0.0.0:8787".to_string());
    let listener = tokio::net::TcpListener::bind(&addr).await?;
    tracing::info!("charm-web-server listening on {addr}");

    let app = routes::router(state);
    axum::serve(listener, app).await?;
    Ok(())
}
