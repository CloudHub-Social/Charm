//! Durable encrypted snapshots of each web session's Matrix crypto database.
//!
//! The live SDK databases stay on App Platform's ephemeral disk. Consistent
//! SQLite online backups are encrypted again with an independently managed
//! key and written to a separate private Spaces bucket. The bucket is treated
//! as untrusted: every object is AEAD-bound to the server-issued session,
//! Matrix user/device, random store id, generation, and filename.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use aes_gcm::aead::{Aead, AeadCore, KeyInit, OsRng, Payload};
use aes_gcm::{Aes256Gcm, Key, Nonce};
use base64::engine::general_purpose::STANDARD as BASE64;
use base64::Engine;
use object_store::aws::AmazonS3Builder;
use object_store::path::Path as ObjectPath;
use object_store::{ObjectStore, PutPayload};
use rand::distr::Alphanumeric;
use rand::RngExt;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::persistence::DATA_DIR_ENV;

pub const BUCKET_ENV: &str = "CHARM_WEB_SERVER_CRYPTO_SPACES_BUCKET";
pub const REGION_ENV: &str = "CHARM_WEB_SERVER_CRYPTO_SPACES_REGION";
pub const ENDPOINT_ENV: &str = "CHARM_WEB_SERVER_CRYPTO_SPACES_ENDPOINT";
pub const ACCESS_KEY_ID_ENV: &str = "CHARM_WEB_SERVER_CRYPTO_SPACES_ACCESS_KEY_ID";
pub const SECRET_ACCESS_KEY_ENV: &str = "CHARM_WEB_SERVER_CRYPTO_SPACES_SECRET_ACCESS_KEY";
pub const BACKUP_KEY_ENV: &str = "CHARM_WEB_SERVER_CRYPTO_BACKUP_KEY";
pub const DOPPLER_TOKEN_ENV: &str = "CHARM_WEB_SERVER_DOPPLER_TOKEN";

const DOPPLER_DOWNLOAD_URL: &str = "https://api.doppler.com/v3/configs/config/secrets/download?format=json&secrets=CHARM_WEB_SERVER_CRYPTO_BACKUP_KEY";
const SNAPSHOT_FORMAT_VERSION: u8 = 1;
const RETAIN_COMMITTED_GENERATIONS: usize = 3;
const ACTIVE_WRITER_PATH: &str = "control/active-writer";
// Only the crypto database is irreplaceable. Room/state/event-cache/media
// stores are rebuilt from the homeserver after restore; backing them up would
// multiply storage and transfer cost without preventing a recovery-key prompt.
const DATABASE_FILES: [&str; 1] = ["matrix-sdk-crypto.sqlite3"];

#[derive(Debug, Clone)]
pub struct CryptoSnapshotBinding {
    token_hash: String,
    user_id: String,
    device_id: String,
    store_key: String,
}

impl CryptoSnapshotBinding {
    pub fn new(
        token: &str,
        session: &matrix_sdk::authentication::matrix::MatrixSession,
        store_key: &str,
    ) -> Self {
        let token_hash = hex_sha256(token.as_bytes());
        Self {
            token_hash,
            user_id: session.meta.user_id.to_string(),
            device_id: session.meta.device_id.to_string(),
            store_key: store_key.to_string(),
        }
    }

    fn aad(&self, kind: &str, generation: Option<u64>, filename: Option<&str>) -> Vec<u8> {
        format!(
            "charm-web-crypto:v1:{}:{}:{}:{}:{}:{}:{}",
            self.token_hash,
            self.user_id,
            self.device_id,
            self.store_key,
            kind,
            generation.map_or_else(String::new, |value| value.to_string()),
            filename.unwrap_or_default(),
        )
        .into_bytes()
    }
}

#[derive(Debug, Serialize, Deserialize)]
struct EncryptedObject {
    version: u8,
    nonce: String,
    ciphertext: String,
}

#[derive(Debug, Serialize, Deserialize)]
struct SnapshotManifest {
    version: u8,
    generation: u64,
    #[serde(default)]
    writer_id: String,
    files: Vec<SnapshotFile>,
}

#[derive(Debug, Serialize, Deserialize)]
struct SnapshotFile {
    name: String,
    sha256: String,
    size: u64,
}

pub struct CryptoBackupStore {
    key: Aes256Gcm,
    store: Arc<dyn ObjectStore>,
    writer_id: String,
    enforce_writer_fence: bool,
}

struct TempDirGuard {
    path: PathBuf,
    armed: bool,
}

impl TempDirGuard {
    fn new(path: PathBuf) -> Self {
        Self { path, armed: true }
    }

    fn path(&self) -> &Path {
        &self.path
    }

    fn disarm(&mut self) {
        self.armed = false;
    }
}

