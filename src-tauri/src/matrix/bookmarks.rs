//! Spec 12: personal, private "saved messages" bookmarks — distinct from
//! room-pinning (day-2 Spec 04), which is shared/visible to the whole room.
//! A bookmark never sends a Matrix event of any kind (no account-data event
//! either, at least in this Phase 1 — see the spec's non-goals): it's a
//! purely local, per-account table, so it can never leak across accounts and
//! never becomes visible to other room members or other devices.
//!
//! Storage snapshots the message's sender/body/timestamp at save time (see
//! [`build_bookmark_entry`]) rather than storing only `(room_id, event_id)`
//! and re-resolving those fields on every `list_bookmarks` read — the Saved
//! Messages view (Spec 12's global access surface) needs to render room
//! context even for a room whose timeline isn't currently loaded, and
//! re-fetching an arbitrary historical event on every list render would be
//! far more expensive than the several-hundred-byte snapshot this keeps
//! instead.

use matrix_sdk::ruma::RoomId;
use matrix_sdk::Client;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, State};
use ts_rs::TS;

use super::persistence;
use super::timeline::items_to_summaries;
use super::MatrixState;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../src/bindings/")]
pub struct BookmarkEntry {
    pub room_id: String,
    pub event_id: String,
    /// Milliseconds since the Unix epoch, when this bookmark was created —
    /// drives the Saved Messages list's newest-saved-first ordering. Not the
    /// same as the message's own `timestamp_ms` (when it was *sent*).
    #[ts(type = "number")]
    pub saved_at_ms: u64,
    pub sender: String,
    pub sender_display_name: Option<String>,
    /// Truncated preview of the message body at save time — see the module
    /// doc for why this is snapshotted rather than re-resolved live.
    pub body_preview: String,
    #[ts(type = "number")]
    pub timestamp_ms: u64,
}

/// Caps a bookmark's stored preview so a very long message doesn't bloat the
/// local bookmarks file — the Saved Messages list only ever shows a preview
/// line, never the full body.
const BODY_PREVIEW_MAX_CHARS: usize = 280;

fn truncate_preview(body: &str) -> String {
    if body.chars().count() <= BODY_PREVIEW_MAX_CHARS {
        return body.to_string();
    }
    let truncated: String = body.chars().take(BODY_PREVIEW_MAX_CHARS).collect();
    format!("{truncated}…")
}

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// Core logic behind [`add_bookmark`], taking an already-resolved
/// `&Timeline` rather than `&MatrixState` — same split as
/// `timeline::get_timeline_page_impl`, so this can be exercised against a
/// real (mocked-homeserver) `Timeline` in a `--lib` unit test without a
/// running Tauri app.
pub async fn build_bookmark_entry(
    room_id: &str,
    event_id: &str,
    client: &Client,
    timeline: &matrix_sdk_ui::Timeline,
    media_cache: Option<&super::media::MediaCache>,
) -> Result<BookmarkEntry, String> {
    let (items, _stream) = timeline.subscribe().await;
    let own_user_id = client.user_id().map(ToOwned::to_owned);
    let summaries = items_to_summaries(&items, own_user_id.as_deref(), client, media_cache).await;
    let message = summaries
        .into_iter()
        .find(|m| m.event_id == event_id)
        .ok_or_else(|| "message not currently loaded in this room's timeline".to_string())?;

    Ok(BookmarkEntry {
        room_id: room_id.to_string(),
        event_id: event_id.to_string(),
        saved_at_ms: now_ms(),
        sender: message.sender,
        sender_display_name: message.sender_display_name,
        body_preview: truncate_preview(&message.body),
        timestamp_ms: message.timestamp_ms,
    })
}

async fn account_key_for_current_user(state: &State<'_, MatrixState>) -> Result<String, String> {
    let client = state.require_client().await?;
    let user_id = client
        .user_id()
        .ok_or_else(|| "not logged in".to_string())?;
    Ok(persistence::account_key(user_id.as_str()))
}

/// Bookmarks the message `event_id` in `room_id` for the current account.
/// A no-op (not an error) if it's already bookmarked. The message must be
/// currently loaded in that room's live `Timeline` — true whenever this is
/// invoked from the message action menu, the only entry point Spec 12
/// defines for adding a bookmark.
#[tauri::command]
pub async fn add_bookmark(
    app: AppHandle,
    state: State<'_, MatrixState>,
    room_id: String,
    event_id: String,
) -> Result<(), String> {
    let client = state.require_client().await?;
    let parsed_room_id = RoomId::parse(&room_id).map_err(|e| e.to_string())?;
    let timeline = state
        .get_or_create_timeline(&app, &client, &parsed_room_id)
        .await?;
    let media_cache = state.require_media_cache(&app).await.ok();

    let account_key = account_key_for_current_user(&state).await?;
    let mut bookmarks: Vec<BookmarkEntry> = persistence::load_bookmarks(&app, &account_key)?;
    if bookmarks.iter().any(|b| b.event_id == event_id) {
        return Ok(());
    }
    let entry = build_bookmark_entry(&room_id, &event_id, &client, &timeline, media_cache).await?;
    bookmarks.push(entry);
    persistence::save_bookmarks(&app, &account_key, &bookmarks)
}

/// Removes a bookmark by `event_id` — a no-op if it isn't currently
/// bookmarked. Only `event_id` is needed: bookmarked event ids are already
/// unique within one account's list (a room/event-id pair can only be
/// bookmarked once, per [`add_bookmark`]'s dedupe check).
#[tauri::command]
pub async fn remove_bookmark(
    app: AppHandle,
    state: State<'_, MatrixState>,
    event_id: String,
) -> Result<(), String> {
    let account_key = account_key_for_current_user(&state).await?;
    let mut bookmarks: Vec<BookmarkEntry> = persistence::load_bookmarks(&app, &account_key)?;
    bookmarks.retain(|b| b.event_id != event_id);
    persistence::save_bookmarks(&app, &account_key, &bookmarks)
}

/// Lists every bookmark for the current account, newest-saved first — the
/// Saved Messages view's data source. Purely local; no Matrix sync/send
/// traffic.
#[tauri::command]
pub async fn list_bookmarks(
    app: AppHandle,
    state: State<'_, MatrixState>,
) -> Result<Vec<BookmarkEntry>, String> {
    let account_key = account_key_for_current_user(&state).await?;
    let mut bookmarks: Vec<BookmarkEntry> = persistence::load_bookmarks(&app, &account_key)?;
    bookmarks.sort_by(|a, b| b.saved_at_ms.cmp(&a.saved_at_ms));
    Ok(bookmarks)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn truncate_preview_leaves_short_bodies_untouched() {
        assert_eq!(truncate_preview("hello"), "hello");
    }

    #[test]
    fn truncate_preview_caps_long_bodies_with_an_ellipsis() {
        let long_body = "a".repeat(BODY_PREVIEW_MAX_CHARS + 50);
        let preview = truncate_preview(&long_body);
        assert_eq!(preview.chars().count(), BODY_PREVIEW_MAX_CHARS + 1); // + the ellipsis char
        assert!(preview.ends_with('…'));
    }
}
