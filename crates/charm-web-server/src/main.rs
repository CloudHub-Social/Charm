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

    let crypto_backup = match charm_web_server::crypto_backup::CryptoBackupStore::from_env().await {
        Ok(backup) => backup.map(Arc::new),
        Err(e) => {
            tracing::error!("invalid durable crypto backup configuration: {e}");
            return Err(format!("invalid durable crypto backup configuration: {e}").into());
        }
    };

    let persistence = match PersistenceStore::from_env() {
        Ok(Some(persistence)) => Some(Arc::new(
            persistence.with_crypto_backup(crypto_backup.clone()),
        )),
        Ok(None) if crypto_backup.is_some() => {
            tracing::error!(
                "durable crypto backup requires encrypted session persistence to be configured"
            );
            return Err("durable crypto backup requires encrypted session persistence".into());
        }
        Ok(None) => None,
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
                crypto: session.persisted_crypto.clone(),
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
    if let Some(crypto_backup) = crypto_backup.as_deref() {
        crypto_backup.activate_writer().await.map_err(|e| {
            tracing::error!("failed to activate durable crypto snapshot writer: {e}");
            format!("failed to activate durable crypto snapshot writer: {e}")
        })?;
    }
    tracing::info!("charm-web-server listening on {addr}");

    let shutdown_state = state.clone();
    let shutdown_persistence = persistence.clone();
    let app = routes::router(state);
    if let Err(e) = axum::serve(listener, app)
        .with_graceful_shutdown(async move {
            shutdown_signal().await;
            if let Some(persistence) = shutdown_persistence {
                snapshot_active_sessions(&shutdown_state, &persistence).await;
            }
        })
        .await
    {
        tracing::error!("server exited with an error: {e}");
        return Err(e.into());
    }
    Ok(())
}

async fn shutdown_signal() {
    let ctrl_c = async {
        if let Err(error) = tokio::signal::ctrl_c().await {
            tracing::error!("failed to install Ctrl-C handler: {error}");
        }
    };

    #[cfg(unix)]
    let terminate = async {
        match tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate()) {
            Ok(mut signal) => {
                signal.recv().await;
            }
            Err(error) => tracing::error!("failed to install SIGTERM handler: {error}"),
        }
    };

    #[cfg(unix)]
    tokio::select! {
        () = ctrl_c => {},
        () = terminate => {},
    }
    #[cfg(not(unix))]
    ctrl_c.await;

    tracing::info!("shutdown requested; writing final crypto snapshots");
}

async fn snapshot_active_sessions(state: &AppState, persistence: &PersistenceStore) {
    let sessions = state.sessions.entries().await;
    for (token, session) in sessions {
        if let Some(handle) = session
            .sync_handle
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .take()
        {
            handle.abort();
        }
        let Some(matrix_session) = session.client.matrix_auth().session() else {
            continue;
        };
        let crypto = session
            .persisted_crypto
            .as_ref()
            .map(|value| (value.store_key.as_str(), value.passphrase.as_str()));
        if let Err(error) = persistence
            .snapshot_final_crypto_store(&token, &matrix_session, crypto)
            .await
        {
            tracing::error!("failed to write final crypto snapshot during shutdown: {error}");
        }
    }
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
                let crypto = session
                    .persisted_crypto
                    .as_ref()
                    .map(|c| (c.store_key.as_str(), c.passphrase.as_str()));
                if let Err(e) = persistence
                    .snapshot_crypto_store(&token, &matrix_session, crypto)
                    .await
                {
                    tracing::warn!("failed to snapshot crypto store before idle eviction: {e}");
                }
                if let Err(e) = persistence
                    .save(&token, &homeserver_url, &matrix_session, crypto)
                    .await
                {
                    // Evicted anyway — an earlier version of this tried to
                    // resume syncing and reinsert the session in place
                    // rather than evict it on a failed save, but that
                    // "recovery" path accumulated its own pile of distinct
                    // races on review (retry-suppressing token seeding, a
                    // leaked sync task when a concurrent restore won the
                    // reinsert race, a presence flash from a bare
                    // `SyncSettings::default()`, and — most seriously — a
                    // logged-out session getting resurrected if the reinsert
                    // landed after `routes::logout` had already removed it).
                    // Untangling all of that for what should be a rare,
                    // transient object-store failure wasn't worth it: a
                    // failed save here just means the *next* on-demand
                    // restore might see a token pair that predates whatever
                    // refresh happened right before this eviction, which —
                    // same as several other already-accepted edge cases in
                    // this file — degrades to nothing worse than a forced
                    // re-login, not data loss or a security issue.
                    tracing::error!(
                        "failed to re-persist session before idle eviction, evicting it \
                         anyway: {e}"
                    );
                }
            }
        }
    });
}