impl Drop for TempDirGuard {
    fn drop(&mut self) {
        if self.armed {
            let _ = std::fs::remove_dir_all(&self.path);
        }
    }
}

impl CryptoBackupStore {
    pub async fn from_env() -> Result<Option<Self>, String> {
        let bucket = match std::env::var(BUCKET_ENV) {
            Ok(bucket) if !bucket.trim().is_empty() => bucket,
            _ => return Ok(None),
        };
        let key = load_backup_key().await?;
        let require = |name: &str| {
            std::env::var(name).map_err(|_| format!("{name} must be set when {BUCKET_ENV} is set"))
        };
        let region_endpoint = require(ENDPOINT_ENV)?;
        let endpoint = virtual_hosted_endpoint(&bucket, &region_endpoint);
        let store: Arc<dyn ObjectStore> = Arc::new(
            AmazonS3Builder::new()
                .with_bucket_name(&bucket)
                .with_region(require(REGION_ENV)?)
                .with_endpoint(endpoint)
                .with_access_key_id(require(ACCESS_KEY_ID_ENV)?)
                .with_secret_access_key(require(SECRET_ACCESS_KEY_ENV)?)
                .with_virtual_hosted_style_request(true)
                .build()
                .map_err(|error| error.to_string())?,
        );
        let writer_id = random_identifier();
        store
            .put(
                &ObjectPath::from(ACTIVE_WRITER_PATH),
                PutPayload::from(writer_id.clone()),
            )
            .await
            .map_err(|error| format!("failed to publish crypto snapshot writer fence: {error}"))?;
        Ok(Some(Self {
            key,
            store,
            writer_id,
            enforce_writer_fence: true,
        }))
    }

    #[cfg(test)]
    pub fn new_for_test(key_bytes: [u8; 32]) -> Self {
        Self {
            key: Aes256Gcm::new(Key::<Aes256Gcm>::from_slice(&key_bytes)),
            store: Arc::new(object_store::memory::InMemory::new()),
            writer_id: "test-writer".to_string(),
            enforce_writer_fence: false,
        }
    }

    #[cfg(test)]
    fn new_for_test_with_store(
        key_bytes: [u8; 32],
        writer_id: &str,
        store: Arc<dyn ObjectStore>,
        enforce_writer_fence: bool,
    ) -> Self {
        Self {
            key: Aes256Gcm::new(Key::<Aes256Gcm>::from_slice(&key_bytes)),
            store,
            writer_id: writer_id.to_string(),
            enforce_writer_fence,
        }
    }

    pub async fn snapshot(
        &self,
        binding: &CryptoSnapshotBinding,
        source_dir: &Path,
    ) -> Result<(), String> {
        if !self.is_active_writer().await? {
            return Ok(());
        }
        let generation = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map_err(|error| error.to_string())?
            .as_nanos()
            .try_into()
            .map_err(|_| "snapshot generation timestamp overflowed u64".to_string())?;
        let snapshot_dir = TempDirGuard::new(create_snapshot_temp_dir()?);
        let source = source_dir.to_path_buf();
        let destination = snapshot_dir.path().to_path_buf();
        let backup_result =
            tokio::task::spawn_blocking(move || backup_sqlite_databases(&source, &destination))
                .await
                .map_err(|error| error.to_string())?;
        backup_result?;

        let mut files = Vec::new();
        for name in DATABASE_FILES {
            let path = snapshot_dir.path().join(name);
            if !path.is_file() {
                continue;
            }
            let bytes = tokio::fs::read(&path)
                .await
                .map_err(|error| error.to_string())?;
            let encrypted = self.encrypt(
                &bytes,
                &binding.aad("database", Some(generation), Some(name)),
            )?;
            let json = serde_json::to_vec(&encrypted).map_err(|error| error.to_string())?;
            self.store
                .put(
                    &database_object_path(&binding.store_key, generation, name),
                    PutPayload::from(json),
                )
                .await
                .map_err(|error| error.to_string())?;
            files.push(SnapshotFile {
                name: name.to_string(),
                sha256: hex_sha256(&bytes),
                size: bytes.len() as u64,
            });
        }
        if files.is_empty() {
            return Err("crypto store contained no recognized SQLite databases".to_string());
        }

        let manifest = SnapshotManifest {
            version: SNAPSHOT_FORMAT_VERSION,
            generation,
            writer_id: self.writer_id.clone(),
            files,
        };
        let plaintext = serde_json::to_vec(&manifest).map_err(|error| error.to_string())?;
        let encrypted =
            self.encrypt(&plaintext, &binding.aad("manifest", Some(generation), None))?;
        let json = serde_json::to_vec(&encrypted).map_err(|error| error.to_string())?;
        // Each generation owns its commit marker. Database objects are
        // uploaded first, so readers never observe a committed partial
        // generation. There is deliberately no shared "latest" pointer for
        // two App Platform instances to overwrite out of order during a
        // zero-downtime deploy.
        // Re-check after uploading the database objects. A replacement
        // instance may have published its fence while this snapshot was in
        // flight; in that case this stale writer must not publish a commit
        // marker. Restore also ranks manifests by the current fence, closing
        // the tiny race between this check and the manifest put itself.
        if !self.is_active_writer().await? {
            self.remove_uncommitted_generation(binding, &manifest).await;
            return Ok(());
        }
        self.store
            .put(
                &manifest_object_path(&binding.store_key, generation),
                PutPayload::from(json),
            )
            .await
            .map_err(|error| error.to_string())?;
        if let Err(error) = self.prune_committed_generations(binding).await {
            tracing::warn!("crypto snapshot committed but old-generation cleanup failed: {error}");
        }
        Ok(())
    }

