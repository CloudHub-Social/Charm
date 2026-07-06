//! Room member lookup backing the composer's `@` mention autocomplete.

use matrix_sdk::ruma::RoomId;
use matrix_sdk::{Client, RoomMemberships};
use serde::{Deserialize, Serialize};
use tauri::State;
use ts_rs::TS;

use super::MatrixState;

/// A room member as offered by the `@` mention autocomplete. Deliberately
/// thin — just enough to filter and render a suggestion row and build a
/// mention pill.
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../src/bindings/")]
pub struct RoomMemberSummary {
    pub user_id: String,
    pub display_name: Option<String>,
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

    Ok(members
        .into_iter()
        .map(|m| RoomMemberSummary {
            user_id: m.user_id().to_string(),
            display_name: m.display_name().map(ToOwned::to_owned),
        })
        .collect())
}
