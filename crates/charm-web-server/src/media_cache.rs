//! Process-wide filesystem media cache, mirroring desktop's
//! `MatrixState::require_media_cache` (`<app_data>/media/`) but with no
//! `AppHandle` to derive a data directory from — reuses the same
//! `CHARM_WEB_SERVER_DATA_DIR` sub-PR B already introduced for
//! `persistence.rs` (`persistence::DATA_DIR_ENV`), under a `media/`
//! subdirectory. Shared across every session (never account-specific — the
//! cache key is the `mxc://` source, which is already globally unique), same
//! as desktop's single shared cache.

use charm_lib::matrix::media::MediaCache;
use tokio::sync::OnceCell;

static CACHE: OnceCell<MediaCache> = OnceCell::const_new();

pub async fn shared() -> Result<&'static MediaCache, String> {
    CACHE
        .get_or_try_init(|| async {
            let dir = std::env::var(crate::persistence::DATA_DIR_ENV)
                .unwrap_or_else(|_| "./data".to_string());
            let dir = std::path::PathBuf::from(dir).join("media");
            std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
            let cache = MediaCache::new(dir);
            cache.rebuild_index().await?;
            Ok::<_, String>(cache)
        })
        .await
}