    async fn active_writer_id(&self) -> Result<Option<String>, String> {
        if !self.enforce_writer_fence {
            return Ok(None);
        }
        let result = self
            .store
            .get(&ObjectPath::from(ACTIVE_WRITER_PATH))
            .await
            .map_err(|error| format!("failed to read crypto snapshot writer fence: {error}"))?;
        let bytes = result.bytes().await.map_err(|error| error.to_string())?;
        let writer = std::str::from_utf8(&bytes)
            .map_err(|error| format!("crypto snapshot writer fence is not UTF-8: {error}"))?
            .trim();
        if writer.is_empty() {
            return Err("crypto snapshot writer fence is empty".to_string());
        }
        Ok(Some(writer.to_string()))
    }

    async fn is_active_writer(&self) -> Result<bool, String> {
        Ok(self
            .active_writer_id()
            .await?
            .is_none_or(|active| active == self.writer_id))
    }

    async fn remove_uncommitted_generation(
        &self,
        binding: &CryptoSnapshotBinding,
        manifest: &SnapshotManifest,
    ) {
        for file in &manifest.files {
            let _ = self
                .store
                .delete(&database_object_path(
                    &binding.store_key,
                    manifest.generation,
                    &file.name,
                ))
                .await;
        }
    }

    pub async fn restore(
        &self,
        binding: &CryptoSnapshotBinding,
        destination_dir: &Path,
    ) -> Result<bool, String> {
        let prefix = ObjectPath::from(format!("crypto/{}/", binding.store_key));
        let mut objects = self.store.list(Some(&prefix));
        let mut generations = Vec::new();
        use futures_util::StreamExt;
        while let Some(object) = objects.next().await {
            let object = object.map_err(|error| error.to_string())?;
            if let Some(generation) = manifest_generation(&binding.store_key, &object.location) {
                generations.push(generation);
            }
        }
        generations.sort_unstable();
        generations.dedup();
        if generations.is_empty() {
            return Ok(false);
        }

        let active_writer = self.active_writer_id().await?;
        let mut manifests = Vec::new();
        let mut last_error = None;
        for generation in generations {
            match self.read_manifest(binding, generation).await {
                Ok(manifest) => manifests.push(manifest),
                Err(error) => last_error = Some(error),
            }
        }
        manifests.sort_unstable_by(|left, right| {
            let left_active = active_writer
                .as_deref()
                .is_some_and(|active| left.writer_id == active);
            let right_active = active_writer
                .as_deref()
                .is_some_and(|active| right.writer_id == active);
            right_active
                .cmp(&left_active)
                .then_with(|| right.generation.cmp(&left.generation))
        });
        if manifests.is_empty() {
            return Err(
                last_error.unwrap_or_else(|| "no usable crypto snapshot generation".to_string())
            );
        }

        // Another request may have completed the same restore after the
        // caller observed this directory as missing. A published directory
        // only appears via the atomic staging rename below, so it is safe to
        // use instead of treating the concurrent winner as an error.
        if destination_dir.is_dir() {
            return Ok(true);
        }

        for manifest in manifests {
            let mut staging_dir = TempDirGuard::new(create_restore_temp_dir(destination_dir)?);
            match self
                .restore_generation(binding, staging_dir.path(), &manifest)
                .await
            {
                Ok(()) => {
                    match std::fs::rename(staging_dir.path(), destination_dir) {
                        Ok(()) => {
                            staging_dir.disarm();
                            return Ok(true);
                        }
                        Err(_) if destination_dir.is_dir() => {
                            // A concurrent restore won the rename race. The
                            // guard removes only this attempt's staging dir.
                            return Ok(true);
                        }
                        Err(error) => return Err(error.to_string()),
                    }
                }
                Err(error) => {
                    last_error = Some(error);
                }
            }
        }
        Err(last_error.unwrap_or_else(|| "no usable crypto snapshot generation".to_string()))
    }

