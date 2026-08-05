//! Charm-owned, SQLCipher-encrypted search-index storage for Spec 28.
//!
//! This database is deliberately separate from matrix-rust-sdk's encrypted
//! store. Callers must pass only acknowledged, decrypted text, notice, or
//! emote events after applying Matrix reply and HTML normalization.

use std::{
    fmt::Write as _,
    path::{Path, PathBuf},
};

use hkdf::Hkdf;
use rusqlite::{params, Connection, ErrorCode, OpenFlags, OptionalExtension, Transaction};
use sha2::{Digest, Sha256};
use sha2_compat::Sha256 as HkdfSha256;
use zeroize::Zeroizing;

const SEARCH_ROOT: &str = "message_search";
const SEARCH_DATABASE: &str = "message-search.sqlite3";
const SCHEMA_VERSION: u32 = 2;
const KEY_DERIVATION_SALT: &[u8] = b"Charm message search SQLCipher key v1";

enum MigrationError {
    IncompatibleSchema,
    Storage(String),
}

impl MigrationError {
    fn into_message(self) -> String {
        match self {
            Self::IncompatibleSchema => "message search schema version mismatch".to_string(),
            Self::Storage(message) => message,
        }
    }

    fn from_sqlite(error: rusqlite::Error) -> Self {
        let transient_storage_failure = matches!(
            error.sqlite_error_code(),
            Some(
                ErrorCode::PermissionDenied
                    | ErrorCode::DatabaseBusy
                    | ErrorCode::DatabaseLocked
                    | ErrorCode::OutOfMemory
                    | ErrorCode::ReadOnly
                    | ErrorCode::OperationInterrupted
                    | ErrorCode::SystemIoFailure
                    | ErrorCode::DiskFull
                    | ErrorCode::CannotOpen
                    | ErrorCode::FileLockingProtocolFailed
            )
        );
        if transient_storage_failure {
            Self::Storage(safe_storage_error(error))
        } else {
            // Migration runs only fixed schema statements. Corruption,
            // missing/wrong columns, invalid types, and constraint failures
            // therefore describe an incompatible derived index, not a
            // transient filesystem failure.
            Self::IncompatibleSchema
        }
    }
}

/// One renderer-selected searchable version of a Matrix message.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SearchDocument {
    pub room_id: String,
    pub event_id: String,
    pub version_event_id: String,
    pub sender: String,
    /// `None` means the visible replacement is a non-searchable msgtype.
    pub body: Option<String>,
    pub origin_server_ts: u64,
    /// Renderer-authoritative ordering of the selected original/edit event.
    pub selection_order: u64,
}

/// A Charm-owned, device-scoped SQLCipher message index.
pub struct SearchIndex {
    connection: Connection,
    database_path: PathBuf,
}

impl SearchIndex {
    /// Opens or creates the index for one account/device pair.
    ///
    /// # Errors
    ///
    /// Returns an error when the keychain-backed store secret is unavailable,
    /// the private directory cannot be created, SQLCipher cannot open the
    /// database, or schema setup and validation fails.
    pub fn open(
        app_data_dir: &Path,
        account_store_key: &str,
        device_id: &str,
    ) -> Result<Self, String> {
        let store_passphrase = Zeroizing::new(
            super::persistence::get_or_create_passphrase(account_store_key)
                .map_err(|_| "message search encryption key unavailable".to_string())?,
        );
        Self::open_with_secret(
            app_data_dir,
            account_store_key,
            device_id,
            &store_passphrase,
        )
    }

    fn open_with_secret(
        app_data_dir: &Path,
        account_store_key: &str,
        device_id: &str,
        store_passphrase: &str,
    ) -> Result<Self, String> {
        // `SQLITE_OPEN_NOFOLLOW` rejects a symlink in any path component. Resolve
        // the trusted app-data root once, then continue to reject symlinks in
        // every Charm-owned component beneath it.
        let app_data_dir = std::fs::canonicalize(app_data_dir).map_err(safe_io_error)?;
        create_private_directory(&app_data_dir.join(SEARCH_ROOT))?;
        let directory = index_directory(&app_data_dir, account_store_key, device_id);
        create_private_directory(&directory)?;
        let database_path = directory.join(SEARCH_DATABASE);
        let connection = Connection::open_with_flags(
            &database_path,
            OpenFlags::default() | OpenFlags::SQLITE_OPEN_NOFOLLOW,
        )
        .map_err(safe_storage_error)?;
        apply_encryption_key(&connection, account_store_key, device_id, store_passphrase)?;
        configure(&connection)?;
        // This storage-only slice fails closed on an incompatible schema.
        // Destructive rebuild belongs to the lifecycle layer, where cleanup can
        // validate the account root and durably reconcile a failed deletion.
        migrate(&connection).map_err(MigrationError::into_message)?;
        Ok(Self {
            connection,
            database_path,
        })
    }

