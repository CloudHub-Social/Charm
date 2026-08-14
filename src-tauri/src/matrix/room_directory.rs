//! Public room directory search (Day-2 Spec 06).
//!
//! The Matrix SDK owns request construction and protocol parsing. Charm keeps
//! only a narrow, paginated DTO boundary shared by Tauri and the web companion.

use matrix_sdk::ruma::{
    api::client::directory::get_public_rooms_filtered,
    directory::{Filter, PublicRoomsChunk},
};
use matrix_sdk::Client;
use serde::{Deserialize, Serialize};
use tauri::State;
use ts_rs::TS;

use super::MatrixState;

const DEFAULT_PAGE_SIZE: u32 = 20;
const MAX_PAGE_SIZE: u32 = 50;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../src/bindings/")]
pub struct PublicRoomSummary {
    pub room_id: String,
    pub name: Option<String>,
    pub topic: Option<String>,
    pub canonical_alias: Option<String>,
    pub avatar_url: Option<String>,
    #[ts(type = "number")]
    pub joined_members: u64,
}

impl From<PublicRoomsChunk> for PublicRoomSummary {
    fn from(room: PublicRoomsChunk) -> Self {
        Self {
            room_id: room.room_id.to_string(),
            name: room.name,
            topic: room.topic,
            canonical_alias: room.canonical_alias.map(|alias| alias.to_string()),
            avatar_url: room.avatar_url.map(|avatar| avatar.to_string()),
            joined_members: room.num_joined_members.into(),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../src/bindings/")]
pub struct PublicRoomPage {
    pub rooms: Vec<PublicRoomSummary>,
    pub next_batch: Option<String>,
    #[ts(type = "number | null")]
    pub total_room_count_estimate: Option<u64>,
}

fn normalize_optional(value: Option<String>) -> Option<String> {
    value.and_then(|value| {
        let value = value.trim().to_string();
        (!value.is_empty()).then_some(value)
    })
}

#[tauri::command]
pub async fn search_public_rooms(
    state: State<'_, MatrixState>,
    query: Option<String>,
    since: Option<String>,
    limit: Option<u32>,
) -> Result<PublicRoomPage, String> {
    let client = state.require_client().await?;
    search_public_rooms_impl(&client, query, since, limit).await
}

pub async fn search_public_rooms_impl(
    client: &Client,
    query: Option<String>,
    since: Option<String>,
    limit: Option<u32>,
) -> Result<PublicRoomPage, String> {
    let mut filter = Filter::new();
    filter.generic_search_term = normalize_optional(query);

    let mut request = get_public_rooms_filtered::v3::Request::new();
    request.filter = filter;
    request.since = normalize_optional(since);
    request.limit = Some(
        limit
            .unwrap_or(DEFAULT_PAGE_SIZE)
            .clamp(1, MAX_PAGE_SIZE)
            .into(),
    );

    let response = client
        .public_rooms_filtered(request)
        .await
        .map_err(|error| error.to_string())?;

    Ok(PublicRoomPage {
        rooms: response.chunk.into_iter().map(Into::into).collect(),
        next_batch: response.next_batch,
        total_room_count_estimate: response.total_room_count_estimate.map(Into::into),
    })
}

#[cfg(test)]
mod tests {
    use matrix_sdk::test_utils::mocks::MatrixMockServer;
    use wiremock::matchers::{body_json, method, path};
    use wiremock::{Mock, ResponseTemplate};

    use super::search_public_rooms_impl;

    #[tokio::test]
    async fn search_maps_results_and_round_trips_pagination() {
        let server = MatrixMockServer::new().await;
        let client = server.client_builder().build().await;

        Mock::given(method("POST"))
            .and(path("/_matrix/client/v3/publicRooms"))
            .and(body_json(serde_json::json!({
                "limit": 20,
                "since": "page-2",
                "filter": { "generic_search_term": "matrix" }
            })))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "chunk": [{
                    "room_id": "!public:example.org",
                    "name": "Matrix HQ",
                    "topic": "Public Matrix discussion",
                    "canonical_alias": "#matrix:example.org",
                    "avatar_url": "mxc://example.org/avatar",
                    "num_joined_members": 42,
                    "world_readable": true,
                    "guest_can_join": false,
                    "join_rule": "public"
                }],
                "next_batch": "page-3",
                "total_room_count_estimate": 120
            })))
            .mount(server.server())
            .await;

        let page = search_public_rooms_impl(
            &client,
            Some(" matrix ".to_string()),
            Some("page-2".to_string()),
            None,
        )
        .await
        .expect("directory page should load");

        assert_eq!(page.rooms.len(), 1);
        assert_eq!(page.rooms[0].room_id, "!public:example.org");
        assert_eq!(
            page.rooms[0].canonical_alias.as_deref(),
            Some("#matrix:example.org")
        );
        assert_eq!(page.rooms[0].joined_members, 42);
        assert_eq!(page.next_batch.as_deref(), Some("page-3"));
        assert_eq!(page.total_room_count_estimate, Some(120));
    }
}
