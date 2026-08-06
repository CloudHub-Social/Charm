//! Charm-owned, SQLCipher-encrypted search-index storage for Spec 28.
//!
//! This database is deliberately separate from matrix-rust-sdk's encrypted
//! store. Callers must pass only acknowledged, decrypted text, notice, or
//! emote events after applying Matrix reply and HTML normalization.

use std::{
    collections::{HashMap, HashSet},
    fmt::Write as _,
    future::Future as _,
    path::{Path, PathBuf},
    task::Poll,
    time::{Duration, Instant},
};

use hkdf::Hkdf;
use matrix_sdk::{
    deserialized_responses::{TimelineEvent, TimelineEventKind},
    ruma::{
        events::{
            room::message::{MessageFormat, MessageType, Relation, RoomMessageEventContent},
            AnySyncMessageLikeEvent, AnySyncTimelineEvent, SyncMessageLikeEvent,
        },
        html::{Html, HtmlSanitizerMode, NodeData, NodeRef, RemoveReplyFallback, SanitizerConfig},
        serde::Raw,
    },
    Client,
};
use matrix_sdk_ui::timeline::TimelineItem;
use rand::{distr::Alphanumeric, RngExt};
use rusqlite::{
    params, params_from_iter, types::Value, Connection, ErrorCode, OpenFlags, OptionalExtension,
    Transaction,
};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use sha2_compat::Sha256 as HkdfSha256;
use tauri::{AppHandle, Manager, State};
use ts_rs::TS;
use zeroize::Zeroizing;

const SEARCH_ROOT: &str = "message_search";
const SEARCH_DATABASE: &str = "message-search.sqlite3";
const SCHEMA_VERSION: u32 = 5;
const KEY_DERIVATION_SALT: &[u8] = b"Charm message search SQLCipher key v1";
const SNAPSHOT_QUERY_DIGEST_INFO: &[u8] = b"Charm message search snapshot query v1";
const MAX_QUERY_BYTES: usize = 512;
const MAX_RESULTS_PER_PAGE: usize = 100;
const MAX_SNAPSHOT_RESULTS: usize = 2_000;
const MAX_LIVE_SNAPSHOTS: usize = 8;
const SNAPSHOT_TTL: Duration = Duration::from_secs(5 * 60);
const ROOM_LEAVE_PURGE_TIMEOUT: Duration = Duration::from_secs(5);

#[derive(Debug)]
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
                    // A wrong SQLCipher key is intentionally surfaced as
                    // SQLITE_NOTADB. Never rebuild in that case: doing so
                    // would destroy an intact index under a transiently wrong
                    // source secret.
                    | ErrorCode::NotADatabase
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
    /// Ordering of the selected original/edit event. Equal replacement orders
    /// are intentionally ambiguous until an authoritative timeline projection
    /// resolves them.
    pub selection_order: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../src/bindings/")]
pub struct SearchMatchRange {
    pub start: u32,
    pub end: u32,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../src/bindings/")]
pub struct SearchResult {
    pub room_id: String,
    pub event_id: String,
    pub sender: String,
    #[ts(type = "number")]
    pub origin_server_ts: u64,
    pub snippet: String,
    pub match_ranges: Vec<SearchMatchRange>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../src/bindings/")]
pub struct SearchResultPage {
    pub results: Vec<SearchResult>,
    pub next_cursor: Option<String>,
    pub incomplete: bool,
}

impl SearchResultPage {
    /// Applies freshly-read room-membership and ignored-sender visibility at
    /// the final response boundary.
    pub fn retain_current_visibility(
        &mut self,
        allowed_rooms: &HashSet<String>,
        ignored_senders: &HashSet<String>,
    ) {
        self.results.retain(|result| {
            allowed_rooms.contains(&result.room_id) && !ignored_senders.contains(&result.sender)
        });
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(tag = "code", rename_all = "snake_case")]
#[ts(export, export_to = "../src/bindings/")]
pub enum SearchCommandError {
    InvalidQuery { message: String },
    StaleCursor { message: String },
    Unavailable { message: String },
}

impl SearchCommandError {
    fn invalid_query(message: &str) -> Self {
        Self::InvalidQuery {
            message: message.to_string(),
        }
    }

    fn stale_cursor() -> Self {
        Self::StaleCursor {
            message: "message search cursor is stale; restart the search".to_string(),
        }
    }

    pub fn unavailable() -> Self {
        Self::Unavailable {
            message: "message search is unavailable".to_string(),
        }
    }
}

#[derive(Debug, Clone)]
struct SearchSnapshotEntry {
    room_id: String,
    event_id: String,
    version_event_id: String,
}

#[derive(Debug)]
struct SearchSnapshot {
    query_digest: [u8; 32],
    room_id: Option<String>,
    created_at: Instant,
    entries: Vec<SearchSnapshotEntry>,
}

/// A Charm-owned, device-scoped SQLCipher message index.
pub struct SearchIndex {
    connection: Connection,
    database_path: PathBuf,
    incarnation: String,
    snapshot_query_key: Zeroizing<[u8; 32]>,
    snapshots: HashMap<String, SearchSnapshot>,
}

pub(crate) struct ActiveSearchIndex {
    account_store_key: String,
    device_id: String,
    pub(crate) index: SearchIndex,
}

#[derive(Debug)]
pub(crate) enum SearchMutation {
    Apply(SearchDocument),
    SelectVersion {
        room_id: String,
        event_id: String,
        version_event_id: String,
    },
    Redact {
        room_id: String,
        event_id: String,
    },
    PurgeRoom {
        room_id: String,
    },
}

#[derive(Debug)]
pub struct SearchWork {
    account_store_key: String,
    device_id: String,
    mutations: Vec<SearchMutation>,
    ignored_senders: HashSet<String>,
}

pub(crate) struct QueuedSearchWork {
    generation: u64,
    work: SearchWork,
    completes_backfill: bool,
    completion: Option<tokio::sync::oneshot::Sender<Result<(), String>>>,
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
        Self::open_with_source_secret(
            app_data_dir,
            account_store_key,
            device_id,
            &store_passphrase,
        )
    }

    pub fn open_with_source_secret(
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
        let mut connection = match open_encrypted_connection(
            &database_path,
            account_store_key,
            device_id,
            store_passphrase,
        ) {
            Ok(connection) => connection,
            Err(MigrationError::Storage(message)) => return Err(message),
            Err(MigrationError::IncompatibleSchema) => rebuild_encrypted_connection(
                &directory,
                &database_path,
                account_store_key,
                device_id,
                store_passphrase,
                "corrupt_index",
            )?,
        };
        if let Err(error) = migrate(&connection) {
            match error {
                MigrationError::Storage(message) => return Err(message),
                MigrationError::IncompatibleSchema => {
                    drop(connection);
                    connection = rebuild_encrypted_connection(
                        &directory,
                        &database_path,
                        account_store_key,
                        device_id,
                        store_passphrase,
                        "incompatible_schema",
                    )?;
                }
            }
        }
        Ok(Self {
            connection,
            database_path,
            incarnation: random_id(),
            snapshot_query_key: Zeroizing::new(rand::rng().random()),
            snapshots: HashMap::new(),
        })
    }

    #[cfg(test)]
    fn open_with_secret(
        app_data_dir: &Path,
        account_store_key: &str,
        device_id: &str,
        store_passphrase: &str,
    ) -> Result<Self, String> {
        Self::open_with_source_secret(app_data_dir, account_store_key, device_id, store_passphrase)
    }

    /// Returns the opaque database path for lifecycle coordination and tests.
    pub fn database_path(&self) -> &Path {
        &self.database_path
    }

    /// Closes and physically removes this derived index and SQLite sidecars.
    pub fn delete(self) -> Result<(), String> {
        let database_path = self.database_path.clone();
        drop(self);
        delete_database_path(&database_path)
    }

    /// Removes one derived account/device index without opening it or
    /// requiring its encryption secret. Persisted-session teardown uses this
    /// when no live [`SearchIndex`] handle remains.
    pub fn delete_for_source(
        app_data_dir: &Path,
        account_store_key: &str,
        device_id: &str,
    ) -> Result<(), String> {
        let app_data_dir = match std::fs::canonicalize(app_data_dir) {
            Ok(path) => path,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
            Err(error) => return Err(safe_io_error(error)),
        };
        let search_root = app_data_dir.join(SEARCH_ROOT);
        let directory = index_directory(&app_data_dir, account_store_key, device_id);
        for path in [&search_root, &directory] {
            match std::fs::symlink_metadata(path) {
                Ok(metadata) if metadata.file_type().is_dir() => {}
                Ok(_) => {
                    return Err("message search filesystem path is not a directory".to_string())
                }
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
                Err(error) => return Err(safe_io_error(error)),
            }
        }
        delete_database_path(&directory.join(SEARCH_DATABASE))
    }

    /// Removes every retained device index derived from one account store
    /// key. Account deactivation uses this broader boundary because no device
    /// for the deleted account can legitimately retain decrypted search rows.
    pub fn delete_for_account(app_data_dir: &Path, account_store_key: &str) -> Result<(), String> {
        let app_data_dir = match std::fs::canonicalize(app_data_dir) {
            Ok(path) => path,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
            Err(error) => return Err(safe_io_error(error)),
        };
        let search_root = app_data_dir.join(SEARCH_ROOT);
        match std::fs::symlink_metadata(&search_root) {
            Ok(metadata) if metadata.file_type().is_dir() => {}
            Ok(_) => return Err("message search filesystem path is not a directory".to_string()),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
            Err(error) => return Err(safe_io_error(error)),
        }
        let prefix = account_directory_prefix(account_store_key);
        for entry in std::fs::read_dir(&search_root).map_err(safe_io_error)? {
            let entry = entry.map_err(safe_io_error)?;
            let name = entry.file_name();
            let Some(name) = name.to_str() else { continue };
            if !name.starts_with(&prefix) {
                continue;
            }
            let metadata = std::fs::symlink_metadata(entry.path()).map_err(safe_io_error)?;
            if !metadata.file_type().is_dir() {
                return Err("message search filesystem path is not a directory".to_string());
            }
            delete_database_path(&entry.path().join(SEARCH_DATABASE))?;
        }
        Ok(())
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
        if document.version_event_id != document.event_id {
            let original_sender = transaction
                .query_row(
                    "SELECT sender FROM message_versions
                     WHERE room_id = ?1 AND original_event_id = ?2
                       AND version_event_id = original_event_id",
                    params![&document.room_id, &document.event_id],
                    |row| row.get::<_, String>(0),
                )
                .optional()
                .map_err(safe_storage_error)?;
            if original_sender.as_deref() != Some(document.sender.as_str()) {
                return transaction.commit().map_err(safe_storage_error);
            }
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
                    "DELETE FROM selected_versions WHERE room_id = ?1 AND original_event_id = ?2",
                    params![room_id, event_id],
                )
                .map_err(safe_storage_error)?;
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
                 WHERE room_id = ?1 AND version_event_id = ?2
                 UNION ALL
                 SELECT original_event_id FROM selected_versions
                 WHERE room_id = ?1 AND version_event_id = ?2
                 LIMIT 1",
                params![room_id, event_id],
                |row| row.get::<_, String>(0),
            )
            .optional()
            .map_err(safe_storage_error)?
        {
            transaction
                .execute(
                    "DELETE FROM selected_versions
                     WHERE room_id = ?1 AND original_event_id = ?2 AND version_event_id = ?3",
                    params![room_id, &original_event_id, event_id],
                )
                .map_err(safe_storage_error)?;
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

    /// Records the edit version selected by matrix-sdk-ui's renderer.
    pub fn select_version(
        &mut self,
        room_id: &str,
        event_id: &str,
        version_event_id: &str,
    ) -> Result<(), String> {
        let transaction = self.connection.transaction().map_err(safe_storage_error)?;
        transaction
            .execute(
                "INSERT INTO selected_versions (room_id, original_event_id, version_event_id)
                 VALUES (?1, ?2, ?3)
                 ON CONFLICT(room_id, original_event_id)
                 DO UPDATE SET version_event_id = excluded.version_event_id",
                params![room_id, event_id, version_event_id],
            )
            .map_err(safe_storage_error)?;
        restore_visible_row(&transaction, room_id, event_id)?;
        transaction.commit().map_err(safe_storage_error)
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
                "DELETE FROM searchable_messages_fts WHERE room_id = ?1",
                [room_id],
            )
            .map_err(safe_storage_error)?;
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
        transaction
            .execute(
                "DELETE FROM selected_versions WHERE room_id = ?1",
                [room_id],
            )
            .map_err(safe_storage_error)?;
        transaction.commit().map_err(safe_storage_error)?;
        compact(&self.connection)
    }

    /// Removes every indexed version authored by an ignored sender.
    ///
    /// Sync workers call this before applying queued mutations. Search
    /// commands also call it with the account's freshly-read ignore list so
    /// a full or delayed worker queue cannot expose a newly ignored sender.
    pub fn purge_ignored_senders(&mut self, senders: &HashSet<String>) -> Result<(), String> {
        if senders.is_empty() {
            return Ok(());
        }
        let transaction = self.connection.transaction().map_err(safe_storage_error)?;
        let mut originals = Vec::new();
        {
            let mut statement = transaction
                .prepare(
                    "SELECT DISTINCT room_id, original_event_id
                     FROM message_versions WHERE sender = ?1",
                )
                .map_err(safe_storage_error)?;
            for sender in senders {
                let rows = statement
                    .query_map([sender], |row| {
                        Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
                    })
                    .map_err(safe_storage_error)?;
                for row in rows {
                    originals.push(row.map_err(safe_storage_error)?);
                }
            }
        }
        if originals.is_empty() {
            return transaction.commit().map_err(safe_storage_error);
        }
        for (room_id, event_id) in originals {
            delete_visible_row(&transaction, &room_id, &event_id)?;
            transaction
                .execute(
                    "DELETE FROM selected_versions
                     WHERE room_id = ?1 AND original_event_id = ?2",
                    params![&room_id, &event_id],
                )
                .map_err(safe_storage_error)?;
            transaction
                .execute(
                    "DELETE FROM message_versions
                     WHERE room_id = ?1 AND original_event_id = ?2",
                    params![room_id, event_id],
                )
                .map_err(safe_storage_error)?;
        }
        transaction.commit().map_err(safe_storage_error)?;
        compact(&self.connection)
    }

