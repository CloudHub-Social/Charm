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
#[derive(Debug, Clone, Default, PartialEq, Eq, serde::Serialize, serde::Deserialize, ts_rs::TS)]
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
    /// Rollups keyed by space room id. Each value sums descendant rooms via
    /// `RoomSummary.parent_space_ids`, so rooms nested under a sub-space
    /// also count for every ancestor space currently present in the room
    /// snapshot.
    pub spaces: std::collections::HashMap<String, SpaceBadgeState>,
}

/// Unread/highlight rollup for a single space.
#[derive(
    Debug, Clone, Copy, Default, PartialEq, Eq, serde::Serialize, serde::Deserialize, ts_rs::TS,
)]
#[ts(export, export_to = "../src/bindings/")]
pub struct SpaceBadgeState {
    /// Number of child rooms with `has_unread() == true`.
    #[ts(type = "number")]
    pub total_unread: u32,
    /// Sum of child-room `unread_count`.
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
    let spaces = compute_space_badge_states(rooms);
    BadgeState {
        total_unread,
        total_highlight,
        spaces,
    }
}

fn compute_space_badge_states(
    rooms: &[RoomSummary],
) -> std::collections::HashMap<String, SpaceBadgeState> {
    let mut badges = std::collections::HashMap::new();
    let parents_by_room = rooms
        .iter()
        .map(|room| (room.room_id.as_str(), room.parent_space_ids.as_slice()))
        .collect::<std::collections::HashMap<_, _>>();

    for room in rooms {
        if room.is_space {
            continue;
        }

        let has_unread = super::rooms::has_unread(
            room.is_marked_unread,
            room.is_muted,
            room.unread_messages,
            room.unread_count,
        );
        let highlight = u32::try_from(room.unread_count).unwrap_or(u32::MAX);
        if !has_unread && highlight == 0 {
            continue;
        }
        for_each_ancestor_space_id(&room.room_id, &parents_by_room, |space_id| {
            let badge: &mut SpaceBadgeState = badges.entry(space_id.to_owned()).or_default();
            if has_unread {
                badge.total_unread = badge.total_unread.saturating_add(1);
            }
            badge.total_highlight = badge.total_highlight.saturating_add(highlight);
        });
    }
    badges
}

fn for_each_ancestor_space_id(
    room_id: &str,
    parents_by_room: &std::collections::HashMap<&str, &[String]>,
    mut visit_ancestor: impl FnMut(&str),
) {
    let mut seen = std::collections::HashSet::new();
    let mut stack = vec![room_id];

    while let Some(current_room_id) = stack.pop() {
        let Some(parents) = parents_by_room.get(current_room_id) else {
            continue;
        };
        for parent in parents.iter().rev() {
            let parent_id = parent.as_str();
            if seen.insert(parent_id) {
                visit_ancestor(parent_id);
                stack.push(parent_id);
            }
        }
    }
}

/// Whether a new message in `event_room_id` should produce a local
/// notification, given which room (if any) currently has focus, whether the
/// target room is muted or set to mentions-and-keywords-only, and whether
/// this particular message is a highlight (mention/keyword match) in that
/// room.
///
/// A muted room never notifies regardless of focus (matches `has_unread`'s
/// treatment of ambient unread in muted rooms). A mentions-and-keywords-only
/// room only notifies for messages that actually are a highlight — an
/// ambient (non-mention) message there is suppressed the same as it would be
/// in the in-app unread rail. The focused room never notifies for its own
/// new messages, since the user is already looking at it.
pub fn should_notify(
    focused_room_id: Option<&str>,
    event_room_id: &str,
    is_muted: bool,
    mentions_only: bool,
    is_highlighted: bool,
) -> bool {
    if is_muted {
        return false;
    }
    if mentions_only && !is_highlighted {
        return false;
    }
    focused_room_id != Some(event_room_id)
}

