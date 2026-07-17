//! Space hierarchy browsing, join, and knock. Spec 06 shipped direct
//! space -> child-room browsing; Spec 19 Phase 1 adds a recursive hierarchy
//! DTO for the space rail/scoped-room-list work without changing the
//! existing direct-child `list_space_children` contract.

use matrix_sdk::deserialized_responses::SyncOrStrippedState;
use matrix_sdk::ruma::api::client::room::create_room;
use matrix_sdk::ruma::api::client::space::get_hierarchy;
use matrix_sdk::ruma::events::space::child::SpaceChildEventContent;
use matrix_sdk::ruma::events::SyncStateEvent;
use matrix_sdk::ruma::room::{JoinRuleSummary, RoomType};
use matrix_sdk::ruma::{uint, OwnedRoomOrAliasId, RoomId};
use matrix_sdk::Client;
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use tauri::State;
use ts_rs::TS;

use super::room_admin::require_room;
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

/// Adds an already-joined room or space as a child of `space_id` (Spec 63's
/// "Add Existing" flow) — sends `m.space.child` on the space's state,
/// pointing at `child_room_id`. Distinct from [`create_space`], which makes
/// a brand-new room; this files an existing one under the space instead.
#[tauri::command]
pub async fn add_existing_space_child(
    state: State<'_, MatrixState>,
    space_id: String,
    child_room_id: String,
) -> Result<(), String> {
    let client = state.require_client().await?;
    add_existing_space_child_impl(&client, &space_id, &child_room_id).await
}

/// Core logic behind [`add_existing_space_child`].
pub async fn add_existing_space_child_impl(
    client: &Client,
    space_id: &str,
    child_room_id: &str,
) -> Result<(), String> {
    let space = require_room(client, space_id)?;
    if !space.is_space() {
        return Err(format!("{space_id} is not a space"));
    }
    let parsed_child_id = RoomId::parse(child_room_id).map_err(|e| e.to_string())?;
    if child_room_id == space_id {
        return Err(format!("{space_id} cannot be a child of itself"));
    }
    // Only a room the caller has actually joined may be published as a
    // child — otherwise this would let the caller expose a pending invite's
    // room id (which they haven't joined, and may not be entitled to
    // publish) to every member of `space_id`. Checked here too, not just in
    // the frontend picker's own filter, since this command is reachable
    // directly over IPC.
    match client.get_room(&parsed_child_id).map(|room| room.state()) {
        Some(matrix_sdk::RoomState::Joined) => {}
        _ => return Err(format!("{child_room_id} has not been joined")),
    }
    let parents_by_room = super::rooms::parent_space_ids(client).await;
    if let Some(existing_children) = parents_by_room.get(child_room_id) {
        if existing_children.iter().any(|parent| parent == space_id) {
            return Err(format!("{child_room_id} is already a child of {space_id}"));
        }
    }
    if is_ancestor(space_id, child_room_id, &parents_by_room) {
        return Err(format!(
            "{child_room_id} is an ancestor of {space_id} — adding it as a child would form a cycle"
        ));
    }
    // Every client that later reads this edge needs at least one candidate
    // server to route the join through — an empty `via` (which a missing
    // `user_id`, e.g. a session lost mid-request, would otherwise silently
    // produce) makes the edge unusable rather than merely degraded, so this
    // is a hard error rather than falling back to an empty list.
    let user_id = client
        .user_id()
        .ok_or_else(|| "not logged in".to_string())?;
    let via = vec![user_id.server_name().to_owned()];
    space
        .send_state_event_for_key(&parsed_child_id, SpaceChildEventContent::new(via))
        .await
        .map_err(|e| e.to_string())?;
    Ok(())
}

