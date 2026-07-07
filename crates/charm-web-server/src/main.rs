//! Companion Matrix server for Charm's web client (Spec 16). This sub-PR
//! (A) covers the HTTP router, ephemeral in-memory session store, and auth
//! middleware. See `README.md` in this crate for what's deferred to sub-PR
//! B (WebSocket transport + encrypted-at-rest session storage).

use charm_web_server::{routes, AppState};

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    tracing_subscriber::fmt::init();

    let state = AppState::default();

    let addr =
        std::env::var("CHARM_WEB_SERVER_ADDR").unwrap_or_else(|_| "0.0.0.0:8787".to_string());
    let listener = tokio::net::TcpListener::bind(&addr).await?;
    tracing::info!("charm-web-server listening on {addr}");

    let app = routes::router(state);
    axum::serve(listener, app).await?;
    Ok(())
}
