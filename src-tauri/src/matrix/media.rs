//! Filesystem media cache + fetch/decrypt for images, video, audio, and
//! files, plus avatar-thumbnail resolution for Spec 01.
//!
//! Design (see Spec 02 — Media and attachments):
//! - Frontend never sees raw media bytes, encryption keys, or ciphertext. It
//!   only ever gets a local filesystem path (loaded via Tauri's asset
//!   protocol / `convertFileSrc`). The frontend resolves media by the plain
//!   `(room_id, event_id)` pair it already has from `RoomMessageSummary` —
//!   `resolve_media` (in `mod.rs`) re-fetches that event server-side and
//!   pulls the real `MediaSource` (`Plain(mxc_uri)` or
//!   `Encrypted(Box<EncryptedFile>)`) out of it, so no encoded/opaque form of
//!   the source (which for `Encrypted` sources would include the AES key)
//!   ever needs to cross IPC at all.
//! - Cache is a flat directory of files named by a hash of `(mxc, format)`,
//!   indexed by an in-memory `BTreeMap` rebuilt from a directory scan at
//!   startup (simplest option, per the spec's own open question — no
//!   separate on-disk index to keep in sync).
//! - LRU policy: evict when total size exceeds 500MB, or entries are older
//!   than 7 days (by mtime); when over budget, evict the oldest ~10% first.
//!   Both checks run at startup (right after the index rebuild) as well as
//!   after every `store`, so a cache that's already over budget or stale
//!   when the app launches doesn't sit unenforced until the next write.
//!   mtime is refreshed on cache hits (not just writes) so the policy is a
//!   true LRU (least-recently-*used*) rather than least-recently-*written*.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime};

use matrix_sdk::media::{MediaFormat, MediaRequestParameters, MediaThumbnailSettings};
use matrix_sdk::ruma::api::client::media::get_content_thumbnail::v3::Method;
use matrix_sdk::ruma::events::room::MediaSource;
use matrix_sdk::Client;
use sha2::{Digest, Sha256};
use tauri::{AppHandle, Manager};
use tokio::sync::Mutex;

/// Cache budget: total on-disk size before eviction kicks in.
pub const MAX_CACHE_BYTES: u64 = 500 * 1024 * 1024;
/// Cache budget: entries older than this (by mtime) are evicted regardless
/// of total size.
pub const MAX_ENTRY_AGE: Duration = Duration::from_secs(7 * 24 * 60 * 60);
/// When over the size budget, evict (at least) this fraction of entries,
/// oldest-mtime-first.
const EVICT_FRACTION: f64 = 0.10;

/// Which flavor of media to resolve — full file, or a thumbnail at a given
/// size.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MediaKind {
    File,
    Thumbnail { width: u32, height: u32 },
}

impl MediaKind {
    fn cache_key_suffix(self) -> String {
        match self {
            MediaKind::File => "file".to_string(),
            MediaKind::Thumbnail { width, height } => format!("thumb_{width}x{height}"),
        }
    }

    fn into_media_format(self) -> MediaFormat {
        match self {
            MediaKind::File => MediaFormat::File,
            MediaKind::Thumbnail { width, height } => MediaFormat::Thumbnail(
                MediaThumbnailSettings::with_method(Method::Scale, width.into(), height.into()),
            ),
        }
    }
}

#[derive(Debug, Clone)]
struct CacheEntry {
    path: PathBuf,
    size: u64,
    modified: SystemTime,
}

/// In-memory index over `<app_data>/media/`, rebuilt from a directory scan at
/// startup. Keyed by the cache filename (hash of mxc+format), not the raw
/// mxc URI, so lookups are a simple map hit.
pub struct MediaCache {
    dir: PathBuf,
    index: Mutex<BTreeMap<String, CacheEntry>>,
}

impl MediaCache {
    pub fn new(dir: PathBuf) -> Self {
        Self {
            dir,
            index: Mutex::new(BTreeMap::new()),
        }
    }

