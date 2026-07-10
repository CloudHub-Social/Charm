//! Companion Matrix server for Charm's web client (Spec 16). Sub-PR A
//! shipped the HTTP router and an ephemeral in-memory session store; this
//! sub-PR (B) adds a per-session WebSocket event channel (`routes::ws_handler`
//! / `sync_loop.rs`) and encrypted-at-rest session persistence
//! (`persistence.rs`) that survives a restart. See `README.md`.

use std::sync::Arc;

use charm_web_server::{observability, persistence::PersistenceStore, routes, sync_loop, AppState};

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    // Bound for the rest of `main`'s lifetime, not discarded — an unbound
    // `Some(guard)` temporary would drop (and tear down the Sentry client)
    // immediately after this statement. `None` when
    // `observability::SENTRY_DSN_ENV` isn't set; either way this call is
    // also what installs the `tracing_subscriber` global default, so it
    // must run before anything else in this function logs.
    let _sentry_guard = observability::init();

    let persistence = match PersistenceStore::from_env() {
        Ok(persistence) => persistence.map(Arc::new),
        Err(e) => {
            // `tracing::error!` here (not just the `?` below) matters: this
            // target (`charm_web_server`) is one `observability::init`'s
            // Sentry bridge forwards ERROR-level events for, so a
            // misconfigured deploy (bad `CHARM_WEB_SERVER_MASTER_KEY`/Spaces
            // credentials) actually reaches Sentry as an event before the
            // process exits, instead of only ever being visible in DO's
            // stdout log viewer. `_sentry_guard`'s `Drop` still runs on this
            // early return (guards for every local drop on any return path,
            // `?` included) and flushes whatever's already queued, so this
            // event isn't lost even though the process exits immediately
            // after.
            tracing::error!("invalid session persistence configuration: {e}");
            return Err(format!("invalid session persistence configuration: {e}").into());
        }
    };

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
                initial_access_token: Some(initial_access_token),
            });
            let handle = sync_loop::spawn(
                session.client.clone(),
                session.events.clone(),
                session.sync_presence.clone(),
                persist,
                initial_response,
                session.sync_snapshots(),
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
    let listener = match tokio::net::TcpListener::bind(&addr).await {
        Ok(listener) => listener,
        Err(e) => {
            // Same reasoning as the persistence error above: log it as an
            // ERROR before returning so it reaches Sentry, not just stdout.
            tracing::error!("failed to bind {addr}: {e}");
            return Err(e.into());
        }
    };
    tracing::info!("charm-web-server listening on {addr}");

    let app = routes::router(state);
    if let Err(e) = axum::serve(listener, app).await {
        tracing::error!("server exited with an error: {e}");
        return Err(e.into());
    }
    Ok(())
}