/// Whether a message's `m.mentions` content targets the signed-in user
/// (directly, or via a whole-room mention) — the per-message highlight
/// signal `should_notify` needs for mentions-and-keywords-only rooms. Only
/// covers `m.mentions`-based mentions (MSC3952); a homeserver-side keyword
/// push rule with no `m.mentions` payload isn't detected by this — that's a
/// narrower, documented gap rather than a claim of full push-rule parity.
pub fn is_highlighted_mentions(
    mentions: Option<&matrix_sdk::ruma::events::Mentions>,
    own_user_id: &str,
) -> bool {
    mentions.is_some_and(|m| m.room || m.user_ids.iter().any(|u| u.as_str() == own_user_id))
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
        #[cfg(target_os = "macos")]
        {
            let badge = (count > 0).then_some(count as i64);
            let _ = window.set_badge_count(badge);
        }
        #[cfg(target_os = "windows")]
        {
            // A pre-baked dot rather than rendering the actual digits — a
            // numeric taskbar overlay is a much bigger lift (real text
            // rasterization) for a signal that's already coarse ("you have
            // unread" vs. an exact count, which the in-app rail already
            // shows); this matches the spec's own call to prefer a
            // pre-baked/simple badge over per-count icon generation.
            let _ = window.set_overlay_icon(windows_overlay_icon(count));
        }
        let _ = window;
        let _ = count;
    }
    Ok(())
}

/// Builds a small solid-red-dot RGBA icon for the Windows taskbar overlay
/// when `count > 0`, or `None` (clearing any existing overlay) at 0.
#[cfg(target_os = "windows")]
fn windows_overlay_icon(count: u32) -> Option<tauri::image::Image<'static>> {
    if count == 0 {
        return None;
    }
    const SIZE: u32 = 32;
    const RADIUS: f32 = (SIZE as f32) / 2.0 - 1.0;
    const CENTER: f32 = (SIZE as f32) / 2.0;

    let mut rgba = vec![0u8; (SIZE * SIZE * 4) as usize];
    for y in 0..SIZE {
        for x in 0..SIZE {
            let dx = x as f32 + 0.5 - CENTER;
            let dy = y as f32 + 0.5 - CENTER;
            let inside = dx * dx + dy * dy <= RADIUS * RADIUS;
            let idx = ((y * SIZE + x) * 4) as usize;
            if inside {
                rgba[idx] = 220; // R
                rgba[idx + 1] = 38; // G
                rgba[idx + 2] = 38; // B
                rgba[idx + 3] = 255; // A
            }
        }
    }
    Some(tauri::image::Image::new_owned(rgba, SIZE, SIZE))
}

/// The fields of a new message `maybe_send_notification` needs, grouped so
/// the function itself doesn't take an unwieldy number of bare parameters.
pub struct NewMessageNotification<'a> {
    pub event_id: &'a str,
    pub sender: &'a str,
    pub sender_display_name: Option<&'a str>,
    pub body: &'a str,
}

/// Builds and fires a local notification for one message, if it warrants
/// one — the single decision+fire path shared by the opened-room timeline
/// listener (`timeline::maybe_notify_new_message`) and the sync loop's
/// unopened-room path (`sync::notify_unopened_room_messages`), so both agree
/// on mute/mentions-only/focus suppression instead of each re-implementing
/// it. Also the natural place for Spec 11 to plug in a push-decrypted
/// message later.
///
/// `event_id` gates on `MatrixState::mark_notified` before doing anything
/// else — a room can transition between the opened/unopened-room paths
/// while a notification for it is in flight (see `notified_event_ids`'s doc
/// comment), so this is the one place both agree not to double-fire for the
/// same event.
///
/// `fetch_mentions` is a lazy callback rather than a plain `Option` so
/// `room.notification_mode()` is only ever read once, here: reading it once
/// in a caller to decide whether to bother fetching mentions and again in
/// here to make the final mute/mentions-only decision left a window where a
/// room's mode could change between the two reads, potentially reaching a
/// mentions-only decision without ever having fetched the mentions needed to
/// evaluate it.
pub async fn maybe_send_notification<F, Fut>(
    app: &AppHandle,
    room: &matrix_sdk::Room,
    own_user_id: Option<&matrix_sdk::ruma::UserId>,
    message: NewMessageNotification<'_>,
    fetch_mentions: F,
) where
    F: FnOnce() -> Fut,
    Fut: std::future::Future<Output = Option<matrix_sdk::ruma::events::Mentions>>,
{
    use tauri_plugin_notification::NotificationExt;

    let NewMessageNotification {
        event_id,
        sender,
        sender_display_name,
        body,
    } = message;

    if own_user_id.is_some_and(|me| me.as_str() == sender) {
        return;
    }
    if !app.state::<MatrixState>().mark_notified(event_id) {
        return;
    }

    let mode = room.notification_mode().await;
    let is_muted = matches!(
        mode,
        Some(matrix_sdk::notification_settings::RoomNotificationMode::Mute)
    );
    let mentions_only = matches!(
        mode,
        Some(matrix_sdk::notification_settings::RoomNotificationMode::MentionsAndKeywordsOnly)
    );
    let mentions = if mentions_only {
        fetch_mentions().await
    } else {
        None
    };
    let is_highlighted =
        own_user_id.is_some_and(|me| is_highlighted_mentions(mentions.as_ref(), me.as_str()));

    let focused_room_id = app
        .state::<MatrixState>()
        .focused_room_id
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .clone();
    if !should_notify(
        focused_room_id.as_deref(),
        room.room_id().as_str(),
        is_muted,
        mentions_only,
        is_highlighted,
    ) {
        return;
    }

    let display_name = match room.cached_display_name() {
        Some(name) => name,
        None => room
            .display_name()
            .await
            .unwrap_or(matrix_sdk::RoomDisplayName::Empty),
    };
    let room_name = match display_name {
        matrix_sdk::RoomDisplayName::Empty => None,
        other => Some(other.to_string()),
    };

    let (title, notif_body) =
        build_notification(room_name.as_deref(), sender_display_name, sender, body);
    let _ = app
        .notification()
        .builder()
        .title(title)
        .body(notif_body)
        .show();
}