    pub fn dir(&self) -> &Path {
        &self.dir
    }

    /// Scans `dir` and rebuilds the in-memory index, then immediately runs
    /// the eviction policy — so a cache directory that's already over
    /// budget or holding stale entries from a previous run doesn't sit
    /// unenforced until the next `store`. Cheap and safe to call more than
    /// once; used at startup.
    pub async fn rebuild_index(&self) -> Result<(), String> {
        std::fs::create_dir_all(&self.dir).map_err(|e| e.to_string())?;
        let mut index = BTreeMap::new();
        for entry in std::fs::read_dir(&self.dir).map_err(|e| e.to_string())? {
            let entry = entry.map_err(|e| e.to_string())?;
            let path = entry.path();
            if !path.is_file() {
                continue;
            }
            let metadata = entry.metadata().map_err(|e| e.to_string())?;
            let Some(name) = path.file_name().and_then(|n| n.to_str()) else {
                continue;
            };
            index.insert(
                name.to_string(),
                CacheEntry {
                    path: path.clone(),
                    size: metadata.len(),
                    modified: metadata.modified().unwrap_or_else(|_| SystemTime::now()),
                },
            );
        }
        *self.index.lock().await = index;
        self.enforce_policy().await
    }

    fn cache_filename(source: &MediaSource, kind: MediaKind) -> String {
        let mut hasher = Sha256::new();
        hasher.update(source.unique_key_for_cache().as_bytes());
        hasher.update(kind.cache_key_suffix().as_bytes());
        let hash = hasher.finalize();
        hex_encode(&hash)
    }

    /// Returns the cached path for `(source, kind)` if present, without
    /// touching the network. Touches the entry's mtime (in the index and on
    /// disk) so the eviction policy in `enforce_policy` is a true LRU —
    /// least-recently-*used*, not least-recently-*written*.
    pub async fn cached_path(&self, source: &MediaSource, kind: MediaKind) -> Option<PathBuf> {
        let filename = Self::cache_filename(source, kind);
        let mut index = self.index.lock().await;
        let entry = index.get_mut(&filename)?;
        let now = SystemTime::now();
        entry.modified = now;
        let path = entry.path.clone();
        if let Ok(file) = std::fs::File::open(&path) {
            let _ = file.set_modified(now);
        }
        Some(path)
    }

    /// Writes `data` into the cache for `(source, kind)`, updates the
    /// in-memory index, and runs the eviction policy. Returns the path
    /// written to.
    pub async fn store(
        &self,
        source: &MediaSource,
        kind: MediaKind,
        data: &[u8],
    ) -> Result<PathBuf, String> {
        let filename = Self::cache_filename(source, kind);
        let path = self.dir.join(&filename);
        std::fs::write(&path, data).map_err(|e| e.to_string())?;

        let metadata = std::fs::metadata(&path).map_err(|e| e.to_string())?;
        let entry = CacheEntry {
            path: path.clone(),
            size: metadata.len(),
            modified: metadata.modified().unwrap_or_else(|_| SystemTime::now()),
        };
        {
            let mut index = self.index.lock().await;
            index.insert(filename, entry);
        }

        self.enforce_policy().await?;
        Ok(path)
    }

    /// Enforces the cache policy documented on this module: evicts entries
    /// older than [`MAX_ENTRY_AGE`], then — if still over [`MAX_CACHE_BYTES`]
    /// — evicts the oldest ~10% of what remains.
    async fn enforce_policy(&self) -> Result<(), String> {
        let mut index = self.index.lock().await;
        let now = SystemTime::now();

        let stale: Vec<String> = index
            .iter()
            .filter(|(_, entry)| {
                now.duration_since(entry.modified).unwrap_or(Duration::ZERO) > MAX_ENTRY_AGE
            })
            .map(|(name, _)| name.clone())
            .collect();
        for name in stale {
            if let Some(entry) = index.remove(&name) {
                let _ = std::fs::remove_file(&entry.path);
            }
        }

        let total: u64 = index.values().map(|e| e.size).sum();
        if total > MAX_CACHE_BYTES {
            let mut by_age: Vec<(String, SystemTime)> = index
                .iter()
                .map(|(name, entry)| (name.clone(), entry.modified))
                .collect();
            by_age.sort_by_key(|(_, modified)| *modified);

            let evict_count = ((by_age.len() as f64) * EVICT_FRACTION).ceil() as usize;
            for (name, _) in by_age.into_iter().take(evict_count.max(1)) {
                if let Some(entry) = index.remove(&name) {
                    let _ = std::fs::remove_file(&entry.path);
                }
            }
        }

        Ok(())
    }
}

