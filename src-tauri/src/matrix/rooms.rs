//! Room organization: favourite/low-priority tags, mute, mark-unread, manual
//! ordering, and the single `has_unread` invariant every unread indicator in
//! the UI reads from (computed once here, in [`snapshot_rooms`] via
//! [`has_unread`], never re-derived per-component — see Spec 06).

use matrix_sdk::notification_settings::RoomNotificationMode;
use matrix_sdk::room::Room;
use matrix_sdk::ruma::events::tag::{TagInfo, TagName, UserTagName};
use matrix_sdk::Client;
use std::str::FromStr;
use tauri::State;

use super::MatrixState;

/// The tag a room's manual order lives on: whichever section tag is
/// currently set (Favourite/LowPriority), or a dedicated user tag for rooms
/// with no section tag at all (the plain "Rooms" section) — so drag-reorder
/// persists everywhere, not just in the two special sections.
pub(crate) fn order_tag_name(is_favourite: bool, is_low_priority: bool) -> TagName {
    if is_favourite {
        TagName::Favorite
    } else if is_low_priority {
        TagName::LowPriority
    } else {
        TagName::User(UserTagName::from_str("u.order").expect("valid user tag name"))
    }
}

fn parse_room(client: &Client, room_id: &str) -> Result<Room, String> {
    let parsed_room_id = matrix_sdk::ruma::RoomId::parse(room_id).map_err(|e| e.to_string())?;
    client
        .get_room(&parsed_room_id)
        .ok_or_else(|| format!("room {room_id} not found"))
}

/// The single authoritative "does this room need attention" signal.
///
/// Muted rooms with only ambient unread messages don't count — an explicit
/// mark-unread flag or a real notification (e.g. a mention, which still
/// generates a notification-count even in a muted room) always does.
pub fn has_unread(
    is_marked_unread: bool,
    is_muted: bool,
    unread_messages: u64,
    unread_count: u64,
) -> bool {
    is_marked_unread || (!is_muted && unread_messages > 0) || unread_count > 0
}