    /// Returns the opaque database path for lifecycle coordination and tests.
    pub fn database_path(&self) -> &Path {
        &self.database_path
    }

    /// Inserts a renderer-selected message version and atomically updates the
    /// visible search row.
    ///
    /// # Errors
    ///
    /// Returns an error when SQLite cannot commit provenance and visibility
    /// together.
    pub fn apply_document(&mut self, document: &SearchDocument) -> Result<(), String> {
        let transaction = self.connection.transaction().map_err(safe_storage_error)?;
        // Check before binding `body` into any write. A replay or late edit of
        // an already-redacted original must not reintroduce decrypted text into
        // provenance even when the visible search row remains suppressed.
        if is_tombstoned(&transaction, &document.room_id, &document.event_id)?
            || is_tombstoned(&transaction, &document.room_id, &document.version_event_id)?
        {
            return transaction.commit().map_err(safe_storage_error);
        }
        let already_indexed = transaction
            .query_row(
                "SELECT 1 FROM message_versions
                 WHERE room_id = ?1 AND version_event_id = ?2",
                params![&document.room_id, &document.version_event_id],
                |_| Ok(()),
            )
            .optional()
            .map_err(safe_storage_error)?
            .is_some();
        if already_indexed {
            return transaction.commit().map_err(safe_storage_error);
        }
        transaction
            .execute(
                "INSERT INTO message_versions (
                    room_id, original_event_id, version_event_id, sender, body,
                    origin_server_ts, selection_order
                 ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
                params![
                    &document.room_id,
                    &document.event_id,
                    &document.version_event_id,
                    &document.sender,
                    &document.body,
                    timestamp_to_i64(document.origin_server_ts),
                    timestamp_to_i64(document.selection_order),
                ],
            )
            .map_err(safe_storage_error)?;
        restore_visible_row(&transaction, &document.room_id, &document.event_id)?;
        transaction.commit().map_err(safe_storage_error)
    }

    /// Removes a redacted original or edit. Original redactions remove every
    /// version; edit redactions restore the previously selected version.
    ///
    /// # Errors
    ///
    /// Returns an error when deletion, WAL truncation, or compaction fails.
    pub fn redact(&mut self, room_id: &str, event_id: &str) -> Result<(), String> {
        let transaction = self.connection.transaction().map_err(safe_storage_error)?;
        transaction
            .execute(
                "INSERT OR IGNORE INTO redacted_events (room_id, event_id) VALUES (?1, ?2)",
                params![room_id, event_id],
            )
            .map_err(safe_storage_error)?;

        let is_original = transaction
            .query_row(
                "SELECT 1 FROM message_versions
                 WHERE room_id = ?1 AND original_event_id = ?2 LIMIT 1",
                params![room_id, event_id],
                |_| Ok(()),
            )
            .optional()
            .map_err(safe_storage_error)?
            .is_some();
        if is_original {
            delete_visible_row(&transaction, room_id, event_id)?;
            transaction
                .execute(
                    "DELETE FROM message_versions
                     WHERE room_id = ?1 AND original_event_id = ?2",
                    params![room_id, event_id],
                )
                .map_err(safe_storage_error)?;
        } else if let Some(original_event_id) = transaction
            .query_row(
                "SELECT original_event_id FROM message_versions
                 WHERE room_id = ?1 AND version_event_id = ?2",
                params![room_id, event_id],
                |row| row.get::<_, String>(0),
            )
            .optional()
            .map_err(safe_storage_error)?
        {
            transaction
                .execute(
                    "DELETE FROM message_versions
                     WHERE room_id = ?1 AND version_event_id = ?2",
                    params![room_id, event_id],
                )
                .map_err(safe_storage_error)?;
            restore_visible_row(&transaction, room_id, &original_event_id)?;
        }
        transaction.commit().map_err(safe_storage_error)?;
        compact(&self.connection)
    }

