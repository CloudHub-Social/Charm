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
        let store = AmazonS3Builder::new()
            .with_bucket_name(&bucket)
            .with_region(require(REGION_ENV)?)
            .with_endpoint(endpoint)
            .with_access_key_id(require(ACCESS_KEY_ID_ENV)?)
            .with_secret_access_key(require(SECRET_ACCESS_KEY_ENV)?)
            .with_virtual_hosted_style_request(true)
            .build()
            .map_err(|error| error.to_string())?;
        Ok(Some(Self {
            key,
            store: Arc::new(store),
        }))
    }

    #[cfg(test)]
    pub fn new_for_test(key_bytes: [u8; 32]) -> Self {
        Self {
            key: Aes256Gcm::new(Key::<Aes256Gcm>::from_slice(&key_bytes)),
            store: Arc::new(object_store::memory::InMemory::new()),
        }
    }

    pub async fn snapshot(
        &self,
        binding: &CryptoSnapshotBinding,
        source_dir: &Path,
    ) -> Result<(), String> {
        let generation = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map_err(|error| error.to_string())?
            .as_nanos()
            .try_into()
            .map_err(|_| "snapshot generation timestamp overflowed u64".to_string())?;
        let snapshot_dir = create_snapshot_temp_dir()?;
        let source = source_dir.to_path_buf();
        let destination = snapshot_dir.clone();
        let backup_result =
            tokio::task::spawn_blocking(move || backup_sqlite_databases(&source, &destination))
                .await
                .map_err(|error| error.to_string())?;
        if let Err(error) = backup_result {
            let _ = std::fs::remove_dir_all(&snapshot_dir);
            return Err(error);
        }

        let mut files = Vec::new();
        for name in DATABASE_FILES {
            let path = snapshot_dir.join(name);
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
        let _ = std::fs::remove_dir_all(&snapshot_dir);
        if files.is_empty() {
            return Err("crypto store contained no recognized SQLite databases".to_string());
        }

        let manifest = SnapshotManifest {
            version: SNAPSHOT_FORMAT_VERSION,
            generation,
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
        self.store
            .put(
                &manifest_object_path(&binding.store_key, generation),
                PutPayload::from(json),
            )
            .await
            .map_err(|error| error.to_string())?;
        if let Err(error) = self.prune_committed_generations(&binding.store_key).await {
            tracing::warn!("crypto snapshot committed but old-generation cleanup failed: {error}");
        }
        Ok(())
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
        generations.sort_unstable_by(|left, right| right.cmp(left));
        generations.dedup();
        if generations.is_empty() {
            return Ok(false);
        }

        let mut last_error = None;
        for generation in generations {
            match self
                .restore_generation(binding, destination_dir, generation)
                .await
            {
                Ok(()) => return Ok(true),
                Err(error) => {
                    let _ = std::fs::remove_dir_all(destination_dir);
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
        generation: u64,
    ) -> Result<(), String> {
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

    pub async fn remove(&self, store_key: &str) -> Result<(), String> {
        let prefix = ObjectPath::from(format!("crypto/{store_key}"));
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

    async fn prune_committed_generations(&self, store_key: &str) -> Result<(), String> {
        let prefix = ObjectPath::from(format!("crypto/{store_key}/"));
        let mut objects = self.store.list(Some(&prefix));
        let mut locations = Vec::new();
        let mut committed = Vec::new();
        use futures_util::StreamExt;
        while let Some(object) = objects.next().await {
            let object = object.map_err(|error| error.to_string())?;
            if let Some(generation) = manifest_generation(store_key, &object.location) {
                committed.push(generation);
            }
            locations.push(object.location);
        }
        committed.sort_unstable_by(|left, right| right.cmp(left));
        committed.dedup();
        let obsolete = committed
            .into_iter()
            .skip(RETAIN_COMMITTED_GENERATIONS)
            .collect::<std::collections::HashSet<_>>();
        for location in locations {
            if object_generation(store_key, &location)
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
    let suffix: String = rand::rng()
        .sample_iter(&Alphanumeric)
        .take(24)
        .map(char::from)
        .collect();
    let path = PathBuf::from(base).join("crypto-snapshot-tmp").join(suffix);
    std::fs::create_dir_all(&path).map_err(|error| error.to_string())?;
    Ok(path)
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
        for _ in 0..5 {
            store.snapshot(&binding, &source).await.unwrap();
        }
        let prefix = ObjectPath::from("crypto/removestorekey/");
        let retained = store.store.list(Some(&prefix)).collect::<Vec<_>>().await;
        assert_eq!(retained.len(), RETAIN_COMMITTED_GENERATIONS * 2);
        store.remove("removestorekey").await.unwrap();

        let destination = scratch_dir("remove-destination");
        std::fs::remove_dir_all(&destination).unwrap();
        assert!(!store.restore(&binding, &destination).await.unwrap());
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