    /// Searches the current encrypted index without issuing Matrix requests.
    /// The first page captures an identifier-only snapshot; later pages use
    /// its cursor so concurrent indexing cannot duplicate or skip entries.
    pub fn search(
        &mut self,
        query: &str,
        room_id: Option<&str>,
        allowed_rooms: &HashSet<String>,
        limit: usize,
        cursor: Option<&str>,
    ) -> Result<SearchResultPage, SearchCommandError> {
        let query = validate_query(query)?;
        let query_digest = snapshot_query_digest(&self.snapshot_query_key, &query);
        let limit = limit.clamp(1, MAX_RESULTS_PER_PAGE);
        self.snapshots
            .retain(|_, snapshot| snapshot.created_at.elapsed() <= SNAPSHOT_TTL);

        let (snapshot_id, offset) = if let Some(cursor) = cursor {
            parse_cursor(cursor, &self.incarnation)?
        } else {
            let entries = self.collect_snapshot_entries(&query, room_id, allowed_rooms)?;
            while self.snapshots.len() >= MAX_LIVE_SNAPSHOTS {
                let Some(oldest) = self
                    .snapshots
                    .iter()
                    .min_by_key(|(_, snapshot)| snapshot.created_at)
                    .map(|(id, _)| id.clone())
                else {
                    break;
                };
                self.snapshots.remove(&oldest);
            }
            let snapshot_id = random_id();
            self.snapshots.insert(
                snapshot_id.clone(),
                SearchSnapshot {
                    query_digest,
                    room_id: room_id.map(str::to_owned),
                    created_at: Instant::now(),
                    entries,
                },
            );
            (snapshot_id, 0)
        };

        let snapshot = self
            .snapshots
            .get(&snapshot_id)
            .ok_or_else(SearchCommandError::stale_cursor)?;
        if snapshot.query_digest != query_digest || snapshot.room_id.as_deref() != room_id {
            return Err(SearchCommandError::stale_cursor());
        }

        let mut results = Vec::with_capacity(limit);
        let mut next_offset = offset;
        while next_offset < snapshot.entries.len() && results.len() < limit {
            let entry = &snapshot.entries[next_offset];
            next_offset += 1;
            if !allowed_rooms.contains(&entry.room_id) {
                continue;
            }
            let resolved = self
                .connection
                .query_row(
                    "SELECT sender, body, origin_server_ts
                     FROM message_versions
                     WHERE room_id = ?1 AND original_event_id = ?2
                       AND version_event_id = ?3 AND body IS NOT NULL",
                    params![&entry.room_id, &entry.event_id, &entry.version_event_id],
                    |row| {
                        Ok((
                            row.get::<_, String>(0)?,
                            row.get::<_, String>(1)?,
                            row.get::<_, i64>(2)?,
                        ))
                    },
                )
                .optional()
                .map_err(|_| SearchCommandError::unavailable())?;
            let Some((sender, body, timestamp)) = resolved else {
                continue;
            };
            let (snippet, match_ranges) = snippet_and_ranges(&body, &query);
            results.push(SearchResult {
                room_id: entry.room_id.clone(),
                event_id: entry.event_id.clone(),
                sender,
                origin_server_ts: timestamp.max(0) as u64,
                snippet,
                match_ranges,
            });
        }

        let next_cursor = (next_offset < snapshot.entries.len())
            .then(|| format!("{snapshot_id}:{next_offset}:{}", self.incarnation));
        Ok(SearchResultPage {
            results,
            next_cursor,
            incomplete: false,
        })
    }