/// True if `candidate_ancestor_id` is reachable by walking up `room_id`'s
/// parent chain (per `parents_by_room`, itself built from every joined
/// space's own `m.space.child` list — see its doc comment for why that's the
/// authoritative direction rather than the child-side `m.space.parent`).
/// Cycle-guarded against a malformed/cyclic parent graph already existing in
/// synced state.
fn is_ancestor(
    room_id: &str,
    candidate_ancestor_id: &str,
    parents_by_room: &std::collections::HashMap<String, Vec<String>>,
) -> bool {
    let mut visited = HashSet::new();
    let mut stack: Vec<String> = parents_by_room.get(room_id).cloned().unwrap_or_default();
    while let Some(current) = stack.pop() {
        if current == candidate_ancestor_id {
            return true;
        }
        if !visited.insert(current.clone()) {
            continue;
        }
        if let Some(parents) = parents_by_room.get(&current) {
            stack.extend(parents.iter().cloned());
        }
    }
    false
}

/// Detaches `child_room_id` from `space_id`'s hierarchy — sends an empty
/// `m.space.child` state event (per MSC1772, an empty/missing `via` marks the
/// child link revoked), without leaving the child room/space itself and
/// without touching any of its other parent relationships.
#[tauri::command]
pub async fn remove_space_child(
    state: State<'_, MatrixState>,
    space_id: String,
    child_room_id: String,
) -> Result<(), String> {
    let client = state.require_client().await?;
    remove_space_child_impl(&client, &space_id, &child_room_id).await
}

/// Core logic behind [`remove_space_child`].
pub async fn remove_space_child_impl(
    client: &Client,
    space_id: &str,
    child_room_id: &str,
) -> Result<(), String> {
    let space = require_room(client, space_id)?;
    if !space.is_space() {
        return Err(format!("{space_id} is not a space"));
    }
    let parsed_child_id = RoomId::parse(child_room_id).map_err(|e| e.to_string())?;

    // Mirrors `set_space_child_suggested_impl`'s existing-child check — sending
    // an empty `m.space.child` at a state key with no live child edge (never
    // set, or already redacted) would be a silent no-op rather than an error,
    // hiding a stale/duplicate removal from the caller.
    let existing = space
        .get_state_event_static_for_key::<SpaceChildEventContent, RoomId>(&parsed_child_id)
        .await
        .map_err(|e| e.to_string())?;
    let has_live_via = matches!(
        existing.and_then(|raw| raw.deserialize().ok()),
        Some(SyncOrStrippedState::Sync(SyncStateEvent::Original(original)))
            if !original.content.via.is_empty()
    );
    if !has_live_via {
        return Err(format!(
            "{child_room_id} is not currently a child of {space_id}"
        ));
    }

    space
        .send_state_event_raw("m.space.child", child_room_id, serde_json::json!({}))
        .await
        .map_err(|e| e.to_string())?;
    Ok(())
}

/// Marks (or unmarks) `child_room_id` as a "suggested" child of `space_id` —
/// a hint that clients can surface it more eagerly (e.g. auto-expanded) to
/// new joiners of the space. Preserves the child edge's existing `via`/
/// `order` fields, only flipping `suggested`; errors if `child_room_id` isn't
/// currently a child of `space_id` at all, since there's nothing to mark.
#[tauri::command]
pub async fn set_space_child_suggested(
    state: State<'_, MatrixState>,
    space_id: String,
    child_room_id: String,
    suggested: bool,
) -> Result<(), String> {
    let client = state.require_client().await?;
    set_space_child_suggested_impl(&client, &space_id, &child_room_id, suggested).await
}