    async fn restore_generation(
        &self,
        binding: &CryptoSnapshotBinding,
        destination_dir: &Path,
        manifest: &SnapshotManifest,
    ) -> Result<(), String> {
        std::fs::create_dir_all(destination_dir).map_err(|error| error.to_string())?;

        for file in &manifest.files {
            if !DATABASE_FILES.contains(&file.name.as_str()) {
                let _ = std::fs::remove_dir_all(destination_dir);
                return Err(format!(
                    "snapshot contained unexpected database name {:?}",
                    file.name
                ));
            }
            let object = self
                .store
                .get(&database_object_path(
                    &binding.store_key,
                    manifest.generation,
                    &file.name,
                ))
                .await
                .map_err(|error| error.to_string())?;
            let bytes = object.bytes().await.map_err(|error| error.to_string())?;
            let encrypted: EncryptedObject =
                serde_json::from_slice(&bytes).map_err(|error| error.to_string())?;
            let plaintext = self.decrypt(
                &encrypted,
                &binding.aad("database", Some(manifest.generation), Some(&file.name)),
            )?;
            if plaintext.len() as u64 != file.size || hex_sha256(&plaintext) != file.sha256 {
                let _ = std::fs::remove_dir_all(destination_dir);
                return Err(format!(
                    "snapshot database {:?} failed integrity validation",
                    file.name
                ));
            }
            tokio::fs::write(destination_dir.join(&file.name), plaintext)
                .await
                .map_err(|error| error.to_string())?;
        }
        Ok(())
    }

    async fn read_manifest(
        &self,
        binding: &CryptoSnapshotBinding,
        generation: u64,
    ) -> Result<SnapshotManifest, String> {
        let manifest_path = manifest_object_path(&binding.store_key, generation);
        let result = match self.store.get(&manifest_path).await {
            Ok(result) => result,
            Err(object_store::Error::NotFound { .. }) => {
                return Err("crypto snapshot manifest disappeared during restore".to_string());
            }
            Err(error) => return Err(error.to_string()),
        };
        let bytes = result.bytes().await.map_err(|error| error.to_string())?;
        let encrypted: EncryptedObject =
            serde_json::from_slice(&bytes).map_err(|error| error.to_string())?;
        let plaintext =
            self.decrypt(&encrypted, &binding.aad("manifest", Some(generation), None))?;
        let manifest: SnapshotManifest =
            serde_json::from_slice(&plaintext).map_err(|error| error.to_string())?;
        if manifest.version != SNAPSHOT_FORMAT_VERSION {
            return Err(format!(
                "unsupported crypto snapshot version {}",
                manifest.version
            ));
        }
        if manifest.files.len() != DATABASE_FILES.len() {
            return Err("crypto snapshot manifest has an incomplete database set".to_string());
        }
        if manifest.generation != generation {
            return Err("crypto snapshot manifest generation does not match its path".to_string());
        }
        Ok(manifest)
    }

    pub async fn remove(&self, store_key: &str) -> Result<(), String> {
        let prefix = ObjectPath::from(format!("crypto/{store_key}/"));
        let mut objects = self.store.list(Some(&prefix));
        use futures_util::StreamExt;
        while let Some(object) = objects.next().await {
            let object = object.map_err(|error| error.to_string())?;
            self.store
                .delete(&object.location)
                .await
                .map_err(|error| error.to_string())?;
        }
        Ok(())
    }

    async fn prune_committed_generations(
        &self,
        binding: &CryptoSnapshotBinding,
    ) -> Result<(), String> {
        let prefix = ObjectPath::from(format!("crypto/{}/", binding.store_key));
        let mut objects = self.store.list(Some(&prefix));
        let mut locations = Vec::new();
        let mut generations = Vec::new();
        use futures_util::StreamExt;
        while let Some(object) = objects.next().await {
            let object = object.map_err(|error| error.to_string())?;
            if let Some(generation) = manifest_generation(&binding.store_key, &object.location) {
                generations.push(generation);
            }
            locations.push(object.location);
        }
        generations.sort_unstable();
        generations.dedup();

        let active_writer = self.active_writer_id().await?;
        let mut committed = Vec::new();
        for generation in generations {
            if let Ok(manifest) = self.read_manifest(binding, generation).await {
                committed.push(manifest);
            }
        }
        committed.sort_unstable_by(|left, right| {
            let left_active = active_writer
                .as_deref()
                .is_some_and(|active| left.writer_id == active);
            let right_active = active_writer
                .as_deref()
                .is_some_and(|active| right.writer_id == active);
            right_active
                .cmp(&left_active)
                .then_with(|| right.generation.cmp(&left.generation))
        });
        let obsolete = committed
            .into_iter()
            .skip(RETAIN_COMMITTED_GENERATIONS)
            .map(|manifest| manifest.generation)
            .collect::<std::collections::HashSet<_>>();
        for location in locations {
            if object_generation(&binding.store_key, &location)
                .is_some_and(|value| obsolete.contains(&value))
            {
                self.store
                    .delete(&location)
                    .await
                    .map_err(|error| error.to_string())?;
            }
        }
        Ok(())
    }

