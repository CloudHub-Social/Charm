//! Space hierarchy browsing, join, and knock. Spec 06 shipped direct
//! space -> child-room browsing; Spec 19 Phase 1 adds a recursive hierarchy
//! DTO for the space rail/scoped-room-list work without changing the
//! existing direct-child `list_space_children` contract.

use matrix_sdk::ruma::api::client::room::create_room;
use matrix_sdk::ruma::api::client::space::get_hierarchy;
use matrix_sdk::ruma::room::{JoinRuleSummary, RoomType};
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
    let mut seen_page_tokens = HashSet::new();

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
        from = next_hierarchy_page_token(&mut seen_page_tokens, response.next_batch)?;
        let Some(_) = from else {
            return Ok(chunks);
        };
    }
}

fn next_hierarchy_page_token(
    seen_page_tokens: &mut HashSet<String>,
    next_batch: Option<String>,
) -> Result<Option<String>, String> {
    let Some(token) = next_batch else {
        return Ok(None);
    };
    if !seen_page_tokens.insert(token.clone()) {
        // Deliberately doesn't interpolate the opaque server-provided
        // `next_batch` token into the message — this error can reach Sentry
        // via the frontend's IPC error capture, and the token has no
        // syntactic marker to redact it against safely there (unlike a
        // Matrix ID's sigil or a URL's scheme).
        return Err("space hierarchy pagination repeated next_batch token".to_string());
    }
    Ok(Some(token))
}

fn chunk_to_child(
    chunk: matrix_sdk::ruma::api::client::space::SpaceHierarchyRoomsChunk,
) -> SpaceChild {
    let is_space = chunk_is_space(&chunk);
    SpaceChild {
        room_id: chunk.summary.room_id.to_string(),
        name: chunk.summary.name,
        topic: chunk.summary.topic,
        num_joined_members: chunk.summary.num_joined_members.into(),
        join_rule: SpaceJoinRule::from(&chunk.summary.join_rule),
        is_space,
    }
}

fn chunk_is_space(chunk: &matrix_sdk::ruma::api::client::space::SpaceHierarchyRoomsChunk) -> bool {
    chunk
        .summary
        .room_type
        .as_ref()
        .is_some_and(|t| *t == matrix_sdk::ruma::room::RoomType::Space)
}

fn build_hierarchy_from_chunks(
    root_id: &str,
    chunks: Vec<matrix_sdk::ruma::api::client::space::SpaceHierarchyRoomsChunk>,
) -> Vec<SpaceHierarchyNode> {
    let mut rooms = HashMap::new();
    let mut edges: HashMap<String, Vec<String>> = HashMap::new();
    for chunk in chunks {
        let parent_id = chunk.summary.room_id.to_string();
        let parent_is_space = chunk_is_space(&chunk);
        let mut seen_children = HashSet::new();
        let children = chunk
            .children_state
            .iter()
            .filter_map(|raw| {
                let event_type = raw.get_field::<String>("type").ok().flatten()?;
                if event_type != "m.space.child" {
                    return None;
                }
                let child_id = raw.get_field::<String>("state_key").ok().flatten()?;
                if seen_children.insert(child_id.clone()) {
                    Some(child_id)
                } else {
                    None
                }
            })
            .collect::<Vec<_>>();
        if parent_is_space && !children.is_empty() {
            edges.insert(parent_id.clone(), children);
        }
        rooms.insert(parent_id, chunk_to_child(chunk));
    }

    build_hierarchy_from_edges(root_id, &rooms, &edges)
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
    ) -> Option<SpaceHierarchyNode> {
        if !ancestors.insert(room_id.to_owned()) {
            return None;
        }

        let Some(child) = rooms.get(room_id).cloned() else {
            ancestors.remove(room_id);
            return None;
        };
        let children = if child.is_space {
            edges
                .get(room_id)
                .into_iter()
                .flat_map(|ids| ids.iter())
                .filter_map(|id| walk(id, rooms, edges, ancestors))
                .collect()
        } else {
            Vec::new()
        };

        ancestors.remove(room_id);
        Some(SpaceHierarchyNode { child, children })
    }

    edges
        .get(root_id)
        .into_iter()
        .flat_map(|ids| ids.iter())
        .filter_map(|id| {
            let mut ancestors = HashSet::from([root_id.to_owned()]);
            walk(id, rooms, edges, &mut ancestors)
        })
        .collect()
}