    /// Physically removes searchable rows and provenance for one room.
    ///
    /// # Errors
    ///
    /// Returns an error when deletion or compaction fails.
    pub fn purge_room(&mut self, room_id: &str) -> Result<(), String> {
        let transaction = self.connection.transaction().map_err(safe_storage_error)?;
        transaction
            .execute(
                "DELETE FROM searchable_messages WHERE room_id = ?1",
                [room_id],
            )
            .map_err(safe_storage_error)?;
        transaction
            .execute("DELETE FROM message_versions WHERE room_id = ?1", [room_id])
            .map_err(safe_storage_error)?;
        transaction
            .execute("DELETE FROM redacted_events WHERE room_id = ?1", [room_id])
            .map_err(safe_storage_error)?;
        transaction.commit().map_err(safe_storage_error)?;
        compact(&self.connection)
    }

    #[cfg(test)]
    fn visible_body(&self, room_id: &str, event_id: &str) -> Option<String> {
        self.connection
            .query_row(
                "SELECT body FROM searchable_messages WHERE room_id = ?1 AND event_id = ?2",
                params![room_id, event_id],
                |row| row.get(0),
            )
            .optional()
            .expect("test query should succeed")
    }
}

fn restore_visible_row(
    transaction: &Transaction<'_>,
    room_id: &str,
    original_event_id: &str,
) -> Result<(), String> {
    delete_visible_row(transaction, room_id, original_event_id)?;
    let previous = transaction
        .query_row(
            "SELECT version_event_id, sender, body, origin_server_ts
             FROM message_versions
             WHERE room_id = ?1 AND original_event_id = ?2
             ORDER BY selection_order DESC
             LIMIT 1",
            params![room_id, original_event_id],
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, Option<String>>(2)?,
                    row.get::<_, i64>(3)?,
                ))
            },
        )
        .optional()
        .map_err(safe_storage_error)?;
    if let Some((version_event_id, sender, Some(body), origin_server_ts)) = previous {
        transaction
            .execute(
                "INSERT INTO searchable_messages (
                    body, room_id, event_id, version_event_id, sender, origin_server_ts
                 ) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
                params![
                    body,
                    room_id,
                    original_event_id,
                    version_event_id,
                    sender,
                    origin_server_ts,
                ],
            )
            .map_err(safe_storage_error)?;
    }
    Ok(())
}

fn is_tombstoned(
    transaction: &Transaction<'_>,
    room_id: &str,
    event_id: &str,
) -> Result<bool, String> {
    transaction
        .query_row(
            "SELECT 1 FROM redacted_events WHERE room_id = ?1 AND event_id = ?2",
            params![room_id, event_id],
            |_| Ok(()),
        )
        .optional()
        .map(|value| value.is_some())
        .map_err(safe_storage_error)
}

fn delete_visible_row(
    transaction: &Transaction<'_>,
    room_id: &str,
    event_id: &str,
) -> Result<(), String> {
    transaction
        .execute(
            "DELETE FROM searchable_messages WHERE room_id = ?1 AND event_id = ?2",
            params![room_id, event_id],
        )
        .map_err(safe_storage_error)?;
    Ok(())
}

fn configure(connection: &Connection) -> Result<(), String> {
    connection
        .execute_batch(
            "PRAGMA cipher_memory_security = ON;
             PRAGMA temp_store = MEMORY;
             PRAGMA foreign_keys = ON;
             PRAGMA secure_delete = ON;
             PRAGMA journal_mode = WAL;",
        )
        .map_err(safe_storage_error)
}

fn apply_encryption_key(
    connection: &Connection,
    account_store_key: &str,
    device_id: &str,
    store_passphrase: &str,
) -> Result<(), String> {
    let derived_key = derive_search_key(account_store_key, device_id, store_passphrase)?;
    let key_literal = Zeroizing::new(sqlcipher_raw_key_literal(derived_key.as_ref()));
    connection
        .pragma_update(None, "key", key_literal.as_str())
        .map_err(safe_storage_error)?;

    let cipher_version = connection
        .query_row("PRAGMA cipher_version", [], |row| row.get::<_, String>(0))
        .map_err(safe_storage_error)?;
    if cipher_version.is_empty() {
        return Err("message search encryption unavailable".to_string());
    }
    connection
        .query_row("SELECT count(*) FROM sqlite_master", [], |row| {
            row.get::<_, i64>(0)
        })
        .map(|_| ())
        .map_err(safe_storage_error)
}

