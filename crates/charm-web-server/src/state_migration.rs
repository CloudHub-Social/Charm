//! Bounded, opaque state copy. No source writes and no source fallback after commit.
use futures_util::TryStreamExt;
use object_store::{path::Path, ObjectMeta, ObjectStore, ObjectStoreExt, PutMode};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

const MARKER: &str = "control/state-migration-v1";
const FENCE: &str = "control/active-writer";
const MAX_OBJECTS: usize = 1000;
const MAX_OBJECT_BYTES: u64 = 1024 * 1024;
const MAX_TOTAL_BYTES: u64 = 64 * 1024 * 1024;

#[derive(Debug, PartialEq, Eq, Serialize, Deserialize)]
struct Receipt {
    version: u8,
    objects: usize,
    bytes: u64,
    digest: String,
}

async fn inventory(store: &dyn ObjectStore) -> Result<Vec<ObjectMeta>, String> {
    let prefix = Path::from("sessions");
    let mut stream = store.list(Some(&prefix));
    let mut entries = Vec::new();
    let mut bytes = 0_u64;
    while let Some(meta) = stream.try_next().await.map_err(|_| "state inventory failed")? {
        let key = meta.location.as_ref();
        let valid = key.strip_prefix("sessions/").and_then(|s| s.strip_suffix(".json"))
            .is_some_and(|s| s.len() == 64 && s.bytes().all(|b| b.is_ascii_hexdigit()));
        bytes = bytes.checked_add(meta.size).ok_or("state size overflow")?;
        if !valid || meta.size > MAX_OBJECT_BYTES || bytes > MAX_TOTAL_BYTES || entries.len() >= MAX_OBJECTS {
            return Err("state inventory exceeds approved copy bounds or schema".into());
        }
        entries.push(meta);
    }
    entries.sort_by(|a, b| a.location.cmp(&b.location));
    Ok(entries)
}

fn same_inventory(a: &[ObjectMeta], b: &[ObjectMeta]) -> bool {
    a.len() == b.len() && a.iter().zip(b).all(|(x,y)| {
        x.location == y.location && x.size == y.size && x.e_tag == y.e_tag
            && x.version == y.version && x.last_modified == y.last_modified
    })
}

async fn read_optional(store: &dyn ObjectStore, path: &Path) -> Result<Option<Vec<u8>>, String> {
    let result = match store.get(path).await {
        Ok(result) => result,
        Err(object_store::Error::NotFound { .. }) => return Ok(None),
        Err(_) => return Err("state read failed".into()),
    };
    if result.meta.size > MAX_OBJECT_BYTES { return Err("state object exceeds copy bound".into()); }
    let bytes = result.bytes().await.map_err(|_| "state body read failed")?;
    if bytes.len() as u64 > MAX_OBJECT_BYTES { return Err("state body exceeds copy bound".into()); }
    Ok(Some(bytes.to_vec()))
}

async fn copy_exact(destination: &dyn ObjectStore, path: &Path, bytes: &[u8]) -> Result<(), String> {
    match destination.put_opts(path, bytes.to_vec().into(), PutMode::Create.into()).await {
        Ok(_) | Err(object_store::Error::AlreadyExists { .. }) | Err(object_store::Error::Precondition { .. }) => {}
        Err(_) => return Err("state conditional copy failed".into()),
    }
    if read_optional(destination, path).await?.as_deref() != Some(bytes) {
        return Err("state copy verification mismatch".into());
    }
    Ok(())
}

/// Check authority without opening or reading either legacy source.
pub async fn completed(destination: &dyn ObjectStore) -> Result<bool, String> {
    let Some(bytes) = read_optional(destination, &Path::from(MARKER)).await? else { return Ok(false); };
    let receipt: Receipt = serde_json::from_slice(&bytes).map_err(|_| "invalid state migration receipt")?;
    if receipt.version != 1 || receipt.objects > MAX_OBJECTS + 1
        || receipt.bytes > MAX_TOTAL_BYTES + MAX_OBJECT_BYTES
        || receipt.digest.len() != 64 || !receipt.digest.bytes().all(|b| b.is_ascii_hexdigit()) {
        return Err("unsupported state migration receipt".into());
    }
    Ok(true)
}