/// Cache-key helper: a stable string for a `MediaSource`, used for our own
/// filename hashing (distinct from matrix-rust-sdk's own internal media
/// store keys).
trait UniqueCacheKey {
    fn unique_key_for_cache(&self) -> String;
}

impl UniqueCacheKey for MediaSource {
    fn unique_key_for_cache(&self) -> String {
        match self {
            MediaSource::Plain(uri) => uri.to_string(),
            MediaSource::Encrypted(file) => file.url.to_string(),
        }
    }
}

fn hex_encode(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

/// `<app_data>/media/` — sibling of `matrix_store/`, same app-data-dir
/// pattern as `persistence::store_path`.
pub fn media_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?
        .join("media");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir)
}

/// Fetches (using the SDK's own on-disk/DB media cache first, so this is a
/// second, path-oriented cache layer on top) and decrypts media for
/// `source`/`kind`, writing it to our filesystem cache and returning the
/// local path. Decryption happens entirely inside matrix-rust-sdk — this
/// function only ever sees plaintext bytes it's already allowed to persist
/// to disk unencrypted, and only ever returns a [`PathBuf`] to the frontend,
/// never bytes or keys.
pub async fn resolve(
    cache: &MediaCache,
    client: &Client,
    source: MediaSource,
    kind: MediaKind,
) -> Result<PathBuf, String> {
    if let Some(path) = cache.cached_path(&source, kind).await {
        if path.exists() {
            return Ok(path);
        }
    }

    let request = MediaRequestParameters {
        source: source.clone(),
        format: kind.into_media_format(),
    };
    let data = client
        .media()
        .get_media_content(&request, true)
        .await
        .map_err(|e| e.to_string())?;

    cache.store(&source, kind, &data).await
}

