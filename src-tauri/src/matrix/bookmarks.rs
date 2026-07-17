//! Spec 12: personal, private "saved messages" bookmarks — distinct from
//! room-pinning (day-2 Spec 04), which is shared/visible to the whole room.
//! A bookmark never sends a Matrix event of any kind (no account-data event
//! either, at least in this Phase 1 — see the spec's non-goals): it's a
//! purely local, per-account table, so it can never leak across accounts and
//! never becomes visible to other room members or other devices.
//!
//! Review fix: an earlier version of this module persisted the message's
//! sender/body-preview/timestamp to the on-disk bookmarks file at save time.
//! That file (`<app_data>/bookmarks/<account_key>.json`) is a bare,
//! unencrypted JSON file — fine for opaque ids, but persisting a decrypted
//! message body from an *encrypted room* into it leaks plaintext content
//! from the encrypted timeline into unencrypted app-data storage that could
//! be read from disk or a backup, independent of the room's own encryption.
//! [`StoredBookmark`] now only ever persists `(room_id, event_id,
//! saved_at_ms)` — no message content, decrypted or not. The richer
//! [`BookmarkEntry`] the frontend actually renders (with sender/preview/
//! timestamp) is resolved at *read* time in [`list_bookmarks`], the same way
//! `ChatShell`'s jump-to-message resolves a bookmark's target event: from
//! the room's already-decrypted in-memory `Timeline` if it's currently open
//! (`MatrixState::peek_timeline`), falling back to a placeholder preview
//! (never a re-fetch of history, and never anything written back to disk)
//! when it isn't.

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
    /// Truncated preview of the message body, resolved live from the room's
    /// timeline at read time if it's open — see the module doc. Never
    /// persisted to disk.
    pub body_preview: String,
    #[ts(type = "number")]
    pub timestamp_ms: u64,
}

/// What actually lives in `<app_data>/bookmarks/<account_key>.json` — just
/// enough to identify the bookmarked message and order the list, no message
/// content. See the module doc for why this is deliberately narrower than
/// [`BookmarkEntry`].
#[derive(Debug, Clone, Serialize, Deserialize)]
struct StoredBookmark {
    room_id: String,
    event_id: String,
    saved_at_ms: u64,
}

/// Caps a bookmark's resolved preview so a very long message doesn't bloat
/// the in-memory response — the Saved Messages list only ever shows a
/// preview line, never the full body.
const BODY_PREVIEW_MAX_CHARS: usize = 280;

/// Shown in place of a real preview when the bookmarked message can't be
/// resolved from an already-open timeline (see the module doc) — e.g. the
/// room hasn't been opened this session, or the message has since scrolled
/// out of the loaded window. Deliberately not a re-fetch of room history:
/// the Saved Messages list is a lightweight, always-available surface, not
/// one that should pay pagination cost for every unopened room it lists.
const UNRESOLVED_PREVIEW: &str = "Preview unavailable — open the room to refresh";

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

/// Looks up `event_id` in `timeline`'s currently-loaded items and, if
/// found, returns its sender/body/timestamp. Shared by [`build_bookmark_entry`]
/// (add-time validation — the message must be currently loaded to be
/// bookmarked at all) and [`list_bookmarks`] (best-effort read-time
/// resolution when the room happens to already be open).
async fn resolve_from_timeline(
    event_id: &str,
    client: &Client,
    timeline: &matrix_sdk_ui::Timeline,
    media_cache: Option<&super::media::MediaCache>,
) -> Option<(String, Option<String>, String, u64)> {
    let (items, _stream) = timeline.subscribe().await;
    let own_user_id = client.user_id().map(ToOwned::to_owned);
    let summaries = items_to_summaries(&items, own_user_id.as_deref(), client, media_cache).await;
    summaries
        .into_iter()
        .find(|m| m.event_id == event_id)
        .map(|message| {
            (
                message.sender,
                message.sender_display_name,
                truncate_preview(&message.body),
                message.timestamp_ms,
            )
        })
}

/// Core logic behind [`add_bookmark`]'s validation, taking an
/// already-resolved `&Timeline` rather than `&MatrixState` — same split as
/// `timeline::get_timeline_page_impl`, so this can be exercised against a
/// real (mocked-homeserver) `Timeline` in a `--lib`/integration test without
/// a running Tauri app. Errors if the message isn't currently loaded in
/// `timeline` — a bookmark can only be created for a message the user can
/// currently see.
pub async fn build_bookmark_entry(
    room_id: &str,
    event_id: &str,
    client: &Client,
    timeline: &matrix_sdk_ui::Timeline,
    media_cache: Option<&super::media::MediaCache>,
) -> Result<BookmarkEntry, String> {
    let (sender, sender_display_name, body_preview, timestamp_ms) =
        resolve_from_timeline(event_id, client, timeline, media_cache)
            .await
            .ok_or_else(|| "message not currently loaded in this room's timeline".to_string())?;

    Ok(BookmarkEntry {
        room_id: room_id.to_string(),
        event_id: event_id.to_string(),
        saved_at_ms: now_ms(),
        sender,
        sender_display_name,
        body_preview,
        timestamp_ms,
    })
}

async fn account_key_for_current_user(state: &State<'_, MatrixState>) -> Result<String, String> {
    let client = state.require_client().await?;
    account_key_for_client(&client)
}

