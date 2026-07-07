//! Space hierarchy browsing, join, and knock — Spec 06. Day 1 scope is a
//! collapsed grouped list (space -> child rooms), not a nested tree, so
//! `list_space_children` only fetches the first hierarchy page.

use matrix_sdk::ruma::api::client::space::get_hierarchy;
use matrix_sdk::ruma::room::JoinRuleSummary;
use matrix_sdk::ruma::{OwnedRoomOrAliasId, RoomId};
use matrix_sdk::Client;
use serde::{Deserialize, Serialize};
use tauri::State;
use ts_rs::TS;

use super::MatrixState;

#[derive(Debug, Clone, Copy, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../src/bindings/")]
#[serde(rename_all = "snake_case")]
pub enum SpaceJoinRule {
    Public,
    Knock,
    Invite,
    Restricted,
    Other,
}

impl From<&JoinRuleSummary> for SpaceJoinRule {
    fn from(rule: &JoinRuleSummary) -> Self {
        match rule {
            JoinRuleSummary::Public => SpaceJoinRule::Public,
            JoinRuleSummary::Knock | JoinRuleSummary::KnockRestricted(_) => SpaceJoinRule::Knock,
            JoinRuleSummary::Invite => SpaceJoinRule::Invite,
            JoinRuleSummary::Restricted(_) => SpaceJoinRule::Restricted,
            _ => SpaceJoinRule::Other,
        }
    }
}

/// One child room of a space, as returned by the `/hierarchy` endpoint —
/// Day-1 scope only reads the first page (see module docs), so large spaces
/// show a "load more" affordance instead of paginating automatically.
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../src/bindings/")]
pub struct SpaceChild {
    pub room_id: String,
    pub name: Option<String>,
    pub topic: Option<String>,
    // u64 serializes to a JS-safe integer here (member counts are small); emit `number`
    // rather than ts-rs's default `bigint` so the frontend can use it directly.
    #[ts(type = "number")]
    pub num_joined_members: u64,
    pub join_rule: SpaceJoinRule,
    pub is_space: bool,
}

/// Fetches the first page of `space_id`'s child-room hierarchy.
#[tauri::command]
pub async fn list_space_children(
    state: State<'_, MatrixState>,
    space_id: String,
) -> Result<Vec<SpaceChild>, String> {
    let client = state.require_client().await?;
    list_space_children_impl(&client, &space_id).await
}

/// Core logic behind [`list_space_children`].
pub async fn list_space_children_impl(
    client: &Client,
    space_id: &str,
) -> Result<Vec<SpaceChild>, String> {
    let parsed_space_id = RoomId::parse(space_id).map_err(|e| e.to_string())?;

    let request = get_hierarchy::v1::Request::new(parsed_space_id.clone());
    let response = client.send(request).await.map_err(|e| e.to_string())?;

    Ok(response
        .rooms
        .into_iter()
        // The hierarchy response includes the space itself as the first
        // entry (depth 0) — only its children are relevant here.
        .filter(|chunk| chunk.summary.room_id != parsed_space_id)
        .map(|chunk| SpaceChild {
            room_id: chunk.summary.room_id.to_string(),
            name: chunk.summary.name,
            topic: chunk.summary.topic,
            num_joined_members: chunk.summary.num_joined_members.into(),
            join_rule: SpaceJoinRule::from(&chunk.summary.join_rule),
            is_space: chunk
                .summary
                .room_type
                .as_ref()
                .is_some_and(|t| *t == matrix_sdk::ruma::room::RoomType::Space),
        })
        .collect())
}

fn parse_room_or_alias(input: &str) -> Result<OwnedRoomOrAliasId, String> {
    OwnedRoomOrAliasId::try_from(input.to_owned()).map_err(|e| e.to_string())
}

/// Joins a public/invited/restricted-and-allowed child room from a space
/// browser. Uses [`Client::join_room_by_id_or_alias`] rather than knocking —
/// this is for rooms the user can join outright.
#[tauri::command]
pub async fn join_room(
    state: State<'_, MatrixState>,
    room_id_or_alias: String,
) -> Result<(), String> {
    let client = state.require_client().await?;
    join_room_impl(&client, &room_id_or_alias).await
}

/// Core logic behind [`join_room`].
pub async fn join_room_impl(client: &Client, room_id_or_alias: &str) -> Result<(), String> {
    let parsed = parse_room_or_alias(room_id_or_alias)?;
    client
        .join_room_by_id_or_alias(&parsed, &[])
        .await
        .map_err(|e| e.to_string())?;
    Ok(())
}

/// Sends a knock request for a `join_rule: knock` child room — offered by
/// the space browser instead of a Join button when
/// [`SpaceChild::join_rule`] is [`SpaceJoinRule::Knock`].
#[tauri::command]
pub async fn knock_room(
    state: State<'_, MatrixState>,
    room_id_or_alias: String,
    reason: Option<String>,
) -> Result<(), String> {
    let client = state.require_client().await?;
    knock_room_impl(&client, &room_id_or_alias, reason.as_deref()).await
}

/// Core logic behind [`knock_room`].
pub async fn knock_room_impl(
    client: &Client,
    room_id_or_alias: &str,
    reason: Option<&str>,
) -> Result<(), String> {
    let parsed = parse_room_or_alias(room_id_or_alias)?;
    client
        .knock(parsed, reason.map(ToOwned::to_owned), vec![])
        .await
        .map_err(|e| e.to_string())?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use matrix_sdk::ruma::room::JoinRuleSummary;

    #[test]
    fn maps_join_rules() {
        assert!(matches!(
            SpaceJoinRule::from(&JoinRuleSummary::Public),
            SpaceJoinRule::Public
        ));
        assert!(matches!(
            SpaceJoinRule::from(&JoinRuleSummary::Knock),
            SpaceJoinRule::Knock
        ));
        assert!(matches!(
            SpaceJoinRule::from(&JoinRuleSummary::Invite),
            SpaceJoinRule::Invite
        ));
    }
}
