//! Per-account filesystem media cache, mirroring desktop's
//! `MatrixState::require_media_cache` (`<app_data>/media/`) but with no
//! `AppHandle` to derive a data directory from — reuses the same
//! `CHARM_WEB_SERVER_DATA_DIR` sub-PR B already introduced for
//! `persistence.rs` (`persistence::DATA_DIR_ENV`), under
//! `media/<account_key>/`.
//!
//! **Scoped per account, not process-wide.** `MediaCache::cached_path` keys
//! purely on the `mxc://` source, with no encryption-key/session check —
//! that's safe on desktop (one account per process) but not here (many
//! logged-in accounts share this process). A single shared cache would let
//! session B's request for a room it has never joined resolve straight to a
//! plaintext file session A already decrypted for an *encrypted* room A is
//! in, purely because both `mxc://` ids happened to match — i.e. media
//! disclosure across accounts without proving possession of the Megolm/media
//! key. Keying by [`charm_lib::matrix::persistence::account_key`] (the same
//! per-account hash desktop uses for its on-disk store layout) gives every
//! account its own cache directory and its own `MediaCache` index, so a
//! cache hit is only ever possible against media *that account itself* has
//! already resolved.

use charm_lib::matrix::media::MediaCache;
use charm_lib::matrix::persistence::account_key;
use std::collections::HashMap;
use tokio::sync::RwLock;

static CACHES: RwLock<Option<HashMap<String, &'static MediaCache>>> = RwLock::const_new(None);

/// Returns the calling account's own media cache, building (and leaking —
/// see below) one on first use.
pub async fn for_account(user_id: &str) -> Result<&'static MediaCache, String> {
    let key = account_key(user_id);

    if let Some(cache) = CACHES.read().await.as_ref().and_then(|m| m.get(&key)) {
        return Ok(cache);
    }

    let mut guard = CACHES.write().await;
    let map = guard.get_or_insert_with(HashMap::new);
    if let Some(cache) = map.get(&key) {
        return Ok(cache);
    }

    let dir =
        std::env::var(crate::persistence::DATA_DIR_ENV).unwrap_or_else(|_| "./data".to_string());
    let dir = std::path::PathBuf::from(dir).join("media").join(&key);
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let cache = MediaCache::new(dir);
    cache.rebuild_index().await?;
    // Leaked deliberately: one `MediaCache` per distinct logged-in account
    // for the life of the process (bounded by how many accounts actually
    // log in, not per-request), matching the process-lifetime static this
    // replaces — never freed, but never unboundedly reallocated either.
    let cache: &'static MediaCache = Box::leak(Box::new(cache));
    map.insert(key, cache);
    Ok(cache)
}
