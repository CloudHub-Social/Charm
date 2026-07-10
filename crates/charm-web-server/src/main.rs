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

    // Only sweep when persistence is configured — an idle-evicted session
    // can only come back via `routes::require_session`'s on-demand restore
    // (`PersistenceStore::restore_by_token`), which needs `state.persistence`
    // to be `Some`. Sweeping in in-memory-only mode would silently log out
    // any user who leaves a tab open without an active WebSocket for the
    // idle timeout, with no way back short of a fresh login.
    if persistence.is_some() {
        spawn_idle_session_sweeper(state.sessions.clone());
    }

    let addr =
        std::env::var("CHARM_WEB_SERVER_ADDR").unwrap_or_else(|_| "0.0.0.0:8787".to_string());
    let listener = tokio::net::TcpListener::bind(&addr).await?;
    tracing::info!("charm-web-server listening on {addr}");

    let app = routes::router(state);
    axum::serve(listener, app).await?;
    Ok(())
}

/// Periodically evicts idle sessions' in-memory `Client`s — see
/// `session::SessionStore::sweep_idle` and `session::DEFAULT_IDLE_TIMEOUT_SECS`
/// for what "idle" means and why eviction is safe (the persisted session, if
/// any, is left alone and restored on demand — see
/// `routes::require_session`'s persistence fallback). Runs for the lifetime
/// of the process; there's nothing to join it against on shutdown since it
/// does no I/O of its own beyond the sweep and aborting already-idle sync
/// loops.
fn spawn_idle_session_sweeper(sessions: charm_web_server::session::SessionStore) {
    let idle_timeout = std::env::var(charm_web_server::session::IDLE_TIMEOUT_SECS_ENV)
        .ok()
        .and_then(|v| v.parse().ok())
        .map(std::time::Duration::from_secs)
        .unwrap_or(std::time::Duration::from_secs(
            charm_web_server::session::DEFAULT_IDLE_TIMEOUT_SECS,
        ));

    tokio::spawn(async move {
        let mut interval = tokio::time::interval(charm_web_server::session::SWEEP_INTERVAL);
        // The first `tick()` fires immediately, not after the first
        // interval — skip it so this doesn't sweep the instant the process
        // starts, when nothing has had time to go idle yet. Same fix as the
        // WS keepalive in `routes.rs` and the liveness check in
        // `spawn_timeline_listener` (`session.rs`).
        interval.tick().await;
        loop {
            interval.tick().await;
            let evicted = sessions.sweep_idle(idle_timeout).await;
            if evicted.is_empty() {
                continue;
            }
            tracing::info!("evicting {} idle session(s)", evicted.len());
            for (_token, session) in evicted {
                // Stop the background `/sync` long-poll — same reason
                // `routes::logout` aborts it, just without also removing the
                // persisted entry (see `SessionStore::sweep_idle`'s doc
                // comment for why eviction leaves persistence alone).
                if let Some(handle) = session
                    .sync_handle
                    .lock()
                    .unwrap_or_else(|e| e.into_inner())
                    .take()
                {
                    handle.abort();
                }
            }
        }
    });
}
