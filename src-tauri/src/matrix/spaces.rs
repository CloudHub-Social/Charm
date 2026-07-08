//! Space hierarchy browsing, join, and knock. Spec 06 shipped direct
//! space -> child-room browsing; Spec 19 Phase 1 adds a recursive hierarchy
//! DTO for the space rail/scoped-room-list work without changing the
//! existing direct-child `list_space_children` contract.

use matrix_sdk::ruma::api::client::space::get_hierarchy;
use matrix_sdk::ruma::room::JoinRuleSummary;
use matrix_sdk::ruma::{uint, OwnedRoomOrAliasId, RoomId};
use matrix_sdk::Client;
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use tauri::State;
use ts_rs::TS;

use super::MatrixState;

const RECURSIVE_HIERARCHY_MAX_DEPTH: u32 = 50;

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

/// One node in a recursive space hierarchy. `child` may be a normal room or
/// another space; only space nodes can have non-empty `children`.
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../src/bindings/")]
pub struct SpaceHierarchyNode {
    pub child: SpaceChild,
    pub children: Vec<SpaceHierarchyNode>,
}

/// Fetches the first `/hierarchy` page of direct children for `space_id`.
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
    let chunks = fetch_hierarchy_chunks(client, parsed_space_id.clone(), true).await?;

    Ok(chunks
        .into_iter()
        // The hierarchy response includes the space itself as the first
        // entry (depth 0) — only its children are relevant here.
        .filter(|chunk| chunk.summary.room_id != parsed_space_id)
        .map(chunk_to_child)
        .collect())
}

/// Fetches the full recursive hierarchy rooted at `space_id`.
#[tauri::command]
pub async fn list_space_hierarchy(
    state: State<'_, MatrixState>,
    space_id: String,
) -> Result<Vec<SpaceHierarchyNode>, String> {
    let client = state.require_client().await?;
    list_space_hierarchy_impl(&client, &space_id).await
}

/// Core logic behind [`list_space_hierarchy`].
pub async fn list_space_hierarchy_impl(
    client: &Client,
    space_id: &str,
) -> Result<Vec<SpaceHierarchyNode>, String> {
    let parsed_space_id = RoomId::parse(space_id).map_err(|e| e.to_string())?;
    let chunks = fetch_hierarchy_chunks(client, parsed_space_id.clone(), false).await?;
    Ok(build_hierarchy_from_chunks(
        parsed_space_id.as_ref(),
        chunks,
    ))
}

async fn fetch_hierarchy_chunks(
    client: &Client,
    room_id: matrix_sdk::ruma::OwnedRoomId,
    direct_children_only: bool,
) -> Result<Vec<matrix_sdk::ruma::api::client::space::SpaceHierarchyRoomsChunk>, String> {
    let mut chunks = Vec::new();
    let mut from = None;

    loop {
        let mut request = get_hierarchy::v1::Request::new(room_id.clone());
        request.from = from;
        request.max_depth = Some(if direct_children_only {
            uint!(1)
        } else {
            RECURSIVE_HIERARCHY_MAX_DEPTH.into()
        });
        let response = client.send(request).await.map_err(|e| e.to_string())?;
        chunks.extend(response.rooms);
        if direct_children_only {
            return Ok(chunks);
        }
        from = response.next_batch;
        if from.is_none() {
            return Ok(chunks);
        }
    }
}

fn chunk_to_child(
    chunk: matrix_sdk::ruma::api::client::space::SpaceHierarchyRoomsChunk,
) -> SpaceChild {
    SpaceChild {
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
    }
}