fn derive_search_key(
    account_store_key: &str,
    device_id: &str,
    store_passphrase: &str,
) -> Result<Zeroizing<[u8; 32]>, String> {
    let hkdf = Hkdf::<HkdfSha256>::new(Some(KEY_DERIVATION_SALT), store_passphrase.as_bytes());
    let mut derived_key = Zeroizing::new([0_u8; 32]);
    let mut context = Vec::with_capacity(account_store_key.len() + device_id.len() + 1);
    context.extend_from_slice(account_store_key.as_bytes());
    context.push(0);
    context.extend_from_slice(device_id.as_bytes());
    hkdf.expand(&context, derived_key.as_mut())
        .map_err(|_| "message search key derivation failed".to_string())?;
    Ok(derived_key)
}

fn migrate(connection: &Connection) -> Result<(), MigrationError> {
    let transaction = connection
        .unchecked_transaction()
        .map_err(MigrationError::from_sqlite)?;
    transaction
        .execute_batch(
            "CREATE TABLE IF NOT EXISTS search_metadata (
                schema_version INTEGER NOT NULL
             );",
        )
        .map_err(MigrationError::from_sqlite)?;

    let (row_count, schema_version) = transaction
        .query_row(
            "SELECT COUNT(*), MIN(schema_version) FROM search_metadata",
            [],
            |row| Ok((row.get::<_, u32>(0)?, row.get::<_, Option<u32>>(1)?)),
        )
        .map_err(MigrationError::from_sqlite)?;
    match (row_count, schema_version) {
        (0, None) => {
            create_current_schema(&transaction)?;
            transaction
                .execute(
                    "INSERT INTO search_metadata(schema_version) VALUES (?1)",
                    [SCHEMA_VERSION],
                )
                .map_err(MigrationError::from_sqlite)?;
        }
        (1, Some(1)) => {
            transaction
                .execute_batch(
                    "ALTER TABLE message_versions
                        ADD COLUMN selection_order INTEGER NOT NULL DEFAULT 0;
                     UPDATE message_versions SET selection_order = rowid;",
                )
                .map_err(MigrationError::from_sqlite)?;
            transaction
                .execute(
                    "UPDATE search_metadata SET schema_version = ?1",
                    [SCHEMA_VERSION],
                )
                .map_err(MigrationError::from_sqlite)?;
            create_current_schema(&transaction)?;
        }
        (1, Some(SCHEMA_VERSION)) => {
            create_current_schema(&transaction)?;
        }
        _ => return Err(MigrationError::IncompatibleSchema),
    }
    transaction.commit().map_err(MigrationError::from_sqlite)
}

fn create_current_schema(transaction: &Transaction<'_>) -> Result<(), MigrationError> {
    transaction
        .execute_batch(
            "CREATE TABLE IF NOT EXISTS message_versions (
                room_id TEXT NOT NULL,
                original_event_id TEXT NOT NULL,
                version_event_id TEXT NOT NULL,
                sender TEXT NOT NULL,
                body TEXT,
                origin_server_ts INTEGER NOT NULL,
                selection_order INTEGER NOT NULL,
                PRIMARY KEY(room_id, version_event_id)
             );
             CREATE TABLE IF NOT EXISTS redacted_events (
                room_id TEXT NOT NULL,
                event_id TEXT NOT NULL,
                PRIMARY KEY(room_id, event_id)
             );
             CREATE TABLE IF NOT EXISTS searchable_messages (
                body TEXT NOT NULL,
                room_id TEXT NOT NULL,
                event_id TEXT NOT NULL,
                version_event_id TEXT NOT NULL,
                sender TEXT NOT NULL,
                origin_server_ts INTEGER NOT NULL,
                PRIMARY KEY(room_id, event_id)
             );",
        )
        .map_err(MigrationError::from_sqlite)?;
    transaction
        .prepare(
            "SELECT room_id, original_event_id, version_event_id, sender, body,
                    origin_server_ts, selection_order
             FROM message_versions LIMIT 0",
        )
        .map_err(MigrationError::from_sqlite)?;
    transaction
        .prepare("SELECT room_id, event_id FROM redacted_events LIMIT 0")
        .map_err(MigrationError::from_sqlite)?;
    transaction
        .prepare(
            "SELECT body, room_id, event_id, version_event_id, sender, origin_server_ts
             FROM searchable_messages LIMIT 0",
        )
        .map_err(MigrationError::from_sqlite)?;
    Ok(())
}

fn compact(connection: &Connection) -> Result<(), String> {
    connection
        .execute_batch("VACUUM; PRAGMA wal_checkpoint(TRUNCATE);")
        .map_err(safe_storage_error)
}

fn timestamp_to_i64(timestamp: u64) -> i64 {
    i64::try_from(timestamp).unwrap_or(i64::MAX)
}

