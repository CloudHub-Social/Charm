//! Room member lookup backing the composer's `@` mention autocomplete and
//! (Spec 07) the right panel's member-management list.

use matrix_sdk::room::RoomMember;
use matrix_sdk::ruma::events::room::power_levels::UserPowerLevel;
use matrix_sdk::ruma::RoomId;
use matrix_sdk::{Client, RoomMemberships};
use serde::{Deserialize, Serialize};
use tauri::State;
use ts_rs::TS;

use super::room_admin::MembershipKind;
use super::MatrixState;

/// A room member as offered by the `@` mention autocomplete and the Spec 07
/// member-management panel — one shared shape/mapping ([`member_to_summary`])
/// for both, rather than two near-identical member DTOs.
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../src/bindings/")]
pub struct RoomMemberSummary {
    pub user_id: String,
    pub display_name: Option<String>,
    pub avatar_url: Option<String>,
    // See `PowerLevelThresholds`'s doc comment in `room_admin.rs` for why
    // this is `number`, not ts-rs's default `bigint`.
    #[ts(type = "number")]
    pub power_level: i64,
    pub membership: MembershipKind,
}

/// Shared mapping from an SDK `RoomMember` to the IPC-facing summary —
/// reused by both [`get_room_members`] (active-only, autocomplete) and
/// `room_admin::get_room_member_list` (all memberships, admin panel).
pub(crate) fn member_to_summary(member: &RoomMember) -> RoomMemberSummary {
    let power_level = match member.power_level() {
        UserPowerLevel::Infinite => i64::MAX,
        UserPowerLevel::Int(level) => level.into(),
        _ => 0,
    };
    RoomMemberSummary {
        user_id: member.user_id().to_string(),
        display_name: member.display_name().map(ToOwned::to_owned),
        avatar_url: member.avatar_url().map(ToString::to_string),
        power_level,
        membership: member.membership().into(),
    }
}

/// Lists this room's active (joined + invited) members from the already-
/// synced local store — `members_no_sync` rather than `members`, so this
/// never blocks on a network round-trip. Per the spec's stated latency
/// tradeoff, this deliberately doesn't cover members of a large room the
/// client hasn't fully synced yet.
#[tauri::command]
pub async fn get_room_members(
    state: State<'_, MatrixState>,
    room_id: String,
) -> Result<Vec<RoomMemberSummary>, String> {
    let client = state.require_client().await?;
    get_room_members_impl(&client, &room_id).await
}

/// Core logic behind [`get_room_members`].
pub async fn get_room_members_impl(
    client: &Client,
    room_id: &str,
) -> Result<Vec<RoomMemberSummary>, String> {
    let parsed_room_id = RoomId::parse(room_id).map_err(|e| e.to_string())?;
    let room = client
        .get_room(&parsed_room_id)
        .ok_or_else(|| format!("room {room_id} not found"))?;

    let members = room
        .members_no_sync(RoomMemberships::ACTIVE)
        .await
        .map_err(|e| e.to_string())?;

    Ok(members.iter().map(member_to_summary).collect())
}