/// Caller must establish stopped writers before enabling migration. Returns before
/// touching either source on every restart after the durable completion marker.
/// An interrupted copy is resumed only when existing destination bytes match.
pub async fn migrate(
    sessions: &dyn ObjectStore,
    crypto: &dyn ObjectStore,
    destination: &dyn ObjectStore,
) -> Result<(), String> {
    if completed(destination).await? { return Ok(()); }
    let marker = Path::from(MARKER);
    let before = inventory(sessions).await?;
    let existing = inventory(destination).await?;
    if existing.iter().any(|entry| !before.iter().any(|source| source.location == entry.location)) {
        return Err("destination contains state absent from stopped source".into());
    }
    let fence_path = Path::from(FENCE);
    let fence = read_optional(crypto, &fence_path).await?;
    let mut digest = Sha256::new();
    let mut total = 0_u64;
    for entry in &before {
        let bytes = read_optional(sessions, &entry.location).await?.ok_or("source state disappeared")?;
        if bytes.len() as u64 != entry.size { return Err("source state size changed".into()); }
        digest.update(entry.location.as_ref().as_bytes());
        digest.update((bytes.len() as u64).to_be_bytes());
        digest.update(&bytes);
        total += bytes.len() as u64;
        copy_exact(destination, &entry.location, &bytes).await?;
    }
    if let Some(bytes) = &fence {
        digest.update(FENCE.as_bytes());
        digest.update((bytes.len() as u64).to_be_bytes());
        digest.update(bytes);
        total += bytes.len() as u64;
        copy_exact(destination, &fence_path, bytes).await?;
    } else if read_optional(destination, &fence_path).await?.is_some() {
        return Err("destination fence conflicts with absent source fence".into());
    }
    if !same_inventory(&before, &inventory(sessions).await?)
        || fence != read_optional(crypto, &fence_path).await? {
        return Err("source state changed during stopped-writer migration".into());
    }
    let receipt = Receipt { version: 1, objects: before.len() + usize::from(fence.is_some()), bytes: total,
        digest: format!("{:x}", digest.finalize()) };
    let bytes = serde_json::to_vec(&receipt).map_err(|_| "state receipt encoding failed")?;
    copy_exact(destination, &marker, &bytes).await?;
    tracing::info!(objects = receipt.objects, bytes = receipt.bytes, "state migration verified; R2 is authoritative");
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use object_store::memory::InMemory;

    #[tokio::test]
    async fn copies_opaque_state_and_never_reimports_after_commit() {
        let source = InMemory::new(); let crypto = InMemory::new(); let destination = InMemory::new();
        let path = Path::from(format!("sessions/{}.json", "a".repeat(64)));
        source.put(&path, b"ciphertext".to_vec().into()).await.unwrap();
        crypto.put(&Path::from(FENCE), b"previous-writer".to_vec().into()).await.unwrap();
        migrate(&source, &crypto, &destination).await.unwrap();
        destination.delete(&path).await.unwrap();
        migrate(&source, &crypto, &destination).await.unwrap();
        assert!(read_optional(&destination, &path).await.unwrap().is_none());
        assert_eq!(read_optional(&source, &path).await.unwrap().unwrap(), b"ciphertext");
    }

    #[tokio::test]
    async fn partial_copy_resumes_but_conflicting_destination_fails_closed() {
        let source = InMemory::new(); let crypto = InMemory::new(); let destination = InMemory::new();
        let path = Path::from(format!("sessions/{}.json", "b".repeat(64)));
        source.put(&path, b"ciphertext".to_vec().into()).await.unwrap();
        destination.put(&path, b"different".to_vec().into()).await.unwrap();
        assert!(migrate(&source, &crypto, &destination).await.is_err());
        assert!(read_optional(&destination, &Path::from(MARKER)).await.unwrap().is_none());
        destination.put(&path, b"ciphertext".to_vec().into()).await.unwrap();
        migrate(&source, &crypto, &destination).await.unwrap();
    }

    #[tokio::test]
    async fn rejects_unexpected_source_keys_before_copy() {
        let source = InMemory::new(); let crypto = InMemory::new(); let destination = InMemory::new();
        source.put(&Path::from("sessions/unexpected"), b"ciphertext".to_vec().into()).await.unwrap();
        assert!(migrate(&source, &crypto, &destination).await.is_err());
        assert!(read_optional(&destination, &Path::from(MARKER)).await.unwrap().is_none());
    }
}