fn account_directory_prefix(account_store_key: &str) -> String {
    let digest = Sha256::digest(account_store_key.as_bytes());
    format!("{}-", hex(&digest[..16]))
}

fn index_directory(app_data_dir: &Path, account_store_key: &str, device_id: &str) -> PathBuf {
    let prefix = account_directory_prefix(account_store_key);
    let mut digest = Sha256::new();
    digest.update(account_store_key.as_bytes());
    digest.update([0]);
    digest.update(device_id.as_bytes());
    app_data_dir
        .join(SEARCH_ROOT)
        .join(format!("{prefix}{}", hex(&digest.finalize()[..16])))
}

fn hex(bytes: &[u8]) -> String {
    let mut encoded = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        write!(&mut encoded, "{byte:02x}").expect("writing to a String cannot fail");
    }
    encoded
}

fn sqlcipher_raw_key_literal(bytes: &[u8]) -> String {
    let mut literal = String::with_capacity(bytes.len() * 2 + 3);
    literal.push_str("x'");
    for byte in bytes {
        write!(&mut literal, "{byte:02x}").expect("writing to a String cannot fail");
    }
    literal.push('\'');
    literal
}

fn create_private_directory(path: &Path) -> Result<(), String> {
    match std::fs::create_dir(path) {
        Ok(()) => {}
        Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {}
        Err(error) => return Err(safe_io_error(error)),
    }
    let metadata = std::fs::symlink_metadata(path).map_err(safe_io_error)?;
    if !metadata.file_type().is_dir() {
        return Err("message search filesystem path is not a directory".to_string());
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o700))
            .map_err(safe_io_error)?;
    }
    Ok(())
}

fn safe_storage_error(error: rusqlite::Error) -> String {
    format!(
        "message search storage error ({:?})",
        error.sqlite_error_code()
    )
}

fn safe_io_error(error: std::io::Error) -> String {
    format!("message search filesystem error ({:?})", error.kind())
}

#[cfg(test)]
mod tests {
    use super::*;

    const TEST_STORE_SECRET: &str = "test-only-random-store-secret";

    fn open_index(directory: &Path, account: &str, device: &str) -> SearchIndex {
        SearchIndex::open_with_secret(directory, account, device, TEST_STORE_SECRET).expect("open")
    }

    fn document(body: Option<&str>, version_event_id: &str) -> SearchDocument {
        let selection_order = match version_event_id {
            "$original" => 1,
            "$edit" | "$edit-1" => 2,
            "$edit-2" => 3,
            _ => 4,
        };
        SearchDocument {
            room_id: "!room:example.org".to_string(),
            event_id: "$original".to_string(),
            version_event_id: version_event_id.to_string(),
            sender: "@alice:example.org".to_string(),
            body: body.map(str::to_string),
            origin_server_ts: 42,
            selection_order,
        }
    }

    #[test]
    fn key_derivation_is_separated_by_account_device_and_source_secret() {
        let baseline = derive_search_key("account-a", "DEVICE-A", TEST_STORE_SECRET).expect("key");
        let other_account =
            derive_search_key("account-b", "DEVICE-A", TEST_STORE_SECRET).expect("key");
        let other_device =
            derive_search_key("account-a", "DEVICE-B", TEST_STORE_SECRET).expect("key");
        let other_secret =
            derive_search_key("account-a", "DEVICE-A", "another-secret").expect("key");

        assert_ne!(*baseline, *other_account);
        assert_ne!(*baseline, *other_device);
        assert_ne!(*baseline, *other_secret);
    }

    #[test]
    fn sqlcipher_key_literal_uses_the_raw_key_form() {
        let literal = Zeroizing::new(sqlcipher_raw_key_literal(&[0x01, 0xab, 0xff]));
        assert_eq!(literal.as_str(), "x'01abff'");
    }

    #[test]
    fn open_rejects_an_unknown_schema_version_without_deleting_content() {
        let directory = tempfile::tempdir().expect("tempdir");
        let mut index = open_index(directory.path(), "account", "DEVICE");
        index
            .apply_document(&document(Some("discarded content"), "$original"))
            .expect("insert content");
        index
            .connection
            .execute("UPDATE search_metadata SET schema_version = 999", [])
            .expect("change schema version");
        let database_path = index.database_path().to_path_buf();
        drop(index);

        let error =
            SearchIndex::open_with_secret(directory.path(), "account", "DEVICE", TEST_STORE_SECRET)
                .err()
                .expect("unknown schema must fail closed");
        assert_eq!(error, "message search schema version mismatch");

        let connection = Connection::open(database_path).expect("reopen database");
        apply_encryption_key(&connection, "account", "DEVICE", TEST_STORE_SECRET)
            .expect("apply encryption key");
        let retained_body = connection
            .query_row(
                "SELECT body FROM searchable_messages WHERE event_id = '$original'",
                [],
                |row| row.get::<_, String>(0),
            )
            .expect("retained content");
        assert_eq!(retained_body, "discarded content");
    }