    fn collect_snapshot_entries(
        &self,
        query: &str,
        room_id: Option<&str>,
        allowed_rooms: &HashSet<String>,
    ) -> Result<Vec<SearchSnapshotEntry>, SearchCommandError> {
        let mut selected_rooms: Vec<String> = match room_id {
            Some(room_id) if allowed_rooms.contains(room_id) => vec![room_id.to_string()],
            Some(_) => return Ok(Vec::new()),
            None => allowed_rooms.iter().cloned().collect(),
        };
        if selected_rooms.is_empty() {
            return Ok(Vec::new());
        }
        selected_rooms.sort_unstable();
        let room_placeholders = (2..selected_rooms.len() + 2)
            .map(|index| format!("?{index}"))
            .collect::<Vec<_>>()
            .join(", ");
        let limit_parameter = selected_rooms.len() + 2;
        let mut entries = Vec::new();
        if query.chars().count() >= 3 {
            let literal = format!("\"{}\"", query.replace('"', "\"\""));
            let sql = format!(
                "SELECT room_id, event_id, version_event_id
                 FROM searchable_messages_fts
                 WHERE searchable_messages_fts MATCH ?1
                   AND room_id IN ({room_placeholders})
                 ORDER BY bm25(searchable_messages_fts) ASC,
                          CAST(origin_server_ts AS INTEGER) DESC,
                          room_id ASC, event_id ASC
                 LIMIT ?{limit_parameter}"
            );
            let mut statement = self
                .connection
                .prepare(&sql)
                .map_err(|_| SearchCommandError::unavailable())?;
            let mut values = Vec::with_capacity(selected_rooms.len() + 2);
            values.push(Value::Text(literal));
            values.extend(selected_rooms.iter().cloned().map(Value::Text));
            values.push(Value::Integer(MAX_SNAPSHOT_RESULTS as i64));
            let rows = statement
                .query_map(params_from_iter(values), |row| {
                    Ok(SearchSnapshotEntry {
                        room_id: row.get(0)?,
                        event_id: row.get(1)?,
                        version_event_id: row.get(2)?,
                    })
                })
                .map_err(|_| SearchCommandError::unavailable())?;
            for row in rows {
                entries.push(row.map_err(|_| SearchCommandError::unavailable())?);
            }
        } else {
            let escaped = escape_like(query);
            let pattern = format!("%{escaped}%");
            let sql = format!(
                "SELECT room_id, event_id, version_event_id
                 FROM searchable_messages
                 WHERE body LIKE ?1 ESCAPE '\\' COLLATE NOCASE
                   AND room_id IN ({room_placeholders})
                 ORDER BY origin_server_ts DESC, room_id ASC, event_id ASC
                 LIMIT ?{limit_parameter}"
            );
            let mut statement = self
                .connection
                .prepare(&sql)
                .map_err(|_| SearchCommandError::unavailable())?;
            let mut values = Vec::with_capacity(selected_rooms.len() + 2);
            values.push(Value::Text(pattern));
            values.extend(selected_rooms.iter().cloned().map(Value::Text));
            values.push(Value::Integer(MAX_SNAPSHOT_RESULTS as i64));
            let rows = statement
                .query_map(params_from_iter(values), |row| {
                    Ok(SearchSnapshotEntry {
                        room_id: row.get(0)?,
                        event_id: row.get(1)?,
                        version_event_id: row.get(2)?,
                    })
                })
                .map_err(|_| SearchCommandError::unavailable())?;
            for row in rows {
                entries.push(row.map_err(|_| SearchCommandError::unavailable())?);
            }
        }
        Ok(entries)
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

impl SearchWork {
    /// Builds an identity-bound physical room purge for an explicit local
    /// leave/forget transition.
    pub fn purge_room_for_client(client: &Client, room_id: &str) -> Option<Self> {
        let (account_store_key, device_id) = active_identity(client)?;
        Some(Self {
            account_store_key,
            device_id,
            mutations: vec![SearchMutation::PurgeRoom {
                room_id: room_id.to_string(),
            }],
            ignored_senders: HashSet::new(),
        })
    }

    /// Creates an identity-bound empty marker for FIFO lifecycle signaling.
    /// Applying it is a no-op, but placing it after cached-room batches lets a
    /// transport know the initial backfill has drained without exposing index
    /// identity fields outside this module.
    pub fn empty_for_client(client: &Client) -> Option<Self> {
        let (account_store_key, device_id) = active_identity(client)?;
        Some(Self {
            account_store_key,
            device_id,
            mutations: Vec::new(),
            ignored_senders: HashSet::new(),
        })
    }

    /// Applies one ordered sync batch to an already-open index.
    pub fn apply_to(self, index: &mut SearchIndex) -> Result<(), String> {
        index.purge_ignored_senders(&self.ignored_senders)?;
        for mutation in self.mutations {
            match mutation {
                SearchMutation::Apply(document) => index.apply_document(&document)?,
                SearchMutation::SelectVersion {
                    room_id,
                    event_id,
                    version_event_id,
                } => index.select_version(&room_id, &event_id, &version_event_id)?,
                SearchMutation::Redact { room_id, event_id } => {
                    index.redact(&room_id, &event_id)?
                }
                SearchMutation::PurgeRoom { room_id } => index.purge_room(&room_id)?,
            }
        }
        Ok(())
    }

    pub fn is_empty(&self) -> bool {
        self.mutations.is_empty() && self.ignored_senders.is_empty()
    }

    /// Drops message additions for rooms that are no longer joined while
    /// preserving redactions, room purges, and ignore-list cleanup. Workers
    /// call this after dequeueing so FIFO ordering closes the leave/backfill
    /// race: additions dequeued before a leave purge are removed by that
    /// later purge, while additions queued after it see the departed room and
    /// are discarded before touching the index.
    pub fn retain_joined_room_additions(&mut self, joined_room_ids: &HashSet<String>) {
        self.mutations.retain(|mutation| match mutation {
            SearchMutation::Apply(document) => joined_room_ids.contains(&document.room_id),
            SearchMutation::SelectVersion { room_id, .. } => joined_room_ids.contains(room_id),
            SearchMutation::Redact { .. } | SearchMutation::PurgeRoom { .. } => true,
        });
    }

    /// Refreshes every visibility predicate that can change while this batch
    /// waits in the queue. The current ignore set is also installed on the
    /// batch so `apply_to` purges senders ignored after enqueue before any
    /// surviving additions are written.
    pub fn retain_currently_visible_additions(
        &mut self,
        joined_room_ids: &HashSet<String>,
        ignored_senders: HashSet<String>,
    ) {
        self.mutations.retain(|mutation| match mutation {
            SearchMutation::Apply(document) => {
                joined_room_ids.contains(&document.room_id)
                    && !ignored_senders.contains(&document.sender)
            }
            SearchMutation::SelectVersion { room_id, .. } => joined_room_ids.contains(room_id),
            SearchMutation::Redact { .. } | SearchMutation::PurgeRoom { .. } => true,
        });
        self.ignored_senders = ignored_senders;
    }

    /// Returns true when dropping this batch could retain content that Matrix
    /// says is no longer visible. Callers must apply backpressure instead of
    /// using a best-effort queue send for these mutations.
    pub fn requires_reliable_delivery(&self) -> bool {
        !self.ignored_senders.is_empty()
            || self.mutations.iter().any(|mutation| {
                matches!(
                    mutation,
                    SearchMutation::Redact { .. } | SearchMutation::PurgeRoom { .. }
                )
            })
    }

    /// Drops decrypted message additions while retaining only removal metadata
    /// that is safe to hold outside the bounded plaintext queue.
    pub fn into_privacy_removals(mut self) -> (Self, bool) {
        let original_len = self.mutations.len();
        self.mutations.retain(|mutation| {
            matches!(
                mutation,
                SearchMutation::Redact { .. } | SearchMutation::PurgeRoom { .. }
            )
        });
        let dropped_additions = self.mutations.len() != original_len;
        (self, dropped_additions)
    }

    /// Builds plaintext-free reconciliation work from matrix-sdk-ui's current
    /// rendered message versions. The raw sync indexer remains responsible
    /// for bodies; this only resolves equal-order edit ambiguity.
    pub fn from_timeline_items<'a>(
        client: &Client,
        room_id: &str,
        items: impl IntoIterator<Item = &'a std::sync::Arc<TimelineItem>>,
    ) -> Option<Self> {
        let (account_store_key, device_id) = active_identity(client)?;
        let mutations = items
            .into_iter()
            .filter_map(|item| item.as_event())
            .filter(|item| item.content().as_message().is_some())
            .filter_map(|item| {
                let event_id = item.event_id()?.to_string();
                let version_event_id = item
                    .latest_edit_json()
                    .and_then(|raw| {
                        raw.get_field::<matrix_sdk::ruma::OwnedEventId>("event_id")
                            .ok()
                            .flatten()
                    })?
                    .to_string();
                Some(SearchMutation::SelectVersion {
                    room_id: room_id.to_string(),
                    event_id,
                    version_event_id,
                })
            })
            .collect();
        Some(Self {
            account_store_key,
            device_id,
            mutations,
            ignored_senders: HashSet::new(),
        })
    }
}

impl ActiveSearchIndex {
    fn matches(&self, account_store_key: &str, device_id: &str) -> bool {
        self.account_store_key == account_store_key && self.device_id == device_id
    }
}

fn feature_enabled(app: &AppHandle) -> bool {
    app.path().app_data_dir().is_ok_and(|directory| {
        crate::feature_flags::flag(
            &directory,
            crate::feature_flags::FeatureFlagKey::EncryptedLocalMessageSearch,
        )
    })
}

fn active_identity(client: &Client) -> Option<(String, String)> {
    let user_id = client.user_id()?;
    let device_id = client.device_id()?;
    Some((
        super::persistence::account_key(user_id.as_str()),
        device_id.to_string(),
    ))
}

async fn client_identity_is_current(
    state: &super::MatrixState,
    expected_identity: &(String, String),
) -> bool {
    state
        .client
        .lock()
        .await
        .as_ref()
        .and_then(active_identity)
        .as_ref()
        == Some(expected_identity)
}

async fn search_lifecycle_is_current(
    state: &super::MatrixState,
    expected_identity: &(String, String),
    generation: u64,
) -> bool {
    generation
        == state
            .search_generation
            .load(std::sync::atomic::Ordering::Acquire)
        && client_identity_is_current(state, expected_identity).await
}

/// Invalidates every detached/queued search task owned by the session being
/// replaced, resets lifecycle disclosure for the next session, and closes the
/// process-local index handle without deleting the account/device database.
///
/// Call only after `MatrixState::client` has been cleared. Advancing the
/// generation before taking the index lock makes an old worker fail its first
/// or lock-protected second generation check; if it already passed both, this
/// waits for that final apply to release the slot and then closes the handle.
/// The index lock is intentionally synchronous because all database work runs
/// on blocking threads; acquire it from `spawn_blocking` here so supersession
/// does not stall a Tokio worker while an index operation drains.
pub(crate) async fn invalidate_for_session_replacement(state: &super::MatrixState) {
    reset_index_lifecycle(state);
    let search_index = std::sync::Arc::clone(&state.search_index);
    if tokio::task::spawn_blocking(move || {
        search_index
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .take();
    })
    .await
    .is_err()
    {
        tracing::warn!(
            command = "message_search_supersession",
            status = "close_failed"
        );
    }
}

pub(crate) fn reset_index_lifecycle(state: &super::MatrixState) {
    let _lifecycle = state
        .search_lifecycle_lock
        .lock()
        .unwrap_or_else(|error| error.into_inner());
    state
        .search_generation
        .fetch_add(1, std::sync::atomic::Ordering::AcqRel);
    state
        .search_backfill_started
        .store(false, std::sync::atomic::Ordering::Release);
    state
        .search_backfill_pending
        .store(false, std::sync::atomic::Ordering::Release);
    state
        .search_incomplete
        .store(false, std::sync::atomic::Ordering::Release);
    state
        .search_pending_seed_rooms
        .lock()
        .unwrap_or_else(|error| error.into_inner())
        .clear();
}

/// Marks the active lifecycle incomplete without allowing an old worker to
/// poison the account that replaced it. Session invalidation advances the
/// generation while holding the same lifecycle lock, so the check and store
/// are atomic with respect to the replacement lifecycle's reset.
fn mark_incomplete_if_current(state: &super::MatrixState, generation: u64) -> bool {
    let _lifecycle = state
        .search_lifecycle_lock
        .lock()
        .unwrap_or_else(|error| error.into_inner());
    if generation
        != state
            .search_generation
            .load(std::sync::atomic::Ordering::Acquire)
    {
        return false;
    }
    state
        .search_incomplete
        .store(true, std::sync::atomic::Ordering::Release);
    true
}

/// Removes the encrypted search database for a client that has been
/// successfully superseded. Authentication flows call this only after their
/// rollback/cancellation window has closed and before publishing the
/// replacement client, so a failed login can still resume the previous index
/// while a committed replacement cannot orphan it indefinitely.
pub(crate) async fn delete_for_superseded_client(app: &AppHandle, client: Option<&Client>) {
    let Some((account_store_key, device_id)) = client.and_then(active_identity) else {
        return;
    };
    let Ok(app_data_dir) = app.path().app_data_dir() else {
        tracing::warn!(
            command = "message_search_supersession",
            status = "cleanup_failed"
        );
        return;
    };
    let deleted = tokio::task::spawn_blocking(move || {
        SearchIndex::delete_for_source(&app_data_dir, &account_store_key, &device_id)
    })
    .await;
    if !matches!(deleted, Ok(Ok(()))) {
        tracing::warn!(
            command = "message_search_supersession",
            status = "cleanup_failed"
        );
    }
}

fn ensure_index<'a>(
    app: &AppHandle,
    slot: &'a mut Option<ActiveSearchIndex>,
    account_store_key: &str,
    device_id: &str,
) -> Result<&'a mut SearchIndex, String> {
    if slot
        .as_ref()
        .is_some_and(|active| !active.matches(account_store_key, device_id))
    {
        if let Some(active) = slot.take() {
            active.index.delete()?;
        }
    }
    if slot.is_none() {
        let app_data_dir = app
            .path()
            .app_data_dir()
            .map_err(|_| "message search application data directory unavailable".to_string())?;
        let index = SearchIndex::open(&app_data_dir, account_store_key, device_id)?;
        *slot = Some(ActiveSearchIndex {
            account_store_key: account_store_key.to_owned(),
            device_id: device_id.to_owned(),
            index,
        });
    }
    Ok(&mut slot.as_mut().expect("search index initialized").index)
}

fn searchable_body(mut content: RoomMessageEventContent) -> Option<String> {
    let formatted = match &content.msgtype {
        MessageType::Text(message) => message.formatted.as_ref(),
        MessageType::Notice(message) => message.formatted.as_ref(),
        MessageType::Emote(message) => message.formatted.as_ref(),
        _ => return None,
    }
    .filter(|formatted| formatted.format == MessageFormat::Html)
    .map(|formatted| formatted.body.clone());
    content.sanitize(HtmlSanitizerMode::Compat, RemoveReplyFallback::Yes);
    let body = match content.msgtype {
        MessageType::Text(message) => message.body,
        MessageType::Notice(message) => message.body,
        MessageType::Emote(message) => message.body,
        _ => return None,
    };
    let body = match formatted {
        Some(formatted) => sanitized_html_text(&formatted)?,
        None => body,
    };
    (!body.trim().is_empty()).then_some(body)
}

/// Mirrors the renderer's `DOMParser(...).body.textContent` extraction after
/// Matrix sanitization, using Ruma's maintained parser and sanitizer rather
/// than a bespoke tag stripper. The explicit removal list mirrors DOMPurify's
/// content-dropping elements that are not in Charm's renderer allowlist;
/// Ruma otherwise unwraps unknown elements and would retain hidden script
/// text that the renderer discards.
fn sanitized_html_text(formatted: &str) -> Option<String> {
    fn append_text(node: &NodeRef, text: &mut String) {
        if let Some(value) = node.as_text() {
            text.push_str(&value.borrow());
        }
        for child in node.children() {
            append_text(&child, text);
        }
    }

    fn contains_spoiler(node: &NodeRef) -> bool {
        if let NodeData::Element(element) = node.data() {
            if element
                .attrs
                .borrow()
                .iter()
                .any(|attribute| attribute.name.local.as_bytes() == b"data-mx-spoiler")
            {
                return true;
            }
        }
        node.children().any(|child| contains_spoiler(&child))
    }

    let document = Html::parse(formatted);
    document.sanitize_with(
        &SanitizerConfig::compat()
            .remove_reply_fallback()
            .remove_elements([
                "annotation-xml",
                "audio",
                "colgroup",
                "desc",
                "foreignobject",
                "head",
                "iframe",
                "math",
                "mi",
                "mn",
                "mo",
                "ms",
                "mtext",
                "noembed",
                "noframes",
                "noscript",
                "plaintext",
                "script",
                "selectedcontent",
                "style",
                "svg",
                "template",
                "title",
                "video",
                "xmp",
            ]),
    );
    // The result DTO cannot preserve concealed ranges. Inspect the parsed,
    // sanitized element attributes so visible text or unrelated attribute
    // values that merely mention `data-mx-spoiler` remain searchable, while
    // an actual Matrix spoiler still fails closed for the complete event.
    if document.children().any(|child| contains_spoiler(&child)) {
        return None;
    }
    let mut text = String::new();
    for child in document.children() {
        append_text(&child, &mut text);
    }
    (!text.trim().is_empty()).then_some(text)
}

#[derive(Deserialize)]
struct RawReplacementContent {
    #[serde(rename = "m.new_content")]
    new_content: RawReplacementNewContent,
}

#[derive(Deserialize)]
struct RawReplacementNewContent {
    #[serde(rename = "m.relates_to")]
    relates_to: Option<RawReplyRelation>,
}

#[derive(Deserialize)]
struct RawReplyRelation {
    #[serde(rename = "m.in_reply_to")]
    in_reply_to: Option<RawInReplyTo>,
}

#[derive(Deserialize)]
struct RawInReplyTo {
    event_id: matrix_sdk::ruma::OwnedEventId,
}

fn replacement_reply_relation(
    raw_event: &Raw<AnySyncTimelineEvent>,
) -> Option<Relation<matrix_sdk::ruma::events::room::message::RoomMessageEventContentWithoutRelation>>
{
    let content = raw_event
        .get_field::<RawReplacementContent>("content")
        .ok()??;
    let event_id = content.new_content.relates_to?.in_reply_to?.event_id;
    Some(Relation::Reply(
        matrix_sdk::ruma::events::relation::Reply::with_event_id(event_id),
    ))
}

pub fn work_from_sync(
    client: &Client,
    response: &matrix_sdk::sync::SyncResponse,
    ignored_senders: HashSet<String>,
) -> Option<SearchWork> {
    let (account_store_key, device_id) = active_identity(client)?;
    let mut mutations = Vec::new();
    for room_id in response.rooms.left.keys() {
        mutations.push(SearchMutation::PurgeRoom {
            room_id: room_id.to_string(),
        });
    }
    for (room_id, update) in &response.rooms.joined {
        for raw_event in &update.timeline.events {
            append_raw_event_mutation(
                room_id.as_str(),
                raw_event.raw(),
                &ignored_senders,
                &mut mutations,
            );
        }
    }
    Some(SearchWork {
        account_store_key,
        device_id,
        mutations,
        // A sync response is one account-wide batch, so retain this set even
        // when it has no timeline mutations: an m.ignored_user_list-only sync
        // must still physically purge rows for newly ignored senders. The
        // room-sized cached-history constructor below intentionally differs.
        ignored_senders,
    })
}

/// Builds only privacy-removal mutations from a sync response. This path is
/// used when account-data reads fail, so one-shot redactions and departed-room
/// purges are still retained while message additions fail closed.
pub fn removal_work_from_sync(
    client: &Client,
    response: &matrix_sdk::sync::SyncResponse,
) -> Option<SearchWork> {
    let (account_store_key, device_id) = active_identity(client)?;
    let mut mutations = response
        .rooms
        .left
        .keys()
        .map(|room_id| SearchMutation::PurgeRoom {
            room_id: room_id.to_string(),
        })
        .collect::<Vec<_>>();
    for (room_id, update) in &response.rooms.joined {
        for raw_event in &update.timeline.events {
            let Ok(event) = raw_event.raw().deserialize() else {
                continue;
            };
            let AnySyncTimelineEvent::MessageLike(AnySyncMessageLikeEvent::RoomRedaction(
                redaction,
            )) = event
            else {
                continue;
            };
            let Some(original) = redaction.as_original() else {
                continue;
            };
            if let Some(redacted_event_id) = original
                .redacts
                .as_ref()
                .or(original.content.redacts.as_ref())
            {
                mutations.push(SearchMutation::Redact {
                    room_id: room_id.to_string(),
                    event_id: redacted_event_id.to_string(),
                });
            }
        }
    }
    Some(SearchWork {
        account_store_key,
        device_id,
        mutations,
        ignored_senders: HashSet::new(),
    })
}

/// Builds one room-sized backfill batch from matrix-sdk's already-decrypted
/// local event cache. It never paginates or performs Matrix protocol traffic.
pub fn work_from_cached_room(
    client: &Client,
    room_id: &str,
    events: &[TimelineEvent],
    ignored_senders: HashSet<String>,
) -> Option<SearchWork> {
    let (account_store_key, device_id) = active_identity(client)?;
    let mut mutations = Vec::new();
    for event in events {
        if matches!(&event.kind, TimelineEventKind::UnableToDecrypt { .. }) {
            continue;
        }
        append_raw_event_mutation(room_id, event.raw(), &ignored_senders, &mut mutations);
    }
    Some(SearchWork {
        account_store_key,
        device_id,
        mutations,
        // Used above to filter additions. Workers refresh the authoritative
        // ignore set at dequeue, so repeating it per cached room would turn
        // mutation-empty rooms into duplicate purge-only queue entries.
        ignored_senders: HashSet::new(),
    })
}

fn append_raw_event_mutation(
    room_id: &str,
    raw_event: &Raw<AnySyncTimelineEvent>,
    ignored_senders: &HashSet<String>,
    mutations: &mut Vec<SearchMutation>,
) {
    let Ok(event) = raw_event.deserialize() else {
        return;
    };
    match event {
        AnySyncTimelineEvent::MessageLike(AnySyncMessageLikeEvent::RoomMessage(
            SyncMessageLikeEvent::Original(original),
        )) => {
            if ignored_senders.contains(original.sender.as_str()) {
                return;
            }
            let timestamp: u64 = original.origin_server_ts.get().into();
            let (event_id, content) = match original.content.relates_to.clone() {
                Some(Relation::Replacement(replacement)) => {
                    let reply_relation = replacement_reply_relation(raw_event);
                    (
                        replacement.event_id.to_string(),
                        replacement.new_content.with_relation(reply_relation),
                    )
                }
                _ => (original.event_id.to_string(), original.content),
            };
            mutations.push(SearchMutation::Apply(SearchDocument {
                room_id: room_id.to_string(),
                event_id,
                version_event_id: original.event_id.to_string(),
                sender: original.sender.to_string(),
                body: searchable_body(content),
                origin_server_ts: timestamp,
                // Raw sync/cache history has no renderer-authoritative order
                // for equal-timestamp edits. Preserve the tie so
                // `restore_visible_row` can defer the original instead of
                // inventing an arrival-order tie-break.
                selection_order: timestamp,
            }));
        }
        AnySyncTimelineEvent::MessageLike(AnySyncMessageLikeEvent::RoomRedaction(redaction)) => {
            let Some(original) = redaction.as_original() else {
                return;
            };
            if let Some(redacted_event_id) = original
                .redacts
                .as_ref()
                .or(original.content.redacts.as_ref())
            {
                mutations.push(SearchMutation::Redact {
                    room_id: room_id.to_string(),
                    event_id: redacted_event_id.to_string(),
                });
            }
        }
        _ => {}
    }
}

fn apply_work(app: &AppHandle, generation: u64, work: SearchWork) -> Result<(), String> {
    let state = app.state::<super::MatrixState>();
    if generation
        != state
            .search_generation
            .load(std::sync::atomic::Ordering::Acquire)
    {
        return Ok(());
    }
    if !feature_enabled(app) {
        reset_index_lifecycle(&state);
        if let Some(active) = app
            .state::<super::MatrixState>()
            .search_index
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .take()
        {
            active.index.delete()?;
        }
        return Ok(());
    }
    let mut slot = state
        .search_index
        .lock()
        .unwrap_or_else(|error| error.into_inner());
    // Recheck while holding the same lock logout uses to take/delete the
    // index. This closes the check-then-lock race where cleanup could finish
    // between the first check and `ensure_index`, after which stale work
    // would otherwise recreate the signed-out account's database.
    if generation
        != state
            .search_generation
            .load(std::sync::atomic::Ordering::Acquire)
    {
        return Ok(());
    }
    if !feature_enabled(app) {
        reset_index_lifecycle(&state);
        if let Some(active) = slot.take() {
            active.index.delete()?;
        }
        return Ok(());
    }
    let index = ensure_index(app, &mut slot, &work.account_store_key, &work.device_id)?;
    work.apply_to(index)
}

/// Orders a successful leave purge behind already-queued sync mutations and
/// gives SQLCipher a bounded opportunity to physically remove the room.
pub(crate) async fn purge_room_after_leave(
    app: &AppHandle,
    client: &Client,
    room_id: &str,
    generation: u64,
) -> Result<(), String> {
    if !feature_enabled(app) {
        return Ok(());
    }
    let Some(work) = SearchWork::purge_room_for_client(client, room_id) else {
        return Ok(());
    };
    let state = app.state::<super::MatrixState>();
    let Some(expected_identity) = active_identity(client) else {
        return Ok(());
    };
    if !client_identity_is_current(&state, &expected_identity).await
        || generation
            != state
                .search_generation
                .load(std::sync::atomic::Ordering::Acquire)
    {
        return Ok(());
    }
    tokio::time::timeout(ROOM_LEAVE_PURGE_TIMEOUT, async {
        while state
            .search_pagination_seed_running
            .load(std::sync::atomic::Ordering::Acquire)
        {
            let notified = state.search_pagination_seed_done.notified();
            if !state
                .search_pagination_seed_running
                .load(std::sync::atomic::Ordering::Acquire)
            {
                break;
            }
            notified.await;
        }
        if !client_identity_is_current(&state, &expected_identity).await
            || generation
                != state
                    .search_generation
                    .load(std::sync::atomic::Ordering::Acquire)
        {
            return Ok(());
        }
        let (completion, completed) = tokio::sync::oneshot::channel();
        let sender = search_work_sender(app).await;
        if !client_identity_is_current(&state, &expected_identity).await
            || generation
                != state
                    .search_generation
                    .load(std::sync::atomic::Ordering::Acquire)
        {
            return Ok(());
        }
        sender
            .send(QueuedSearchWork {
                generation,
                work,
                completes_backfill: false,
                completion: Some(completion),
            })
            .await
            .map_err(|_| "message search purge worker unavailable".to_string())?;
        completed
            .await
            .map_err(|_| "message search purge worker unavailable".to_string())?
    })
    .await
    .map_err(|_| "message search purge timed out".to_string())?
}

/// Records a secondary search-purge failure after the homeserver has already
/// accepted a room leave. The authoritative leave must stay successful; joined
/// room filtering keeps the departed room out of queries while the incomplete
/// marker discloses that derived storage still needs reconciliation.
pub fn record_room_leave_purge_result(
    incomplete: &std::sync::atomic::AtomicBool,
    result: Result<(), String>,
    command: &'static str,
) {
    if result.is_err() {
        incomplete.store(true, std::sync::atomic::Ordering::Release);
        tracing::warn!(
            command,
            cleanup = "message_search_room_purge",
            status = "failed"
        );
    }
}

pub(crate) async fn submit_sync_response(
    app: &AppHandle,
    client: &Client,
    response: &matrix_sdk::sync::SyncResponse,
) {
    let state = app.state::<super::MatrixState>();
    if !feature_enabled(app) {
        reset_index_lifecycle(&state);
        let source = active_identity(client);
        let app_data_dir = app.path().app_data_dir().ok();
        let app = app.clone();
        let deleted = tauri::async_runtime::spawn_blocking(move || {
            let mut deleted = true;
            let active = app
                .state::<super::MatrixState>()
                .search_index
                .lock()
                .unwrap_or_else(|error| error.into_inner())
                .take();
            if let Some(active) = active {
                deleted &= active.index.delete().is_ok();
            }
            match (app_data_dir, source) {
                (Some(app_data_dir), Some((account_store_key, device_id))) => {
                    deleted &= SearchIndex::delete_for_source(
                        &app_data_dir,
                        &account_store_key,
                        &device_id,
                    )
                    .is_ok();
                }
                (None, Some(_)) => deleted = false,
                _ => {}
            }
            deleted
        })
        .await;
        if !matches!(deleted, Ok(true)) {
            tracing::warn!(
                command = "message_search_kill_switch",
                status = "cleanup_failed"
            );
        }
        return;
    }
    let Some(client_identity) = active_identity(client) else {
        return;
    };
    let generation = {
        let current = state.client.lock().await;
        let is_current_client = current
            .as_ref()
            .and_then(active_identity)
            .is_some_and(|identity| identity == client_identity);
        if !is_current_client {
            return;
        }
        state
            .search_generation
            .load(std::sync::atomic::Ordering::Acquire)
    };
    if state
        .search_backfill_started
        .compare_exchange(
            false,
            true,
            std::sync::atomic::Ordering::AcqRel,
            std::sync::atomic::Ordering::Acquire,
        )
        .is_ok()
    {
        // Publish the disclosure before detaching so a search racing this
        // spawn cannot briefly present the not-yet-seeded index as complete.
        state
            .search_backfill_pending
            .store(true, std::sync::atomic::Ordering::Release);
        let seed_app = app.clone();
        let seed_client = client.clone();
        tauri::async_runtime::spawn(async move {
            submit_cached_history(&seed_app, &seed_client, generation).await;
        });
    }
    let ignored_senders = super::account::ignored_user_ids(client).await;
    if !search_lifecycle_is_current(&state, &client_identity, generation).await {
        return;
    }
    let Ok(ignored_senders) = ignored_senders else {
        state
            .search_incomplete
            .store(true, std::sync::atomic::Ordering::Release);
        if let Some(work) = removal_work_from_sync(client, response) {
            enqueue_sync_work(app, &client_identity, generation, work).await;
        }
        return;
    };
    let ignored_senders = ignored_senders
        .into_iter()
        .map(|sender| sender.to_string())
        .collect();
    let Some(work) = work_from_sync(client, response, ignored_senders) else {
        return;
    };
    enqueue_sync_work(app, &client_identity, generation, work).await;
}

async fn enqueue_sync_work(
    app: &AppHandle,
    expected_identity: &(String, String),
    generation: u64,
    work: SearchWork,
) {
    if work.is_empty() {
        return;
    }
    let state = app.state::<super::MatrixState>();
    let sender = search_work_sender(app).await;
    // Keep account replacement from clearing the client between the final
    // lifecycle check and the non-blocking queue insertion. Invalidation only
    // starts after the client has been cleared under this same mutex.
    let current_client = state.client.lock().await;
    if current_client.as_ref().and_then(active_identity).as_ref() != Some(expected_identity) {
        return;
    }
    let requires_reliable_delivery = work.requires_reliable_delivery();
    let queued = QueuedSearchWork {
        generation,
        work,
        completes_backfill: false,
        completion: None,
    };
    let Some(send_result) = try_enqueue_current_generation(&state, generation, &sender, queued)
    else {
        return;
    };
    drop(current_client);
    let delivered = match send_result {
        Ok(()) => true,
        Err(tokio::sync::mpsc::error::TrySendError::Full(mut queued))
            if requires_reliable_delivery =>
        {
            let (privacy_work, dropped_additions) = queued.work.into_privacy_removals();
            queued.work = privacy_work;
            if dropped_additions {
                state
                    .search_incomplete
                    .store(true, std::sync::atomic::Ordering::Release);
                tracing::warn!(
                    command = "message_search_index",
                    status = "queue_full_dropped_additions"
                );
            }
            // Polling an owned reservation once establishes FIFO position
            // without waiting for capacity on the Matrix sync task. Only
            // removal metadata can leave the bounded plaintext queue here.
            enqueue_reliable_search_work(app, sender, queued).await
        }
        Err(_) => false,
    };
    if !delivered {
        state
            .search_incomplete
            .store(true, std::sync::atomic::Ordering::Release);
        tracing::warn!(command = "message_search_index", status = "queue_full");
    }
}

/// Queues the renderer's selected versions for one live timeline. This work
/// contains event IDs only; decrypted bodies continue to enter through sync
/// and cached-history ingestion.
pub(crate) async fn submit_timeline_reconciliation(
    app: &AppHandle,
    client: &Client,
    room_id: &str,
    items: &imbl::Vector<std::sync::Arc<TimelineItem>>,
) {
    if !feature_enabled(app) {
        return;
    }
    let Some(expected_identity) = active_identity(client) else {
        return;
    };
    let generation = app
        .state::<super::MatrixState>()
        .search_generation
        .load(std::sync::atomic::Ordering::Acquire);
    let Some(work) = SearchWork::from_timeline_items(client, room_id, items.iter()) else {
        return;
    };
    enqueue_sync_work(app, &expected_identity, generation, work).await;
}

#[allow(clippy::result_large_err)]
fn try_enqueue_current_generation(
    state: &super::MatrixState,
    generation: u64,
    sender: &tokio::sync::mpsc::Sender<QueuedSearchWork>,
    queued: QueuedSearchWork,
) -> Option<Result<(), tokio::sync::mpsc::error::TrySendError<QueuedSearchWork>>> {
    (generation
        == state
            .search_generation
            .load(std::sync::atomic::Ordering::Acquire))
    .then(|| sender.try_send(queued))
}

async fn enqueue_reliable_search_work(
    app: &AppHandle,
    sender: tokio::sync::mpsc::Sender<QueuedSearchWork>,
    queued: QueuedSearchWork,
) -> bool {
    let mut reservation = Box::pin(sender.reserve_owned());
    let immediate = std::future::poll_fn(|context| {
        Poll::Ready(match reservation.as_mut().poll(context) {
            Poll::Ready(result) => Some(result),
            Poll::Pending => None,
        })
    })
    .await;
    match immediate {
        Some(Ok(permit)) => {
            permit.send(queued);
            true
        }
        Some(Err(_)) => false,
        None => {
            let app = app.clone();
            tauri::async_runtime::spawn(async move {
                match reservation.await {
                    Ok(permit) => {
                        permit.send(queued);
                    }
                    Err(_) => {
                        app.state::<super::MatrixState>()
                            .search_incomplete
                            .store(true, std::sync::atomic::Ordering::Release);
                        tracing::warn!(
                            command = "message_search_index",
                            status = "worker_unavailable"
                        );
                    }
                }
            });
            true
        }
    }
}

async fn search_work_sender(app: &AppHandle) -> tokio::sync::mpsc::Sender<QueuedSearchWork> {
    app.state::<super::MatrixState>()
        .search_work_tx
        .get_or_init(|| async {
            let (sender, mut receiver) = tokio::sync::mpsc::channel::<QueuedSearchWork>(32);
            let worker_app = app.clone();
            tauri::async_runtime::spawn(async move {
                while let Some(queued) = receiver.recv().await {
                    let QueuedSearchWork {
                        generation,
                        mut work,
                        completes_backfill,
                        completion,
                    } = queued;
                    let state = worker_app.state::<super::MatrixState>();
                    let current_visibility = match state
                        .require_client_with_search_generation()
                        .await
                    {
                        Ok((client, current_generation)) if current_generation == generation => {
                            let joined_room_ids = client
                                .joined_rooms()
                                .into_iter()
                                .map(|room| room.room_id().to_string())
                                .collect();
                            super::account::ignored_user_ids(&client).await.ok().map(
                                |ignored_senders| {
                                    let ignored_senders = ignored_senders
                                        .into_iter()
                                        .map(|sender| sender.to_string())
                                        .collect();
                                    (joined_room_ids, ignored_senders)
                                },
                            )
                        }
                        _ => None,
                    };
                    let visibility_complete = if let Some((joined_room_ids, ignored_senders)) =
                        current_visibility
                    {
                        work.retain_currently_visible_additions(&joined_room_ids, ignored_senders);
                        true
                    } else {
                        // Fail closed for plaintext additions while preserving
                        // redactions, room purges, and already-known ignore
                        // cleanup from the queued batch.
                        work.retain_joined_room_additions(&HashSet::new());
                        false
                    };
                    let app = worker_app.clone();
                    let result = match tauri::async_runtime::spawn_blocking(move || {
                        apply_work(&app, generation, work)
                    })
                    .await
                    {
                        Ok(result) => result,
                        Err(_) => Err("message search worker failed".to_string()),
                    };
                    let applied = visibility_complete && result.is_ok();
                    let state = worker_app.state::<super::MatrixState>();
                    if !applied && mark_incomplete_if_current(&state, generation) {
                        tracing::warn!(command = "message_search_index", status = "worker_failed");
                    }
                    if completes_backfill
                        && generation
                            == state
                                .search_generation
                                .load(std::sync::atomic::Ordering::Acquire)
                    {
                        state
                            .search_backfill_pending
                            .store(false, std::sync::atomic::Ordering::Release);
                    }
                    if let Some(completion) = completion {
                        let _ = completion.send(result);
                    }
                }
            });
            sender
        })
        .await
        .clone()
}

/// Seeds the index with history already present in matrix-sdk's decrypted
/// event cache. Queue overflow marks the index incomplete instead of delaying
/// initial sync/timeline delivery behind local indexing work.
pub(crate) async fn submit_cached_history(app: &AppHandle, client: &Client, generation: u64) {
    let state = app.state::<super::MatrixState>();
    state
        .search_backfill_pending
        .store(true, std::sync::atomic::Ordering::Release);
    if !feature_enabled(app) {
        state
            .search_backfill_pending
            .store(false, std::sync::atomic::Ordering::Release);
        return;
    }
    let Some((account_store_key, device_id)) = active_identity(client) else {
        state
            .search_backfill_pending
            .store(false, std::sync::atomic::Ordering::Release);
        return;
    };
    let expected_identity = (account_store_key.clone(), device_id.clone());
    let ignored_senders = super::account::ignored_user_ids(client).await;
    if !search_lifecycle_is_current(&state, &expected_identity, generation).await {
        return;
    }
    let Ok(ignored_senders) = ignored_senders else {
        state
            .search_incomplete
            .store(true, std::sync::atomic::Ordering::Release);
        state
            .search_backfill_pending
            .store(false, std::sync::atomic::Ordering::Release);
        return;
    };
    let ignored_senders: HashSet<String> = ignored_senders
        .into_iter()
        .map(|sender| sender.to_string())
        .collect();
    let sender = search_work_sender(app).await;
    if !search_lifecycle_is_current(&state, &expected_identity, generation).await {
        return;
    }
    for room in client.joined_rooms() {
        let events = match room.event_cache().await {
            Ok((cache, _drop_handles)) => cache.events().await,
            Err(_) => {
                if !search_lifecycle_is_current(&state, &expected_identity, generation).await {
                    return;
                }
                state
                    .search_incomplete
                    .store(true, std::sync::atomic::Ordering::Release);
                continue;
            }
        };
        let Ok(events) = events else {
            if !search_lifecycle_is_current(&state, &expected_identity, generation).await {
                return;
            }
            state
                .search_incomplete
                .store(true, std::sync::atomic::Ordering::Release);
            continue;
        };
        if !search_lifecycle_is_current(&state, &expected_identity, generation).await {
            return;
        }
        let Some(work) = work_from_cached_room(
            client,
            room.room_id().as_str(),
            &events,
            ignored_senders.clone(),
        ) else {
            state
                .search_incomplete
                .store(true, std::sync::atomic::Ordering::Release);
            break;
        };
        if work.is_empty() {
            continue;
        }
        if room.state() != matrix_sdk::RoomState::Joined {
            continue;
        }
        // Event-cache reads and mutation construction retain decrypted bodies
        // in this stack frame. Recheck at the final enqueue boundary so a
        // logout/account switch drops them immediately rather than buffering
        // stale-generation plaintext for the worker to discard later.
        if !search_lifecycle_is_current(&state, &expected_identity, generation).await {
            return;
        }
        // The trusted remote kill switch can change while the event-cache or
        // ignore-list awaits above are in flight. Do not let newly extracted
        // decrypted bodies cross into the bounded worker queue after it has
        // flipped off; the worker independently drops any older queued work.
        if !feature_enabled(app) {
            state
                .search_backfill_pending
                .store(false, std::sync::atomic::Ordering::Release);
            return;
        }
        if sender
            .try_send(QueuedSearchWork {
                generation,
                work,
                completes_backfill: false,
                completion: None,
            })
            .is_err()
        {
            state
                .search_incomplete
                .store(true, std::sync::atomic::Ordering::Release);
            state
                .search_backfill_pending
                .store(false, std::sync::atomic::Ordering::Release);
            tracing::warn!(command = "message_search_backfill", status = "queue_full");
            return;
        }
    }
    let completion = SearchWork {
        account_store_key,
        device_id,
        mutations: Vec::new(),
        ignored_senders: HashSet::new(),
    };
    if !search_lifecycle_is_current(&state, &expected_identity, generation).await {
        return;
    }
    if !feature_enabled(app) {
        state
            .search_backfill_pending
            .store(false, std::sync::atomic::Ordering::Release);
        return;
    }
    if sender
        .try_send(QueuedSearchWork {
            generation,
            work: completion,
            completes_backfill: true,
            completion: None,
        })
        .is_err()
    {
        state
            .search_incomplete
            .store(true, std::sync::atomic::Ordering::Release);
        state
            .search_backfill_pending
            .store(false, std::sync::atomic::Ordering::Release);
    }
}

/// Adds metadata-only cached-room work to a single-worker queue. Insertion and
/// worker ownership change under the same mutex, closing the empty-queue
/// handoff race without retaining decrypted message bodies.
pub fn enqueue_cached_room_seed<K: Eq + std::hash::Hash>(
    pending: &std::sync::Mutex<HashSet<K>>,
    running: &std::sync::atomic::AtomicBool,
    request: K,
) -> bool {
    let mut pending = pending.lock().unwrap_or_else(|error| error.into_inner());
    pending.insert(request);
    running
        .compare_exchange(
            false,
            true,
            std::sync::atomic::Ordering::AcqRel,
            std::sync::atomic::Ordering::Acquire,
        )
        .is_ok()
}

/// Takes one queued request, or atomically releases worker ownership while the
/// queue mutex is still held when no follow-up remains.
pub fn take_cached_room_seed<K: Clone + Eq + std::hash::Hash>(
    pending: &std::sync::Mutex<HashSet<K>>,
    running: &std::sync::atomic::AtomicBool,
) -> Option<K> {
    let mut pending = pending.lock().unwrap_or_else(|error| error.into_inner());
    let next = pending.iter().next().cloned();
    if let Some(next) = &next {
        pending.remove(next);
    } else {
        running.store(false, std::sync::atomic::Ordering::Release);
    }
    next
}

/// Re-seeds one room after timeline pagination decrypts more local history.
/// The detached task and bounded `try_send` keep the user-visible timeline
/// response independent from event-cache and SQLCipher work.
pub(crate) fn schedule_cached_room(
    app: AppHandle,
    client: Client,
    room_id: matrix_sdk::ruma::OwnedRoomId,
    generation: u64,
) {
    if !feature_enabled(&app) || active_identity(&client).is_none() {
        return;
    }
    let state = app.state::<super::MatrixState>();
    let should_spawn = enqueue_cached_room_seed(
        &state.search_pending_seed_rooms,
        &state.search_pagination_seed_running,
        (generation, room_id),
    );
    if !should_spawn {
        return;
    }

    tauri::async_runtime::spawn(async move {
        loop {
            let state = app.state::<super::MatrixState>();
            let request = take_cached_room_seed(
                &state.search_pending_seed_rooms,
                &state.search_pagination_seed_running,
            );
            let Some((generation, room_id)) = request else {
                break;
            };
            process_cached_room_seed(&app, generation, room_id).await;
        }
        app.state::<super::MatrixState>()
            .search_pagination_seed_done
            .notify_waiters();
    });
}

async fn process_cached_room_seed(
    app: &AppHandle,
    generation: u64,
    room_id: matrix_sdk::ruma::OwnedRoomId,
) {
    let state = app.state::<super::MatrixState>();
    let Ok((client, current_generation)) = state.require_client_with_search_generation().await
    else {
        return;
    };
    if current_generation != generation {
        return;
    }
    let Some(expected_identity) = active_identity(&client) else {
        return;
    };
    let Some(room) = client.get_room(&room_id) else {
        return;
    };
    if room.state() != matrix_sdk::RoomState::Joined {
        return;
    }
    let Ok(ignored_senders) = super::account::ignored_user_ids(&client).await else {
        if search_lifecycle_is_current(&state, &expected_identity, generation).await {
            state
                .search_incomplete
                .store(true, std::sync::atomic::Ordering::Release);
        }
        return;
    };
    let ignored_senders = ignored_senders
        .into_iter()
        .map(|sender| sender.to_string())
        .collect();
    let events = match room.event_cache().await {
        Ok((cache, _drop_handles)) => cache.events().await,
        Err(_) => {
            if search_lifecycle_is_current(&state, &expected_identity, generation).await {
                state
                    .search_incomplete
                    .store(true, std::sync::atomic::Ordering::Release);
            }
            return;
        }
    };
    let Ok(events) = events else {
        if search_lifecycle_is_current(&state, &expected_identity, generation).await {
            state
                .search_incomplete
                .store(true, std::sync::atomic::Ordering::Release);
        }
        return;
    };
    let Some(work) = work_from_cached_room(&client, room_id.as_str(), &events, ignored_senders)
    else {
        return;
    };
    if work.is_empty() {
        return;
    }
    let sender = search_work_sender(app).await;
    // Every await above may overlap logout, account replacement, or leave.
    // Only the current lifecycle can retain this decrypted batch in the FIFO.
    if !search_lifecycle_is_current(&state, &expected_identity, generation).await
        || !feature_enabled(app)
        || room.state() != matrix_sdk::RoomState::Joined
    {
        return;
    }
    if sender
        .try_send(QueuedSearchWork {
            generation,
            work,
            completes_backfill: false,
            completion: None,
        })
        .is_err()
    {
        state
            .search_incomplete
            .store(true, std::sync::atomic::Ordering::Release);
        tracing::warn!(command = "message_search_pagination", status = "queue_full");
    }
}

#[tauri::command]
pub async fn search_messages(
    app: AppHandle,
    state: State<'_, super::MatrixState>,
    query: String,
    room_id: Option<String>,
    limit: usize,
    cursor: Option<String>,
) -> Result<SearchResultPage, SearchCommandError> {
    if !feature_enabled(&app) {
        delete_disabled_active_index(&app, &state).await;
        return Err(SearchCommandError::unavailable());
    }
    validate_query(&query)?;
    let (client, generation) = state
        .require_client_with_search_generation()
        .await
        .map_err(|_| SearchCommandError::unavailable())?;
    let (account_store_key, device_id) =
        active_identity(&client).ok_or_else(SearchCommandError::unavailable)?;
    let expected_identity = (account_store_key.clone(), device_id.clone());
    if state
        .search_backfill_started
        .compare_exchange(
            false,
            true,
            std::sync::atomic::Ordering::AcqRel,
            std::sync::atomic::Ordering::Acquire,
        )
        .is_ok()
    {
        // Publish the disclosure before detaching so the first request can
        // return promptly while still reporting that cached-history coverage
        // is incomplete until the worker's FIFO completion marker drains.
        state
            .search_backfill_pending
            .store(true, std::sync::atomic::Ordering::Release);
        let seed_app = app.clone();
        let seed_client = client.clone();
        tauri::async_runtime::spawn(async move {
            submit_cached_history(&seed_app, &seed_client, generation).await;
        });
    }
    let ignored_senders: HashSet<String> = super::account::ignored_user_ids(&client)
        .await
        .map_err(|_| SearchCommandError::unavailable())?
        .into_iter()
        .map(|user_id| user_id.to_string())
        .collect();
    let allowed_rooms: HashSet<String> = client
        .joined_rooms()
        .into_iter()
        .map(|room| room.room_id().to_string())
        .collect();
    if room_id
        .as_ref()
        .is_some_and(|room_id| !allowed_rooms.contains(room_id))
    {
        return Err(SearchCommandError::unavailable());
    }

    let blocking_app = app.clone();
    let mut page = tauri::async_runtime::spawn_blocking(move || {
        let app = blocking_app;
        let state = app.state::<super::MatrixState>();
        let mut slot = state
            .search_index
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        // Logout/account switch increments the generation before taking this
        // same mutex to delete the index. Recheck while holding it so a stale
        // query cannot run after cleanup and recreate the signed-out
        // account's database via `ensure_index`.
        if generation
            != state
                .search_generation
                .load(std::sync::atomic::Ordering::Acquire)
        {
            return Err(SearchCommandError::unavailable());
        }
        // The initial guard precedes cache seeding and account-data reads.
        // Re-evaluate the trusted kill switch under the index lock so a flag
        // change during those awaits cannot reopen or query the local index.
        if !feature_enabled(&app) {
            reset_index_lifecycle(&state);
            if let Some(active) = slot.take() {
                active
                    .index
                    .delete()
                    .map_err(|_| SearchCommandError::unavailable())?;
            }
            return Err(SearchCommandError::unavailable());
        }
        let index = ensure_index(&app, &mut slot, &account_store_key, &device_id)
            .map_err(|_| SearchCommandError::unavailable())?;
        index
            .purge_ignored_senders(&ignored_senders)
            .map_err(|_| SearchCommandError::unavailable())?;
        let mut page = index.search(
            &query,
            room_id.as_deref(),
            &allowed_rooms,
            limit,
            cursor.as_deref(),
        )?;
        if !feature_enabled(&app) {
            reset_index_lifecycle(&state);
            if let Some(active) = slot.take() {
                active
                    .index
                    .delete()
                    .map_err(|_| SearchCommandError::unavailable())?;
            }
            return Err(SearchCommandError::unavailable());
        }
        page.incomplete = state
            .search_incomplete
            .load(std::sync::atomic::Ordering::Acquire)
            || state
                .search_backfill_pending
                .load(std::sync::atomic::Ordering::Acquire);
        Ok(page)
    })
    .await
    .map_err(|_| SearchCommandError::unavailable())??;
    let current_client = state
        .require_client()
        .await
        .map_err(|_| SearchCommandError::unavailable())?;
    if !feature_enabled(&app) {
        return Err(SearchCommandError::unavailable());
    }
    if active_identity(&current_client).as_ref() != Some(&expected_identity) {
        return Err(SearchCommandError::unavailable());
    }
    let current_allowed_rooms: HashSet<String> = current_client
        .joined_rooms()
        .into_iter()
        .map(|room| room.room_id().to_string())
        .collect();
    let current_ignored_senders: HashSet<String> =
        super::account::ignored_user_ids(&current_client)
            .await
            .map_err(|_| SearchCommandError::unavailable())?
            .into_iter()
            .map(|user_id| user_id.to_string())
            .collect();
    if !feature_enabled(&app)
        || !search_lifecycle_is_current(&state, &expected_identity, generation).await
    {
        return Err(SearchCommandError::unavailable());
    }
    page.retain_current_visibility(&current_allowed_rooms, &current_ignored_senders);
    Ok(page)
}

async fn delete_disabled_active_index(app: &AppHandle, state: &super::MatrixState) {
    // Invalidate queued plaintext and force a fresh cache seed before taking
    // the derived index. Cleanup can fail after the live handle is removed;
    // that must not leave a later re-enable believing backfill is complete.
    reset_index_lifecycle(state);
    let source = state.client.lock().await.as_ref().and_then(active_identity);
    let app_data_dir = app.path().app_data_dir().ok();
    let search_index = std::sync::Arc::clone(&state.search_index);
    let deleted = tokio::task::spawn_blocking(move || {
        let active = search_index
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .take();
        if let Some(active) = active {
            active.index.delete()?;
        }
        match (app_data_dir, source) {
            (Some(app_data_dir), Some((account_store_key, device_id))) => {
                SearchIndex::delete_for_source(&app_data_dir, &account_store_key, &device_id)
            }
            (None, Some(_)) => Err("message search application data directory unavailable".into()),
            _ => Ok(()),
        }
    })
    .await;
    if !matches!(deleted, Ok(Ok(()))) {
        tracing::warn!(
            command = "message_search_kill_switch",
            status = "cleanup_failed"
        );
    }
}

fn restore_visible_row(
    transaction: &Transaction<'_>,
    room_id: &str,
    original_event_id: &str,
) -> Result<(), String> {
    delete_visible_row(transaction, room_id, original_event_id)?;
    let selected_version = transaction
        .query_row(
            "SELECT version_event_id FROM selected_versions
             WHERE room_id = ?1 AND original_event_id = ?2",
            params![room_id, original_event_id],
            |row| row.get::<_, String>(0),
        )
        .optional()
        .map_err(safe_storage_error)?;
    let selected_version = if let Some(selected_version) = selected_version {
        let selected_order = transaction
            .query_row(
                "SELECT selection_order FROM message_versions
                 WHERE room_id = ?1 AND original_event_id = ?2 AND version_event_id = ?3",
                params![room_id, original_event_id, &selected_version],
                |row| row.get::<_, i64>(0),
            )
            .optional()
            .map_err(safe_storage_error)?;
        let latest_order = transaction
            .query_row(
                "SELECT MAX(selection_order) FROM message_versions
                 WHERE room_id = ?1 AND original_event_id = ?2",
                params![room_id, original_event_id],
                |row| row.get::<_, Option<i64>>(0),
            )
            .map_err(safe_storage_error)?;
        if selected_order.is_none() {
            // Timeline reconciliation can beat detached cached-history
            // ingestion. Preserve the pending selection, but do not let its
            // missing provenance hide the currently visible version.
            None
        } else if selected_order == latest_order {
            Some(selected_version)
        } else {
            // Renderer selections resolve only same-order ambiguity. A later
            // edit remains authoritative even while this room has no open
            // timeline listener.
            transaction
                .execute(
                    "DELETE FROM selected_versions
                     WHERE room_id = ?1 AND original_event_id = ?2",
                    params![room_id, original_event_id],
                )
                .map_err(safe_storage_error)?;
            None
        }
    } else {
        None
    };
    let previous = transaction
        .query_row(
            "SELECT version_event_id, sender, body, origin_server_ts, selection_order
             FROM message_versions
             WHERE room_id = ?1 AND original_event_id = ?2
               AND (?3 IS NULL OR version_event_id = ?3)
             ORDER BY selection_order DESC,
                      (version_event_id != original_event_id) DESC
             LIMIT 1",
            params![room_id, original_event_id, selected_version],
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, Option<String>>(2)?,
                    row.get::<_, i64>(3)?,
                    row.get::<_, i64>(4)?,
                ))
            },
        )
        .optional()
        .map_err(safe_storage_error)?;
    let Some((version_event_id, sender, body, origin_server_ts, selection_order)) = previous else {
        return Ok(());
    };
    if selected_version.is_none() && version_event_id != original_event_id {
        let tied_edits = transaction
            .query_row(
                "SELECT COUNT(*) FROM message_versions
                 WHERE room_id = ?1 AND original_event_id = ?2
                   AND version_event_id != original_event_id
                   AND selection_order = ?3",
                params![room_id, original_event_id, selection_order],
                |row| row.get::<_, i64>(0),
            )
            .map_err(safe_storage_error)?;
        if tied_edits > 1 {
            // Raw history cannot tell which equal-timestamp replacement the
            // renderer selected. Keep provenance, but expose no searchable
            // row until a later redaction/reconciliation makes the choice
            // authoritative.
            return Ok(());
        }
    }
    if let Some(body) = body {
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
        transaction
            .execute(
                "INSERT INTO searchable_messages_fts (
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
            "DELETE FROM searchable_messages_fts WHERE room_id = ?1 AND event_id = ?2",
            params![room_id, event_id],
        )
        .map_err(safe_storage_error)?;
    transaction
        .execute(
            "DELETE FROM searchable_messages WHERE room_id = ?1 AND event_id = ?2",
            params![room_id, event_id],
        )
        .map_err(safe_storage_error)?;
    Ok(())
}