fn build_hierarchy_from_chunks(
    root_id: &str,
    chunks: Vec<matrix_sdk::ruma::api::client::space::SpaceHierarchyRoomsChunk>,
) -> Vec<SpaceHierarchyNode> {
    let mut rooms = HashMap::new();
    let mut edges: HashMap<String, Vec<String>> = HashMap::new();
    let mut response_order = HashMap::new();

    for (index, chunk) in chunks.into_iter().enumerate() {
        let parent_id = chunk.summary.room_id.to_string();
        response_order.insert(parent_id.clone(), index);
        let children = chunk
            .children_state
            .iter()
            .filter_map(|raw| raw.deserialize().ok())
            .map(|event| event.state_key.to_string())
            .collect::<Vec<_>>();
        if !children.is_empty() {
            edges.insert(parent_id.clone(), children);
        }
        rooms.insert(parent_id, chunk_to_child(chunk));
    }

    sort_edges_by_response_order(&mut edges, &response_order);

    build_hierarchy_from_edges(root_id, &rooms, &edges)
}

fn sort_edges_by_response_order(
    edges: &mut HashMap<String, Vec<String>>,
    response_order: &HashMap<String, usize>,
) {
    for children in edges.values_mut() {
        children.sort_by_key(|id| response_order.get(id).copied().unwrap_or(usize::MAX));
    }
}