    #[test]
    fn open_rejects_a_malformed_schema_and_classifies_transient_storage_errors() {
        let directory = tempfile::tempdir().expect("tempdir");
        let index = open_index(directory.path(), "account", "DEVICE");
        index
            .connection
            .execute(
                "ALTER TABLE search_metadata
                 RENAME COLUMN schema_version TO wrong_version",
                [],
            )
            .expect("corrupt metadata schema");
        drop(index);

        let error =
            SearchIndex::open_with_secret(directory.path(), "account", "DEVICE", TEST_STORE_SECRET)
                .err()
                .expect("malformed schema must fail closed");
        assert_eq!(error, "message search schema version mismatch");

        assert!(matches!(
            MigrationError::from_sqlite(rusqlite::Error::SqliteFailure(
                rusqlite::ffi::Error::new(rusqlite::ffi::SQLITE_BUSY),
                None,
            )),
            MigrationError::Storage(_)
        ));
    }

    #[test]
    fn open_migrates_v1_and_preserves_version_order() {
        let directory = tempfile::tempdir().expect("tempdir");
        let index_directory = index_directory(directory.path(), "account", "DEVICE");
        create_private_directory(&directory.path().join(SEARCH_ROOT)).expect("private root");
        create_private_directory(&index_directory).expect("private directory");
        let connection =
            Connection::open(index_directory.join(SEARCH_DATABASE)).expect("open v1 database");
        apply_encryption_key(&connection, "account", "DEVICE", TEST_STORE_SECRET)
            .expect("apply encryption key");
        configure(&connection).expect("configure");
        connection
            .execute_batch(
                "CREATE TABLE search_metadata (schema_version INTEGER NOT NULL);
                 INSERT INTO search_metadata VALUES (1);
                 CREATE TABLE message_versions (
                    room_id TEXT NOT NULL,
                    original_event_id TEXT NOT NULL,
                    version_event_id TEXT NOT NULL,
                    sender TEXT NOT NULL,
                    body TEXT,
                    origin_server_ts INTEGER NOT NULL,
                    PRIMARY KEY(room_id, version_event_id)
                 );
                 CREATE TABLE redacted_events (
                    room_id TEXT NOT NULL,
                    event_id TEXT NOT NULL,
                    PRIMARY KEY(room_id, event_id)
                 );
                 CREATE TABLE searchable_messages (
                    body TEXT NOT NULL,
                    room_id TEXT NOT NULL,
                    event_id TEXT NOT NULL,
                    version_event_id TEXT NOT NULL,
                    sender TEXT NOT NULL,
                    origin_server_ts INTEGER NOT NULL,
                    PRIMARY KEY(room_id, event_id)
                 );
                 INSERT INTO message_versions VALUES
                    ('!room:example.org', '$original', '$original', '@alice:example.org', 'original', 1),
                    ('!room:example.org', '$original', '$edit-1', '@alice:example.org', 'first edit', 2),
                    ('!room:example.org', '$original', '$edit-2', '@alice:example.org', 'second edit', 3);
                 INSERT INTO searchable_messages VALUES
                    ('second edit', '!room:example.org', '$original', '$edit-2', '@alice:example.org', 3);",
            )
            .expect("create v1 schema");
        drop(connection);

        let mut index = open_index(directory.path(), "account", "DEVICE");
        let schema_version = index
            .connection
            .query_row("SELECT schema_version FROM search_metadata", [], |row| {
                row.get::<_, u32>(0)
            })
            .expect("schema version");
        assert_eq!(schema_version, SCHEMA_VERSION);

        index
            .redact("!room:example.org", "$edit-2")
            .expect("redact latest migrated edit");
        assert_eq!(
            index
                .visible_body("!room:example.org", "$original")
                .as_deref(),
            Some("first edit")
        );
    }