fn configure(connection: &Connection) -> Result<(), MigrationError> {
    connection
        .execute_batch(
            "PRAGMA cipher_memory_security = ON;
             PRAGMA temp_store = MEMORY;
             PRAGMA foreign_keys = ON;
             PRAGMA secure_delete = ON;
             PRAGMA journal_mode = WAL;",
        )
        .map_err(MigrationError::from_sqlite)
}

fn open_encrypted_connection(
    database_path: &Path,
    account_store_key: &str,
    device_id: &str,
    store_passphrase: &str,
) -> Result<Connection, MigrationError> {
    let connection = Connection::open_with_flags(
        database_path,
        OpenFlags::default() | OpenFlags::SQLITE_OPEN_NOFOLLOW,
    )
    .map_err(MigrationError::from_sqlite)?;
    apply_encryption_key(&connection, account_store_key, device_id, store_passphrase)?;
    configure(&connection)?;
    Ok(connection)
}

fn apply_encryption_key(
    connection: &Connection,
    account_store_key: &str,
    device_id: &str,
    store_passphrase: &str,
) -> Result<(), MigrationError> {
    let derived_key = derive_search_key(account_store_key, device_id, store_passphrase)
        .map_err(MigrationError::Storage)?;
    let key_literal = Zeroizing::new(sqlcipher_raw_key_literal(derived_key.as_ref()));
    connection
        .pragma_update(None, "key", key_literal.as_str())
        .map_err(MigrationError::from_sqlite)?;

    let cipher_version = connection
        .query_row("PRAGMA cipher_version", [], |row| row.get::<_, String>(0))
        .map_err(MigrationError::from_sqlite)?;
    if cipher_version.is_empty() {
        return Err(MigrationError::Storage(
            "message search encryption unavailable".to_string(),
        ));
    }
    connection
        .query_row("SELECT count(*) FROM sqlite_master", [], |row| {
            row.get::<_, i64>(0)
        })
        .map_err(MigrationError::from_sqlite)?;
    let integrity = connection
        .query_row("PRAGMA integrity_check", [], |row| row.get::<_, String>(0))
        .map_err(MigrationError::from_sqlite)?;
    if integrity != "ok" {
        return Err(MigrationError::IncompatibleSchema);
    }
    Ok(())
}

