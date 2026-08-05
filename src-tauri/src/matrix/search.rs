//! Charm-owned, SQLCipher-encrypted search-index storage for Spec 28.
//!
//! This database is deliberately separate from matrix-rust-sdk's encrypted
//! store. Callers must pass only acknowledged, decrypted text, notice, or
//! emote events after applying Matrix reply and HTML normalization.

use std::{
    collections::{HashMap, HashSet},
    fmt::Write as _,
    path::{Path, PathBuf},
    time::{Duration, Instant},
};

use hkdf::Hkdf;
use matrix_sdk::{
    deserialized_responses::{TimelineEvent, TimelineEventKind},
    ruma::{
        events::{
            room::message::{MessageType, Relation, RoomMessageEventContent},
            AnySyncMessageLikeEvent, AnySyncTimelineEvent, SyncMessageLikeEvent,
        },
        html::{HtmlSanitizerMode, RemoveReplyFallback},
        serde::Raw,
    },
    Client,
};
use rand::{distr::Alphanumeric, RngExt};
use rusqlite::{params, Connection, ErrorCode, OpenFlags, OptionalExtension, Transaction};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use sha2_compat::Sha256 as HkdfSha256;
use tauri::{AppHandle, Manager, State};
use ts_rs::TS;
use zeroize::Zeroizing;

const SEARCH_ROOT: &str = "message_search";
const SEARCH_DATABASE: &str = "message-search.sqlite3";
const SCHEMA_VERSION: u32 = 3;
const KEY_DERIVATION_SALT: &[u8] = b"Charm message search SQLCipher key v1";
const MAX_QUERY_BYTES: usize = 512;
const MAX_RESULTS_PER_PAGE: usize = 100;
const MAX_SNAPSHOT_RESULTS: usize = 2_000;
const MAX_LIVE_SNAPSHOTS: usize = 8;
const SNAPSHOT_TTL: Duration = Duration::from_secs(5 * 60);

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
    query: String,
    room_id: Option<String>,
    created_at: Instant,
    entries: Vec<SearchSnapshotEntry>,
}