    fn encrypt(&self, plaintext: &[u8], aad: &[u8]) -> Result<EncryptedObject, String> {
        let nonce = Aes256Gcm::generate_nonce(&mut OsRng);
        let ciphertext = self
            .key
            .encrypt(
                &nonce,
                Payload {
                    msg: plaintext,
                    aad,
                },
            )
            .map_err(|error| error.to_string())?;
        Ok(EncryptedObject {
            version: SNAPSHOT_FORMAT_VERSION,
            nonce: BASE64.encode(nonce),
            ciphertext: BASE64.encode(ciphertext),
        })
    }

    fn decrypt(&self, object: &EncryptedObject, aad: &[u8]) -> Result<Vec<u8>, String> {
        if object.version != SNAPSHOT_FORMAT_VERSION {
            return Err(format!(
                "unsupported encrypted crypto object version {}",
                object.version
            ));
        }
        let nonce = BASE64
            .decode(&object.nonce)
            .map_err(|error| error.to_string())?;
        if nonce.len() != 12 {
            return Err(format!(
                "invalid crypto object nonce length {}",
                nonce.len()
            ));
        }
        let ciphertext = BASE64
            .decode(&object.ciphertext)
            .map_err(|error| error.to_string())?;
        self.key
            .decrypt(
                Nonce::from_slice(&nonce),
                Payload {
                    msg: &ciphertext,
                    aad,
                },
            )
            .map_err(|error| error.to_string())
    }
}

async fn load_backup_key() -> Result<Aes256Gcm, String> {
    let encoded = match std::env::var(BACKUP_KEY_ENV) {
        Ok(value) if !value.trim().is_empty() => value,
        _ => fetch_backup_key_from_doppler().await?,
    };
    let bytes = BASE64
        .decode(encoded.trim())
        .map_err(|error| format!("{BACKUP_KEY_ENV} is not valid base64: {error}"))?;
    if bytes.len() != 32 {
        return Err(format!(
            "{BACKUP_KEY_ENV} must decode to exactly 32 bytes, got {}",
            bytes.len()
        ));
    }
    Ok(Aes256Gcm::new(Key::<Aes256Gcm>::from_slice(&bytes)))
}

async fn fetch_backup_key_from_doppler() -> Result<String, String> {
    let token = std::env::var(DOPPLER_TOKEN_ENV).map_err(|_| {
        format!(
            "{BUCKET_ENV} is configured but neither {BACKUP_KEY_ENV} nor {DOPPLER_TOKEN_ENV} is set"
        )
    })?;
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(10))
        .build()
        .map_err(|error| format!("failed to build Doppler client: {error}"))?;
    let response = client
        .get(DOPPLER_DOWNLOAD_URL)
        .bearer_auth(token)
        .send()
        .await
        .map_err(|error| format!("failed to fetch crypto backup key from Doppler: {error}"))?;
    if !response.status().is_success() {
        return Err(format!(
            "Doppler returned {} while fetching the crypto backup key",
            response.status()
        ));
    }
    let secrets: HashMap<String, String> = response
        .json()
        .await
        .map_err(|error| format!("Doppler returned an invalid secrets response: {error}"))?;
    secrets
        .get(BACKUP_KEY_ENV)
        .cloned()
        .filter(|value| !value.trim().is_empty())
        .ok_or_else(|| format!("Doppler config does not contain {BACKUP_KEY_ENV}"))
}

fn backup_sqlite_databases(source_dir: &Path, destination_dir: &Path) -> Result<(), String> {
    std::fs::create_dir_all(destination_dir).map_err(|error| error.to_string())?;
    for name in DATABASE_FILES {
        let source_path = source_dir.join(name);
        if !source_path.is_file() {
            continue;
        }
        let source = rusqlite::Connection::open_with_flags(
            source_path,
            rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY,
        )
        .map_err(|error| error.to_string())?;
        let mut destination = rusqlite::Connection::open(destination_dir.join(name))
            .map_err(|error| error.to_string())?;
        let backup = rusqlite::backup::Backup::new(&source, &mut destination)
            .map_err(|error| error.to_string())?;
        backup
            .run_to_completion(128, Duration::from_millis(5), None)
            .map_err(|error| error.to_string())?;
    }
    Ok(())
}

fn create_snapshot_temp_dir() -> Result<PathBuf, String> {
    let base = std::env::var(DATA_DIR_ENV).unwrap_or_else(|_| "./data".to_string());
    let suffix = random_identifier();
    let path = PathBuf::from(base).join("crypto-snapshot-tmp").join(suffix);
    std::fs::create_dir_all(&path).map_err(|error| error.to_string())?;
    Ok(path)
}