fn rebuild_encrypted_connection(
    directory: &Path,
    database_path: &Path,
    account_store_key: &str,
    device_id: &str,
    store_passphrase: &str,
    category: &str,
) -> Result<Connection, String> {
    let incident_id = random_id();
    tracing::warn!(
        command = "message_search_migration",
        category,
        %incident_id,
        status = "rebuilding"
    );
    delete_database_path(database_path)?;
    create_private_directory(directory)?;
    let connection = open_encrypted_connection(
        database_path,
        account_store_key,
        device_id,
        store_passphrase,
    )
    .map_err(MigrationError::into_message)?;
    migrate(&connection).map_err(MigrationError::into_message)?;
    Ok(connection)
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
                     UPDATE message_versions SET selection_order = origin_server_ts;",
                )
                .map_err(MigrationError::from_sqlite)?;
            create_current_schema(&transaction)?;
            rebuild_visible_rows(&transaction)?;
            transaction
                .execute(
                    "UPDATE search_metadata SET schema_version = ?1",
                    [SCHEMA_VERSION],
                )
                .map_err(MigrationError::from_sqlite)?;
        }
        (1, Some(2..=4)) => {
            create_current_schema(&transaction)?;
            transaction
                .execute(
                    "UPDATE message_versions SET selection_order = origin_server_ts",
                    [],
                )
                .map_err(MigrationError::from_sqlite)?;
            rebuild_visible_rows(&transaction)?;
            transaction
                .execute(
                    "UPDATE search_metadata SET schema_version = ?1",
                    [SCHEMA_VERSION],
                )
                .map_err(MigrationError::from_sqlite)?;
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
             CREATE TABLE IF NOT EXISTS selected_versions (
                room_id TEXT NOT NULL,
                original_event_id TEXT NOT NULL,
                version_event_id TEXT NOT NULL,
                PRIMARY KEY(room_id, original_event_id)
             );
             CREATE TABLE IF NOT EXISTS searchable_messages (
                body TEXT NOT NULL,
                room_id TEXT NOT NULL,
                event_id TEXT NOT NULL,
                version_event_id TEXT NOT NULL,
                sender TEXT NOT NULL,
                origin_server_ts INTEGER NOT NULL,
                PRIMARY KEY(room_id, event_id)
             );
             CREATE VIRTUAL TABLE IF NOT EXISTS searchable_messages_fts USING fts5(
                body,
                room_id UNINDEXED,
                event_id UNINDEXED,
                version_event_id UNINDEXED,
                sender UNINDEXED,
                origin_server_ts UNINDEXED,
                tokenize = 'trigram'
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
            "SELECT room_id, original_event_id, version_event_id
             FROM selected_versions LIMIT 0",
        )
        .map_err(MigrationError::from_sqlite)?;
    transaction
        .prepare(
            "SELECT body, room_id, event_id, version_event_id, sender, origin_server_ts
             FROM searchable_messages LIMIT 0",
        )
        .map_err(MigrationError::from_sqlite)?;
    transaction
        .prepare(
            "SELECT body, room_id, event_id, version_event_id, sender, origin_server_ts
             FROM searchable_messages_fts LIMIT 0",
        )
        .map_err(MigrationError::from_sqlite)?;
    Ok(())
}

