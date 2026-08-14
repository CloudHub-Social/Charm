//! Space hierarchy browsing, join, and knock. Spec 06 shipped direct
//! space -> child-room browsing; Spec 19 Phase 1 adds a recursive hierarchy
//! DTO for the space rail/scoped-room-list work without changing the
//! existing direct-child `list_space_children` contract.

use matrix_sdk::ruma::api::client::room::create_room;
use matrix_sdk::ruma::api::client::space::get_hierarchy;
use matrix_sdk::ruma::api::client::state::{get_state_event_for_key, get_state_events};
use matrix_sdk::ruma::api::error::ErrorKind;
use matrix_sdk::ruma::events::space::child::SpaceChildEventContent;
use matrix_sdk::ruma::events::space::parent::SpaceParentEventContent;
use matrix_sdk::ruma::events::{AnyStateEvent, InitialStateEvent, StateEvent, StateEventType};
use matrix_sdk::ruma::room::{JoinRuleSummary, RoomType};
use matrix_sdk::ruma::{OwnedRoomOrAliasId, RoomId};
use matrix_sdk::{Client, Room};
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use tauri::{AppHandle, Manager, State};
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

/// One child room summary. The lightweight browser reads one hierarchy page;
/// settings management enumerates every live child edge.
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
    let mut request = get_hierarchy::v1::Request::new(parsed_space_id.clone());
    request.max_depth = Some(1_u32.into());
    let chunks = client.send(request).await.map_err(|e| e.to_string())?.rooms;

    Ok(chunks
        .into_iter()
        // The hierarchy response includes the space itself as the first
        // entry (depth 0) — only its children are relevant here.
        .filter(|chunk| chunk.summary.room_id != parsed_space_id)
        .map(chunk_to_child)
        .collect())
}

/// Fetches the complete live child-edge set for settings management.
#[tauri::command]
pub async fn list_manageable_space_children(
    state: State<'_, MatrixState>,
    space_id: String,
) -> Result<Vec<SpaceChild>, String> {
    let client = state.require_client().await?;
    list_manageable_space_children_impl(&client, &space_id).await
}

pub async fn list_manageable_space_children_impl(
    client: &Client,
    space_id: &str,
) -> Result<Vec<SpaceChild>, String> {
    let parsed_space_id = RoomId::parse(space_id).map_err(|e| e.to_string())?;
    let space = require_space(client, space_id)?;
    let chunks = fetch_hierarchy_chunks(client, parsed_space_id.clone(), Some(1)).await?;
    let summaries = chunks
        .into_iter()
        .filter(|chunk| chunk.summary.room_id != parsed_space_id)
        .map(|chunk| (chunk.summary.room_id.to_owned(), chunk_to_child(chunk)))
        .collect::<HashMap<_, _>>();
    let child_events = space
        .get_state_events_static::<SpaceChildEventContent>()
        .await
        .map_err(|e| e.to_string())?;
    let mut children = child_events
        .into_iter()
        .filter_map(|raw| {
            let event = raw.deserialize().ok()?;
            let has_via = matches!(
                &event,
                matrix_sdk::deserialized_responses::SyncOrStrippedState::Sync(
                    matrix_sdk::ruma::events::SyncStateEvent::Original(original)
                ) if !original.content.via.is_empty()
            );
            has_via.then(|| event.state_key().to_owned())
        })
        .map(|child_id| {
            summaries.get(&child_id).cloned().unwrap_or_else(|| {
                let is_space = client
                    .get_room(&child_id)
                    .is_some_and(|room| room.is_space());
                SpaceChild {
                    room_id: child_id.to_string(),
                    name: None,
                    topic: None,
                    num_joined_members: 0,
                    join_rule: SpaceJoinRule::Other,
                    is_space,
                }
            })
        })
        .collect::<Vec<_>>();
    children.sort_by(|a, b| a.room_id.cmp(&b.room_id));
    Ok(children)
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
    let chunks = fetch_hierarchy_chunks(
        client,
        parsed_space_id.clone(),
        Some(RECURSIVE_HIERARCHY_MAX_DEPTH),
    )
    .await?;
    Ok(build_hierarchy_from_chunks(
        parsed_space_id.as_ref(),
        chunks,
    ))
}

async fn fetch_hierarchy_chunks(
    client: &Client,
    room_id: matrix_sdk::ruma::OwnedRoomId,
    max_depth: Option<u32>,
) -> Result<Vec<matrix_sdk::ruma::api::client::space::SpaceHierarchyRoomsChunk>, String> {
    let mut chunks = Vec::new();
    let mut from = None;
    let mut seen_page_tokens = HashSet::new();

    loop {
        let mut request = get_hierarchy::v1::Request::new(room_id.clone());
        request.from = from;
        request.max_depth = max_depth.map(Into::into);
        let response = client.send(request).await.map_err(|e| e.to_string())?;
        chunks.extend(response.rooms);
        from = next_hierarchy_page_token(&mut seen_page_tokens, response.next_batch)?;
        let Some(_) = from else {
            return Ok(chunks);
        };
    }
}