/// Public API for Spec 01: resolves a plain (never encrypted — avatars are
/// always bare `mxc://` URIs, not `EncryptedFile`s) mxc URI to a cached
/// thumbnail path at the given square size, or `None` on failure.
pub async fn resolve_avatar_thumbnail(
    cache: &MediaCache,
    client: &Client,
    mxc: &str,
    size: u32,
) -> Option<PathBuf> {
    let uri = matrix_sdk::ruma::OwnedMxcUri::from(mxc);
    let source = MediaSource::Plain(uri);
    resolve(
        cache,
        client,
        source,
        MediaKind::Thumbnail {
            width: size,
            height: size,
        },
    )
    .await
    .ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn plain_source(mxc: &str) -> MediaSource {
        MediaSource::Plain(matrix_sdk::ruma::OwnedMxcUri::from(mxc))
    }

    #[tokio::test]
    async fn store_and_cached_path_round_trip() {
        let tmp = tempfile_dir();
        let cache = MediaCache::new(tmp.clone());
        cache.rebuild_index().await.unwrap();

        let source = plain_source("mxc://example.org/roundtrip");
        assert!(cache.cached_path(&source, MediaKind::File).await.is_none());

        let path = cache
            .store(&source, MediaKind::File, b"hello world")
            .await
            .unwrap();
        assert!(path.exists());
        assert_eq!(std::fs::read(&path).unwrap(), b"hello world");

        let cached = cache.cached_path(&source, MediaKind::File).await.unwrap();
        assert_eq!(cached, path);

        std::fs::remove_dir_all(&tmp).ok();
    }

    #[tokio::test]
    async fn rebuild_index_discovers_existing_files() {
        let tmp = tempfile_dir();
        std::fs::create_dir_all(&tmp).unwrap();
        std::fs::write(tmp.join("deadbeef"), b"cached bytes").unwrap();

        let cache = MediaCache::new(tmp.clone());
        cache.rebuild_index().await.unwrap();

        let index = cache.index.lock().await;
        assert!(index.contains_key("deadbeef"));

        drop(index);
        std::fs::remove_dir_all(&tmp).ok();
    }

    #[tokio::test]
    async fn expires_entries_older_than_seven_days() {
        let tmp = tempfile_dir();
        let cache = MediaCache::new(tmp.clone());
        cache.rebuild_index().await.unwrap();

        let source = plain_source("mxc://example.org/old");
        let path = cache
            .store(&source, MediaKind::File, b"stale data")
            .await
            .unwrap();

        // Backdate the entry's mtime (both on disk and in the index) past
        // the 7-day expiry window, then force the policy to re-evaluate it
        // (store() already ran the policy once right after writing, while
        // the file was still fresh).
        let old_time = SystemTime::now() - MAX_ENTRY_AGE - Duration::from_secs(60);
        set_mtime(&path, old_time);
        {
            let mut index = cache.index.lock().await;
            if let Some(entry) = index.values_mut().find(|e| e.path == path) {
                entry.modified = old_time;
            }
        }

        cache.enforce_policy().await.unwrap();

        assert!(!path.exists());
        let index = cache.index.lock().await;
        assert!(index.values().all(|e| e.path != path));

        drop(index);
        std::fs::remove_dir_all(&tmp).ok();
    }

    #[tokio::test]
    async fn evicts_oldest_ten_percent_when_over_budget() {
        let tmp = tempfile_dir();
        let cache = MediaCache::new(tmp.clone());
        cache.rebuild_index().await.unwrap();

        // Simulate an over-budget cache directly on the index (writing
        // MAX_CACHE_BYTES worth of real files would be slow and wasteful for
        // a unit test) — this exercises enforce_policy()'s pure selection
        // logic without touching hundreds of MB of disk.
        let mut paths = Vec::new();
        {
            let mut index = cache.index.lock().await;
            for i in 0..10u32 {
                let path = tmp.join(format!("entry-{i}"));
                std::fs::write(&path, b"x").unwrap();
                let modified = SystemTime::now() - Duration::from_secs((10 - i) as u64 * 3600);
                index.insert(
                    format!("entry-{i}"),
                    CacheEntry {
                        path: path.clone(),
                        size: MAX_CACHE_BYTES / 5,
                        modified,
                    },
                );
                paths.push(path);
            }
        }

        cache.enforce_policy().await.unwrap();

        let index = cache.index.lock().await;
        // Oldest entry (entry-0, modified 10h ago) should have been evicted;
        // newest (entry-9, modified 1h ago) should remain.
        assert!(!index.contains_key("entry-0"));
        assert!(index.contains_key("entry-9"));
        assert!(!paths[0].exists());

        drop(index);
        std::fs::remove_dir_all(&tmp).ok();
    }

    fn tempfile_dir() -> PathBuf {
        let mut dir = std::env::temp_dir();
        dir.push(format!("charm-media-cache-test-{}", unique_suffix()));
        dir
    }

    fn unique_suffix() -> String {
        use std::sync::atomic::{AtomicU64, Ordering};
        static COUNTER: AtomicU64 = AtomicU64::new(0);
        let n = COUNTER.fetch_add(1, Ordering::Relaxed);
        format!(
            "{}-{n}",
            SystemTime::now()
                .duration_since(SystemTime::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        )
    }

    fn set_mtime(path: &Path, time: SystemTime) {
        let file = std::fs::File::open(path).unwrap();
        file.set_modified(time).unwrap();
    }
}