fn rebuild_visible_rows(transaction: &Transaction<'_>) -> Result<(), MigrationError> {
    transaction
        .execute_batch(
            "DELETE FROM searchable_messages;
             INSERT INTO searchable_messages (
                body, room_id, event_id, version_event_id, sender, origin_server_ts
             )
             SELECT selected.body, selected.room_id, selected.original_event_id,
                    selected.version_event_id, selected.sender, selected.origin_server_ts
             FROM message_versions AS selected
             WHERE selected.body IS NOT NULL
               AND selected.version_event_id = (
                    SELECT candidate.version_event_id
                    FROM message_versions AS candidate
                    WHERE candidate.room_id = selected.room_id
                      AND candidate.original_event_id = selected.original_event_id
                    ORDER BY candidate.selection_order DESC,
                             (candidate.version_event_id != candidate.original_event_id) DESC
                    LIMIT 1
               )
               AND (
                    selected.version_event_id = selected.original_event_id
                    OR 1 = (
                        SELECT COUNT(*)
                        FROM message_versions AS tied
                        WHERE tied.room_id = selected.room_id
                          AND tied.original_event_id = selected.original_event_id
                          AND tied.version_event_id != tied.original_event_id
                          AND tied.selection_order = selected.selection_order
                    )
               );
             DELETE FROM searchable_messages_fts;
             INSERT INTO searchable_messages_fts (
                body, room_id, event_id, version_event_id, sender, origin_server_ts
             )
             SELECT body, room_id, event_id, version_event_id, sender, origin_server_ts
             FROM searchable_messages;",
        )
        .map_err(MigrationError::from_sqlite)
}

fn compact(connection: &Connection) -> Result<(), String> {
    connection
        .execute_batch("VACUUM; PRAGMA wal_checkpoint(TRUNCATE);")
        .map_err(safe_storage_error)
}

fn timestamp_to_i64(timestamp: u64) -> i64 {
    i64::try_from(timestamp).unwrap_or(i64::MAX)
}

fn validate_query(query: &str) -> Result<String, SearchCommandError> {
    let query = query.trim();
    if query.is_empty() {
        return Err(SearchCommandError::invalid_query(
            "message search query cannot be empty",
        ));
    }
    if query.len() > MAX_QUERY_BYTES {
        return Err(SearchCommandError::invalid_query(
            "message search query is too long",
        ));
    }
    Ok(query.to_owned())
}

fn escape_like(value: &str) -> String {
    value
        .replace('\\', "\\\\")
        .replace('%', "\\%")
        .replace('_', "\\_")
}

fn random_id() -> String {
    rand::rng()
        .sample_iter(Alphanumeric)
        .take(24)
        .map(char::from)
        .collect()
}

fn snapshot_query_digest(key: &[u8; 32], query: &str) -> [u8; 32] {
    let hkdf = Hkdf::<HkdfSha256>::new(Some(key), query.as_bytes());
    let mut digest = [0_u8; 32];
    hkdf.expand(SNAPSHOT_QUERY_DIGEST_INFO, &mut digest)
        .expect("fixed-size SHA-256 snapshot digest");
    digest
}

fn parse_cursor(cursor: &str, incarnation: &str) -> Result<(String, usize), SearchCommandError> {
    let mut parts = cursor.split(':');
    let snapshot_id = parts.next().filter(|part| !part.is_empty());
    let offset = parts.next().and_then(|part| part.parse::<usize>().ok());
    let cursor_incarnation = parts.next();
    if parts.next().is_some() || cursor_incarnation != Some(incarnation) {
        return Err(SearchCommandError::stale_cursor());
    }
    match (snapshot_id, offset) {
        (Some(snapshot_id), Some(offset)) => Ok((snapshot_id.to_owned(), offset)),
        _ => Err(SearchCommandError::stale_cursor()),
    }
}

fn snippet_and_ranges(body: &str, query: &str) -> (String, Vec<SearchMatchRange>) {
    const CONTEXT_CHARS: usize = 100;
    let body_chars: Vec<(usize, char)> = body.char_indices().collect();
    let query_char_count = query.chars().count();
    let folded_query = query.to_lowercase();
    let match_at = (0..body_chars.len()).find(|start| {
        let end = start.saturating_add(query_char_count);
        if end > body_chars.len() {
            return false;
        }
        let start_byte = body_chars[*start].0;
        let end_byte = body_chars
            .get(end)
            .map_or(body.len(), |(offset, _)| *offset);
        body[start_byte..end_byte].to_lowercase() == folded_query
    });
    let Some(match_start_char) = match_at else {
        return (body.chars().take(CONTEXT_CHARS * 2).collect(), Vec::new());
    };

    let match_end_char = match_start_char + query_char_count;
    let snippet_start_char = match_start_char.saturating_sub(CONTEXT_CHARS);
    let snippet_end_char = (match_end_char + CONTEXT_CHARS).min(body_chars.len());
    let snippet_start_byte = body_chars
        .get(snippet_start_char)
        .map_or(body.len(), |(offset, _)| *offset);
    let snippet_end_byte = body_chars
        .get(snippet_end_char)
        .map_or(body.len(), |(offset, _)| *offset);
    let prefix = if snippet_start_char > 0 { "…" } else { "" };
    let suffix = if snippet_end_char < body_chars.len() {
        "…"
    } else {
        ""
    };
    let snippet = format!(
        "{prefix}{}{suffix}",
        &body[snippet_start_byte..snippet_end_byte]
    );

    let range_start = prefix.encode_utf16().count()
        + body[snippet_start_byte..body_chars[match_start_char].0]
            .encode_utf16()
            .count();
    let match_end_byte = body_chars
        .get(match_end_char)
        .map_or(body.len(), |(offset, _)| *offset);
    let range_end = range_start
        + body[body_chars[match_start_char].0..match_end_byte]
            .encode_utf16()
            .count();
    (
        snippet,
        vec![SearchMatchRange {
            start: u32::try_from(range_start).unwrap_or(u32::MAX),
            end: u32::try_from(range_end).unwrap_or(u32::MAX),
        }],
    )
}

fn delete_database_path(database_path: &Path) -> Result<(), String> {
    retry_delete(|| delete_database_path_once(database_path))
}

fn retry_delete(mut delete: impl FnMut() -> Result<(), String>) -> Result<(), String> {
    const MAX_ATTEMPTS: usize = 3;
    let mut last_error = None;
    for attempt in 0..MAX_ATTEMPTS {
        match delete() {
            Ok(()) => return Ok(()),
            Err(error) => last_error = Some(error),
        }
        if attempt + 1 < MAX_ATTEMPTS {
            std::thread::sleep(Duration::from_millis(25 * (attempt as u64 + 1)));
        }
    }
    Err(last_error.expect("delete retries record an error"))
}