#[tauri::command]
pub async fn set_room_favourite(
    state: State<'_, MatrixState>,
    room_id: String,
    favourite: bool,
) -> Result<(), String> {
    let client = state.require_client().await?;
    let room = parse_room(&client, &room_id)?;
    room.set_is_favourite(favourite, None)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn set_room_low_priority(
    state: State<'_, MatrixState>,
    room_id: String,
    low_priority: bool,
) -> Result<(), String> {
    let client = state.require_client().await?;
    let room = parse_room(&client, &room_id)?;
    room.set_is_low_priority(low_priority, None)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn set_room_muted(
    state: State<'_, MatrixState>,
    room_id: String,
    muted: bool,
) -> Result<(), String> {
    let client = state.require_client().await?;
    let parsed_room_id = matrix_sdk::ruma::RoomId::parse(&room_id).map_err(|e| e.to_string())?;
    let room = client
        .get_room(&parsed_room_id)
        .ok_or_else(|| format!("room {room_id} not found"))?;

    let mode = if muted {
        RoomNotificationMode::Mute
    } else {
        // Unmuting restores this room's default (encrypted / DM-vs-not)
        // notification mode rather than hardcoding `AllMessages` — we can't
        // just re-read `room.notification_mode()` here since the room is
        // *currently* muted, so that would just echo `Mute` back.
        let is_encrypted = room
            .latest_encryption_state()
            .await
            .map(|state| state.is_encrypted())
            .unwrap_or(false);
        let is_one_to_one = room.active_members_count() == 2;
        client
            .notification_settings()
            .await
            .get_default_room_notification_mode(is_encrypted.into(), is_one_to_one.into())
            .await
    };

    client
        .notification_settings()
        .await
        .set_room_notification_mode(&parsed_room_id, mode)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn set_room_marked_unread(
    state: State<'_, MatrixState>,
    room_id: String,
    unread: bool,
) -> Result<(), String> {
    let client = state.require_client().await?;
    let room = parse_room(&client, &room_id)?;
    room.set_unread_flag(unread)
        .await
        .map_err(|e| e.to_string())
}

/// Persists a drag-reorder as a fractional-index midpoint on whichever tag
/// currently governs this room's section (see [`order_tag_name`]) — the
/// caller (`RoomList.tsx`) computes `order` as the midpoint between the two
/// neighbouring rooms' `manual_order` in the same section.
#[tauri::command]
pub async fn set_room_manual_order(
    state: State<'_, MatrixState>,
    room_id: String,
    order: f64,
) -> Result<(), String> {
    let client = state.require_client().await?;
    let room = parse_room(&client, &room_id)?;

    let tag = order_tag_name(room.is_favourite(), room.is_low_priority());
    let mut tag_info = TagInfo::new();
    tag_info.order = Some(order);
    room.set_tag(tag, tag_info)
        .await
        .map_err(|e| e.to_string())?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Exhaustive truth table over the four inputs to [`has_unread`] — see
    /// Spec 06's "Unread invariant is the highest-risk item": getting this
    /// wrong (muted rooms flagged, or genuine unread hidden) undermines the
    /// whole room list, so every combination is checked explicitly rather
    /// than spot-checked.
    #[test]
    fn has_unread_truth_table() {
        struct Case {
            is_marked_unread: bool,
            is_muted: bool,
            unread_messages: u64,
            unread_count: u64,
            expected: bool,
        }

        let cases = [
            // Nothing going on at all: not unread.
            Case {
                is_marked_unread: false,
                is_muted: false,
                unread_messages: 0,
                unread_count: 0,
                expected: false,
            },
            // Explicit mark-unread always wins, regardless of mute/counts.
            Case {
                is_marked_unread: true,
                is_muted: false,
                unread_messages: 0,
                unread_count: 0,
                expected: true,
            },
            Case {
                is_marked_unread: true,
                is_muted: true,
                unread_messages: 0,
                unread_count: 0,
                expected: true,
            },
            Case {
                is_marked_unread: true,
                is_muted: true,
                unread_messages: 5,
                unread_count: 5,
                expected: true,
            },
            // Ambient unread messages in an unmuted room: unread.
            Case {
                is_marked_unread: false,
                is_muted: false,
                unread_messages: 1,
                unread_count: 0,
                expected: true,
            },
            // Ambient unread messages in a MUTED room, no real notification: NOT unread.
            Case {
                is_marked_unread: false,
                is_muted: true,
                unread_messages: 3,
                unread_count: 0,
                expected: false,
            },
            // A mention/notification in a muted room still counts.
            Case {
                is_marked_unread: false,
                is_muted: true,
                unread_messages: 3,
                unread_count: 1,
                expected: true,
            },
            // A mention/notification in an unmuted room counts (even with zero unread_messages).
            Case {
                is_marked_unread: false,
                is_muted: false,
                unread_messages: 0,
                unread_count: 1,
                expected: true,
            },
            // Unmuted, unread_count set alongside unread_messages: still unread.
            Case {
                is_marked_unread: false,
                is_muted: false,
                unread_messages: 2,
                unread_count: 1,
                expected: true,
            },
        ];

        for (i, case) in cases.iter().enumerate() {
            assert_eq!(
                has_unread(
                    case.is_marked_unread,
                    case.is_muted,
                    case.unread_messages,
                    case.unread_count,
                ),
                case.expected,
                "case {i} failed: {:?} {:?} {:?} {:?}",
                case.is_marked_unread,
                case.is_muted,
                case.unread_messages,
                case.unread_count,
            );
        }
    }

    #[test]
    fn order_tag_prefers_favourite_over_low_priority() {
        assert_eq!(order_tag_name(true, true), TagName::Favorite);
        assert_eq!(order_tag_name(true, false), TagName::Favorite);
        assert_eq!(order_tag_name(false, true), TagName::LowPriority);
        assert_eq!(
            order_tag_name(false, false),
            TagName::User(UserTagName::from_str("u.order").unwrap())
        );
    }
}