fn random_identifier() -> String {
    rand::rng()
        .sample_iter(&Alphanumeric)
        .take(24)
        .map(char::from)
        .collect()
}

fn create_restore_temp_dir(destination_dir: &Path) -> Result<PathBuf, String> {
    let parent = destination_dir
        .parent()
        .ok_or_else(|| "crypto restore destination has no parent directory".to_string())?;
    let name = destination_dir
        .file_name()
        .and_then(|value| value.to_str())
        .ok_or_else(|| "crypto restore destination has an invalid directory name".to_string())?;
    std::fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    for _ in 0..10 {
        let suffix: String = rand::rng()
            .sample_iter(&Alphanumeric)
            .take(24)
            .map(char::from)
            .collect();
        let path = parent.join(format!(".{name}.restore-{suffix}"));
        match std::fs::create_dir(&path) {
            Ok(()) => return Ok(path),
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(error) => return Err(error.to_string()),
        }
    }
    Err("failed to allocate a unique crypto restore staging directory".to_string())
}

fn manifest_object_path(store_key: &str, generation: u64) -> ObjectPath {
    ObjectPath::from(format!("crypto/{store_key}/{generation}/manifest.json"))
}

fn database_object_path(store_key: &str, generation: u64, name: &str) -> ObjectPath {
    ObjectPath::from(format!("crypto/{store_key}/{generation}/{name}.json"))
}

fn manifest_generation(store_key: &str, path: &ObjectPath) -> Option<u64> {
    let (generation, filename) = object_generation_and_filename(store_key, path)?;
    (filename == "manifest.json").then_some(generation)
}

fn object_generation(store_key: &str, path: &ObjectPath) -> Option<u64> {
    object_generation_and_filename(store_key, path).map(|(generation, _)| generation)
}

fn object_generation_and_filename<'a>(
    store_key: &str,
    path: &'a ObjectPath,
) -> Option<(u64, &'a str)> {
    let relative = path
        .as_ref()
        .strip_prefix(&format!("crypto/{store_key}/"))?;
    let (generation, filename) = relative.split_once('/')?;
    Some((generation.parse().ok()?, filename))
}

