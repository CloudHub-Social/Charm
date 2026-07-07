//! Per-session (account + device) filesystem media cache, mirroring
//! desktop's `MatrixState::require_media_cache` (`<app_data>/media/`) but
//! with no `AppHandle` to derive a data directory from — reuses the same
//! `CHARM_WEB_SERVER_DATA_DIR` sub-PR B already introduced for
//! `persistence.rs` (`persistence::DATA_DIR_ENV`), under
//! `media/<account_key>/<device_id>/`.
//!
//! **Scoped per device, not merely per account.** `MediaCache::cached_path`
//! keys purely on the `mxc://` source, with no encryption-key/session check
//! — that's safe on desktop (one account, one device, per process) but not
//! here (many logged-in sessions, possibly several devices of the same
//! account, share this process). A cache shared across an *account* (rather
//! than a *device*) would let one session's request for a room it has never
//! joined — or never received the Megolm key for on its own device — resolve
//! straight to a plaintext file a different device already decrypted for an
//! *encrypted* room, purely because both `mxc://` ids happened to match —
//! i.e. media disclosure across sessions without that session ever proving
//! possession of the Megolm/media key on its own device. Matrix's key
//! sharing is per-device, so the cache partition matches that: keying by
//! [`charm_lib::matrix::persistence::account_key`] *and* the session's own
//! `device_id` gives every device its own cache directory and its own
//! `MediaCache` index, so a cache hit is only ever possible against media
//! *that same device* has already resolved.

use charm_lib::matrix::media::MediaCache;
use charm_lib::matrix::persistence::account_key;
use std::collections::HashMap;
use tokio::sync::RwLock;

static CACHES: RwLock<Option<HashMap<String, &'static MediaCache>>> = RwLock::const_new(None);

/// Returns the calling session's own device-scoped media cache, building
/// (and leaking — see below) one on first use. `device_id` should come from
/// `Client::device_id()` for the session in question — never shared across
/// devices, even devices of the same account.
pub async fn for_session(user_id: &str, device_id: &str) -> Result<&'static MediaCache, String> {
    let key = format!("{}/{device_id}", account_key(user_id));

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
    // Leaked deliberately: one `MediaCache` per distinct logged-in device
    // for the life of the process (bounded by how many devices actually log
    // in, not per-request), matching the process-lifetime static this
    // replaces — never freed, but never unboundedly reallocated either.
    let cache: &'static MediaCache = Box::leak(Box::new(cache));
    map.insert(key, cache);
    Ok(cache)
}