fn parse_room_or_alias(input: &str) -> Result<OwnedRoomOrAliasId, String> {
    OwnedRoomOrAliasId::try_from(input.to_owned()).map_err(|e| e.to_string())
}

/// The result of a successful [`join_room`] call. `is_space` lets a caller
/// that doesn't already know the room's type (e.g. the create/join dialog,
/// given only a user-typed address) tell a space apart from a regular room
/// without a separate lookup.
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../src/bindings/")]
pub struct JoinedRoom {
    pub room_id: String,
    pub is_space: bool,
}

/// Joins a public/invited/restricted-and-allowed child room from a space
/// browser, or a space by address/ID from the create/join dialog. Uses
/// [`Client::join_room_by_id_or_alias`] rather than knocking — this is for
/// rooms the user can join outright. Returns the resolved room id (and
/// whether it's a space) so a caller that only has an alias (e.g. the
/// create/join dialog) can still navigate to the joined room/space
/// afterward.
#[tauri::command]
pub async fn join_room(
    state: State<'_, MatrixState>,
    room_id_or_alias: String,
) -> Result<JoinedRoom, String> {
    let client = state.require_client().await?;
    join_room_impl(&client, &room_id_or_alias).await
}

/// Core logic behind [`join_room`].
///
/// `is_space` is a best-effort read of `Room::is_space()` at the moment the
/// join completes, from the client's local sync state — it can briefly lag
/// behind a room that was just created/joined in the same request, before
/// that room's own `m.room.create` type has finished syncing back. This
/// command doesn't retry/poll for it here: `join_room` is also the plain
/// "join a regular room" path (e.g. from the space browser), where blocking
/// every join on a fixed poll window would add needless latency to the
/// common case. Retrying is instead the caller's job where the ambiguity
/// actually matters — see `CreateJoinSpaceDialog.handleJoin`'s retry loop.
pub async fn join_room_impl(client: &Client, room_id_or_alias: &str) -> Result<JoinedRoom, String> {
    let parsed = parse_room_or_alias(room_id_or_alias)?;
    let room = client
        .join_room_by_id_or_alias(&parsed, &[])
        .await
        .map_err(|e| e.to_string())?;
    Ok(JoinedRoom {
        room_id: room.room_id().to_string(),
        is_space: room.is_space(),
    })
}

/// Creates a new space room (an `m.room.create` with `type: m.space` per
/// MSC1772). Does not accept a parent space — parenting an existing space
/// under another (adding an `m.space.child` state event) is a separate
/// follow-up call, not implemented by this command, which only creates the
/// room itself.
#[tauri::command]
pub async fn create_space(
    state: State<'_, MatrixState>,
    name: String,
    topic: Option<String>,
    room_alias_name: Option<String>,
    public: bool,
) -> Result<String, String> {
    let client = state.require_client().await?;
    create_space_impl(
        &client,
        &name,
        topic.as_deref(),
        room_alias_name.as_deref(),
        public,
    )
    .await
}