fn hex_sha256(bytes: &[u8]) -> String {
    Sha256::digest(bytes)
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

fn virtual_hosted_endpoint(bucket: &str, region_endpoint: &str) -> String {
    match region_endpoint.split_once("://") {
        Some((scheme, host)) => format!("{scheme}://{bucket}.{host}"),
        None => format!("{bucket}.{region_endpoint}"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use futures_util::StreamExt;
    use matrix_sdk::authentication::SessionTokens;
    use matrix_sdk::ruma::device_id;
    use matrix_sdk::SessionMeta;

    fn dummy_session(mxid: &str) -> matrix_sdk::authentication::matrix::MatrixSession {
        matrix_sdk::authentication::matrix::MatrixSession {
            meta: SessionMeta {
                user_id: matrix_sdk::ruma::UserId::parse(mxid).unwrap(),
                device_id: device_id!("BACKUPDEVICE").to_owned(),
            },
            tokens: SessionTokens {
                access_token: "access-token".to_string(),
                refresh_token: None,
            },
        }
    }

    fn scratch_dir(name: &str) -> PathBuf {
        let suffix = format!("{:x}", rand::random::<u64>());
        let path = std::env::temp_dir().join(format!("charm-crypto-backup-{name}-{suffix}"));
        std::fs::create_dir_all(&path).unwrap();
        path
    }

    #[test]
    fn temp_directory_guard_cleans_up_unless_disarmed() {
        let removed = scratch_dir("guard-removed");
        drop(TempDirGuard::new(removed.clone()));
        assert!(!removed.exists());

        let retained = scratch_dir("guard-retained");
        let mut guard = TempDirGuard::new(retained.clone());
        guard.disarm();
        drop(guard);
        assert!(retained.exists());
        std::fs::remove_dir_all(retained).unwrap();
    }

    #[test]
    fn binding_changes_when_session_identity_changes() {
        let a = CryptoSnapshotBinding {
            token_hash: "a".into(),
            user_id: "@alice:example.org".into(),
            device_id: "A".into(),
            store_key: "store".into(),
        };
        let mut b = a.clone();
        b.device_id = "B".into();
        assert_ne!(
            a.aad("database", Some(1), Some(DATABASE_FILES[0])),
            b.aad("database", Some(1), Some(DATABASE_FILES[0]))
        );
    }

    #[test]
    fn encrypted_objects_cannot_be_relocated_between_bindings() {
        let store = CryptoBackupStore::new_for_test([7; 32]);
        let a = CryptoSnapshotBinding {
            token_hash: "a".into(),
            user_id: "@alice:example.org".into(),
            device_id: "A".into(),
            store_key: "store-a".into(),
        };
        let b = CryptoSnapshotBinding {
            token_hash: "b".into(),
            user_id: "@bob:example.org".into(),
            device_id: "B".into(),
            store_key: "store-b".into(),
        };
        let encrypted = store
            .encrypt(b"secret", &a.aad("manifest", None, None))
            .unwrap();
        assert!(store
            .decrypt(&encrypted, &b.aad("manifest", None, None))
            .is_err());
    }

    #[tokio::test]
    async fn snapshot_round_trips_a_live_sqlite_database() {
        let source = scratch_dir("source");
        let destination = scratch_dir("destination");
        std::fs::remove_dir_all(&destination).unwrap();
        let database = source.join(DATABASE_FILES[0]);
        let connection = rusqlite::Connection::open(&database).unwrap();
        connection
            .execute_batch(
                "CREATE TABLE example(value TEXT); INSERT INTO example VALUES ('durable');",
            )
            .unwrap();

        let store = CryptoBackupStore::new_for_test([23; 32]);
        let session = dummy_session("@alice:example.invalid");
        let binding = CryptoSnapshotBinding::new("opaque-token", &session, "storekey123");
        store.snapshot(&binding, &source).await.unwrap();
        assert!(store.restore(&binding, &destination).await.unwrap());

        let restored = rusqlite::Connection::open(destination.join(DATABASE_FILES[0])).unwrap();
        let value: String = restored
            .query_row("SELECT value FROM example", (), |row| row.get(0))
            .unwrap();
        assert_eq!(value, "durable");
    }

    #[tokio::test]
    async fn restore_chooses_the_newest_committed_generation() {
        let source = scratch_dir("newest-source");
        let database = source.join(DATABASE_FILES[0]);
        let connection = rusqlite::Connection::open(&database).unwrap();
        connection
            .execute_batch("CREATE TABLE example(value TEXT); INSERT INTO example VALUES ('old');")
            .unwrap();

        let store = CryptoBackupStore::new_for_test([31; 32]);
        let session = dummy_session("@alice:example.invalid");
        let binding = CryptoSnapshotBinding::new("opaque-token", &session, "neweststorekey");
        store.snapshot(&binding, &source).await.unwrap();
        connection
            .execute("UPDATE example SET value = 'new'", ())
            .unwrap();
        store.snapshot(&binding, &source).await.unwrap();

        let destination = scratch_dir("newest-destination");
        std::fs::remove_dir_all(&destination).unwrap();
        assert!(store.restore(&binding, &destination).await.unwrap());
        let restored = rusqlite::Connection::open(destination.join(DATABASE_FILES[0])).unwrap();
        let value: String = restored
            .query_row("SELECT value FROM example", (), |row| row.get(0))
            .unwrap();
        assert_eq!(value, "new");
    }

    #[tokio::test]
    async fn active_writer_snapshot_outranks_a_stale_writers_later_upload() {
        let backend: Arc<dyn ObjectStore> = Arc::new(object_store::memory::InMemory::new());
        let old_writer = CryptoBackupStore::new_for_test_with_store(
            [47; 32],
            "old-writer",
            backend.clone(),
            false,
        );
        let active_writer = CryptoBackupStore::new_for_test_with_store(
            [47; 32],
            "active-writer",
            backend.clone(),
            true,
        );
        let fenced_old_writer = CryptoBackupStore::new_for_test_with_store(
            [47; 32],
            "old-writer",
            backend.clone(),
            true,
        );
        backend
            .put(
                &ObjectPath::from(ACTIVE_WRITER_PATH),
                PutPayload::from("active-writer"),
            )
            .await
            .unwrap();

        let source = scratch_dir("writer-fence-source");
        let database = source.join(DATABASE_FILES[0]);
        let connection = rusqlite::Connection::open(&database).unwrap();
        connection
            .execute_batch("CREATE TABLE example(value TEXT); INSERT INTO example VALUES ('old');")
            .unwrap();
        let session = dummy_session("@alice:example.invalid");
        let binding = CryptoSnapshotBinding::new("opaque-token", &session, "writerfencestore");

        old_writer.snapshot(&binding, &source).await.unwrap();
        tokio::time::sleep(Duration::from_millis(1)).await;
        connection
            .execute("UPDATE example SET value = 'active'", ())
            .unwrap();
        active_writer.snapshot(&binding, &source).await.unwrap();
        tokio::time::sleep(Duration::from_millis(1)).await;
        connection
            .execute("UPDATE example SET value = 'stale-late'", ())
            .unwrap();
        let prefix = ObjectPath::from("crypto/writerfencestore/");
        let before = backend.list(Some(&prefix)).collect::<Vec<_>>().await.len();
        fenced_old_writer.snapshot(&binding, &source).await.unwrap();
        let after = backend.list(Some(&prefix)).collect::<Vec<_>>().await.len();
        assert_eq!(after, before, "an inactive writer must not publish objects");
        // Force a stale manifest into the test backend to cover the narrow
        // race after a real writer's final fence check. Restore must still
        // rank the active writer first even though this generation is later.
        old_writer.snapshot(&binding, &source).await.unwrap();

        let destination = scratch_dir("writer-fence-destination");
        std::fs::remove_dir_all(&destination).unwrap();
        assert!(active_writer.restore(&binding, &destination).await.unwrap());
        let restored = rusqlite::Connection::open(destination.join(DATABASE_FILES[0])).unwrap();
        let value: String = restored
            .query_row("SELECT value FROM example", (), |row| row.get(0))
            .unwrap();
        assert_eq!(value, "active");
    }

    #[tokio::test]
    async fn concurrent_restores_share_the_atomically_published_store() {
        let source = scratch_dir("concurrent-source");
        let database = source.join(DATABASE_FILES[0]);
        rusqlite::Connection::open(&database)
            .unwrap()
            .execute_batch(
                "CREATE TABLE example(value TEXT); INSERT INTO example VALUES ('shared');",
            )
            .unwrap();

        let store = CryptoBackupStore::new_for_test([41; 32]);
        let session = dummy_session("@alice:example.invalid");
        let binding = CryptoSnapshotBinding::new("opaque-token", &session, "concurrentstorekey");
        store.snapshot(&binding, &source).await.unwrap();

        let destination = scratch_dir("concurrent-destination");
        std::fs::remove_dir_all(&destination).unwrap();
        let (first, second) = tokio::join!(
            store.restore(&binding, &destination),
            store.restore(&binding, &destination)
        );
        assert!(first.unwrap());
        assert!(second.unwrap());

        let restored = rusqlite::Connection::open(destination.join(DATABASE_FILES[0])).unwrap();
        let value: String = restored
            .query_row("SELECT value FROM example", (), |row| row.get(0))
            .unwrap();
        assert_eq!(value, "shared");
    }

    #[tokio::test]
    async fn remove_deletes_every_committed_generation() {
        let source = scratch_dir("remove-source");
        let database = source.join(DATABASE_FILES[0]);
        rusqlite::Connection::open(&database)
            .unwrap()
            .execute_batch("CREATE TABLE example(value TEXT);")
            .unwrap();

        let store = CryptoBackupStore::new_for_test([37; 32]);
        let session = dummy_session("@alice:example.invalid");
        let binding = CryptoSnapshotBinding::new("opaque-token", &session, "removestorekey");
        let similarly_prefixed_binding =
            CryptoSnapshotBinding::new("other-token", &session, "removestorekey2");
        for _ in 0..5 {
            store.snapshot(&binding, &source).await.unwrap();
        }
        store
            .snapshot(&similarly_prefixed_binding, &source)
            .await
            .unwrap();
        let prefix = ObjectPath::from("crypto/removestorekey/");
        let retained = store.store.list(Some(&prefix)).collect::<Vec<_>>().await;
        assert_eq!(retained.len(), RETAIN_COMMITTED_GENERATIONS * 2);
        store.remove("removestorekey").await.unwrap();

        let destination = scratch_dir("remove-destination");
        std::fs::remove_dir_all(&destination).unwrap();
        assert!(!store.restore(&binding, &destination).await.unwrap());

        let other_destination = scratch_dir("remove-other-destination");
        std::fs::remove_dir_all(&other_destination).unwrap();
        assert!(store
            .restore(&similarly_prefixed_binding, &other_destination)
            .await
            .unwrap());
    }

    #[tokio::test]
    async fn snapshot_manifest_cannot_be_opened_by_another_session() {
        let source = scratch_dir("wrong-binding-source");
        let database = source.join(DATABASE_FILES[0]);
        let connection = rusqlite::Connection::open(&database).unwrap();
        connection
            .execute_batch("CREATE TABLE example(value TEXT);")
            .unwrap();

        let store = CryptoBackupStore::new_for_test([29; 32]);
        let alice = CryptoSnapshotBinding::new(
            "alice-token",
            &dummy_session("@alice:example.invalid"),
            "sharedstorekey",
        );
        let bob = CryptoSnapshotBinding::new(
            "bob-token",
            &dummy_session("@bob:example.invalid"),
            "sharedstorekey",
        );
        store.snapshot(&alice, &source).await.unwrap();

        let destination = scratch_dir("wrong-binding-destination");
        std::fs::remove_dir_all(&destination).unwrap();
        assert!(store.restore(&bob, &destination).await.is_err());
        assert!(!destination.exists());
    }
}
