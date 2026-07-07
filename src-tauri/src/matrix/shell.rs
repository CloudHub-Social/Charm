//! Native platform shell support (Spec 10): total-unread badge aggregation,
//! focused-room tracking for notification suppression, and the
//! title/body-building logic for local OS notifications. Kept independent of
//! `tray`/menu/window-state wiring (that lives in `lib.rs`'s `setup()`) so the
//! pure aggregation/suppression logic here is unit-testable without a running
//! `AppHandle`.
//!
//! `build_notification` is deliberately factored out from any Rust-side
//! "should I actually send one" decision so Spec 11 (remote push /
//! push-decrypt notifications) can reuse the exact same title/body shaping
//! for a notification it triggers from a different source (a decrypted push
//! payload instead of a live `Timeline` diff) without duplicating this logic.

use tauri::{AppHandle, Manager, State};

use super::rooms::RoomSummary;
use super::MatrixState;

/// Total unread state across every room, derived from the same
/// [`super::rooms::has_unread`] signal `RoomSummary`/the room list already
/// use — never re-derived from a naive per-room message count, so a muted
/// room with only ambient unread never inflates the badge, while an explicit
/// mark-unread or a real mention (which still carries a nonzero
/// `unread_count` even in a muted room) always does.
#[derive(
    Debug, Clone, Copy, Default, PartialEq, Eq, serde::Serialize, serde::Deserialize, ts_rs::TS,
)]
#[ts(export, export_to = "../src/bindings/")]
pub struct BadgeState {
    /// Number of rooms with `has_unread() == true`.
    #[ts(type = "number")]
    pub total_unread: u32,
    /// Sum of `unread_count` (mention/highlight notifications) across every
    /// room — a finer-grained signal than `total_unread` for surfacing "you
    /// were mentioned N times" distinctly from ambient unread rooms.
    #[ts(type = "number")]
    pub total_highlight: u32,
}

/// Aggregates a room-list snapshot into the counts the native tray/dock/
/// taskbar badge and the in-app rail both drive from. Pure and independent of
/// any `AppHandle` so it's directly unit-testable against a fixture
/// `Vec<RoomSummary>`.
pub fn compute_badge_state(rooms: &[RoomSummary]) -> BadgeState {
    let mut total_unread: u32 = 0;
    let mut total_highlight: u32 = 0;
    for room in rooms {
        if super::rooms::has_unread(
            room.is_marked_unread,
            room.is_muted,
            room.unread_messages,
            room.unread_count,
        ) {
            total_unread += 1;
        }
        total_highlight =
            total_highlight.saturating_add(u32::try_from(room.unread_count).unwrap_or(u32::MAX));
    }
    BadgeState {
        total_unread,
        total_highlight,
    }
}

/// Whether a new message in `event_room_id` should produce a local
/// notification, given which room (if any) currently has focus and whether
/// the target room is muted.
///
/// A muted room never notifies regardless of focus (matches `has_unread`'s
/// treatment of ambient unread in muted rooms — only an explicit mention
/// still surfaces there, and mentions are Day-2 for notification routing;
/// Day-1 suppression is the coarser mute+focus check the acceptance criteria
/// call for). The focused room never notifies for its own new messages,
/// since the user is already looking at it.
pub fn should_notify(focused_room_id: Option<&str>, event_room_id: &str, is_muted: bool) -> bool {
    if is_muted {
        return false;
    }
    focused_room_id != Some(event_room_id)
}

/// Builds the (title, body) pair for a local notification from a Matrix
/// message. Factored out so Spec 11's push-decrypt notifications can reuse
/// the exact same shaping without duplicating it.
///
/// Title prefers the room name (so a DM or group chat is identified by the
/// conversation, not just the sender) and falls back to the sender's display
/// name when the room has none (e.g. a not-yet-named DM). Body is the raw
/// message preview, truncated to a sane notification length.
pub fn build_notification(
    room_name: Option<&str>,
    sender_display_name: Option<&str>,
    sender: &str,
    body: &str,
) -> (String, String) {
    const MAX_BODY_CHARS: usize = 200;

    let sender_label = sender_display_name.unwrap_or(sender);
    let title = match room_name {
        Some(name) if !name.is_empty() => name.to_string(),
        _ => sender_label.to_string(),
    };

    let truncated_body: String = if body.chars().count() > MAX_BODY_CHARS {
        let mut truncated: String = body.chars().take(MAX_BODY_CHARS).collect();
        truncated.push('…');
        truncated
    } else {
        body.to_string()
    };

    // When the room name already identifies the conversation, prefix the
    // body with the sender so group chats/rooms still show who sent it.
    let body = if room_name.is_some_and(|n| !n.is_empty()) {
        format!("{sender_label}: {truncated_body}")
    } else {
        truncated_body
    };

    (title, body)
}

/// Records which room (if any) currently has focus in the frontend — read by
/// the timeline listener's notification-suppression check
/// ([`should_notify`]). `None` means no room is focused (e.g. the rooms list
/// itself, or settings, is showing).
#[tauri::command]
pub async fn set_focused_room(
    state: State<'_, MatrixState>,
    room_id: Option<String>,
) -> Result<(), String> {
    *state
        .focused_room_id
        .lock()
        .unwrap_or_else(|e| e.into_inner()) = room_id;
    Ok(())
}

