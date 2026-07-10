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

    // Only sweep when persistence is configured — an idle-evicted session
    // can only come back via `routes::require_session`'s on-demand restore
    // (`PersistenceStore::restore_by_token`), which needs `state.persistence`
    // to be `Some`. Sweeping in in-memory-only mode would silently log out
    // any user who leaves a tab open without an active WebSocket for the
    // idle timeout, with no way back short of a fresh login.
    if let Some(persistence) = &persistence {
        spawn_idle_session_sweeper(state.sessions.clone(), Arc::clone(persistence));
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

/// Periodically evicts idle sessions' in-memory `Client`s — see
/// `session::SessionStore::sweep_idle` and `session::DEFAULT_IDLE_TIMEOUT_SECS`
/// for what "idle" means and why eviction is safe (the persisted session, if
/// any, is left alone and restored on demand — see
/// `routes::require_session`'s persistence fallback). Runs for the lifetime
/// of the process; there's nothing to join it against on shutdown since it
/// does no I/O of its own beyond the sweep and aborting already-idle sync
/// loops.
fn spawn_idle_session_sweeper(
    sessions: charm_web_server::session::SessionStore,
    persistence: Arc<PersistenceStore>,
) {
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
            for (token, session) in evicted {
                // `sweep_idle` already aborted this session's sync loop
                // synchronously, before it ever returned this list — see
                // that function's doc comment for why the abort itself
                // needed to move there. What's left here is re-persisting
                // the client's *current* live token pair: if the
                // homeserver refreshed the access/refresh token during the
                // sync cycle that was running right up until the abort,
                // `sync_loop`'s own post-cycle repersist may never have run
                // for it, so without this the persisted object could still
                // hold the token pair from *before* that refresh — already
                // invalidated — and a later on-demand restore would fail,
                // turning idle eviction into a forced re-login.
                // `matrix_auth().session()` reads whatever the client's
                // in-memory auth state currently is, synchronously, no
                // network call — and since the sync loop is already dead by
                // this point, nothing can refresh it further out from under
                // this read.
                let Some(matrix_session) = session.client.matrix_auth().session() else {
                    continue;
                };
                let homeserver_url = session.client.homeserver().to_string();
                if let Err(e) = persistence
                    .save(&token, &homeserver_url, &matrix_session)
                    .await
                {
                    // The just-saved (or not-yet-saved) persisted object may
                    // not reflect this client's actual current token —
                    // evicting anyway here would risk losing this session
                    // for good behind a stale/missing persisted copy. But
                    // `sweep_idle` already aborted its sync loop, so simply
                    // reinserting it (an earlier version of this did
                    // exactly that) would leave it reachable with no live
                    // sync loop until logout or a restart — WebSockets
                    // would attach to an event channel with nothing left to
                    // produce on it. Try to resume syncing before deciding
                    // reinserting is actually worthwhile.
                    tracing::error!("failed to re-persist session before idle eviction: {e}");
                    match session
                        .client
                        .sync_once(matrix_sdk::config::SyncSettings::default())
                        .await
                    {
                        Ok(initial_response) => {
                            let persist = Some(sync_loop::PersistHandle {
                                store: Arc::clone(&persistence),
                                token: token.clone(),
                                homeserver_url,
                                initial_access_token: Some(
                                    matrix_session.tokens.access_token.clone(),
                                ),
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
                            tracing::warn!(
                                "resumed syncing a session whose pre-eviction persistence \
                                 save failed, keeping it in memory instead of evicting"
                            );
                            sessions.reinsert(token, session).await;
                        }
                        Err(sync_err) => {
                            // Can't persist *and* can't resume syncing —
                            // reinserting a session with a dead sync loop
                            // and no realistic path to a fresh one is worse
                            // than just evicting it: the persisted copy may
                            // be stale, but a later on-demand restore at
                            // least gets a real chance to rebuild a working
                            // client, instead of this one sitting inert
                            // until someone logs out or the process
                            // restarts.
                            tracing::error!(
                                "also failed to resume syncing this session ({sync_err}) — \
                                 evicting it despite the failed persistence save"
                            );
                        }
                    }
                }
            }
        }
    });
}