/// Proves whether `room_id` appears below `ancestor_id` by walking live
/// `m.space.child` state. `/hierarchy` can omit inaccessible branches, so a
/// plain "not present in returned chunks" result is not sufficient for a
/// mutation-safety decision: an unclassified child makes this fail closed.
async fn live_hierarchy_contains(
    client: &Client,
    ancestor_id: &RoomId,
    room_id: &str,
) -> Result<bool, String> {
    let target = RoomId::parse(room_id).map_err(|e| e.to_string())?;
    let mut pending = vec![ancestor_id.to_owned()];
    let mut visited = HashSet::new();

    while let Some(space_id) = pending.pop() {
        if !visited.insert(space_id.clone()) {
            continue;
        }
        if visited.len() > 10_000 {
            return Err("space hierarchy is too large to verify safely".to_string());
        }

        let chunks = fetch_hierarchy_chunks(client, space_id.clone(), Some(1)).await?;
        if chunks.iter().any(|chunk| chunk.summary.room_id == target) {
            return Ok(true);
        }
        let child_types = chunks
            .into_iter()
            .filter(|chunk| chunk.summary.room_id != space_id)
            .map(|chunk| {
                let is_space = chunk_is_space(&chunk);
                (chunk.summary.room_id, is_space)
            })
            .collect::<HashMap<_, _>>();
        let response = client
            .send(get_state_events::v3::Request::new(space_id.clone()))
            .await
            .map_err(|_| {
                "could not inspect every descendant; hierarchy change was not applied".to_string()
            })?;

        for child_id in
            response
                .room_state
                .into_iter()
                .filter_map(|raw| match raw.deserialize().ok()? {
                    AnyStateEvent::SpaceChild(StateEvent::Original(event))
                        if !event.content.via.is_empty() =>
                    {
                        Some(event.state_key)
                    }
                    _ => None,
                })
        {
            if child_id == target {
                return Ok(true);
            }
            match child_types
                .get(&child_id)
                .copied()
                .or_else(|| client.get_room(&child_id).map(|room| room.is_space()))
            {
                Some(true) => pending.push(child_id),
                Some(false) => {}
                None => {
                    return Err(
                        "could not inspect every descendant; hierarchy change was not applied"
                            .to_string(),
                    );
                }
            }
        }
    }
    Ok(false)
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
/// MSC1772), optionally nested under an existing joined parent space.
#[tauri::command]
pub async fn create_space(
    app: AppHandle,
    state: State<'_, MatrixState>,
    name: String,
    topic: Option<String>,
    room_alias_name: Option<String>,
    public: bool,
    parent_space_id: Option<String>,
) -> Result<String, String> {
    if parent_space_id.is_some() && !hierarchy_reorganization_enabled(&app) {
        return Err("space hierarchy reorganization is disabled".to_owned());
    }
    let client = state.require_client().await?;
    create_space_impl(
        &client,
        &name,
        topic.as_deref(),
        room_alias_name.as_deref(),
        public,
        parent_space_id.as_deref(),
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
    parent_space_id: Option<&str>,
) -> Result<String, String> {
    use matrix_sdk::ruma::serde::Raw;

    let parent = match parent_space_id {
        Some(parent_id) => Some(require_space(client, parent_id)?),
        None => None,
    };
    if let Some(parent) = &parent {
        // A failed reciprocal edge after `create_room` cannot be rolled back:
        // preflight the existing parent before creating the child space.
        require_state_permission(parent, StateEventType::SpaceChild).await?;
    }
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
    if let Some(parent) = &parent {
        let parent_id = parent.room_id().to_owned();
        let mut parent_content = SpaceParentEventContent::new(room_route(parent).await?);
        parent_content.canonical = true;
        let parent_event = InitialStateEvent::new(parent_id, parent_content);
        request.initial_state = vec![parent_event.to_raw_any()];
    }

    let room = client
        .create_room(request)
        .await
        .map_err(|e| e.to_string())?;
    if let Some(parent) = &parent {
        add_child_edge(parent, &room).await.map_err(|error| {
            format!(
                "created space {} but could not attach it to {}: {error}",
                room.room_id(),
                parent.room_id()
            )
        })?;
    }
    Ok(room.room_id().to_string())
}

/// Makes `parent_space_id` the canonical parent of `space_id`, or removes
/// the current canonical parent when `parent_space_id` is `None`.
///
/// Matrix permits multiple noncanonical parents. Charm therefore removes
/// only relationships that were canonical before this operation and leaves
/// unrelated noncanonical relationships intact.
#[tauri::command]
pub async fn set_space_parent(
    app: AppHandle,
    state: State<'_, MatrixState>,
    space_id: String,
    parent_space_id: Option<String>,
) -> Result<(), String> {
    if !hierarchy_reorganization_enabled(&app) {
        return Err("space hierarchy reorganization is disabled".to_owned());
    }
    let client = state.require_client().await?;
    set_space_parent_impl(&client, &space_id, parent_space_id.as_deref()).await
}

fn hierarchy_reorganization_enabled(app: &AppHandle) -> bool {
    app.path().app_data_dir().is_ok_and(|dir| {
        crate::feature_flags::flag(
            &dir,
            crate::feature_flags::FeatureFlagKey::SpaceHierarchyReorganization,
        )
    })
}

pub async fn set_space_parent_impl(
    client: &Client,
    space_id: &str,
    parent_space_id: Option<&str>,
) -> Result<(), String> {
    let child = require_space(client, space_id)?;
    let child_id = child.room_id().to_owned();
    let new_parent = match parent_space_id {
        Some(parent_id) => {
            if parent_id == space_id {
                return Err(format!("{space_id} cannot be its own parent"));
            }
            let parent = require_space(client, parent_id)?;
            if live_hierarchy_contains(client, &child_id, parent_id).await? {
                return Err(format!(
                    "{parent_id} is a descendant of {space_id} — making it the parent would form a cycle"
                ));
            }
            Some(parent)
        }
        None => None,
    };

    let mut original_canonical_parent_ids = canonical_parent_ids(&child).await?;
    original_canonical_parent_ids.sort();

    // This operation can write the child, the new parent, and every old
    // canonical parent. Acquire their room barriers in stable ID order to
    // avoid inverse-reparent deadlocks, then verify the remotely-read parent
    // set did not change while admission was being acquired.
    let mut mutation_room_ids = original_canonical_parent_ids.clone();
    mutation_room_ids.push(child_id.clone());
    if let Some(parent) = &new_parent {
        mutation_room_ids.push(parent.room_id().to_owned());
    }
    mutation_room_ids.sort();
    mutation_room_ids.dedup();
    let mut _mutation_guards = Vec::with_capacity(mutation_room_ids.len());
    for room_id in &mutation_room_ids {
        _mutation_guards.push(super::actions::lock_room_mutation(room_id.as_str()).await?);
    }
    let mut current_canonical_parent_ids = canonical_parent_ids(&child).await?;
    current_canonical_parent_ids.sort();
    if current_canonical_parent_ids != original_canonical_parent_ids {
        return Err("The space hierarchy changed while reparenting; try again.".to_string());
    }

    // Validate every state-event permission we can know about before sending
    // the first write. In particular, publishing the new parent's
    // `m.space.child` edge before discovering that the child rejects
    // `m.space.parent` would leave a visible, one-sided relationship.
    require_state_permission(&child, StateEventType::SpaceParent).await?;
    if let Some(parent) = &new_parent {
        require_state_permission(parent, StateEventType::SpaceChild).await?;
    }
    // Add/promote the new relationship before removing the old canonical
    // relationship, so a successful reparent never leaves the child
    // temporarily undiscoverable from every parent.
    if let Some(parent) = &new_parent {
        if !has_live_child_via(parent, &child_id).await? {
            add_child_edge(parent, &child).await?;
        }
        let mut content = SpaceParentEventContent::new(room_route(parent).await?);
        content.canonical = true;
        child
            .send_state_event_for_key(parent.room_id(), content)
            .await
            .map_err(|e| e.to_string())?;
    }

    for old_parent_id in original_canonical_parent_ids {
        if new_parent
            .as_ref()
            .is_some_and(|parent| parent.room_id() == old_parent_id)
        {
            continue;
        }
        // The child-side relationship can outlive this account's membership
        // in the old parent (for example, when the user joins a subspace
        // directly and later reparents it). Missing access to that old room
        // must not prevent clearing the canonical relationship we can still
        // edit on `child`. When the old parent is joined and is still a
        // space, remove its reciprocal edge first; doing that before clearing
        // the child-side event keeps a transient parent-edge failure
        // retryable on the next call.
        if let Some(old_parent) = client
            .get_room(&old_parent_id)
            .filter(|room| room.state() == matrix_sdk::RoomState::Joined && room.is_space())
        {
            // Losing permission in the old parent must not trap a child-side
            // canonical relationship that this account is still allowed to
            // clear. Skip only that reciprocal edge and continue.
            if can_send_state(&old_parent, StateEventType::SpaceChild).await?
                && has_live_child_via(&old_parent, &child_id).await?
            {
                remove_child_edge(&old_parent, &child_id).await?;
            }
        }
        child
            .send_state_event_raw(
                "m.space.parent",
                old_parent_id.as_str(),
                serde_json::json!({}),
            )
            .await
            .map_err(|e| e.to_string())?;
    }

    Ok(())
}

async fn require_state_permission(room: &Room, event_type: StateEventType) -> Result<(), String> {
    if can_send_state(room, event_type.clone()).await? {
        Ok(())
    } else {
        Err(format!(
            "insufficient permissions to send {event_type} in {}",
            room.room_id()
        ))
    }
}

async fn can_send_state(room: &Room, event_type: StateEventType) -> Result<bool, String> {
    let client = room.client();
    let own_user_id = client.user_id().ok_or_else(|| "not logged in".to_owned())?;
    let power_levels = room.power_levels().await.map_err(|e| e.to_string())?;
    Ok(power_levels.user_can_send_state(own_user_id, event_type))
}

fn require_space(client: &Client, room_id: &str) -> Result<Room, String> {
    let room = require_room(client, room_id)?;
    if room.state() != matrix_sdk::RoomState::Joined {
        return Err(format!("{room_id} is not joined"));
    }
    if !room.is_space() {
        return Err(format!("{room_id} is not a space"));
    }
    Ok(room)
}

async fn canonical_parent_ids(space: &Room) -> Result<Vec<matrix_sdk::ruma::OwnedRoomId>, String> {
    let response = space
        .client()
        .send(get_state_events::v3::Request::new(
            space.room_id().to_owned(),
        ))
        .await
        .map_err(|e| e.to_string())?;
    Ok(response
        .room_state
        .into_iter()
        .filter_map(|raw| match raw.deserialize().ok()? {
            AnyStateEvent::SpaceParent(StateEvent::Original(event))
                if event.content.canonical && !event.content.via.is_empty() =>
            {
                Some(event.state_key)
            }
            _ => None,
        })
        .collect())
}

async fn add_child_edge(parent: &Room, child: &Room) -> Result<(), String> {
    // `m.space.child.via` routes clients to the child, not the space that
    // publishes the edge. Those rooms can live on different homeservers.
    let via = room_route(child).await?;
    parent
        .send_state_event_for_key(child.room_id(), SpaceChildEventContent::new(via))
        .await
        .map_err(|e| e.to_string())?;
    Ok(())
}

async fn room_route(room: &Room) -> Result<Vec<matrix_sdk::ruma::OwnedServerName>, String> {
    let mut via = room.route().await.map_err(|e| e.to_string())?;
    if !via.is_empty() {
        return Ok(via);
    }
    // A just-created or minimally-synced room can temporarily have no
    // member-derived route even though the current user's homeserver is a
    // valid candidate. Both space relationship event types require `via`;
    // fail closed only if there is no signed-in user to supply that fallback.
    let client = room.client();
    let user_id = client
        .user_id()
        .ok_or_else(|| "not logged in".to_string())?;
    via.push(user_id.server_name().to_owned());
    Ok(via)
}

async fn remove_child_edge(parent: &Room, child_id: &RoomId) -> Result<(), String> {
    parent
        .send_state_event_raw("m.space.child", child_id.as_str(), serde_json::json!({}))
        .await
        .map_err(|e| e.to_string())?;
    Ok(())
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
    let _mutation_guard = super::actions::lock_room_mutation(space_id).await?;
    let space = require_space(client, space_id)?;
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
    let child_room = match client.get_room(&parsed_child_id) {
        Some(room) if room.state() == matrix_sdk::RoomState::Joined => room,
        _ => return Err(format!("{child_room_id} has not been joined")),
    };
    // Mirrors `AddExistingToSpaceDialog`'s own candidate filter — checked
    // here too, not just in the frontend picker, since this command is
    // reachable directly over IPC. A DM's room id is otherwise exposed to
    // every member of `space_id` once published as a child. Fails closed on
    // a lookup error (e.g. a transient store failure) rather than treating
    // it as "not a DM" — this guard is the only thing standing between a
    // caller and leaking a DM's room id here, so an inconclusive answer must
    // not be silently treated as a pass.
    match child_room.is_direct().await {
        Ok(true) => {
            return Err(format!(
                "{child_room_id} is a direct message and cannot be added to a space"
            ));
        }
        Ok(false) => {}
        Err(e) => {
            return Err(format!(
                "could not determine if {child_room_id} is a direct message: {e}"
            ))
        }
    }
    // Local-store fast path: cheap, and catches the common case without a
    // network round trip — but not authoritative on its own (see the live
    // checks below), since this client's own sync may be behind another
    // device's recent edit.
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
    // Authoritative live checks, queried against the *server* rather than
    // this client's local sync-populated store — mirrors the live-edge
    // checks `remove_space_child_impl`/`set_space_child_suggested_impl` use
    // for the same reason: another device may have added or removed a
    // parent edge that hasn't reached this client's own `/sync` yet, and
    // the local-store checks above alone could miss a duplicate or a cycle
    // in that window, letting this command create a genuinely cyclic
    // hierarchy (Codex review, #290).
    if has_live_child_via(&space, &parsed_child_id).await? {
        return Err(format!("{child_room_id} is already a child of {space_id}"));
    }
    // A cycle can only run through a *space* child — a normal room has no
    // children of its own to eventually loop back to `space_id` through, so
    // there's nothing to check. Also sidesteps a real-world failure mode:
    // the `/hierarchy` endpoint below is defined for space room IDs, and
    // some homeservers reject it outright for an ordinary room, which would
    // otherwise break Add Existing for every non-space room (Codex review,
    // #290).
    if child_room.is_space() && live_hierarchy_contains(client, &parsed_child_id, space_id).await? {
        return Err(format!(
            "{child_room_id} is an ancestor of {space_id} — adding it as a child would form a cycle"
        ));
    }
    // Every client that later reads this edge needs at least one candidate
    // server to route the join through — an empty `via` (which a missing
    // `user_id`, e.g. a session lost mid-request, would otherwise silently
    // produce) makes the edge unusable rather than merely degraded, so this
    // is a hard error rather than falling back to an empty list.
    add_child_edge(&space, &child_room).await
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

/// `child_id`'s current `m.space.child` content in `space`, or `None` if
/// there's no live edge (never set, or redacted down to nothing). Queries
/// the *server* directly rather than this client's local sync-populated
/// store, and is the shared basis for every caller here that needs to check
/// or preserve the edge's live state — `remove_space_child_impl`'s
/// live-edge check and `set_space_child_suggested_impl`'s read-modify-write
/// both go through this rather than the store, since either can act on an
/// edge before this client's own `/sync` has caught up with it (a caller
/// right after `RoomList` refetches `/hierarchy` post-Add-Existing, or after
/// another client's own concurrent edit) — a store-only read would let a
/// stale local copy either wrongly reject a live edge, or silently
/// resurrect/clobber one with content that's no longer current.
///
/// A `404`/`M_NOT_FOUND` from the server, or content that fails to
/// deserialize as `SpaceChildEventContent` (the shape a redacted event's
/// content — which per MSC1772 has no `via` left — takes, since `via` has
/// no default and isn't present), both mean "no live edge" and return
/// `Ok(None)`. Any other error (a network failure, an unexpected server
/// response) is propagated as-is rather than silently treated as "not a
/// child", since that would let a transient failure produce a
/// wrong-but-confident rejection.
async fn live_child_content(
    space: &Room,
    child_id: &RoomId,
) -> Result<Option<SpaceChildEventContent>, String> {
    let request = get_state_event_for_key::v3::Request::new(
        space.room_id().to_owned(),
        StateEventType::SpaceChild,
        child_id.to_string(),
    );
    match space.client().send(request).await {
        Ok(response) => Ok(response
            .into_content()
            .deserialize_as_unchecked::<SpaceChildEventContent>()
            .ok()),
        Err(e) if e.client_api_error_kind() == Some(&ErrorKind::NotFound) => Ok(None),
        Err(e) => Err(e.to_string()),
    }
}

/// True if `child_id`'s `m.space.child` state in `space` currently carries a
/// non-empty `via` — i.e. is a live, unrevoked child link. See
/// [`live_child_content`] for how "live" is determined.
async fn has_live_child_via(space: &Room, child_id: &RoomId) -> Result<bool, String> {
    Ok(live_child_content(space, child_id)
        .await?
        .is_some_and(|content| !content.via.is_empty()))
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
    let _mutation_guard = super::actions::lock_room_mutation(space_id).await?;
    let space = require_space(client, space_id)?;
    let parsed_child_id = RoomId::parse(child_room_id).map_err(|e| e.to_string())?;

    // Mirrors `set_space_child_suggested_impl`'s existing-child check — sending
    // an empty `m.space.child` at a state key with no live child edge (never
    // set, or already redacted) would be a silent no-op rather than an error,
    // hiding a stale/duplicate removal from the caller. Queried against the
    // *server*, not the local sync-populated store: `RoomList` can refetch
    // `/hierarchy` and render a room Add Existing just published as a child
    // before this client's own `/sync` has caught up, so a store-only lookup
    // here would wrongly reject an immediate Remove on that still-unsynced
    // row (Codex review, #290).
    let has_live_via = has_live_child_via(&space, &parsed_child_id).await?;
    if !has_live_via {
        return Err(format!(
            "{child_room_id} is not currently a child of {space_id}"
        ));
    }

    remove_child_edge(&space, &parsed_child_id).await
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
    let _mutation_guard = super::actions::lock_room_mutation(space_id).await?;
    let space = require_space(client, space_id)?;
    let parsed_child_id = RoomId::parse(child_room_id).map_err(|e| e.to_string())?;

    // Read-modify-write, so this needs the *current* server-side content to
    // preserve — not the local sync-populated store, which another client's
    // concurrent remove/edit of this same edge (after our last sync) could
    // leave stale here. Writing back a stale `via`/`order` while flipping
    // `suggested` could silently recreate an edge another client just
    // removed, or clobber their update (Codex review, #290). See
    // `live_child_content` for why an empty `via` and a missing/redacted
    // event both collapse to the same "not currently a child" outcome.
    let mut content = live_child_content(&space, &parsed_child_id)
        .await?
        .filter(|content| !content.via.is_empty())
        .ok_or_else(|| format!("{child_room_id} is not currently a child of {space_id}"))?;
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

    async fn sync_space_with_power_level(
        server: &MatrixMockServer,
        client: &Client,
        room_id: &RoomId,
        power_level: i64,
    ) {
        use matrix_sdk_test::event_factory::EventFactory;
        use matrix_sdk_test::{JoinedRoomBuilder, ALICE};
        use std::collections::BTreeMap;

        let event_factory = EventFactory::new().room(room_id).sender(&ALICE);
        let create_event = event_factory
            .create(&ALICE, matrix_sdk::ruma::RoomVersionId::V11)
            .with_space_type();
        let own_user_id = client.user_id().expect("mock client user").to_owned();
        let power_level = matrix_sdk::ruma::Int::try_from(power_level)
            .expect("test power level must be a Matrix integer");
        let power_levels =
            event_factory.power_levels(&mut BTreeMap::from([(own_user_id, power_level)]));
        server
            .sync_room(
                client,
                JoinedRoomBuilder::new(room_id)
                    .add_state_event(create_event)
                    .add_state_event(power_levels),
            )
            .await;
    }

    async fn sync_space(server: &MatrixMockServer, client: &Client, room_id: &RoomId) {
        sync_space_with_power_level(server, client, room_id, 100).await;
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
    async fn create_space_impl_writes_both_sides_of_a_parent_relationship() {
        let parent_id = matrix_sdk::ruma::room_id!("!parent:example.org");
        let child_id = matrix_sdk::ruma::room_id!("!created:example.org");
        let server = MatrixMockServer::new().await;
        let client = server.client_builder().build().await;
        server.mock_room_state_encryption().plain().mount().await;
        sync_space(&server, &client, parent_id).await;

        wiremock::Mock::given(wiremock::matchers::method("POST"))
            .and(wiremock::matchers::path_regex(
                r"^/_matrix/client/(r0|v3)/createRoom$",
            ))
            .respond_with(
                wiremock::ResponseTemplate::new(200).set_body_json(json!({ "room_id": child_id })),
            )
            .expect(1)
            .mount(server.server())
            .await;

        wiremock::Mock::given(wiremock::matchers::method("PUT"))
            .and(wiremock::matchers::path(format!(
                "/_matrix/client/v3/rooms/{parent_id}/state/m.space.child/{child_id}"
            )))
            .and(wiremock::matchers::body_json(
                json!({ "via": ["localhost"] }),
            ))
            .respond_with(
                wiremock::ResponseTemplate::new(200)
                    .set_body_json(json!({ "event_id": "$child_added" })),
            )
            .expect(1)
            .mount(server.server())
            .await;

        let result = create_space_impl(
            &client,
            "Nested",
            None,
            None,
            false,
            Some(parent_id.as_str()),
        )
        .await;

        assert_eq!(result.as_deref(), Ok(child_id.as_str()));
        let requests = server.server().received_requests().await.unwrap();
        let create_request = requests
            .iter()
            .find(|request| request.url.path().ends_with("/createRoom"))
            .expect("createRoom request");
        let body: serde_json::Value =
            serde_json::from_slice(&create_request.body).expect("JSON create-room body");
        assert_eq!(body["creation_content"]["type"], "m.space");
        assert_eq!(
            body["initial_state"],
            json!([{
                "type": "m.space.parent",
                "state_key": parent_id,
                "content": {
                    "canonical": true,
                    "via": ["localhost"],
                },
            }])
        );
    }

    #[tokio::test]
    async fn create_space_impl_preflights_parent_permission_before_creating_room() {
        let parent_id = matrix_sdk::ruma::room_id!("!parent:example.org");
        let server = MatrixMockServer::new().await;
        let client = server.client_builder().build().await;
        server.mock_room_state_encryption().plain().mount().await;
        sync_space_with_power_level(&server, &client, parent_id, 0).await;

        let result = create_space_impl(
            &client,
            "Nested",
            None,
            None,
            false,
            Some(parent_id.as_str()),
        )
        .await;

        assert_eq!(
            result.expect_err("parent-side permission denial must reject creation"),
            "insufficient permissions to send m.space.child in !parent:example.org"
        );
        let requests = server.server().received_requests().await.unwrap();
        assert!(
            requests
                .iter()
                .all(|request| !request.url.path().ends_with("/createRoom")),
            "permission preflight must reject before creating the child room"
        );
    }

    #[tokio::test]
    async fn set_space_parent_impl_rejects_self_parenting_before_network_writes() {
        let space_id = matrix_sdk::ruma::room_id!("!space:example.org");
        let server = MatrixMockServer::new().await;
        let client = server.client_builder().build().await;
        server.mock_room_state_encryption().plain().mount().await;
        sync_space(&server, &client, space_id).await;

        let result =
            set_space_parent_impl(&client, space_id.as_str(), Some(space_id.as_str())).await;

        assert_eq!(
            result.expect_err("self-parenting must fail"),
            "!space:example.org cannot be its own parent"
        );
    }

    #[tokio::test]
    async fn set_space_parent_impl_rejects_a_server_visible_descendant() {
        let space_id = matrix_sdk::ruma::room_id!("!space:example.org");
        let descendant_id = matrix_sdk::ruma::room_id!("!descendant:example.org");
        let server = MatrixMockServer::new().await;
        let client = server.client_builder().build().await;
        server.mock_room_state_encryption().plain().mount().await;
        sync_space(&server, &client, space_id).await;
        sync_space(&server, &client, descendant_id).await;

        wiremock::Mock::given(wiremock::matchers::method("GET"))
            .and(wiremock::matchers::path(format!(
                "/_matrix/client/v1/rooms/{space_id}/hierarchy"
            )))
            .respond_with(wiremock::ResponseTemplate::new(200).set_body_json(json!({
                "rooms": [
                    {
                        "room_id": space_id,
                        "num_joined_members": 1,
                        "world_readable": false,
                        "guest_can_join": false,
                        "join_rule": "invite",
                        "room_type": "m.space",
                        "children_state": [],
                    },
                    {
                        "room_id": descendant_id,
                        "num_joined_members": 1,
                        "world_readable": false,
                        "guest_can_join": false,
                        "join_rule": "invite",
                        "room_type": "m.space",
                        "children_state": [],
                    },
                ],
            })))
            .mount(server.server())
            .await;

        let result =
            set_space_parent_impl(&client, space_id.as_str(), Some(descendant_id.as_str())).await;

        assert_eq!(
            result.expect_err("a descendant cannot become the parent"),
            "!descendant:example.org is a descendant of !space:example.org — making it the parent would form a cycle"
        );
        let requests = server.server().received_requests().await.unwrap();
        assert!(
            requests.iter().all(|request| request.method != "PUT"),
            "cycle rejection must happen before any state write"
        );
    }

    #[tokio::test]
    async fn set_space_parent_impl_preflights_child_permission_before_any_state_write() {
        let child_id = matrix_sdk::ruma::room_id!("!child:example.org");
        let new_parent_id = matrix_sdk::ruma::room_id!("!new:example.org");
        let server = MatrixMockServer::new().await;
        let client = server.client_builder().build().await;
        server.mock_room_state_encryption().plain().mount().await;
        sync_space_with_power_level(&server, &client, child_id, 0).await;
        sync_space_with_power_level(&server, &client, new_parent_id, 100).await;

        wiremock::Mock::given(wiremock::matchers::method("GET"))
            .and(wiremock::matchers::path(format!(
                "/_matrix/client/v1/rooms/{child_id}/hierarchy"
            )))
            .respond_with(wiremock::ResponseTemplate::new(200).set_body_json(json!({
                "rooms": [{
                    "room_id": child_id,
                    "num_joined_members": 1,
                    "world_readable": false,
                    "guest_can_join": false,
                    "join_rule": "invite",
                    "room_type": "m.space",
                    "children_state": [],
                }],
            })))
            .mount(server.server())
            .await;

        wiremock::Mock::given(wiremock::matchers::method("GET"))
            .and(wiremock::matchers::path(format!(
                "/_matrix/client/v3/rooms/{child_id}/state"
            )))
            .respond_with(wiremock::ResponseTemplate::new(200).set_body_json(json!([])))
            .mount(server.server())
            .await;

        let result =
            set_space_parent_impl(&client, child_id.as_str(), Some(new_parent_id.as_str())).await;

        assert_eq!(
            result.expect_err("child-side permission denial must reject reparenting"),
            "insufficient permissions to send m.space.parent in !child:example.org"
        );
        let requests = server.server().received_requests().await.unwrap();
        assert!(
            requests.iter().all(|request| request.method != "PUT"),
            "permission preflight must reject before publishing either relationship edge"
        );
    }

    #[tokio::test]
    async fn set_space_parent_impl_replaces_only_the_canonical_relationship() {
        let child_id = matrix_sdk::ruma::room_id!("!child:example.org");
        let old_parent_id = matrix_sdk::ruma::room_id!("!old:example.org");
        let new_parent_id = matrix_sdk::ruma::room_id!("!new:example.org");
        let other_parent_id = matrix_sdk::ruma::room_id!("!other:example.org");
        let server = MatrixMockServer::new().await;
        let client = server.client_builder().build().await;
        server.mock_room_state_encryption().plain().mount().await;
        for room_id in [child_id, old_parent_id, new_parent_id, other_parent_id] {
            sync_space(&server, &client, room_id).await;
        }

        wiremock::Mock::given(wiremock::matchers::method("GET"))
            .and(wiremock::matchers::path(format!(
                "/_matrix/client/v1/rooms/{child_id}/hierarchy"
            )))
            .respond_with(wiremock::ResponseTemplate::new(200).set_body_json(json!({
                "rooms": [{
                    "room_id": child_id,
                    "num_joined_members": 1,
                    "world_readable": false,
                    "guest_can_join": false,
                    "join_rule": "invite",
                    "room_type": "m.space",
                    "children_state": [],
                }],
            })))
            .mount(server.server())
            .await;

        wiremock::Mock::given(wiremock::matchers::method("GET"))
            .and(wiremock::matchers::path(format!(
                "/_matrix/client/v3/rooms/{child_id}/state"
            )))
            .respond_with(wiremock::ResponseTemplate::new(200).set_body_json(json!([
                {
                    "content": { "canonical": true, "via": ["localhost"] },
                    "event_id": "$old_parent",
                    "origin_server_ts": 1,
                    "room_id": child_id,
                    "sender": "@example:localhost",
                    "state_key": old_parent_id,
                    "type": "m.space.parent",
                    "unsigned": {},
                },
                {
                    "content": { "via": ["localhost"] },
                    "event_id": "$other_parent",
                    "origin_server_ts": 2,
                    "room_id": child_id,
                    "sender": "@example:localhost",
                    "state_key": other_parent_id,
                    "type": "m.space.parent",
                    "unsigned": {},
                },
            ])))
            .mount(server.server())
            .await;

        wiremock::Mock::given(wiremock::matchers::method("GET"))
            .and(wiremock::matchers::path(format!(
                "/_matrix/client/v3/rooms/{new_parent_id}/state/m.space.child/{child_id}"
            )))
            .respond_with(wiremock::ResponseTemplate::new(404).set_body_json(json!({
                "errcode": "M_NOT_FOUND",
                "error": "Event not found.",
            })))
            .mount(server.server())
            .await;
        wiremock::Mock::given(wiremock::matchers::method("GET"))
            .and(wiremock::matchers::path(format!(
                "/_matrix/client/v3/rooms/{old_parent_id}/state/m.space.child/{child_id}"
            )))
            .respond_with(
                wiremock::ResponseTemplate::new(200).set_body_json(json!({ "via": ["localhost"] })),
            )
            .mount(server.server())
            .await;

        for (room_id, event_type, state_key, body) in [
            (
                new_parent_id,
                "m.space.child",
                child_id,
                json!({ "via": ["localhost"] }),
            ),
            (
                child_id,
                "m.space.parent",
                new_parent_id,
                json!({ "canonical": true, "via": ["localhost"] }),
            ),
            (old_parent_id, "m.space.child", child_id, json!({})),
            (child_id, "m.space.parent", old_parent_id, json!({})),
        ] {
            wiremock::Mock::given(wiremock::matchers::method("PUT"))
                .and(wiremock::matchers::path(format!(
                    "/_matrix/client/v3/rooms/{room_id}/state/{event_type}/{state_key}"
                )))
                .and(wiremock::matchers::body_json(body))
                .respond_with(
                    wiremock::ResponseTemplate::new(200)
                        .set_body_json(json!({ "event_id": "$updated" })),
                )
                .expect(1)
                .mount(server.server())
                .await;
        }

        let result =
            set_space_parent_impl(&client, child_id.as_str(), Some(new_parent_id.as_str())).await;

        assert!(
            result.is_ok(),
            "expected canonical reparent to succeed, got {result:?}"
        );
    }

    #[tokio::test]
    async fn set_space_parent_impl_clears_an_inaccessible_canonical_parent() {
        let child_id = matrix_sdk::ruma::room_id!("!child:example.org");
        let old_parent_id = matrix_sdk::ruma::room_id!("!old:elsewhere.example");
        let server = MatrixMockServer::new().await;
        let client = server.client_builder().build().await;
        server.mock_room_state_encryption().plain().mount().await;
        sync_space(&server, &client, child_id).await;

        wiremock::Mock::given(wiremock::matchers::method("GET"))
            .and(wiremock::matchers::path(format!(
                "/_matrix/client/v3/rooms/{child_id}/state"
            )))
            .respond_with(wiremock::ResponseTemplate::new(200).set_body_json(json!([{
                "content": { "canonical": true, "via": ["elsewhere.example"] },
                "event_id": "$old_parent",
                "origin_server_ts": 1,
                "room_id": child_id,
                "sender": "@example:localhost",
                "state_key": old_parent_id,
                "type": "m.space.parent",
                "unsigned": {},
            }])))
            .mount(server.server())
            .await;

        wiremock::Mock::given(wiremock::matchers::method("PUT"))
            .and(wiremock::matchers::path(format!(
                "/_matrix/client/v3/rooms/{child_id}/state/m.space.parent/{old_parent_id}"
            )))
            .and(wiremock::matchers::body_json(json!({})))
            .respond_with(
                wiremock::ResponseTemplate::new(200)
                    .set_body_json(json!({ "event_id": "$parent_cleared" })),
            )
            .expect(1)
            .mount(server.server())
            .await;

        let result = set_space_parent_impl(&client, child_id.as_str(), None).await;

        assert!(
            result.is_ok(),
            "an inaccessible old parent must not block unparenting: {result:?}"
        );
        let requests = server.server().received_requests().await.unwrap();
        let old_parent_path = format!("/_matrix/client/v3/rooms/{old_parent_id}/");
        assert!(
            requests
                .iter()
                .all(|request| !request.url.path().starts_with(&old_parent_path)),
            "the command must not query or write the inaccessible old parent room"
        );
    }

    #[tokio::test]
    async fn set_space_parent_impl_clears_child_when_old_parent_is_not_writable() {
        let child_id = matrix_sdk::ruma::room_id!("!child:example.org");
        let old_parent_id = matrix_sdk::ruma::room_id!("!old:example.org");
        let server = MatrixMockServer::new().await;
        let client = server.client_builder().build().await;
        server.mock_room_state_encryption().plain().mount().await;
        sync_space_with_power_level(&server, &client, child_id, 100).await;
        sync_space_with_power_level(&server, &client, old_parent_id, 0).await;

        wiremock::Mock::given(wiremock::matchers::method("GET"))
            .and(wiremock::matchers::path(format!(
                "/_matrix/client/v3/rooms/{child_id}/state"
            )))
            .respond_with(wiremock::ResponseTemplate::new(200).set_body_json(json!([{
                "content": { "canonical": true, "via": ["localhost"] },
                "event_id": "$old_parent",
                "origin_server_ts": 1,
                "room_id": child_id,
                "sender": "@example:localhost",
                "state_key": old_parent_id,
                "type": "m.space.parent",
                "unsigned": {},
            }])))
            .mount(server.server())
            .await;

        wiremock::Mock::given(wiremock::matchers::method("PUT"))
            .and(wiremock::matchers::path(format!(
                "/_matrix/client/v3/rooms/{child_id}/state/m.space.parent/{old_parent_id}"
            )))
            .and(wiremock::matchers::body_json(json!({})))
            .respond_with(
                wiremock::ResponseTemplate::new(200)
                    .set_body_json(json!({ "event_id": "$parent_cleared" })),
            )
            .expect(1)
            .mount(server.server())
            .await;

        let result = set_space_parent_impl(&client, child_id.as_str(), None).await;

        assert!(
            result.is_ok(),
            "an unwritable old parent must not trap the child relationship: {result:?}"
        );
        let requests = server.server().received_requests().await.unwrap();
        let old_parent_path = format!("/_matrix/client/v3/rooms/{old_parent_id}/");
        assert!(
            requests
                .iter()
                .all(|request| !request.url.path().starts_with(&old_parent_path)),
            "the command must skip reads and writes in the unwritable old parent"
        );
    }

    #[tokio::test]
    async fn add_child_edge_routes_via_the_child_room() {
        use matrix_sdk::ruma::events::room::member::MembershipState;
        use matrix_sdk_test::event_factory::EventFactory;
        use matrix_sdk_test::{JoinedRoomBuilder, ALICE};

        let parent_id = matrix_sdk::ruma::room_id!("!parent:parent.example");
        let child_id = matrix_sdk::ruma::room_id!("!child:child.example");
        let child_member = matrix_sdk::ruma::user_id!("@child-member:child.example").to_owned();
        let server = MatrixMockServer::new().await;
        let client = server.client_builder().build().await;
        server.mock_room_state_encryption().plain().mount().await;

        sync_space(&server, &client, parent_id).await;
        let child_factory = EventFactory::new().room(child_id).sender(&ALICE);
        server
            .sync_room(
                &client,
                JoinedRoomBuilder::new(child_id)
                    .add_state_event(
                        child_factory
                            .create(&ALICE, matrix_sdk::ruma::RoomVersionId::V11)
                            .with_space_type(),
                    )
                    .add_state_event(
                        child_factory
                            .member(&child_member)
                            .membership(MembershipState::Join),
                    ),
            )
            .await;

        wiremock::Mock::given(wiremock::matchers::method("PUT"))
            .and(wiremock::matchers::path(format!(
                "/_matrix/client/v3/rooms/{parent_id}/state/m.space.child/{child_id}"
            )))
            .and(wiremock::matchers::body_json(json!({
                "via": ["child.example"],
            })))
            .respond_with(
                wiremock::ResponseTemplate::new(200)
                    .set_body_json(json!({ "event_id": "$child_added" })),
            )
            .expect(1)
            .mount(server.server())
            .await;

        let parent = client.get_room(parent_id).expect("synced parent");
        let child = client.get_room(child_id).expect("synced child");
        let result = add_child_edge(&parent, &child).await;

        assert!(
            result.is_ok(),
            "expected child route to be published on parent edge: {result:?}"
        );
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

        // The live duplicate check now queries the server directly (see
        // `has_live_child_via`) — the live *cycle* check is skipped
        // entirely here since `child_id` is a plain (non-space) room, which
        // can't have children of its own to loop back through (see the
        // dedicated test below for that guard).
        wiremock::Mock::given(wiremock::matchers::method("GET"))
            .and(wiremock::matchers::path(format!(
                "/_matrix/client/v3/rooms/{space_id}/state/m.space.child/{child_id}"
            )))
            .respond_with(wiremock::ResponseTemplate::new(404).set_body_json(json!({
                "errcode": "M_NOT_FOUND",
                "error": "Event not found.",
            })))
            .mount(server.server())
            .await;

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

    /// A cycle can only run through a *space* child — a plain room has no
    /// children to loop back through — so `add_existing_space_child_impl`
    /// must not call the `/hierarchy` endpoint (defined for space room IDs)
    /// against a non-space child at all. Some homeservers reject that
    /// endpoint outright for an ordinary room, which would otherwise break
    /// Add Existing for every non-space room (Codex review, #290). Modeled
    /// here by mounting the hierarchy endpoint to fail if called at all —
    /// the add still succeeding proves it wasn't.
    #[tokio::test]
    async fn add_existing_space_child_impl_skips_the_hierarchy_check_for_a_non_space_child() {
        use matrix_sdk_test::event_factory::EventFactory;
        use matrix_sdk_test::{JoinedRoomBuilder, ALICE};

        let space_id = matrix_sdk::ruma::room_id!("!space:example.org");
        let child_id = matrix_sdk::ruma::room_id!("!child:example.org");
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
        // A plain (non-space) joined room.
        server.sync_joined_room(&client, child_id).await;

        wiremock::Mock::given(wiremock::matchers::method("GET"))
            .and(wiremock::matchers::path(format!(
                "/_matrix/client/v3/rooms/{space_id}/state/m.space.child/{child_id}"
            )))
            .respond_with(wiremock::ResponseTemplate::new(404).set_body_json(json!({
                "errcode": "M_NOT_FOUND",
                "error": "Event not found.",
            })))
            .mount(server.server())
            .await;
        // Some homeservers 400 this endpoint for a non-space room id — if
        // `add_existing_space_child_impl` called it anyway, this mock would
        // make that failure visible as a rejected add.
        wiremock::Mock::given(wiremock::matchers::method("GET"))
            .and(wiremock::matchers::path(format!(
                "/_matrix/client/v1/rooms/{child_id}/hierarchy"
            )))
            .respond_with(wiremock::ResponseTemplate::new(400).set_body_json(json!({
                "errcode": "M_UNRECOGNIZED",
                "error": "Root room is not a space",
            })))
            .mount(server.server())
            .await;
        wiremock::Mock::given(wiremock::matchers::method("PUT"))
            .and(wiremock::matchers::path(format!(
                "/_matrix/client/v3/rooms/{space_id}/state/m.space.child/{child_id}"
            )))
            .respond_with(
                wiremock::ResponseTemplate::new(200)
                    .set_body_json(json!({ "event_id": "$child_added" })),
            )
            .mount(server.server())
            .await;

        let result =
            add_existing_space_child_impl(&client, space_id.as_str(), child_id.as_str()).await;
        assert!(
            result.is_ok(),
            "expected adding a non-space room to succeed without calling /hierarchy, got {result:?}"
        );
    }

    /// The live cycle check backing `add_existing_space_child_impl` queries
    /// the *server*, not this client's local sync-populated store — covers
    /// the case a Codex review flagged on #290: another device may have
    /// added a parent edge that hasn't reached this client's own `/sync`
    /// yet, so the local `parent_space_ids`-based pre-check alone would miss
    /// a cycle that the live server hierarchy already reflects.
    #[tokio::test]
    async fn add_existing_space_child_impl_sees_a_cycle_the_local_store_missed() {
        use matrix_sdk_test::event_factory::EventFactory;
        use matrix_sdk_test::{JoinedRoomBuilder, ALICE};

        // Root and Child are both known locally with no edge between them
        // yet — so the local pre-check sees no cycle — but the *server*
        // already has Root as a descendant of Child (another device added
        // it after this client's last sync).
        let root_id = matrix_sdk::ruma::room_id!("!root:example.org");
        let child_id = matrix_sdk::ruma::room_id!("!child:example.org");
        let server = MatrixMockServer::new().await;
        let client = server.client_builder().build().await;

        server.mock_room_state_encryption().plain().mount().await;
        let root_create_event = EventFactory::new()
            .room(root_id)
            .sender(&ALICE)
            .create(&ALICE, matrix_sdk::ruma::RoomVersionId::V11)
            .with_space_type();
        server
            .sync_room(
                &client,
                JoinedRoomBuilder::new(root_id).add_state_event(root_create_event),
            )
            .await;
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

        wiremock::Mock::given(wiremock::matchers::method("GET"))
            .and(wiremock::matchers::path(format!(
                "/_matrix/client/v3/rooms/{child_id}/state/m.space.child/{root_id}"
            )))
            .respond_with(wiremock::ResponseTemplate::new(404).set_body_json(json!({
                "errcode": "M_NOT_FOUND",
                "error": "Event not found.",
            })))
            .mount(server.server())
            .await;
        // The server's live hierarchy for Child already includes Root as a
        // descendant — this is what the local store hasn't caught up to.
        wiremock::Mock::given(wiremock::matchers::method("GET"))
            .and(wiremock::matchers::path(format!(
                "/_matrix/client/v1/rooms/{root_id}/hierarchy"
            )))
            .respond_with(wiremock::ResponseTemplate::new(200).set_body_json(json!({
                "rooms": [
                    {
                        "room_id": root_id,
                        "num_joined_members": 1,
                        "world_readable": false,
                        "guest_can_join": false,
                        "join_rule": "invite",
                        "room_type": "m.space",
                        "children_state": [],
                    },
                    {
                        "room_id": child_id,
                        "num_joined_members": 1,
                        "world_readable": false,
                        "guest_can_join": false,
                        "join_rule": "invite",
                        "room_type": "m.space",
                        "children_state": [],
                    },
                ],
            })))
            .mount(server.server())
            .await;

        let result =
            add_existing_space_child_impl(&client, child_id.as_str(), root_id.as_str()).await;
        assert!(
            result.is_err(),
            "expected the server-visible cycle (missed by the local store) to be rejected, got {result:?}"
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
    async fn add_existing_space_child_impl_rejects_a_direct_message_room() {
        use matrix_sdk_test::event_factory::EventFactory;
        use matrix_sdk_test::{JoinedRoomBuilder, ALICE};

        let space_id = matrix_sdk::ruma::room_id!("!space:example.org");
        let dm_id = matrix_sdk::ruma::room_id!("!dm:example.org");
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

        server
            .mock_sync()
            .ok_and_run(&client, |builder| {
                builder.add_joined_room(JoinedRoomBuilder::new(dm_id));
                builder.add_global_account_data(
                    EventFactory::new()
                        .direct()
                        .add_user((*ALICE).into(), dm_id),
                );
            })
            .await;

        let result =
            add_existing_space_child_impl(&client, space_id.as_str(), dm_id.as_str()).await;
        assert!(
            result.is_err(),
            "expected a direct-message room to be rejected, got {result:?}"
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

        // The live-edge check now queries the server directly (not the local
        // sync-populated store — see `has_live_child_via`), so this needs its
        // own GET mock even though `sync_room` above already seeded the store.
        wiremock::Mock::given(wiremock::matchers::method("GET"))
            .and(wiremock::matchers::path(format!(
                "/_matrix/client/v3/rooms/{space_id}/state/m.space.child/{child_id}"
            )))
            .respond_with(
                wiremock::ResponseTemplate::new(200)
                    .set_body_json(json!({ "via": ["example.org"] })),
            )
            .mount(server.server())
            .await;

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

    /// The live-edge check backing `remove_space_child_impl` queries the
    /// *server*, not this client's local sync-populated store — covers the
    /// case a Codex review flagged on #290: a room `RoomList` just rendered
    /// via a `/hierarchy` refetch (e.g. right after Add Existing) may not
    /// have reached this client's own `/sync` yet, so the store alone would
    /// wrongly report no live edge even though the server already has one.
    #[tokio::test]
    async fn remove_space_child_impl_succeeds_on_a_child_edge_not_yet_in_the_local_store() {
        use matrix_sdk_test::event_factory::EventFactory;
        use matrix_sdk_test::{JoinedRoomBuilder, ALICE};

        let space_id = matrix_sdk::ruma::room_id!("!space:example.org");
        let child_id = matrix_sdk::ruma::room_id!("!child:example.org");
        let server = MatrixMockServer::new().await;
        let client = server.client_builder().build().await;

        server.mock_room_state_encryption().plain().mount().await;

        // The synced room state has no `m.space.child` for `child_id` at
        // all — standing in for a client whose `/sync` hasn't caught up yet.
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

        // But the server itself already has the live edge (e.g. Add
        // Existing's write has already landed there).
        wiremock::Mock::given(wiremock::matchers::method("GET"))
            .and(wiremock::matchers::path(format!(
                "/_matrix/client/v3/rooms/{space_id}/state/m.space.child/{child_id}"
            )))
            .respond_with(
                wiremock::ResponseTemplate::new(200)
                    .set_body_json(json!({ "via": ["example.org"] })),
            )
            .mount(server.server())
            .await;

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
            "expected the server-backed check to see the live edge the local store hasn't synced yet, got {result:?}"
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

        wiremock::Mock::given(wiremock::matchers::method("GET"))
            .and(wiremock::matchers::path(format!(
                "/_matrix/client/v3/rooms/{space_id}/state/m.space.child/{not_a_child_id}"
            )))
            .respond_with(wiremock::ResponseTemplate::new(404).set_body_json(json!({
                "errcode": "M_NOT_FOUND",
                "error": "Event not found.",
            })))
            .mount(server.server())
            .await;

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

        // The read-modify-write's live-content read now queries the server
        // directly (not the local sync-populated store — see
        // `live_child_content`), so this needs its own GET mock even though
        // `sync_room` above already seeded the store.
        wiremock::Mock::given(wiremock::matchers::method("GET"))
            .and(wiremock::matchers::path(format!(
                "/_matrix/client/v3/rooms/{space_id}/state/m.space.child/{child_id}"
            )))
            .respond_with(wiremock::ResponseTemplate::new(200).set_body_json(json!({
                "via": ["example.org"],
                "order": "aaa",
            })))
            .mount(server.server())
            .await;

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

    /// `set_space_child_suggested_impl`'s read-modify-write must see another
    /// client's concurrent edit rather than a stale local copy — covers the
    /// case a Codex review flagged on #290: if the local sync-populated
    /// store still has the old content, preserving it while flipping
    /// `suggested` could silently resurrect a removed link or clobber a
    /// concurrent update. Standing in for that here: the store has a live
    /// edge, but the server (queried directly) reports the edge already
    /// revoked.
    #[tokio::test]
    async fn set_space_child_suggested_impl_sees_a_concurrent_removal_the_local_store_missed() {
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

        // Another client removed the edge after our last sync — the server
        // now reports an empty `via`, even though the local store (seeded
        // above) still has the old, live content.
        wiremock::Mock::given(wiremock::matchers::method("GET"))
            .and(wiremock::matchers::path(format!(
                "/_matrix/client/v3/rooms/{space_id}/state/m.space.child/{child_id}"
            )))
            .respond_with(wiremock::ResponseTemplate::new(200).set_body_json(json!({ "via": [] })))
            .mount(server.server())
            .await;

        let result =
            set_space_child_suggested_impl(&client, space_id.as_str(), child_id.as_str(), true)
                .await;
        assert!(
            result.is_err(),
            "expected the concurrent removal (visible only via the server-backed check) to be respected, got {result:?}"
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

        wiremock::Mock::given(wiremock::matchers::method("GET"))
            .and(wiremock::matchers::path(format!(
                "/_matrix/client/v3/rooms/{space_id}/state/m.space.child/{not_a_child_id}"
            )))
            .respond_with(wiremock::ResponseTemplate::new(404).set_body_json(json!({
                "errcode": "M_NOT_FOUND",
                "error": "Event not found.",
            })))
            .mount(server.server())
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

        wiremock::Mock::given(wiremock::matchers::method("GET"))
            .and(wiremock::matchers::path(format!(
                "/_matrix/client/v3/rooms/{space_id}/state/m.space.child/{child_id}"
            )))
            .respond_with(wiremock::ResponseTemplate::new(200).set_body_json(json!({ "via": [] })))
            .mount(server.server())
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