/// Updates the native dock badge (macOS)/taskbar overlay (Windows)/tray icon
/// state to reflect `count`. Thin wrapper the sync loop also calls internally
/// after every `badge:update` emit — exposed as a command too so the
/// frontend can force a refresh (e.g. after marking all rooms read) without
/// waiting for the next sync iteration.
#[tauri::command]
pub fn set_badge_count(app: AppHandle, count: u32) -> Result<(), String> {
    apply_native_badge(&app, count)
}

/// Platform-specific badge application, shared by [`set_badge_count`] and the
/// sync loop's per-iteration `badge:update` emit.
pub fn apply_native_badge(app: &AppHandle, count: u32) -> Result<(), String> {
    if let Some(window) = app.get_webview_window("main") {
        let badge = (count > 0).then_some(count as i64);
        #[cfg(target_os = "macos")]
        {
            let _ = window.set_badge_count(badge);
        }
        #[cfg(target_os = "windows")]
        {
            let _ = window.set_overlay_icon(None);
            let _ = badge;
        }
        let _ = window;
    }
    Ok(())
}

/// Whether the app is currently registered to launch on login.
#[tauri::command]
pub fn get_autostart(app: AppHandle) -> Result<bool, String> {
    use tauri_plugin_autostart::ManagerExt;
    app.autolaunch().is_enabled().map_err(|e| e.to_string())
}

/// Enables/disables launch-on-login.
#[tauri::command]
pub fn set_autostart(app: AppHandle, enabled: bool) -> Result<(), String> {
    use tauri_plugin_autostart::ManagerExt;
    let autostart = app.autolaunch();
    if enabled {
        autostart.enable().map_err(|e| e.to_string())
    } else {
        autostart.disable().map_err(|e| e.to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn room(
        unread_messages: u64,
        unread_count: u64,
        is_muted: bool,
        is_marked_unread: bool,
    ) -> RoomSummary {
        RoomSummary {
            room_id: "!r:example.org".to_string(),
            name: Some("Room".to_string()),
            unread_count,
            unread_messages,
            is_marked_unread,
            is_muted,
            notification_mode: None,
            is_favourite: false,
            is_low_priority: false,
            manual_order: None,
            is_space: false,
            parent_space_ids: Vec::new(),
            is_direct: false,
            has_unread: super::super::rooms::has_unread(
                is_marked_unread,
                is_muted,
                unread_messages,
                unread_count,
            ),
            avatar_url: None,
            avatar_path: None,
            dm_peer_user_id: None,
        }
    }

    #[test]
    fn muted_room_with_only_ambient_unread_does_not_count() {
        let rooms = vec![room(3, 0, true, false)];
        let badge = compute_badge_state(&rooms);
        assert_eq!(badge.total_unread, 0);
        assert_eq!(badge.total_highlight, 0);
    }

    #[test]
    fn muted_room_with_a_mention_still_counts() {
        let rooms = vec![room(3, 1, true, false)];
        let badge = compute_badge_state(&rooms);
        assert_eq!(badge.total_unread, 1);
        assert_eq!(badge.total_highlight, 1);
    }

    #[test]
    fn explicit_mark_unread_counts_even_muted_with_no_messages() {
        let rooms = vec![room(0, 0, true, true)];
        let badge = compute_badge_state(&rooms);
        assert_eq!(badge.total_unread, 1);
        assert_eq!(badge.total_highlight, 0);
    }

    #[test]
    fn total_unread_sums_across_multiple_rooms() {
        let rooms = vec![
            room(1, 0, false, false),
            room(0, 0, false, false),
            room(5, 2, false, false),
        ];
        let badge = compute_badge_state(&rooms);
        assert_eq!(badge.total_unread, 2);
        assert_eq!(badge.total_highlight, 2);
    }

    #[test]
    fn focused_room_is_suppressed() {
        assert!(!should_notify(Some("!a:x"), "!a:x", false));
    }

    #[test]
    fn different_room_than_focused_still_notifies() {
        assert!(should_notify(Some("!a:x"), "!b:x", false));
    }

    #[test]
    fn no_focused_room_notifies() {
        assert!(should_notify(None, "!a:x", false));
    }

    #[test]
    fn muted_room_never_notifies_even_unfocused() {
        assert!(!should_notify(Some("!other:x"), "!a:x", true));
    }

    #[test]
    fn notification_title_prefers_room_name() {
        let (title, body) =
            build_notification(Some("Team Chat"), Some("Alice"), "@alice:x", "hi there");
        assert_eq!(title, "Team Chat");
        assert_eq!(body, "Alice: hi there");
    }

    #[test]
    fn notification_falls_back_to_sender_when_room_unnamed() {
        let (title, body) = build_notification(None, Some("Alice"), "@alice:x", "hi there");
        assert_eq!(title, "Alice");
        assert_eq!(body, "hi there");
    }

    #[test]
    fn notification_falls_back_to_mxid_when_no_display_name() {
        let (title, _) = build_notification(None, None, "@alice:x", "hi there");
        assert_eq!(title, "@alice:x");
    }

    #[test]
    fn notification_body_truncates_long_messages() {
        let long_body = "a".repeat(500);
        let (_, body) = build_notification(None, None, "@alice:x", &long_body);
        assert!(body.chars().count() <= 201);
        assert!(body.ends_with('…'));
    }
}