/// Core logic behind [`set_space_child_suggested`].
pub async fn set_space_child_suggested_impl(
    client: &Client,
    space_id: &str,
    child_room_id: &str,
    suggested: bool,
) -> Result<(), String> {
    let space = require_room(client, space_id)?;
    if !space.is_space() {
        return Err(format!("{space_id} is not a space"));
    }
    let parsed_child_id = RoomId::parse(child_room_id).map_err(|e| e.to_string())?;

    let existing = space
        .get_state_event_static_for_key::<SpaceChildEventContent, RoomId>(&parsed_child_id)
        .await
        .map_err(|e| e.to_string())?;
    let deserialized = existing.and_then(|raw| raw.deserialize().ok());
    // A redacted `m.space.child` event has no `via` left to preserve — per
    // MSC1772 that's equivalent to the child link having been revoked, so
    // this reports the same "not currently a child" outcome a caller would
    // see for a link that was cleanly removed via `remove_space_child`,
    // rather than a generic deserialization failure.
    if matches!(
        deserialized,
        Some(SyncOrStrippedState::Sync(SyncStateEvent::Redacted(_)))
    ) {
        return Err(format!(
            "{child_room_id}'s child link to {space_id} was redacted and no longer carries a via — it is not currently a valid child"
        ));
    }
    let mut content = deserialized
        .and_then(|event| match event {
            SyncOrStrippedState::Sync(SyncStateEvent::Original(original)) => Some(original.content),
            _ => None,
        })
        .ok_or_else(|| format!("{child_room_id} is not currently a child of {space_id}"))?;
    // Mirrors `remove_space_child_impl`'s live-edge check — an empty `via` is
    // the unredacted representation of a revoked child link (what
    // `remove_space_child_impl` itself writes), so it must be rejected the
    // same way a missing/redacted event is, rather than letting `suggested`
    // be flipped on a link that no longer actually connects the two rooms.
    if content.via.is_empty() {
        return Err(format!(
            "{child_room_id} is not currently a child of {space_id}"
        ));
    }
    content.suggested = suggested;

    space
        .send_state_event_for_key(&parsed_child_id, content)
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
    use matrix_sdk::test_utils::mocks::MatrixMockServer;
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

    #[tokio::test]
    async fn add_existing_space_child_impl_sends_via_for_the_signed_in_users_server() {
        use matrix_sdk_test::event_factory::EventFactory;
        use matrix_sdk_test::{JoinedRoomBuilder, ALICE};

        let space_id = matrix_sdk::ruma::room_id!("!space:example.org");
        let child_id = matrix_sdk::ruma::room_id!("!child:example.org");
        let server = MatrixMockServer::new().await;
        // The mock client's default signed-in user is `@example:localhost`
        // (see `matrix_sdk::test_utils::client::mock_session_meta`) — `via`
        // is expected to be that user's own homeserver.
        let client = server.client_builder().build().await;

        server.mock_room_state_encryption().plain().mount().await;
        let create_event = EventFactory::new()
            .room(space_id)
            .sender(&ALICE)
            .create(&ALICE, matrix_sdk::ruma::RoomVersionId::V11)
            .with_space_type();
        server
            .sync_room(
                &client,
                JoinedRoomBuilder::new(space_id).add_state_event(create_event),
            )
            .await;
        server.sync_joined_room(&client, child_id).await;

        wiremock::Mock::given(wiremock::matchers::method("PUT"))
            .and(wiremock::matchers::path(format!(
                "/_matrix/client/v3/rooms/{space_id}/state/m.space.child/{child_id}"
            )))
            .and(wiremock::matchers::body_json(json!({
                "via": ["localhost"],
            })))
            .respond_with(
                wiremock::ResponseTemplate::new(200)
                    .set_body_json(json!({ "event_id": "$child_added" })),
            )
            .expect(1)
            .mount(server.server())
            .await;

        let result =
            add_existing_space_child_impl(&client, space_id.as_str(), child_id.as_str()).await;
        assert!(
            result.is_ok(),
            "expected the existing room to be added as a child, got {result:?}"
        );
    }

    #[tokio::test]
    async fn add_existing_space_child_impl_rejects_a_room_that_has_not_been_joined() {
        use matrix_sdk_test::event_factory::EventFactory;
        use matrix_sdk_test::{JoinedRoomBuilder, ALICE};

        let space_id = matrix_sdk::ruma::room_id!("!space:example.org");
        let uninvolved_id = matrix_sdk::ruma::room_id!("!unjoined:example.org");
        let server = MatrixMockServer::new().await;
        let client = server.client_builder().build().await;

        server.mock_room_state_encryption().plain().mount().await;
        let create_event = EventFactory::new()
            .room(space_id)
            .sender(&ALICE)
            .create(&ALICE, matrix_sdk::ruma::RoomVersionId::V11)
            .with_space_type();
        server
            .sync_room(
                &client,
                JoinedRoomBuilder::new(space_id).add_state_event(create_event),
            )
            .await;
        // `uninvolved_id` is never synced at all — the client has no local
        // knowledge of it, matching a pending invite it hasn't accepted.

        let result =
            add_existing_space_child_impl(&client, space_id.as_str(), uninvolved_id.as_str()).await;
        assert!(
            result.is_err(),
            "expected a room the client hasn't joined to be rejected, got {result:?}"
        );
    }

    #[tokio::test]
    async fn add_existing_space_child_impl_rejects_a_target_that_is_not_a_space() {
        let not_a_space_id = matrix_sdk::ruma::room_id!("!room:example.org");
        let child_id = matrix_sdk::ruma::room_id!("!child:example.org");
        let server = MatrixMockServer::new().await;
        let client = server.client_builder().build().await;

        server.mock_room_state_encryption().plain().mount().await;
        // A plain (non-space) joined room — no `m.room.create` `room_type`.
        server.sync_joined_room(&client, not_a_space_id).await;
        server.sync_joined_room(&client, child_id).await;

        let result =
            add_existing_space_child_impl(&client, not_a_space_id.as_str(), child_id.as_str())
                .await;
        assert!(
            result.is_err(),
            "expected adding a child under a non-space room to be rejected, got {result:?}"
        );
    }

    #[tokio::test]
    async fn add_existing_space_child_impl_rejects_adding_a_space_as_its_own_child() {
        use matrix_sdk_test::event_factory::EventFactory;
        use matrix_sdk_test::{JoinedRoomBuilder, ALICE};

        let server = MatrixMockServer::new().await;
        let client = server.client_builder().build().await;
        let space_id = matrix_sdk::ruma::room_id!("!space:example.org");

        server.mock_room_state_encryption().plain().mount().await;
        let create_event = EventFactory::new()
            .room(space_id)
            .sender(&ALICE)
            .create(&ALICE, matrix_sdk::ruma::RoomVersionId::V11)
            .with_space_type();
        server
            .sync_room(
                &client,
                JoinedRoomBuilder::new(space_id).add_state_event(create_event),
            )
            .await;

        let result =
            add_existing_space_child_impl(&client, space_id.as_str(), space_id.as_str()).await;
        assert!(
            result.is_err(),
            "expected adding a space as its own child to be rejected, got {result:?}"
        );
    }

    #[tokio::test]
    async fn add_existing_space_child_impl_rejects_an_already_existing_child() {
        use matrix_sdk_test::event_factory::EventFactory;
        use matrix_sdk_test::{JoinedRoomBuilder, ALICE};

        let root_id = matrix_sdk::ruma::room_id!("!root:example.org");
        let child_id = matrix_sdk::ruma::room_id!("!child:example.org");
        let server = MatrixMockServer::new().await;
        let client = server.client_builder().build().await;

        server.mock_room_state_encryption().plain().mount().await;
        server.sync_joined_room(&client, child_id).await;

        let factory = EventFactory::new().room(root_id).sender(&ALICE);
        let child_event = factory
            .event(SpaceChildEventContent::new(vec![
                matrix_sdk::ruma::owned_server_name!("example.org"),
            ]))
            .state_key(child_id.to_string());
        let create_event = factory
            .create(&ALICE, matrix_sdk::ruma::RoomVersionId::V11)
            .with_space_type();
        let room_builder = JoinedRoomBuilder::new(root_id)
            .add_state_event(create_event)
            .add_state_event(child_event);
        server.sync_room(&client, room_builder).await;

        let result =
            add_existing_space_child_impl(&client, root_id.as_str(), child_id.as_str()).await;
        assert!(
            result.is_err(),
            "expected re-adding an already-existing child to be rejected, got {result:?}"
        );
    }

    #[tokio::test]
    async fn add_existing_space_child_impl_rejects_an_ancestor_as_a_child_cycle() {
        use matrix_sdk_test::event_factory::EventFactory;
        use matrix_sdk_test::{JoinedRoomBuilder, ALICE};

        // Root already has Child as its child (root --child--> child). Trying
        // to add Root as a child of Child would close the loop.
        let root_id = matrix_sdk::ruma::room_id!("!root:example.org");
        let child_id = matrix_sdk::ruma::room_id!("!child:example.org");
        let server = MatrixMockServer::new().await;
        let client = server.client_builder().build().await;

        server.mock_room_state_encryption().plain().mount().await;
        // `child_id` plays the space-parameter role in the call below (Root
        // is being added as a child *of* Child), so it must be a space too.
        let child_create_event = EventFactory::new()
            .room(child_id)
            .sender(&ALICE)
            .create(&ALICE, matrix_sdk::ruma::RoomVersionId::V11)
            .with_space_type();
        server
            .sync_room(
                &client,
                JoinedRoomBuilder::new(child_id).add_state_event(child_create_event),
            )
            .await;

        let factory = EventFactory::new().room(root_id).sender(&ALICE);
        let child_event = factory
            .event(SpaceChildEventContent::new(vec![
                matrix_sdk::ruma::owned_server_name!("example.org"),
            ]))
            .state_key(child_id.to_string());
        let create_event = factory
            .create(&ALICE, matrix_sdk::ruma::RoomVersionId::V11)
            .with_space_type();
        let room_builder = JoinedRoomBuilder::new(root_id)
            .add_state_event(create_event)
            .add_state_event(child_event);
        server.sync_room(&client, room_builder).await;

        let result =
            add_existing_space_child_impl(&client, child_id.as_str(), root_id.as_str()).await;
        assert!(
            result.is_err(),
            "expected adding an ancestor as a child to be rejected as a cycle, got {result:?}"
        );
    }

    #[test]
    fn is_ancestor_walks_multiple_levels_and_guards_against_cycles() {
        let parents_by_room: HashMap<String, Vec<String>> = HashMap::from([
            ("grandchild".to_string(), vec!["child".to_string()]),
            ("child".to_string(), vec!["root".to_string()]),
            ("root".to_string(), vec!["grandchild".to_string()]),
        ]);

        assert!(is_ancestor("grandchild", "root", &parents_by_room));
        assert!(is_ancestor("grandchild", "child", &parents_by_room));
        assert!(!is_ancestor("grandchild", "unrelated", &parents_by_room));
    }

    #[tokio::test]
    async fn remove_space_child_impl_sends_an_empty_content_to_revoke_the_child_link() {
        use matrix_sdk_test::event_factory::EventFactory;
        use matrix_sdk_test::{JoinedRoomBuilder, ALICE};

        let space_id = matrix_sdk::ruma::room_id!("!space:example.org");
        let child_id = matrix_sdk::ruma::room_id!("!child:example.org");
        let server = MatrixMockServer::new().await;
        let client = server.client_builder().build().await;

        server.mock_room_state_encryption().plain().mount().await;

        let factory = EventFactory::new().room(space_id).sender(&ALICE);
        let child_event = factory
            .event(SpaceChildEventContent::new(vec![
                matrix_sdk::ruma::owned_server_name!("example.org"),
            ]))
            .state_key(child_id.to_string());
        let create_event = factory
            .create(&ALICE, matrix_sdk::ruma::RoomVersionId::V11)
            .with_space_type();
        let room_builder = JoinedRoomBuilder::new(space_id)
            .add_state_event(create_event)
            .add_state_event(child_event);
        server.sync_room(&client, room_builder).await;

        wiremock::Mock::given(wiremock::matchers::method("PUT"))
            .and(wiremock::matchers::path(format!(
                "/_matrix/client/v3/rooms/{space_id}/state/m.space.child/{child_id}"
            )))
            .and(wiremock::matchers::body_json(json!({})))
            .respond_with(
                wiremock::ResponseTemplate::new(200)
                    .set_body_json(json!({ "event_id": "$child_removed" })),
            )
            .expect(1)
            .mount(server.server())
            .await;

        let result = remove_space_child_impl(&client, space_id.as_str(), child_id.as_str()).await;
        assert!(
            result.is_ok(),
            "expected the child link to be revoked with empty content, got {result:?}"
        );
    }

    #[tokio::test]
    async fn remove_space_child_impl_rejects_a_malformed_child_id() {
        let space_id = matrix_sdk::ruma::room_id!("!space:example.org");
        let server = MatrixMockServer::new().await;
        let client = server.client_builder().build().await;

        server.mock_room_state_encryption().plain().mount().await;
        server.sync_joined_room(&client, space_id).await;

        let result = remove_space_child_impl(&client, space_id.as_str(), "not-a-room-id").await;
        assert!(
            result.is_err(),
            "expected a malformed child id to be rejected before any network call, got {result:?}"
        );
    }

    #[tokio::test]
    async fn remove_space_child_impl_rejects_a_target_that_is_not_a_space() {
        let not_a_space_id = matrix_sdk::ruma::room_id!("!room:example.org");
        let child_id = matrix_sdk::ruma::room_id!("!child:example.org");
        let server = MatrixMockServer::new().await;
        let client = server.client_builder().build().await;

        server.mock_room_state_encryption().plain().mount().await;
        // A plain (non-space) joined room — no `m.room.create` `room_type`.
        server.sync_joined_room(&client, not_a_space_id).await;

        let result =
            remove_space_child_impl(&client, not_a_space_id.as_str(), child_id.as_str()).await;
        assert!(
            result.is_err(),
            "expected removing a child from a non-space room to be rejected, got {result:?}"
        );
    }

    #[tokio::test]
    async fn remove_space_child_impl_rejects_a_room_that_is_not_currently_a_child() {
        use matrix_sdk_test::event_factory::EventFactory;
        use matrix_sdk_test::{JoinedRoomBuilder, ALICE};

        let space_id = matrix_sdk::ruma::room_id!("!space:example.org");
        let not_a_child_id = matrix_sdk::ruma::room_id!("!stranger:example.org");
        let server = MatrixMockServer::new().await;
        let client = server.client_builder().build().await;

        server.mock_room_state_encryption().plain().mount().await;

        let factory = EventFactory::new().room(space_id).sender(&ALICE);
        let create_event = factory
            .create(&ALICE, matrix_sdk::ruma::RoomVersionId::V11)
            .with_space_type();
        let room_builder = JoinedRoomBuilder::new(space_id).add_state_event(create_event);
        server.sync_room(&client, room_builder).await;

        let result =
            remove_space_child_impl(&client, space_id.as_str(), not_a_child_id.as_str()).await;
        assert!(
            result.is_err(),
            "expected removing a room with no live child edge to be rejected, got {result:?}"
        );
    }

    #[tokio::test]
    async fn set_space_child_suggested_impl_rejects_a_target_that_is_not_a_space() {
        let not_a_space_id = matrix_sdk::ruma::room_id!("!room:example.org");
        let child_id = matrix_sdk::ruma::room_id!("!child:example.org");
        let server = MatrixMockServer::new().await;
        let client = server.client_builder().build().await;

        server.mock_room_state_encryption().plain().mount().await;
        // A plain (non-space) joined room — no `m.room.create` `room_type`.
        server.sync_joined_room(&client, not_a_space_id).await;

        let result = set_space_child_suggested_impl(
            &client,
            not_a_space_id.as_str(),
            child_id.as_str(),
            true,
        )
        .await;
        assert!(
            result.is_err(),
            "expected marking a child as suggested on a non-space room to be rejected, got {result:?}"
        );
    }

    /// `set_space_child_suggested_impl` must preserve the existing child
    /// edge's `via`/`order` fields, only flipping `suggested` — this is the
    /// behavior that distinguishes it from just re-sending a fresh
    /// `SpaceChildEventContent`, which would silently drop `order`.
    #[tokio::test]
    async fn set_space_child_suggested_impl_preserves_via_and_order() {
        use matrix_sdk::ruma::SpaceChildOrder;
        use matrix_sdk_test::event_factory::EventFactory;
        use matrix_sdk_test::{JoinedRoomBuilder, ALICE};

        let space_id = matrix_sdk::ruma::room_id!("!space:example.org");
        let child_id = matrix_sdk::ruma::room_id!("!child:example.org");
        let server = MatrixMockServer::new().await;
        let client = server.client_builder().build().await;

        server.mock_room_state_encryption().plain().mount().await;

        let factory = EventFactory::new().room(space_id).sender(&ALICE);
        let mut content =
            SpaceChildEventContent::new(vec![matrix_sdk::ruma::owned_server_name!("example.org")]);
        content.order = SpaceChildOrder::parse("aaa").ok();
        let event = factory.event(content).state_key(child_id.to_string());
        let create_event = factory
            .create(&ALICE, matrix_sdk::ruma::RoomVersionId::V11)
            .with_space_type();
        let room_builder = JoinedRoomBuilder::new(space_id)
            .add_state_event(create_event)
            .add_state_event(event);
        server.sync_room(&client, room_builder).await;

        wiremock::Mock::given(wiremock::matchers::method("PUT"))
            .and(wiremock::matchers::path(format!(
                "/_matrix/client/v3/rooms/{space_id}/state/m.space.child/{child_id}"
            )))
            .and(wiremock::matchers::body_json(json!({
                "via": ["example.org"],
                "order": "aaa",
                "suggested": true,
            })))
            .respond_with(
                wiremock::ResponseTemplate::new(200)
                    .set_body_json(json!({ "event_id": "$child_suggested" })),
            )
            .expect(1)
            .mount(server.server())
            .await;

        let result =
            set_space_child_suggested_impl(&client, space_id.as_str(), child_id.as_str(), true)
                .await;
        assert!(
            result.is_ok(),
            "expected suggested to flip while via/order survive, got {result:?}"
        );
    }

    #[tokio::test]
    async fn set_space_child_suggested_impl_errors_when_not_currently_a_child() {
        use matrix_sdk_test::event_factory::EventFactory;
        use matrix_sdk_test::{JoinedRoomBuilder, ALICE};

        let space_id = matrix_sdk::ruma::room_id!("!space:example.org");
        let not_a_child_id = matrix_sdk::ruma::room_id!("!stranger:example.org");
        let server = MatrixMockServer::new().await;
        let client = server.client_builder().build().await;

        server.mock_room_state_encryption().plain().mount().await;
        let create_event = EventFactory::new()
            .room(space_id)
            .sender(&ALICE)
            .create(&ALICE, matrix_sdk::ruma::RoomVersionId::V11)
            .with_space_type();
        server
            .sync_room(
                &client,
                JoinedRoomBuilder::new(space_id).add_state_event(create_event),
            )
            .await;

        let result = set_space_child_suggested_impl(
            &client,
            space_id.as_str(),
            not_a_child_id.as_str(),
            true,
        )
        .await;
        assert!(
            result.is_err(),
            "expected marking a non-child as suggested to be rejected, got {result:?}"
        );
    }

    #[tokio::test]
    async fn set_space_child_suggested_impl_rejects_a_revoked_child_link() {
        use matrix_sdk_test::event_factory::EventFactory;
        use matrix_sdk_test::{JoinedRoomBuilder, ALICE};

        let space_id = matrix_sdk::ruma::room_id!("!space:example.org");
        let child_id = matrix_sdk::ruma::room_id!("!child:example.org");
        let server = MatrixMockServer::new().await;
        let client = server.client_builder().build().await;

        server.mock_room_state_encryption().plain().mount().await;
        let factory = EventFactory::new().room(space_id).sender(&ALICE);
        let create_event = factory
            .create(&ALICE, matrix_sdk::ruma::RoomVersionId::V11)
            .with_space_type();
        // `remove_space_child_impl` writes exactly this: an Original event
        // with an empty `via`, not a redaction — the child link is revoked
        // but the event itself is neither missing nor redacted.
        let revoked_child_event = factory
            .event(SpaceChildEventContent::new(vec![]))
            .state_key(child_id.to_string());
        server
            .sync_room(
                &client,
                JoinedRoomBuilder::new(space_id)
                    .add_state_event(create_event)
                    .add_state_event(revoked_child_event),
            )
            .await;

        let result =
            set_space_child_suggested_impl(&client, space_id.as_str(), child_id.as_str(), true)
                .await;
        assert!(
            result.is_err(),
            "expected marking a revoked (empty-via) child link as suggested to be rejected, got {result:?}"
        );
    }
}