fn build_hierarchy_from_edges(
    root_id: &str,
    rooms: &HashMap<String, SpaceChild>,
    edges: &HashMap<String, Vec<String>>,
) -> Vec<SpaceHierarchyNode> {
    fn walk(
        room_id: &str,
        rooms: &HashMap<String, SpaceChild>,
        edges: &HashMap<String, Vec<String>>,
        ancestors: &mut HashSet<String>,
        emitted: &mut HashSet<String>,
    ) -> Option<SpaceHierarchyNode> {
        if !ancestors.insert(room_id.to_owned()) {
            return None;
        }
        if !emitted.insert(room_id.to_owned()) {
            ancestors.remove(room_id);
            return None;
        }

        let Some(child) = rooms.get(room_id).cloned() else {
            emitted.remove(room_id);
            ancestors.remove(room_id);
            return None;
        };
        let children = edges
            .get(room_id)
            .into_iter()
            .flat_map(|ids| ids.iter())
            .filter_map(|id| walk(id, rooms, edges, ancestors, emitted))
            .collect();

        ancestors.remove(room_id);
        Some(SpaceHierarchyNode { child, children })
    }

    let mut emitted = HashSet::from([root_id.to_owned()]);
    edges
        .get(root_id)
        .into_iter()
        .flat_map(|ids| ids.iter())
        .filter_map(|id| {
            let mut ancestors = HashSet::from([root_id.to_owned()]);
            walk(id, rooms, edges, &mut ancestors, &mut emitted)
        })
        .collect()
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

    fn child(room_id: &str, is_space: bool) -> SpaceChild {
        SpaceChild {
            room_id: room_id.to_owned(),
            name: Some(room_id.to_owned()),
            topic: None,
            num_joined_members: 1,
            join_rule: SpaceJoinRule::Public,
            is_space,
        }
    }

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

    #[test]
    fn builds_recursive_hierarchy_from_edges() {
        let rooms = HashMap::from([
            (
                "!space:example.org".to_owned(),
                child("!space:example.org", true),
            ),
            (
                "!sub:example.org".to_owned(),
                child("!sub:example.org", true),
            ),
            (
                "!room:example.org".to_owned(),
                child("!room:example.org", false),
            ),
        ]);
        let edges = HashMap::from([
            (
                "!space:example.org".to_owned(),
                vec!["!sub:example.org".to_owned()],
            ),
            (
                "!sub:example.org".to_owned(),
                vec!["!room:example.org".to_owned()],
            ),
        ]);

        let tree = build_hierarchy_from_edges("!space:example.org", &rooms, &edges);

        assert_eq!(tree.len(), 1);
        assert_eq!(tree[0].child.room_id, "!sub:example.org");
        assert_eq!(tree[0].children[0].child.room_id, "!room:example.org");
    }

    #[test]
    fn sorts_children_by_hierarchy_response_order() {
        let mut edges = HashMap::from([(
            "!space:example.org".to_owned(),
            vec![
                "!second:example.org".to_owned(),
                "!first:example.org".to_owned(),
            ],
        )]);
        let response_order = HashMap::from([
            ("!space:example.org".to_owned(), 0),
            ("!first:example.org".to_owned(), 1),
            ("!second:example.org".to_owned(), 2),
        ]);

        sort_edges_by_response_order(&mut edges, &response_order);

        assert_eq!(
            edges["!space:example.org"],
            vec![
                "!first:example.org".to_owned(),
                "!second:example.org".to_owned(),
            ]
        );
    }

    #[test]
    fn cycle_guard_skips_back_edges() {
        let rooms = HashMap::from([
            (
                "!space:example.org".to_owned(),
                child("!space:example.org", true),
            ),
            (
                "!sub:example.org".to_owned(),
                child("!sub:example.org", true),
            ),
        ]);
        let edges = HashMap::from([
            (
                "!space:example.org".to_owned(),
                vec!["!sub:example.org".to_owned()],
            ),
            (
                "!sub:example.org".to_owned(),
                vec!["!space:example.org".to_owned()],
            ),
        ]);

        let tree = build_hierarchy_from_edges("!space:example.org", &rooms, &edges);

        assert_eq!(tree.len(), 1);
        assert_eq!(tree[0].child.room_id, "!sub:example.org");
        assert!(tree[0].children.is_empty());
    }

    #[test]
    fn shared_descendants_are_emitted_once() {
        let rooms = HashMap::from([
            (
                "!space:example.org".to_owned(),
                child("!space:example.org", true),
            ),
            (
                "!sub-a:example.org".to_owned(),
                child("!sub-a:example.org", true),
            ),
            (
                "!sub-b:example.org".to_owned(),
                child("!sub-b:example.org", true),
            ),
            (
                "!room:example.org".to_owned(),
                child("!room:example.org", false),
            ),
        ]);
        let edges = HashMap::from([
            (
                "!space:example.org".to_owned(),
                vec![
                    "!sub-a:example.org".to_owned(),
                    "!sub-b:example.org".to_owned(),
                ],
            ),
            (
                "!sub-a:example.org".to_owned(),
                vec!["!room:example.org".to_owned()],
            ),
            (
                "!sub-b:example.org".to_owned(),
                vec!["!room:example.org".to_owned()],
            ),
        ]);

        let tree = build_hierarchy_from_edges("!space:example.org", &rooms, &edges);

        assert_eq!(tree.len(), 2);
        assert_eq!(tree[0].children.len(), 1);
        assert_eq!(tree[0].children[0].child.room_id, "!room:example.org");
        assert!(tree[1].children.is_empty());
    }

    #[test]
    fn missing_rooms_do_not_poison_sibling_cycle_guards() {
        let rooms = HashMap::from([
            (
                "!space:example.org".to_owned(),
                child("!space:example.org", true),
            ),
            (
                "!sub-a:example.org".to_owned(),
                child("!sub-a:example.org", true),
            ),
            (
                "!sub-b:example.org".to_owned(),
                child("!sub-b:example.org", true),
            ),
            (
                "!room:example.org".to_owned(),
                child("!room:example.org", false),
            ),
        ]);
        let edges = HashMap::from([
            (
                "!space:example.org".to_owned(),
                vec![
                    "!sub-a:example.org".to_owned(),
                    "!sub-b:example.org".to_owned(),
                ],
            ),
            (
                "!sub-a:example.org".to_owned(),
                vec!["!missing:example.org".to_owned()],
            ),
            (
                "!missing:example.org".to_owned(),
                vec!["!room:example.org".to_owned()],
            ),
            (
                "!sub-b:example.org".to_owned(),
                vec![
                    "!missing:example.org".to_owned(),
                    "!room:example.org".to_owned(),
                ],
            ),
        ]);

        let tree = build_hierarchy_from_edges("!space:example.org", &rooms, &edges);

        assert_eq!(tree.len(), 2);
        assert!(tree[0].children.is_empty());
        assert_eq!(tree[1].child.room_id, "!sub-b:example.org");
        assert_eq!(tree[1].children.len(), 1);
        assert_eq!(tree[1].children[0].child.room_id, "!room:example.org");
    }
}