/// Core logic behind [`create_space`].
pub async fn create_space_impl(
    client: &Client,
    name: &str,
    topic: Option<&str>,
    room_alias_name: Option<&str>,
    public: bool,
) -> Result<String, String> {
    use matrix_sdk::ruma::serde::Raw;

    let mut content = create_room::v3::CreationContent::new();
    content.room_type = Some(RoomType::Space);
    let creation_content = Raw::new(&content).map_err(|e| e.to_string())?;

    let mut request = create_room::v3::Request::new();
    request.name = Some(name.to_owned());
    request.topic = topic.map(ToOwned::to_owned);
    request.room_alias_name = room_alias_name.map(ToOwned::to_owned);
    request.visibility = if public {
        matrix_sdk::ruma::api::client::room::Visibility::Public
    } else {
        matrix_sdk::ruma::api::client::room::Visibility::Private
    };
    request.preset = Some(if public {
        create_room::v3::RoomPreset::PublicChat
    } else {
        create_room::v3::RoomPreset::PrivateChat
    });
    request.creation_content = Some(creation_content);

    let room = client
        .create_room(request)
        .await
        .map_err(|e| e.to_string())?;
    Ok(room.room_id().to_string())
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
    use serde_json::{from_value as from_json_value, json};

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
    fn shared_descendants_are_preserved_under_each_parent() {
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
        assert_eq!(tree[1].children.len(), 1);
        assert_eq!(tree[1].children[0].child.room_id, "!room:example.org");
    }

    #[test]
    fn non_space_rooms_are_returned_as_leaves() {
        let rooms = HashMap::from([
            (
                "!space:example.org".to_owned(),
                child("!space:example.org", true),
            ),
            (
                "!room:example.org".to_owned(),
                child("!room:example.org", false),
            ),
            (
                "!nested:example.org".to_owned(),
                child("!nested:example.org", false),
            ),
        ]);
        let edges = HashMap::from([
            (
                "!space:example.org".to_owned(),
                vec!["!room:example.org".to_owned()],
            ),
            (
                "!room:example.org".to_owned(),
                vec!["!nested:example.org".to_owned()],
            ),
        ]);

        let tree = build_hierarchy_from_edges("!space:example.org", &rooms, &edges);

        assert_eq!(tree.len(), 1);
        assert_eq!(tree[0].child.room_id, "!room:example.org");
        assert!(tree[0].children.is_empty());
    }

    #[test]
    fn non_space_chunks_do_not_record_child_edges() {
        let chunks = vec![
            from_json_value(json!({
                "room_id": "!space:example.org",
                "room_type": "m.space",
                "num_joined_members": 1,
                "world_readable": false,
                "guest_can_join": false,
                "join_rule": "public",
                "children_state": [
                    {
                        "content": { "via": ["example.org"] },
                        "origin_server_ts": 1,
                        "sender": "@alice:example.org",
                        "state_key": "!room:example.org",
                        "type": "m.space.child"
                    }
                ]
            }))
            .expect("valid root space hierarchy chunk"),
            from_json_value(json!({
                "room_id": "!room:example.org",
                "num_joined_members": 1,
                "world_readable": false,
                "guest_can_join": false,
                "join_rule": "public",
                "children_state": [
                    {
                        "content": { "via": ["example.org"] },
                        "origin_server_ts": 1,
                        "sender": "@alice:example.org",
                        "state_key": "!nested:example.org",
                        "type": "m.space.child"
                    }
                ]
            }))
            .expect("valid malformed room hierarchy chunk"),
            from_json_value(json!({
                "room_id": "!nested:example.org",
                "num_joined_members": 1,
                "world_readable": false,
                "guest_can_join": false,
                "join_rule": "public",
                "children_state": []
            }))
            .expect("valid nested room hierarchy chunk"),
        ];

        let tree = build_hierarchy_from_chunks("!space:example.org", chunks);

        assert_eq!(tree.len(), 1);
        assert_eq!(tree[0].child.room_id, "!room:example.org");
        assert!(!tree[0].child.is_space);
        assert!(tree[0].children.is_empty());
    }

    #[test]
    fn repeated_hierarchy_page_tokens_are_rejected() {
        let mut seen_page_tokens = HashSet::new();

        assert_eq!(
            next_hierarchy_page_token(&mut seen_page_tokens, Some("page-1".to_string())),
            Ok(Some("page-1".to_string()))
        );
        assert_eq!(
            next_hierarchy_page_token(&mut seen_page_tokens, Some("page-2".to_string())),
            Ok(Some("page-2".to_string()))
        );
        let error = next_hierarchy_page_token(&mut seen_page_tokens, Some("page-1".to_string()))
            .expect_err("repeated pagination token should be rejected");

        assert!(error.contains("repeated next_batch token"));
        assert!(!error.contains("page-1"));
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