/// Derives the account key from an already-resolved `Client` rather than
/// re-reading `MatrixState`'s current client. Review fix: `add_bookmark`
/// previously called `account_key_for_current_user` (which re-fetches
/// `state.require_client()`) *after* already resolving its own `client` and
/// validating the message against that client's timeline. If an account
/// switch (logout of A, login of B) landed in between those two awaits, the
/// second fetch could derive B's account key while writing A's room/event
/// ids — corrupting B's bookmark file with A's data. Deriving the key from
/// the same `client` snapshot used for validation closes that window.
fn account_key_for_client(client: &Client) -> Result<String, String> {
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
///
/// Review fix: the read-modify-write of the bookmarks file below (load,
/// dedupe-check, push, save) is now held under `persistence::bookmarks_lock`
/// for the whole span — without it, two concurrent `add_bookmark`/
/// `remove_bookmark` calls for the same account (e.g. bookmarking from two
/// windows, or a rapid double-click racing its own retry) could each load
/// the pre-mutation list, and whichever writes last would silently discard
/// the other's change.
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

    let account_key = account_key_for_client(&client)?;
    let entry = build_bookmark_entry(&room_id, &event_id, &client, &timeline, media_cache).await?;

    let lock = persistence::bookmarks_lock(&account_key);
    let _guard = lock.lock().await;
    let mut bookmarks: Vec<StoredBookmark> = persistence::load_bookmarks(&app, &account_key)?;
    if bookmarks.iter().any(|b| b.event_id == event_id) {
        return Ok(());
    }
    bookmarks.push(StoredBookmark {
        room_id: entry.room_id,
        event_id: entry.event_id,
        saved_at_ms: entry.saved_at_ms,
    });
    persistence::save_bookmarks(&app, &account_key, &bookmarks)
}

/// Removes a bookmark by `event_id` — a no-op if it isn't currently
/// bookmarked. Only `event_id` is needed: bookmarked event ids are already
/// unique within one account's list (a room/event-id pair can only be
/// bookmarked once, per [`add_bookmark`]'s dedupe check). See
/// [`add_bookmark`]'s doc comment for why this is guarded by the same
/// per-account lock.
#[tauri::command]
pub async fn remove_bookmark(
    app: AppHandle,
    state: State<'_, MatrixState>,
    event_id: String,
) -> Result<(), String> {
    let account_key = account_key_for_current_user(&state).await?;
    let lock = persistence::bookmarks_lock(&account_key);
    let _guard = lock.lock().await;
    let mut bookmarks: Vec<StoredBookmark> = persistence::load_bookmarks(&app, &account_key)?;
    bookmarks.retain(|b| b.event_id != event_id);
    persistence::save_bookmarks(&app, &account_key, &bookmarks)
}

/// Lists every bookmark for the current account, newest-saved first — the
/// Saved Messages view's data source. Purely local; no Matrix sync/send
/// traffic. Each bookmark's sender/preview/timestamp is resolved live from
/// that room's timeline if it's currently open in this session (see the
/// module doc); otherwise a placeholder preview is used rather than
/// persisting or re-fetching message content.
#[tauri::command]
pub async fn list_bookmarks(
    app: AppHandle,
    state: State<'_, MatrixState>,
) -> Result<Vec<BookmarkEntry>, String> {
    let account_key = account_key_for_current_user(&state).await?;
    // Review fix: without taking the same lock `add_bookmark`/`remove_bookmark`
    // hold across their read-modify-write, this read could land mid-write —
    // observing the file after `std::fs::write` has truncated it but before
    // the new contents are fully written, surfacing a parse error or a
    // transiently empty/stale list.
    let lock = persistence::bookmarks_lock(&account_key);
    let mut bookmarks: Vec<StoredBookmark> = {
        let _guard = lock.lock().await;
        persistence::load_bookmarks(&app, &account_key)?
    };
    bookmarks.sort_by_key(|b| std::cmp::Reverse(b.saved_at_ms));

    let client = state.require_client().await.ok();
    let media_cache = state.require_media_cache(&app).await.ok();

    let mut entries = Vec::with_capacity(bookmarks.len());
    for bookmark in bookmarks {
        let resolved = match (&client, RoomId::parse(&bookmark.room_id)) {
            (Some(client), Ok(parsed_room_id)) => {
                match state.peek_timeline(&parsed_room_id).await {
                    Some(timeline) => {
                        resolve_from_timeline(&bookmark.event_id, client, &timeline, media_cache)
                            .await
                    }
                    // Room isn't open this session — leave the preview
                    // unresolved rather than issuing a homeserver `/context`
                    // lookup here. Review fix: `list_bookmarks` must stay
                    // entirely local per Spec 12's data-flow ("purely local
                    // reads/writes... no new Matrix sync/send traffic") — an
                    // earlier version resolved previews for the whole
                    // saved-messages list via a server-side context lookup,
                    // meaning simply opening the panel fired one round-trip
                    // per bookmark: leaking the user's saved-event access
                    // pattern to the homeserver and risking the panel
                    // blocking on network timeouts. A network round-trip is
                    // reserved for the explicit jump-to-message action
                    // (`timeline::load_timeline_around_event`'s fallback),
                    // where it's expected because the user asked to navigate
                    // there.
                    None => None,
                }
            }
            _ => None,
        };

        entries.push(match resolved {
            Some((sender, sender_display_name, body_preview, timestamp_ms)) => BookmarkEntry {
                room_id: bookmark.room_id,
                event_id: bookmark.event_id,
                saved_at_ms: bookmark.saved_at_ms,
                sender,
                sender_display_name,
                body_preview,
                timestamp_ms,
            },
            None => BookmarkEntry {
                room_id: bookmark.room_id,
                event_id: bookmark.event_id,
                saved_at_ms: bookmark.saved_at_ms,
                sender: String::new(),
                sender_display_name: None,
                body_preview: UNRESOLVED_PREVIEW.to_string(),
                // No message-sent timestamp is known without resolving the
                // event; falling back to `saved_at_ms` rather than `0` keeps
                // this entry's sort-adjacent display value plausible.
                timestamp_ms: bookmark.saved_at_ms,
            },
        });
    }

    Ok(entries)
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