/// A Charm-owned, device-scoped SQLCipher message index.
pub struct SearchIndex {
    connection: Connection,
    database_path: PathBuf,
    incarnation: String,
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
    Redact { room_id: String, event_id: String },
    PurgeRoom { room_id: String },
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
            incarnation: random_id(),
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
                    query: query.clone(),
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
        if snapshot.query != query || snapshot.room_id.as_deref() != room_id {
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
        let mut entries = Vec::new();
        if query.chars().count() >= 3 {
            let literal = format!("\"{}\"", query.replace('"', "\"\""));
            let mut statement = self
                .connection
                .prepare(
                    "SELECT room_id, event_id, version_event_id
                     FROM searchable_messages_fts
                     WHERE searchable_messages_fts MATCH ?1
                       AND (?2 IS NULL OR room_id = ?2)
                     ORDER BY bm25(searchable_messages_fts) ASC,
                              CAST(origin_server_ts AS INTEGER) DESC,
                              room_id ASC, event_id ASC
                     LIMIT ?3",
                )
                .map_err(|_| SearchCommandError::unavailable())?;
            let rows = statement
                .query_map(
                    params![literal, room_id, MAX_SNAPSHOT_RESULTS as i64],
                    |row| {
                        Ok(SearchSnapshotEntry {
                            room_id: row.get(0)?,
                            event_id: row.get(1)?,
                            version_event_id: row.get(2)?,
                        })
                    },
                )
                .map_err(|_| SearchCommandError::unavailable())?;
            for row in rows {
                let entry = row.map_err(|_| SearchCommandError::unavailable())?;
                if allowed_rooms.contains(&entry.room_id) {
                    entries.push(entry);
                }
            }
        } else {
            let escaped = escape_like(query);
            let pattern = format!("%{escaped}%");
            let mut statement = self
                .connection
                .prepare(
                    "SELECT room_id, event_id, version_event_id
                     FROM searchable_messages
                     WHERE body LIKE ?1 ESCAPE '\\' COLLATE NOCASE
                       AND (?2 IS NULL OR room_id = ?2)
                     ORDER BY origin_server_ts DESC, room_id ASC, event_id ASC
                     LIMIT ?3",
                )
                .map_err(|_| SearchCommandError::unavailable())?;
            let rows = statement
                .query_map(
                    params![pattern, room_id, MAX_SNAPSHOT_RESULTS as i64],
                    |row| {
                        Ok(SearchSnapshotEntry {
                            room_id: row.get(0)?,
                            event_id: row.get(1)?,
                            version_event_id: row.get(2)?,
                        })
                    },
                )
                .map_err(|_| SearchCommandError::unavailable())?;
            for row in rows {
                let entry = row.map_err(|_| SearchCommandError::unavailable())?;
                if allowed_rooms.contains(&entry.room_id) {
                    entries.push(entry);
                }
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
    /// Applies one ordered sync batch to an already-open index.
    pub fn apply_to(self, index: &mut SearchIndex) -> Result<(), String> {
        index.purge_ignored_senders(&self.ignored_senders)?;
        for mutation in self.mutations {
            match mutation {
                SearchMutation::Apply(document) => index.apply_document(&document)?,
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
    content.sanitize(HtmlSanitizerMode::Compat, RemoveReplyFallback::Yes);
    let (body, formatted) = match content.msgtype {
        MessageType::Text(message) => (message.body, message.formatted.map(|body| body.body)),
        MessageType::Notice(message) => (message.body, message.formatted.map(|body| body.body)),
        MessageType::Emote(message) => (message.body, message.formatted.map(|body| body.body)),
        _ => return None,
    };
    // The plain fallback contains spoiler text. Until the search result UI can
    // preserve per-range spoiler semantics, fail closed for the whole event.
    if formatted.is_some_and(|html| html.contains("data-mx-spoiler")) {
        return None;
    }
    (!body.trim().is_empty()).then_some(body)
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
        for (position, raw_event) in update.timeline.events.iter().enumerate() {
            append_raw_event_mutation(
                room_id.as_str(),
                raw_event.raw(),
                position,
                &ignored_senders,
                &mut mutations,
            );
        }
    }
    Some(SearchWork {
        account_store_key,
        device_id,
        mutations,
        ignored_senders,
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
    for (position, event) in events.iter().enumerate() {
        if matches!(&event.kind, TimelineEventKind::UnableToDecrypt { .. }) {
            continue;
        }
        append_raw_event_mutation(
            room_id,
            event.raw(),
            position,
            &ignored_senders,
            &mut mutations,
        );
    }
    Some(SearchWork {
        account_store_key,
        device_id,
        mutations,
        ignored_senders,
    })
}

fn append_raw_event_mutation(
    room_id: &str,
    raw_event: &Raw<AnySyncTimelineEvent>,
    position: usize,
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
            let selection_order = timestamp
                .saturating_mul(65_536)
                .saturating_add(u64::try_from(position).unwrap_or(u64::MAX).min(65_535));
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
                selection_order,
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

fn apply_work(app: &AppHandle, queued: QueuedSearchWork) -> Result<(), String> {
    let state = app.state::<super::MatrixState>();
    if queued.generation
        != state
            .search_generation
            .load(std::sync::atomic::Ordering::Acquire)
    {
        return Ok(());
    }
    if !feature_enabled(app) {
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
    if queued.generation
        != state
            .search_generation
            .load(std::sync::atomic::Ordering::Acquire)
    {
        return Ok(());
    }
    let index = ensure_index(
        app,
        &mut slot,
        &queued.work.account_store_key,
        &queued.work.device_id,
    )?;
    queued.work.apply_to(index)
}

pub(crate) async fn submit_sync_response(
    app: &AppHandle,
    client: &Client,
    response: &matrix_sdk::sync::SyncResponse,
) {
    let state = app.state::<super::MatrixState>();
    if !feature_enabled(app) {
        state
            .search_generation
            .fetch_add(1, std::sync::atomic::Ordering::AcqRel);
        state
            .search_backfill_started
            .store(false, std::sync::atomic::Ordering::Release);
        state
            .search_incomplete
            .store(false, std::sync::atomic::Ordering::Release);
        let app = app.clone();
        tauri::async_runtime::spawn_blocking(move || {
            let active = app
                .state::<super::MatrixState>()
                .search_index
                .lock()
                .unwrap_or_else(|error| error.into_inner())
                .take();
            if let Some(active) = active {
                let _ = active.index.delete();
            }
        });
        return;
    }
    let Some(client_identity) = active_identity(client) else {
        return;
    };
    let is_current_client = {
        let current = state.client.lock().await;
        current
            .as_ref()
            .and_then(active_identity)
            .is_some_and(|identity| identity == client_identity)
    };
    if !is_current_client {
        return;
    }
    let generation = state
        .search_generation
        .load(std::sync::atomic::Ordering::Acquire);
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
        submit_cached_history(app, client, generation).await;
    }
    let ignored_senders = super::account::ignored_user_ids(client)
        .await
        .unwrap_or_default()
        .into_iter()
        .map(|sender| sender.to_string())
        .collect();
    let Some(work) = work_from_sync(client, response, ignored_senders) else {
        return;
    };
    if work.is_empty() {
        return;
    }

    let sender = search_work_sender(app).await;
    if sender
        .try_send(QueuedSearchWork { generation, work })
        .is_err()
    {
        state
            .search_incomplete
            .store(true, std::sync::atomic::Ordering::Release);
        tracing::warn!(command = "message_search_index", status = "queue_full");
    }
}

async fn search_work_sender(app: &AppHandle) -> tokio::sync::mpsc::Sender<QueuedSearchWork> {
    app.state::<super::MatrixState>()
        .search_work_tx
        .get_or_init(|| async {
            let (sender, mut receiver) = tokio::sync::mpsc::channel::<QueuedSearchWork>(32);
            let worker_app = app.clone();
            tauri::async_runtime::spawn(async move {
                while let Some(work) = receiver.recv().await {
                    let app = worker_app.clone();
                    if !matches!(
                        tauri::async_runtime::spawn_blocking(move || apply_work(&app, work)).await,
                        Ok(Ok(()))
                    ) {
                        tracing::warn!(command = "message_search_index", status = "worker_failed");
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
    if !feature_enabled(app) {
        return;
    }
    let ignored_senders: HashSet<String> = super::account::ignored_user_ids(client)
        .await
        .unwrap_or_default()
        .into_iter()
        .map(|sender| sender.to_string())
        .collect();
    let sender = search_work_sender(app).await;
    for room in client.joined_rooms() {
        let events = match room.event_cache().await {
            Ok((cache, _drop_handles)) => cache.events().await,
            Err(_) => {
                app.state::<super::MatrixState>()
                    .search_incomplete
                    .store(true, std::sync::atomic::Ordering::Release);
                continue;
            }
        };
        let Ok(events) = events else {
            app.state::<super::MatrixState>()
                .search_incomplete
                .store(true, std::sync::atomic::Ordering::Release);
            continue;
        };
        let Some(work) = work_from_cached_room(
            client,
            room.room_id().as_str(),
            &events,
            ignored_senders.clone(),
        ) else {
            return;
        };
        if work.is_empty() {
            continue;
        }
        if sender
            .try_send(QueuedSearchWork { generation, work })
            .is_err()
        {
            app.state::<super::MatrixState>()
                .search_incomplete
                .store(true, std::sync::atomic::Ordering::Release);
            tracing::warn!(command = "message_search_backfill", status = "queue_full");
            return;
        }
    }
}

/// Re-seeds one room after timeline pagination decrypts more local history.
/// The detached task and bounded `try_send` keep the user-visible timeline
/// response independent from event-cache and SQLCipher work.
pub(crate) fn schedule_cached_room(
    app: AppHandle,
    client: Client,
    room_id: matrix_sdk::ruma::OwnedRoomId,
) {
    tauri::async_runtime::spawn(async move {
        if !feature_enabled(&app) {
            return;
        }
        let state = app.state::<super::MatrixState>();
        let generation = state
            .search_generation
            .load(std::sync::atomic::Ordering::Acquire);
        let ignored_senders = super::account::ignored_user_ids(&client)
            .await
            .unwrap_or_default()
            .into_iter()
            .map(|sender| sender.to_string())
            .collect();
        let Some(room) = client.get_room(&room_id) else {
            return;
        };
        let events = match room.event_cache().await {
            Ok((cache, _drop_handles)) => cache.events().await,
            Err(_) => {
                state
                    .search_incomplete
                    .store(true, std::sync::atomic::Ordering::Release);
                return;
            }
        };
        let Ok(events) = events else {
            state
                .search_incomplete
                .store(true, std::sync::atomic::Ordering::Release);
            return;
        };
        let Some(work) = work_from_cached_room(&client, room_id.as_str(), &events, ignored_senders)
        else {
            return;
        };
        if work.is_empty() {
            return;
        }
        let sender = search_work_sender(&app).await;
        if sender
            .try_send(QueuedSearchWork { generation, work })
            .is_err()
        {
            state
                .search_incomplete
                .store(true, std::sync::atomic::Ordering::Release);
            tracing::warn!(command = "message_search_pagination", status = "queue_full");
        }
    });
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
        return Err(SearchCommandError::unavailable());
    }
    validate_query(&query)?;
    let client = state
        .require_client()
        .await
        .map_err(|_| SearchCommandError::unavailable())?;
    let (account_store_key, device_id) =
        active_identity(&client).ok_or_else(SearchCommandError::unavailable)?;
    let expected_identity = (account_store_key.clone(), device_id.clone());
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

    let mut page = tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<super::MatrixState>();
        let mut slot = state
            .search_index
            .lock()
            .unwrap_or_else(|error| error.into_inner());
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
        page.incomplete = state
            .search_incomplete
            .load(std::sync::atomic::Ordering::Acquire);
        Ok(page)
    })
    .await
    .map_err(|_| SearchCommandError::unavailable())??;
    let current_client = state
        .require_client()
        .await
        .map_err(|_| SearchCommandError::unavailable())?;
    if active_identity(&current_client).as_ref() != Some(&expected_identity) {
        return Err(SearchCommandError::unavailable());
    }
    let current_allowed_rooms: HashSet<String> = current_client
        .joined_rooms()
        .into_iter()
        .map(|room| room.room_id().to_string())
        .collect();
    page.results
        .retain(|result| current_allowed_rooms.contains(&result.room_id));
    Ok(page)
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
            create_current_schema(&transaction)?;
            rebuild_search_fts(&transaction)?;
            transaction
                .execute(
                    "UPDATE search_metadata SET schema_version = ?1",
                    [SCHEMA_VERSION],
                )
                .map_err(MigrationError::from_sqlite)?;
        }
        (1, Some(2)) => {
            create_current_schema(&transaction)?;
            rebuild_search_fts(&transaction)?;
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

fn rebuild_search_fts(transaction: &Transaction<'_>) -> Result<(), MigrationError> {
    transaction
        .execute_batch(
            "DELETE FROM searchable_messages_fts;
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
    for suffix in ["", "-wal", "-shm"] {
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
    fn cached_event_ingestion_accepts_plaintext_and_fails_closed_on_spoilers() {
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
        let mut mutations = Vec::new();
        append_raw_event_mutation(
            "!room:example.org",
            &plain,
            0,
            &HashSet::new(),
            &mut mutations,
        );
        append_raw_event_mutation(
            "!room:example.org",
            &spoiler,
            1,
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
            0,
            &ignored_senders,
            &mut mutations,
        );
        append_raw_event_mutation(
            "!room:example.org",
            &redaction,
            1,
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

        append_raw_event_mutation(
            "!room:example.org",
            &raw,
            0,
            &HashSet::new(),
            &mut mutations,
        );

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