/// Whether this build targets a desktop OS (macOS/Windows/Linux) as opposed
/// to mobile (iOS/Android) — Tauri's own `desktop`/`mobile` `cfg` flags,
/// exposed to the frontend so it can gate desktop-only settings (autostart)
/// on the actual target rather than viewport width, which a Tauri mobile
/// build at a tablet/landscape size could satisfy despite having none of
/// `get_autostart`'s underlying capability.
#[tauri::command]
pub fn is_desktop_platform() -> bool {
    cfg!(desktop)
}

/// Whether the app is currently registered to launch on login. Desktop-only:
/// autostart isn't a mobile concept, and `tauri-plugin-autostart`'s
/// `ManagerExt`/`autolaunch()` aren't available on mobile builds (mirrors the
/// `#[cfg(desktop)]` gate already around the plugin's registration in
/// `lib.rs`). (Independently fixed on `main` in #46 as well as here — same
/// finding; merge-resolved by keeping `main`'s split-function shape.)
#[cfg(desktop)]
#[tauri::command]
pub fn get_autostart(app: AppHandle) -> Result<bool, String> {
    use tauri_plugin_autostart::ManagerExt;
    app.autolaunch().is_enabled().map_err(|e| e.to_string())
}

#[cfg(not(desktop))]
#[tauri::command]
pub fn get_autostart(_app: AppHandle) -> Result<bool, String> {
    Ok(false)
}

/// Enables/disables launch-on-login. Desktop-only — see [`get_autostart`].
#[cfg(desktop)]
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