    #[test]
    fn open_uses_an_opaque_device_scoped_private_path() {
        let directory = tempfile::tempdir().expect("tempdir");
        let first = open_index(directory.path(), "account-key", "DEVICE-A");
        let second = open_index(directory.path(), "account-key", "DEVICE-B");

        assert_ne!(first.database_path(), second.database_path());
        let rendered = first.database_path().to_string_lossy();
        assert!(!rendered.contains("DEVICE-A"));
        assert!(!rendered.contains("account-key"));
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(
                first
                    .database_path()
                    .parent()
                    .expect("parent")
                    .metadata()
                    .expect("metadata")
                    .permissions()
                    .mode()
                    & 0o777,
                0o700
            );
        }
    }

    #[cfg(unix)]
    #[test]
    fn open_rejects_a_symlinked_search_root() {
        use std::os::unix::fs::symlink;

        let app_data = tempfile::tempdir().expect("app data");
        let outside = tempfile::tempdir().expect("outside directory");
        symlink(outside.path(), app_data.path().join(SEARCH_ROOT)).expect("create root symlink");

        let error =
            SearchIndex::open_with_secret(app_data.path(), "account", "DEVICE", TEST_STORE_SECRET)
                .err()
                .expect("symlinked search root must fail closed");

        assert_eq!(error, "message search filesystem path is not a directory");
        assert_eq!(
            std::fs::read_dir(outside.path())
                .expect("read outside directory")
                .count(),
            0
        );
    }

    #[cfg(unix)]
    #[test]
    fn open_rejects_a_symlinked_database_file() {
        use std::os::unix::fs::symlink;

        let app_data = tempfile::tempdir().expect("app data");
        let outside = tempfile::NamedTempFile::new().expect("outside file");
        let outside_path = outside.path().to_path_buf();
        std::fs::write(&outside_path, b"outside content").expect("seed outside file");

        let search_root = app_data.path().join(SEARCH_ROOT);
        create_private_directory(&search_root).expect("private root");
        let device_directory = index_directory(app_data.path(), "account", "DEVICE");
        create_private_directory(&device_directory).expect("private device directory");
        symlink(&outside_path, device_directory.join(SEARCH_DATABASE))
            .expect("create database symlink");

        let error =
            SearchIndex::open_with_secret(app_data.path(), "account", "DEVICE", TEST_STORE_SECRET)
                .err()
                .expect("symlinked database must fail closed");

        assert!(error.starts_with("message search storage error"));
        assert_eq!(
            std::fs::read(&outside_path).expect("read outside file"),
            b"outside content"
        );
    }

    #[test]
    fn replacement_updates_the_visible_row_without_a_second_result() {
        let directory = tempfile::tempdir().expect("tempdir");
        let mut index = open_index(directory.path(), "account", "DEVICE");
        index
            .apply_document(&document(Some("original"), "$original"))
            .expect("insert");
        index
            .apply_document(&document(Some("edited"), "$edit"))
            .expect("edit");

        assert_eq!(
            index
                .visible_body("!room:example.org", "$original")
                .as_deref(),
            Some("edited")
        );
    }

    #[test]
    fn non_searchable_replacement_removes_the_visible_row() {
        let directory = tempfile::tempdir().expect("tempdir");
        let mut index = open_index(directory.path(), "account", "DEVICE");
        index
            .apply_document(&document(Some("original"), "$original"))
            .expect("insert");
        index
            .apply_document(&document(None, "$edit"))
            .expect("edit");

        assert_eq!(index.visible_body("!room:example.org", "$original"), None);
    }

    #[test]
    fn sqlcipher_hides_indexed_content_and_rejects_an_unkeyed_connection() {
        let directory = tempfile::tempdir().expect("tempdir");
        let mut index = open_index(directory.path(), "account", "DEVICE");
        let marker = "distinctive-unredacted-secret-marker";
        index
            .apply_document(&document(Some(marker), "$original"))
            .expect("insert");
        index
            .connection
            .execute_batch("PRAGMA wal_checkpoint(FULL);")
            .expect("checkpoint");

        for entry in std::fs::read_dir(index.database_path().parent().expect("parent"))
            .expect("index directory")
        {
            let entry = entry.expect("directory entry");
            if !entry.file_type().expect("file type").is_file() {
                continue;
            }
            let bytes = std::fs::read(entry.path()).expect("database or sidecar bytes");
            assert!(!bytes
                .windows(marker.len())
                .any(|window| window == marker.as_bytes()));
        }

        let unkeyed = Connection::open(index.database_path()).expect("open file");
        assert!(unkeyed
            .query_row("SELECT count(*) FROM sqlite_master", [], |row| row
                .get::<_, i64>(0))
            .is_err());

        let database_path = index.database_path().to_owned();
        drop((unkeyed, index));
        assert!(SearchIndex::open_with_secret(
            directory.path(),
            "account",
            "DEVICE",
            "different-store-secret",
        )
        .is_err());
        assert!(database_path.exists());
    }

    #[test]
    fn redaction_tombstone_prevents_late_replay_and_removes_content() {
        let directory = tempfile::tempdir().expect("tempdir");
        let mut index = open_index(directory.path(), "account", "DEVICE");
        index
            .apply_document(&document(Some("secret-marker"), "$original"))
            .expect("insert");
        index
            .redact("!room:example.org", "$original")
            .expect("redact");
        index
            .apply_document(&document(Some("secret-marker"), "$late-edit"))
            .expect("late edit");

        assert_eq!(index.visible_body("!room:example.org", "$original"), None);
        let mut wal_path = index.database_path().as_os_str().to_os_string();
        wal_path.push("-wal");
        let wal_path = PathBuf::from(wal_path);
        assert!(
            !wal_path.exists() || wal_path.metadata().expect("WAL metadata").len() == 0,
            "compaction must truncate the WAL after VACUUM"
        );
        for entry in std::fs::read_dir(index.database_path().parent().expect("parent"))
            .expect("index directory")
        {
            let entry = entry.expect("directory entry");
            if !entry.file_type().expect("file type").is_file() {
                continue;
            }
            let bytes = std::fs::read(entry.path()).expect("database or sidecar bytes");
            assert!(!bytes
                .windows(b"secret-marker".len())
                .any(|window| window == b"secret-marker"));
        }
    }

    #[test]
    fn redacting_edits_restores_the_previously_selected_version() {
        let directory = tempfile::tempdir().expect("tempdir");
        let mut index = open_index(directory.path(), "account", "DEVICE");
        index
            .apply_document(&document(Some("original"), "$original"))
            .expect("insert original");
        index
            .apply_document(&document(Some("first edit"), "$edit-1"))
            .expect("insert first edit");
        index
            .apply_document(&document(Some("second edit"), "$edit-2"))
            .expect("insert second edit");

        index
            .redact("!room:example.org", "$edit-2")
            .expect("redact second edit");
        assert_eq!(
            index
                .visible_body("!room:example.org", "$original")
                .as_deref(),
            Some("first edit")
        );

        index
            .redact("!room:example.org", "$edit-1")
            .expect("redact first edit");
        assert_eq!(
            index
                .visible_body("!room:example.org", "$original")
                .as_deref(),
            Some("original")
        );

        index
            .apply_document(&document(Some("replayed edit"), "$edit-1"))
            .expect("replay redacted edit");
        assert_eq!(
            index
                .visible_body("!room:example.org", "$original")
                .as_deref(),
            Some("original")
        );
    }

    #[test]
    fn duplicate_edit_delivery_does_not_change_version_order_or_visibility() {
        let directory = tempfile::tempdir().expect("tempdir");
        let mut index = open_index(directory.path(), "account", "DEVICE");
        index
            .apply_document(&document(Some("original"), "$original"))
            .expect("insert original");
        index
            .apply_document(&document(Some("first edit"), "$edit-1"))
            .expect("insert first edit");
        index
            .apply_document(&document(Some("second edit"), "$edit-2"))
            .expect("insert second edit");
        index
            .apply_document(&document(Some("replayed first edit"), "$edit-1"))
            .expect("replay first edit");

        assert_eq!(
            index
                .visible_body("!room:example.org", "$original")
                .as_deref(),
            Some("second edit")
        );
        index
            .redact("!room:example.org", "$edit-2")
            .expect("redact second edit");
        assert_eq!(
            index
                .visible_body("!room:example.org", "$original")
                .as_deref(),
            Some("first edit")
        );
    }

    #[test]
    fn out_of_order_edits_preserve_renderer_authoritative_order() {
        let directory = tempfile::tempdir().expect("tempdir");
        let mut index = open_index(directory.path(), "account", "DEVICE");
        index
            .apply_document(&document(Some("original"), "$original"))
            .expect("insert original");
        index
            .apply_document(&document(Some("second edit"), "$edit-2"))
            .expect("insert second edit first");
        index
            .apply_document(&document(Some("first edit"), "$edit-1"))
            .expect("insert first edit late");

        assert_eq!(
            index
                .visible_body("!room:example.org", "$original")
                .as_deref(),
            Some("second edit")
        );
        index
            .redact("!room:example.org", "$edit-2")
            .expect("redact second edit");
        assert_eq!(
            index
                .visible_body("!room:example.org", "$original")
                .as_deref(),
            Some("first edit")
        );
    }
}