fn delete_database_path_once(database_path: &Path) -> Result<(), String> {
    for suffix in ["", "-wal", "-shm", "-journal"] {
        let mut path = database_path.as_os_str().to_os_string();
        path.push(suffix);
        match std::fs::remove_file(path) {
            Ok(()) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => return Err(safe_io_error(error)),
        }
    }
    match std::fs::remove_dir(database_path.parent().expect("index database has parent")) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(safe_io_error(error)),
    }
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

    fn work_with(mutations: Vec<SearchMutation>) -> SearchWork {
        SearchWork {
            account_store_key: "account".to_string(),
            device_id: "DEVICE".to_string(),
            mutations,
            ignored_senders: HashSet::new(),
        }
    }

    #[test]
    fn overlapping_room_seeds_keep_a_metadata_only_follow_up() {
        let pending = std::sync::Mutex::new(HashSet::new());
        let running = std::sync::atomic::AtomicBool::new(false);

        assert!(enqueue_cached_room_seed(&pending, &running, "!one"));
        assert_eq!(take_cached_room_seed(&pending, &running), Some("!one"));

        // The worker still owns `running` while processing the first request,
        // so this overlap must remain queued rather than spawning or dropping.
        assert!(!enqueue_cached_room_seed(&pending, &running, "!two"));
        assert_eq!(take_cached_room_seed(&pending, &running), Some("!two"));
        assert_eq!(take_cached_room_seed(&pending, &running), None);
        assert!(!running.load(std::sync::atomic::Ordering::Acquire));
    }

    #[test]
    fn privacy_removals_require_reliable_queue_delivery() {
        let apply = work_with(vec![SearchMutation::Apply(document(
            Some("hello"),
            "$original",
        ))]);
        let redact = work_with(vec![SearchMutation::Redact {
            room_id: "!room:example.org".to_string(),
            event_id: "$original".to_string(),
        }]);
        let purge = work_with(vec![SearchMutation::PurgeRoom {
            room_id: "!room:example.org".to_string(),
        }]);

        assert!(!apply.requires_reliable_delivery());
        assert!(redact.requires_reliable_delivery());
        assert!(purge.requires_reliable_delivery());
    }

    #[test]
    fn departed_room_filter_drops_additions_but_preserves_privacy_removals() {
        let mut work = work_with(vec![
            SearchMutation::Apply(document(Some("departed plaintext"), "$original")),
            SearchMutation::Redact {
                room_id: "!room:example.org".to_string(),
                event_id: "$original".to_string(),
            },
            SearchMutation::PurgeRoom {
                room_id: "!room:example.org".to_string(),
            },
        ]);

        work.retain_joined_room_additions(&HashSet::new());

        assert_eq!(work.mutations.len(), 2);
        assert!(work.mutations.iter().all(|mutation| matches!(
            mutation,
            SearchMutation::Redact { .. } | SearchMutation::PurgeRoom { .. }
        )));
        assert!(work.requires_reliable_delivery());
    }

    #[test]
    fn worker_visibility_refresh_drops_newly_ignored_additions_and_updates_cleanup() {
        let mut work = work_with(vec![SearchMutation::Apply(document(
            Some("newly ignored plaintext"),
            "$original",
        ))]);
        let joined_rooms = HashSet::from(["!room:example.org".to_string()]);
        let ignored_senders = HashSet::from(["@alice:example.org".to_string()]);

        work.retain_currently_visible_additions(&joined_rooms, ignored_senders.clone());

        assert!(work.mutations.is_empty());
        assert_eq!(work.ignored_senders, ignored_senders);
        assert!(work.requires_reliable_delivery());
    }

    #[test]
    fn parked_privacy_work_drops_decrypted_additions() {
        let mixed = work_with(vec![
            SearchMutation::Apply(document(Some("sensitive body"), "$original")),
            SearchMutation::Redact {
                room_id: "!room:example.org".to_string(),
                event_id: "$original".to_string(),
            },
        ]);

        let (privacy, dropped_additions) = mixed.into_privacy_removals();

        assert!(dropped_additions);
        assert_eq!(privacy.mutations.len(), 1);
        assert!(matches!(
            privacy.mutations[0],
            SearchMutation::Redact { .. }
        ));
    }

    #[test]
    fn stale_generation_drops_sync_plaintext_before_queueing() {
        let state = super::super::MatrixState::default();
        state
            .search_generation
            .store(1, std::sync::atomic::Ordering::Release);
        let (sender, mut receiver) = tokio::sync::mpsc::channel(1);
        let queued = QueuedSearchWork {
            generation: 0,
            work: work_with(vec![SearchMutation::Apply(document(
                Some("signed-out plaintext"),
                "$original",
            ))]),
            completes_backfill: false,
            completion: None,
        };

        assert!(try_enqueue_current_generation(&state, 0, &sender, queued).is_none());
        assert!(matches!(
            receiver.try_recv(),
            Err(tokio::sync::mpsc::error::TryRecvError::Empty)
        ));
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

    #[tokio::test]
    async fn session_replacement_invalidates_search_work_and_resets_lifecycle() {
        let state = super::super::MatrixState::default();
        state
            .search_backfill_started
            .store(true, std::sync::atomic::Ordering::Release);
        state
            .search_backfill_pending
            .store(true, std::sync::atomic::Ordering::Release);
        state
            .search_incomplete
            .store(true, std::sync::atomic::Ordering::Release);
        state.search_pending_seed_rooms.lock().unwrap().insert((
            0,
            matrix_sdk::ruma::RoomId::parse("!room:example.org").unwrap(),
        ));

        invalidate_for_session_replacement(&state).await;

        assert_eq!(
            state
                .search_generation
                .load(std::sync::atomic::Ordering::Acquire),
            1
        );
        assert!(!state
            .search_backfill_started
            .load(std::sync::atomic::Ordering::Acquire));
        assert!(!state
            .search_backfill_pending
            .load(std::sync::atomic::Ordering::Acquire));
        assert!(!state
            .search_incomplete
            .load(std::sync::atomic::Ordering::Acquire));
        assert!(state.search_pending_seed_rooms.lock().unwrap().is_empty());
    }

    #[test]
    fn stale_worker_failure_does_not_poison_replacement_lifecycle() {
        let state = super::super::MatrixState::default();
        state
            .search_generation
            .store(1, std::sync::atomic::Ordering::Release);

        assert!(!mark_incomplete_if_current(&state, 0));
        assert!(!state
            .search_incomplete
            .load(std::sync::atomic::Ordering::Acquire));
        assert!(mark_incomplete_if_current(&state, 1));
        assert!(state
            .search_incomplete
            .load(std::sync::atomic::Ordering::Acquire));
    }

    #[test]
    fn sqlcipher_key_literal_uses_the_raw_key_form() {
        let literal = Zeroizing::new(sqlcipher_raw_key_literal(&[0x01, 0xab, 0xff]));
        assert_eq!(literal.as_str(), "x'01abff'");
    }

    #[test]
    fn cached_event_ingestion_uses_sanitized_rendered_text_and_fails_closed_on_spoilers() {
        let plain: Raw<AnySyncTimelineEvent> = Raw::from_json_string(
            serde_json::json!({
                "type": "m.room.message",
                "event_id": "$plain:example.org",
                "sender": "@alice:example.org",
                "origin_server_ts": 1,
                "content": { "msgtype": "m.text", "body": "searchable words" }
            })
            .to_string(),
        )
        .expect("plain event");
        let spoiler: Raw<AnySyncTimelineEvent> = Raw::from_json_string(
            serde_json::json!({
                "type": "m.room.message",
                "event_id": "$spoiler:example.org",
                "sender": "@alice:example.org",
                "origin_server_ts": 2,
                "content": {
                    "msgtype": "m.text",
                    "body": "hidden words",
                    "format": "org.matrix.custom.html",
                    "formatted_body": "<span data-mx-spoiler>hidden words</span>"
                }
            })
            .to_string(),
        )
        .expect("spoiler event");
        let formatted: Raw<AnySyncTimelineEvent> = Raw::from_json_string(
            serde_json::json!({
                "type": "m.room.message",
                "event_id": "$formatted:example.org",
                "sender": "@alice:example.org",
                "origin_server_ts": 3,
                "content": {
                    "msgtype": "m.text",
                    "body": "fallback-only words visible words",
                    "format": "org.matrix.custom.html",
                    "formatted_body": "<script>fallback-only words</script><strong>visible words</strong>"
                }
            })
            .to_string(),
        )
        .expect("formatted event");
        let mut mutations = Vec::new();
        append_raw_event_mutation("!room:example.org", &plain, &HashSet::new(), &mut mutations);
        append_raw_event_mutation(
            "!room:example.org",
            &spoiler,
            &HashSet::new(),
            &mut mutations,
        );
        append_raw_event_mutation(
            "!room:example.org",
            &formatted,
            &HashSet::new(),
            &mut mutations,
        );

        let SearchMutation::Apply(plain) = &mutations[0] else {
            panic!("plain event should be indexed");
        };
        assert_eq!(plain.body.as_deref(), Some("searchable words"));
        let SearchMutation::Apply(spoiler) = &mutations[1] else {
            panic!("spoiler should retain non-searchable provenance");
        };
        assert_eq!(spoiler.body, None);
        let SearchMutation::Apply(formatted) = &mutations[2] else {
            panic!("formatted event should retain searchable provenance");
        };
        assert_eq!(formatted.body.as_deref(), Some("visible words"));
    }

    #[test]
    fn sanitized_html_detects_only_real_spoiler_attributes() {
        assert_eq!(
            sanitized_html_text("<p>Use data-mx-spoiler for spoilers</p>").as_deref(),
            Some("Use data-mx-spoiler for spoilers")
        );
        assert_eq!(
            sanitized_html_text("<p title=\"data-mx-spoiler\">Visible text</p>").as_deref(),
            Some("Visible text")
        );
        assert!(sanitized_html_text("<span data-mx-spoiler>Hidden text</span>").is_none());
        assert!(sanitized_html_text("<span DATA-MX-SPOILER>Hidden text</span>").is_none());
    }

    #[test]
    fn deletion_retries_transient_failures() {
        let mut attempts = 0;
        retry_delete(|| {
            attempts += 1;
            (attempts == 3)
                .then_some(())
                .ok_or_else(|| "transient delete failure".to_string())
        })
        .expect("third delete attempt succeeds");
        assert_eq!(attempts, 3);
    }

    #[test]
    fn cached_event_ingestion_applies_ignore_and_redaction_rules() {
        let ignored: Raw<AnySyncTimelineEvent> = Raw::from_json_string(
            serde_json::json!({
                "type": "m.room.message",
                "event_id": "$ignored:example.org",
                "sender": "@ignored:example.org",
                "origin_server_ts": 1,
                "content": { "msgtype": "m.text", "body": "do not retain" }
            })
            .to_string(),
        )
        .expect("ignored event");
        let redaction: Raw<AnySyncTimelineEvent> = Raw::from_json_string(
            serde_json::json!({
                "type": "m.room.redaction",
                "event_id": "$redaction:example.org",
                "sender": "@alice:example.org",
                "origin_server_ts": 2,
                "redacts": "$target:example.org",
                "content": {}
            })
            .to_string(),
        )
        .expect("redaction event");
        let ignored_senders = HashSet::from(["@ignored:example.org".to_string()]);
        let mut mutations = Vec::new();
        append_raw_event_mutation(
            "!room:example.org",
            &ignored,
            &ignored_senders,
            &mut mutations,
        );
        append_raw_event_mutation(
            "!room:example.org",
            &redaction,
            &ignored_senders,
            &mut mutations,
        );

        assert_eq!(mutations.len(), 1);
        let SearchMutation::Redact { room_id, event_id } = &mutations[0] else {
            panic!("redaction should be preserved");
        };
        assert_eq!(room_id, "!room:example.org");
        assert_eq!(event_id, "$target:example.org");
    }

    #[test]
    fn open_rebuilds_an_unknown_schema_version_without_retaining_content() {
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

        let rebuilt =
            SearchIndex::open_with_secret(directory.path(), "account", "DEVICE", TEST_STORE_SECRET)
                .expect("unknown schema should rebuild from an empty derived index");
        assert_eq!(rebuilt.database_path(), database_path);
        let indexed_rows = rebuilt
            .connection
            .query_row("SELECT COUNT(*) FROM searchable_messages", [], |row| {
                row.get::<_, u32>(0)
            })
            .expect("count rebuilt rows");
        assert_eq!(indexed_rows, 0);
    }

    #[test]
    fn open_rebuilds_a_malformed_schema_and_classifies_transient_storage_errors() {
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

        SearchIndex::open_with_secret(directory.path(), "account", "DEVICE", TEST_STORE_SECRET)
            .expect("malformed schema should rebuild from an empty derived index");

        assert!(matches!(
            MigrationError::from_sqlite(rusqlite::Error::SqliteFailure(
                rusqlite::ffi::Error::new(rusqlite::ffi::SQLITE_BUSY),
                None,
            )),
            MigrationError::Storage(_)
        ));
    }

    #[test]
    fn open_rebuilds_an_index_corrupted_before_schema_migration() {
        use std::io::{Seek, SeekFrom, Write};

        let directory = tempfile::tempdir().expect("tempdir");
        let mut index = open_index(directory.path(), "account", "DEVICE");
        for ordinal in 0..40 {
            let mut row = document(
                Some("enough content to allocate database pages"),
                "$original",
            );
            row.event_id = format!("$event-{ordinal}");
            row.version_event_id = row.event_id.clone();
            index.apply_document(&row).expect("grow encrypted index");
        }
        let database_path = index.database_path().to_path_buf();
        drop(index);
        let mut database = std::fs::OpenOptions::new()
            .read(true)
            .write(true)
            .open(&database_path)
            .expect("open encrypted index bytes");
        let length = database.metadata().expect("index metadata").len();
        database
            .seek(SeekFrom::Start(length.saturating_sub(128)))
            .expect("seek into encrypted page");
        database.write_all(&[0xA5; 32]).expect("corrupt one page");

        let rebuilt =
            SearchIndex::open_with_secret(directory.path(), "account", "DEVICE", TEST_STORE_SECRET)
                .expect("corrupt derived index should rebuild");
        assert_eq!(
            rebuilt
                .connection
                .query_row("SELECT schema_version FROM search_metadata", [], |row| {
                    row.get::<_, u32>(0)
                })
                .expect("read rebuilt schema"),
            SCHEMA_VERSION
        );
    }

    #[test]
    fn delete_for_source_removes_an_index_that_is_not_currently_open() {
        let directory = tempfile::tempdir().expect("tempdir");
        let index = open_index(directory.path(), "account", "DEVICE");
        let database_path = index.database_path().to_path_buf();
        drop(index);

        SearchIndex::delete_for_source(directory.path(), "account", "DEVICE")
            .expect("delete unopened index");

        assert!(!database_path.exists());
        assert!(!database_path.with_extension("sqlite3-wal").exists());
        assert!(!database_path.with_extension("sqlite3-shm").exists());
    }

    #[test]
    fn delete_for_account_removes_every_device_but_not_another_account() {
        let directory = tempfile::tempdir().expect("tempdir");
        let first = open_index(directory.path(), "account", "DEVICE-A");
        let first_path = first.database_path().to_owned();
        let second = open_index(directory.path(), "account", "DEVICE-B");
        let second_path = second.database_path().to_owned();
        let other = open_index(directory.path(), "other-account", "DEVICE-A");
        let other_path = other.database_path().to_owned();
        drop((first, second, other));

        SearchIndex::delete_for_account(directory.path(), "account")
            .expect("delete account indexes");

        assert!(!first_path.exists());
        assert!(!second_path.exists());
        assert!(other_path.exists());
    }

    #[test]
    fn leave_purge_failure_marks_search_incomplete_without_propagating_content() {
        let incomplete = std::sync::atomic::AtomicBool::new(false);

        record_room_leave_purge_result(
            &incomplete,
            Err("sensitive storage detail".to_string()),
            "test_leave_room",
        );

        assert!(incomplete.load(std::sync::atomic::Ordering::Acquire));
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
    fn open_migrates_v3_arrival_order_into_an_ambiguous_timestamp_tie() {
        let directory = tempfile::tempdir().expect("tempdir");
        let mut index = open_index(directory.path(), "account", "DEVICE");
        index
            .apply_document(&document(Some("original"), "$original"))
            .expect("insert original");
        let mut first = document(Some("first tied edit"), "$tie-1");
        first.selection_order = 10;
        let mut second = document(Some("second tied edit"), "$tie-2");
        second.selection_order = 11;
        index.apply_document(&first).expect("insert first edit");
        index.apply_document(&second).expect("insert second edit");
        assert_eq!(
            index
                .visible_body("!room:example.org", "$original")
                .as_deref(),
            Some("second tied edit")
        );
        index
            .connection
            .execute("UPDATE search_metadata SET schema_version = 3", [])
            .expect("downgrade schema marker");
        drop(index);

        let index = open_index(directory.path(), "account", "DEVICE");
        assert_eq!(index.visible_body("!room:example.org", "$original"), None);
        let distinct_orders = index
            .connection
            .query_row(
                "SELECT COUNT(DISTINCT selection_order) FROM message_versions",
                [],
                |row| row.get::<_, i64>(0),
            )
            .expect("count normalized orders");
        assert_eq!(distinct_orders, 1);
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
    fn fresh_ignore_list_purges_an_already_indexed_sender_before_search() {
        let directory = tempfile::tempdir().expect("tempdir");
        let mut index = open_index(directory.path(), "account", "DEVICE");
        index
            .apply_document(&document(Some("previously searchable"), "$original"))
            .expect("insert");

        index
            .purge_ignored_senders(&HashSet::from(["@alice:example.org".to_string()]))
            .expect("purge ignored sender");

        assert_eq!(index.visible_body("!room:example.org", "$original"), None);
    }

    #[test]
    fn explicit_room_purge_removes_only_the_departed_rooms_rows() {
        let directory = tempfile::tempdir().expect("tempdir");
        let mut index = open_index(directory.path(), "account", "DEVICE");
        let departed = document(Some("departed room"), "$original");
        let mut retained = document(Some("retained room"), "$original");
        retained.room_id = "!retained:example.org".to_string();
        index.apply_document(&departed).expect("insert departed");
        index.apply_document(&retained).expect("insert retained");

        SearchWork {
            account_store_key: "account".to_string(),
            device_id: "DEVICE".to_string(),
            mutations: vec![SearchMutation::PurgeRoom {
                room_id: departed.room_id.clone(),
            }],
            ignored_senders: HashSet::new(),
        }
        .apply_to(&mut index)
        .expect("purge departed room");

        assert_eq!(index.visible_body(&departed.room_id, "$original"), None);
        assert_eq!(
            index
                .visible_body(&retained.room_id, "$original")
                .as_deref(),
            Some("retained room")
        );
        let departed_fts_rows = index
            .connection
            .query_row(
                "SELECT COUNT(*) FROM searchable_messages_fts WHERE room_id = ?1",
                [&departed.room_id],
                |row| row.get::<_, i64>(0),
            )
            .expect("count departed FTS rows");
        let retained_fts_rows = index
            .connection
            .query_row(
                "SELECT COUNT(*) FROM searchable_messages_fts WHERE room_id = ?1",
                [&retained.room_id],
                |row| row.get::<_, i64>(0),
            )
            .expect("count retained FTS rows");
        assert_eq!(departed_fts_rows, 0);
        assert_eq!(retained_fts_rows, 1);
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

    #[test]
    fn equal_order_edits_defer_visibility_until_the_tie_is_resolved() {
        let directory = tempfile::tempdir().expect("tempdir");
        let mut index = open_index(directory.path(), "account", "DEVICE");
        index
            .apply_document(&document(Some("original"), "$original"))
            .expect("insert original");
        let mut first = document(Some("first tied edit"), "$tie-1");
        first.selection_order = 10;
        let mut second = document(Some("second tied edit"), "$tie-2");
        second.selection_order = 10;

        index
            .apply_document(&first)
            .expect("insert first tied edit");
        assert_eq!(
            index
                .visible_body("!room:example.org", "$original")
                .as_deref(),
            Some("first tied edit")
        );
        index
            .apply_document(&second)
            .expect("insert second tied edit");
        assert_eq!(index.visible_body("!room:example.org", "$original"), None);

        index
            .redact("!room:example.org", "$tie-2")
            .expect("redact one tied edit");
        assert_eq!(
            index
                .visible_body("!room:example.org", "$original")
                .as_deref(),
            Some("first tied edit")
        );
    }

    #[test]
    fn renderer_selection_resolves_equal_order_edits() {
        let directory = tempfile::tempdir().expect("tempdir");
        let mut index = open_index(directory.path(), "account", "DEVICE");
        index
            .apply_document(&document(Some("original"), "$original"))
            .expect("insert original");
        let mut first = document(Some("first tied edit"), "$tie-1");
        first.selection_order = 10;
        let mut second = document(Some("second tied edit"), "$tie-2");
        second.selection_order = 10;
        index.apply_document(&first).expect("insert first edit");
        index.apply_document(&second).expect("insert second edit");
        assert_eq!(index.visible_body("!room:example.org", "$original"), None);

        index
            .select_version("!room:example.org", "$original", "$tie-1")
            .expect("select renderer version");
        assert_eq!(
            index
                .visible_body("!room:example.org", "$original")
                .as_deref(),
            Some("first tied edit")
        );
        index
            .select_version("!room:example.org", "$original", "$tie-2")
            .expect("update renderer version");
        assert_eq!(
            index
                .visible_body("!room:example.org", "$original")
                .as_deref(),
            Some("second tied edit")
        );
    }

    #[test]
    fn newer_edit_supersedes_a_stale_renderer_selection() {
        let directory = tempfile::tempdir().expect("tempdir");
        let mut index = open_index(directory.path(), "account", "DEVICE");
        index
            .apply_document(&document(Some("original"), "$original"))
            .expect("insert original");
        let mut first = document(Some("first edit"), "$edit-1");
        first.selection_order = 10;
        index.apply_document(&first).expect("insert first edit");
        index
            .select_version("!room:example.org", "$original", "$edit-1")
            .expect("select first edit");

        let mut later = document(Some("later edit"), "$edit-2");
        later.selection_order = 11;
        index.apply_document(&later).expect("insert later edit");

        assert_eq!(
            index
                .visible_body("!room:example.org", "$original")
                .as_deref(),
            Some("later edit")
        );
        let selected_rows = index
            .connection
            .query_row("SELECT COUNT(*) FROM selected_versions", [], |row| {
                row.get::<_, i64>(0)
            })
            .expect("count selections");
        assert_eq!(selected_rows, 0);
    }

    #[test]
    fn redacting_a_selected_edit_before_provenance_restores_the_original() {
        let directory = tempfile::tempdir().expect("tempdir");
        let mut index = open_index(directory.path(), "account", "DEVICE");
        index
            .apply_document(&document(Some("original"), "$original"))
            .expect("insert original");
        index
            .select_version("!room:example.org", "$original", "$pending-edit")
            .expect("select pending edit");
        assert_eq!(
            index
                .visible_body("!room:example.org", "$original")
                .as_deref(),
            Some("original")
        );

        index
            .redact("!room:example.org", "$pending-edit")
            .expect("redact pending edit");
        index
            .apply_document(&document(Some("redacted edit"), "$pending-edit"))
            .expect("ignore late redacted edit");

        assert_eq!(
            index
                .visible_body("!room:example.org", "$original")
                .as_deref(),
            Some("original")
        );
        let selected_rows = index
            .connection
            .query_row("SELECT COUNT(*) FROM selected_versions", [], |row| {
                row.get::<_, i64>(0)
            })
            .expect("count selections");
        assert_eq!(selected_rows, 0);
    }

    #[test]
    fn final_visibility_filter_removes_departed_rooms_and_newly_ignored_senders() {
        let mut page = SearchResultPage {
            results: vec![
                SearchResult {
                    room_id: "!joined:example.org".to_string(),
                    event_id: "$visible".to_string(),
                    sender: "@visible:example.org".to_string(),
                    origin_server_ts: 1,
                    snippet: "visible".to_string(),
                    match_ranges: Vec::new(),
                },
                SearchResult {
                    room_id: "!joined:example.org".to_string(),
                    event_id: "$ignored".to_string(),
                    sender: "@ignored:example.org".to_string(),
                    origin_server_ts: 2,
                    snippet: "ignored".to_string(),
                    match_ranges: Vec::new(),
                },
                SearchResult {
                    room_id: "!departed:example.org".to_string(),
                    event_id: "$departed".to_string(),
                    sender: "@visible:example.org".to_string(),
                    origin_server_ts: 3,
                    snippet: "departed".to_string(),
                    match_ranges: Vec::new(),
                },
            ],
            next_cursor: None,
            incomplete: false,
        };
        let allowed = HashSet::from(["!joined:example.org".to_string()]);
        let ignored = HashSet::from(["@ignored:example.org".to_string()]);

        page.retain_current_visibility(&allowed, &ignored);

        assert_eq!(page.results.len(), 1);
        assert_eq!(page.results[0].event_id, "$visible");
    }

    #[test]
    fn search_is_literal_scoped_and_reports_utf16_match_ranges() {
        let directory = tempfile::tempdir().expect("tempdir");
        let mut index = open_index(directory.path(), "account", "DEVICE");
        index
            .apply_document(&document(Some("before 🦀 Matrix_100% after"), "$original"))
            .expect("insert searchable content");
        let allowed = HashSet::from(["!room:example.org".to_string()]);

        let page = index
            .search("Matrix_100%", Some("!room:example.org"), &allowed, 20, None)
            .expect("search");
        assert_eq!(page.results.len(), 1);
        assert_eq!(page.results[0].event_id, "$original");
        assert_eq!(
            page.results[0].match_ranges,
            vec![SearchMatchRange { start: 10, end: 21 }]
        );

        assert!(index
            .search("Matrix", Some("!other:example.org"), &allowed, 20, None)
            .expect("scoped search")
            .results
            .is_empty());
        assert_eq!(
            index
                .search("%", None, &allowed, 20, None)
                .expect("literal wildcard search")
                .results
                .len(),
            1
        );
    }

    #[test]
    fn departed_rooms_cannot_consume_the_global_snapshot_cap() {
        let directory = tempfile::tempdir().expect("tempdir");
        let mut index = open_index(directory.path(), "account", "DEVICE");
        let joined_room = "!joined:example.org";

        for offset in 0..MAX_SNAPSHOT_RESULTS {
            let event_id = format!("$departed-{offset}:example.org");
            index
                .apply_document(&SearchDocument {
                    room_id: "!departed:example.org".to_string(),
                    event_id: event_id.clone(),
                    version_event_id: event_id,
                    sender: "@alice:example.org".to_string(),
                    body: Some("crowding marker".to_string()),
                    origin_server_ts: 10_000 + offset as u64,
                    selection_order: 10_000 + offset as u64,
                })
                .expect("insert departed-room result");
        }
        index
            .apply_document(&SearchDocument {
                room_id: joined_room.to_string(),
                event_id: "$joined:example.org".to_string(),
                version_event_id: "$joined:example.org".to_string(),
                sender: "@bob:example.org".to_string(),
                body: Some("crowding marker".to_string()),
                origin_server_ts: 1,
                selection_order: 1,
            })
            .expect("insert joined-room result");

        let allowed = HashSet::from([joined_room.to_string()]);
        let page = index
            .search("crowding", None, &allowed, 20, None)
            .expect("global search");

        assert_eq!(page.results.len(), 1);
        assert_eq!(page.results[0].room_id, joined_room);
        assert_eq!(page.results[0].event_id, "$joined:example.org");
    }

    #[test]
    fn search_cursor_is_stable_and_bound_to_query_and_index_instance() {
        let directory = tempfile::tempdir().expect("tempdir");
        let mut index = open_index(directory.path(), "account", "DEVICE");
        for (event_id, order) in [("$one", 1), ("$two", 2)] {
            let mut searchable = document(Some("searchable phrase"), "$original");
            searchable.event_id = event_id.to_string();
            searchable.version_event_id = event_id.to_string();
            searchable.selection_order = order;
            index.apply_document(&searchable).expect("insert");
        }
        let allowed = HashSet::from(["!room:example.org".to_string()]);
        let first = index
            .search("searchable", None, &allowed, 1, None)
            .expect("first page");
        {
            let snapshot = index.snapshots.values().next().expect("search snapshot");
            assert_eq!(
                snapshot.query_digest,
                snapshot_query_digest(&index.snapshot_query_key, "searchable")
            );
            assert_ne!(
                snapshot.query_digest,
                snapshot_query_digest(&index.snapshot_query_key, "different")
            );
            assert!(!format!("{snapshot:?}").contains("searchable"));
        }
        let cursor = first.next_cursor.expect("next cursor");
        let second = index
            .search("searchable", None, &allowed, 1, Some(&cursor))
            .expect("second page");
        assert_eq!(second.results.len(), 1);
        assert_ne!(first.results[0].event_id, second.results[0].event_id);
        assert!(matches!(
            index.search("different", None, &allowed, 1, Some(&cursor)),
            Err(SearchCommandError::StaleCursor { .. })
        ));

        drop(index);
        let mut reopened = open_index(directory.path(), "account", "DEVICE");
        assert!(matches!(
            reopened.search("searchable", None, &allowed, 1, Some(&cursor)),
            Err(SearchCommandError::StaleCursor { .. })
        ));
    }

    #[test]
    fn reply_edit_indexes_only_the_replacement_body_without_quoted_fallback() {
        let raw: Raw<AnySyncTimelineEvent> = Raw::from_json_string(
            serde_json::json!({
                "type": "m.room.message",
                "event_id": "$edit:example.org",
                "sender": "@alice:example.org",
                "origin_server_ts": 2,
                "content": {
                    "msgtype": "m.text",
                    "body": "* edited answer",
                    "m.new_content": {
                        "msgtype": "m.text",
                        "body": "> <@bob:example.org> quoted text\n\nedited answer",
                        "format": "org.matrix.custom.html",
                        "formatted_body": "<mx-reply><blockquote>quoted text</blockquote></mx-reply><p>edited answer</p>",
                        "m.relates_to": {
                            "m.in_reply_to": { "event_id": "$reply:example.org" }
                        }
                    },
                    "m.relates_to": {
                        "rel_type": "m.replace",
                        "event_id": "$original:example.org"
                    }
                }
            })
            .to_string(),
        )
        .expect("reply edit event");
        let mut mutations = Vec::new();

        append_raw_event_mutation("!room:example.org", &raw, &HashSet::new(), &mut mutations);

        let SearchMutation::Apply(document) = &mutations[0] else {
            panic!("reply edit should be indexed");
        };
        assert_eq!(document.body.as_deref(), Some("edited answer"));
    }

    #[test]
    fn forged_edit_from_another_sender_is_ignored() {
        let directory = tempfile::tempdir().expect("tempdir");
        let mut index = open_index(directory.path(), "account", "DEVICE");
        index
            .apply_document(&document(Some("original"), "$original"))
            .expect("insert original");
        let mut forged = document(Some("forged replacement"), "$edit");
        forged.sender = "@mallory:example.org".to_string();
        index.apply_document(&forged).expect("ignore forged edit");
        assert_eq!(
            index
                .visible_body("!room:example.org", "$original")
                .as_deref(),
            Some("original")
        );
    }
}