#[cfg(not(desktop))]
#[tauri::command]
pub fn set_autostart(_app: AppHandle, _enabled: bool) -> Result<(), String> {
    Err("autostart is not supported on mobile".to_string())
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
        assert!(badge.spaces.is_empty());
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
    fn space_badges_roll_up_direct_child_rooms() {
        let mut unread = room(4, 2, false, false);
        unread.room_id = "!child-a:example.org".to_string();
        unread.parent_space_ids = vec!["!space:example.org".to_string()];

        let mut muted_ambient = room(5, 0, true, false);
        muted_ambient.room_id = "!child-b:example.org".to_string();
        muted_ambient.parent_space_ids = vec!["!space:example.org".to_string()];

        let mut space = room(0, 0, false, false);
        space.room_id = "!space:example.org".to_string();
        space.is_space = true;

        let badge = compute_badge_state(&[space, unread, muted_ambient]);

        assert_eq!(
            badge.spaces.get("!space:example.org"),
            Some(&SpaceBadgeState {
                total_unread: 1,
                total_highlight: 2
            })
        );
    }

    #[test]
    fn space_badges_roll_up_nested_descendants_to_ancestors() {
        let mut nested_room = room(1, 1, false, false);
        nested_room.room_id = "!nested-room:example.org".to_string();
        nested_room.parent_space_ids = vec!["!subspace:example.org".to_string()];

        let mut subspace = room(0, 0, false, false);
        subspace.room_id = "!subspace:example.org".to_string();
        subspace.is_space = true;
        subspace.parent_space_ids = vec!["!root-space:example.org".to_string()];

        let mut root = room(0, 0, false, false);
        root.room_id = "!root-space:example.org".to_string();
        root.is_space = true;

        let badge = compute_badge_state(&[root, subspace, nested_room]);

        assert_eq!(
            badge.spaces.get("!subspace:example.org"),
            Some(&SpaceBadgeState {
                total_unread: 1,
                total_highlight: 1
            })
        );
        assert_eq!(
            badge.spaces.get("!root-space:example.org"),
            Some(&SpaceBadgeState {
                total_unread: 1,
                total_highlight: 1
            })
        );
    }

    #[test]
    fn space_badges_keep_direct_parent_when_intermediate_space_is_missing() {
        let mut nested_room = room(1, 1, false, false);
        nested_room.room_id = "!nested-room:example.org".to_string();
        nested_room.parent_space_ids = vec!["!missing-subspace:example.org".to_string()];

        let mut root = room(0, 0, false, false);
        root.room_id = "!root-space:example.org".to_string();
        root.is_space = true;

        let badge = compute_badge_state(&[root, nested_room]);

        assert_eq!(
            badge.spaces.get("!missing-subspace:example.org"),
            Some(&SpaceBadgeState {
                total_unread: 1,
                total_highlight: 1
            })
        );
        assert!(!badge.spaces.contains_key("!root-space:example.org"));
    }

    #[test]
    fn space_badges_omit_zero_value_spaces() {
        let mut quiet_room = room(0, 0, false, false);
        quiet_room.room_id = "!quiet-room:example.org".to_string();
        quiet_room.parent_space_ids = vec!["!space:example.org".to_string()];

        let mut space = room(0, 0, false, false);
        space.room_id = "!space:example.org".to_string();
        space.is_space = true;

        let badge = compute_badge_state(&[space, quiet_room]);

        assert!(badge.spaces.is_empty());
    }

    #[test]
    fn focused_room_is_suppressed() {
        assert!(!should_notify(Some("!a:x"), "!a:x", false, false, false));
    }

    #[test]
    fn different_room_than_focused_still_notifies() {
        assert!(should_notify(Some("!a:x"), "!b:x", false, false, false));
    }

    #[test]
    fn no_focused_room_notifies() {
        assert!(should_notify(None, "!a:x", false, false, false));
    }

    #[test]
    fn muted_room_never_notifies_even_unfocused() {
        assert!(!should_notify(Some("!other:x"), "!a:x", true, false, false));
    }

    #[test]
    fn mentions_only_room_suppresses_non_highlighted_message() {
        assert!(!should_notify(None, "!a:x", false, true, false));
    }

    #[test]
    fn mentions_only_room_notifies_a_highlighted_message() {
        assert!(should_notify(None, "!a:x", false, true, true));
    }

    #[test]
    fn mentions_only_still_suppressed_when_target_room_is_focused() {
        assert!(!should_notify(Some("!a:x"), "!a:x", false, true, true));
    }

    #[test]
    fn all_messages_mode_notifies_regardless_of_highlight() {
        assert!(should_notify(None, "!a:x", false, false, false));
    }

    #[test]
    fn mentions_targeting_own_user_id_are_highlighted() {
        use matrix_sdk::ruma::events::Mentions;
        use matrix_sdk::ruma::user_id;
        let mut mentions = Mentions::new();
        mentions
            .user_ids
            .insert(user_id!("@me:example.org").to_owned());
        assert!(is_highlighted_mentions(Some(&mentions), "@me:example.org"));
        assert!(!is_highlighted_mentions(
            Some(&mentions),
            "@someone-else:example.org"
        ));
    }

    #[test]
    fn whole_room_mention_is_highlighted_for_anyone() {
        use matrix_sdk::ruma::events::Mentions;
        let mut mentions = Mentions::new();
        mentions.room = true;
        assert!(is_highlighted_mentions(
            Some(&mentions),
            "@anyone:example.org"
        ));
    }

    #[test]
    fn no_mentions_content_is_never_highlighted() {
        assert!(!is_highlighted_mentions(None, "@me:example.org"));
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
