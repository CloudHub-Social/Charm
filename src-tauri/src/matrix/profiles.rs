//! Own-profile resolution and the signed-in user's live profile-change
//! signal, for Spec 01 (Timeline identity and profiles). Per-message sender
//! identity (the other half of Spec 01) doesn't need a bespoke cache here:
//! `matrix-sdk-ui`'s `Timeline` already resolves and live-updates each
//! `EventTimelineItem::sender_profile()` for us (see `timeline.rs`), and room
//! identity for the room list is resolved straight off `Room::heroes()` /
//! `Room::display_name()` (see `snapshot_rooms` in `mod.rs`) — both already
//! cached by matrix-rust-sdk itself, so a third, hand-rolled member cache
//! would just be redundant bookkeeping with nothing new to invalidate.
//!
//! What *isn't* covered by either of those: the signed-in user's own profile.
//! Matrix has no dedicated account-wide "your profile changed" sync event —
//! an out-of-band edit (e.g. from another client) only ever surfaces as an
//! `m.room.member` event about yourself, in whichever room you happen to
//! share with anyone. `register_self_profile_handler` watches for exactly
//! that and pushes `profile:self`.

use futures_util::StreamExt;
use matrix_sdk::deserialized_responses::RawSyncOrStrippedState;
use matrix_sdk::ruma::api::client::profile::{AvatarUrl, DisplayName};
use matrix_sdk::ruma::events::room::member::{
    MembershipState, RoomMemberEventContent, SyncRoomMemberEvent,
};
use matrix_sdk::ruma::events::SyncStateEvent;
use matrix_sdk::ruma::{OwnedMxcUri, RoomId, UserId};
use matrix_sdk::{Client, RoomState};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager, State};
use ts_rs::TS;

use super::media;
use super::presence::{get_presence_impl, PresenceStateDto, PresenceUpdate};
use super::MatrixState;

fn recover_poisoned_presence_lock(
    poison: std::sync::PoisonError<std::sync::MutexGuard<'_, PresenceStateDto>>,
) -> std::sync::MutexGuard<'_, PresenceStateDto> {
    tracing::warn!("sync presence mutex was poisoned; recovering last known presence");
    poison.into_inner()
}

/// Square thumbnail size (px) requested for every avatar this module
/// resolves — sender avatars, room avatars, and the signed-in user's own.
pub(crate) const AVATAR_THUMBNAIL_SIZE: u32 = 96;

/// Resolves `mxc` to a cached local thumbnail path, or `None` if there's no
/// media cache available (e.g. Spec 02 not wired in this build, or a plain
/// unit-test context with no `AppHandle`) or the fetch fails. Shared by
/// sender avatars (`timeline.rs`), room avatars (`mod.rs::snapshot_rooms`),
/// and the signed-in user's own avatar (`get_own_profile`, below).
pub(crate) async fn resolve_avatar_path(
    client: &Client,
    media_cache: Option<&media::MediaCache>,
    mxc: &str,
) -> Option<String> {
    let cache = media_cache?;
    media::resolve_avatar_thumbnail(cache, client, mxc, AVATAR_THUMBNAIL_SIZE)
        .await
        .map(|path| path.to_string_lossy().into_owned())
}

/// The signed-in user's own profile + presence, for the room-list header
/// (and a future account switcher). Read-only — editing your own profile is
/// a Spec 01 non-goal.
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../src/bindings/")]
pub struct OwnProfile {
    pub user_id: String,
    pub display_name: Option<String>,
    pub avatar_url: Option<String>,
    pub avatar_path: Option<String>,
    pub presence: PresenceStateDto,
}

/// Canonical profile-card read model (Spec 36).
///
/// Global profile fields and room-scoped membership fields intentionally stay
/// separate: a room display name/avatar can differ from the account-wide
/// profile, and collapsing them would make the UI unable to explain which
/// identity other room members actually see.
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../src/bindings/")]
pub struct UserProfile {
    pub user_id: String,
    pub display_name: Option<String>,
    pub avatar_url: Option<String>,
    pub avatar_path: Option<String>,
    pub room_display_name: Option<String>,
    pub room_avatar_url: Option<String>,
    pub room_avatar_path: Option<String>,
    pub presence: Option<PresenceUpdate>,
}

/// Minimal room identity returned for the mutual-rooms section of a profile
/// card. Notification counts, tags, and message previews from `RoomSummary`
/// are deliberately excluded because they are unrelated private room-list
/// state.
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../src/bindings/")]
pub struct MutualRoomSummary {
    pub room_id: String,
    pub name: Option<String>,
    pub avatar_url: Option<String>,
    pub avatar_path: Option<String>,
    pub is_direct: bool,
    pub is_space: bool,
}

/// Pushed on `profile:self` when the signed-in user's own membership event
/// (in any shared room) carries a changed display name/avatar — see the
/// module doc comment for why this is keyed off a membership event rather
/// than a dedicated profile-change event. `PartialEq` so
/// `register_self_profile_handler` can suppress a re-emit when a membership
/// event fires for an unrelated reason (e.g. a kick/invite in some other
/// shared room) but the profile fields it carries haven't actually changed.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../src/bindings/")]
pub struct SelfProfileUpdate {
    pub display_name: Option<String>,
    pub avatar_url: Option<String>,
}

/// Returns the signed-in user's display name, avatar (mxc + resolved local
/// thumbnail path, when a media cache is available), and current presence.
#[tauri::command]
pub async fn get_own_profile(
    app: AppHandle,
    state: State<'_, MatrixState>,
) -> Result<OwnProfile, String> {
    let client = state.require_client().await?;
    let media_cache = state.require_media_cache(&app).await.ok();
    let presence = *state
        .sync_presence
        .lock()
        .unwrap_or_else(recover_poisoned_presence_lock);
    get_own_profile_impl(&client, media_cache, presence).await
}

/// Core logic behind [`get_own_profile`], taking a plain `&Client` (and the
/// caller's already-resolved media cache/presence) rather than Tauri's
/// `AppHandle`/`State` extractors — `pub` (not `pub(crate)`) so the
/// network-dependent test for this lives in `tests/`, same rationale as
/// [`super::resolve_alias`]/[`super::discover`].
pub async fn get_own_profile_impl(
    client: &Client,
    media_cache: Option<&media::MediaCache>,
    presence: PresenceStateDto,
) -> Result<OwnProfile, String> {
    let user_id = client
        .user_id()
        .ok_or_else(|| "not logged in".to_string())?
        .to_owned();

    let display_name = client
        .account()
        .get_display_name()
        .await
        .map_err(|e| e.to_string())?;

    // Always a fresh network fetch, same as `get_display_name` above — not
    // `get_cached_avatar_url`, which only ever reads the SDK's own
    // last-fetched-avatar cache. `register_self_profile_handler` invalidates
    // `useOwnProfile` (which calls this) precisely when an out-of-band
    // `m.room.member` event says our avatar changed, so serving the stale
    // cached value here would defeat that invalidation — the whole point of
    // the refetch is to observe the *new* avatar, not echo the old one back.
    let avatar_url = client
        .account()
        .get_avatar_url()
        .await
        .map_err(|e| e.to_string())?;

    let avatar_path = match &avatar_url {
        Some(mxc) => resolve_avatar_path(client, media_cache, mxc.as_str()).await,
        None => None,
    };

    Ok(OwnProfile {
        user_id: user_id.to_string(),
        display_name,
        avatar_url: avatar_url.map(|url| url.to_string()),
        avatar_path,
        presence,
    })
}

/// Returns another user's global profile, optional room-scoped membership
/// profile, resolved avatar thumbnails, and best-effort presence.
#[tauri::command]
pub async fn get_user_profile(
    app: AppHandle,
    state: State<'_, MatrixState>,
    user_id: String,
    room_id: Option<String>,
    avatar_presence_visuals_enabled: Option<bool>,
) -> Result<UserProfile, String> {
    let client = state.require_client().await?;
    let media_cache = state.require_media_cache(&app).await.ok();
    let avatar_presence_visuals_enabled = avatar_presence_visuals_enabled.unwrap_or_else(|| {
        app.path().app_data_dir().is_ok_and(|dir| {
            crate::feature_flags::flag(
                &dir,
                crate::feature_flags::FeatureFlagKey::AvatarPresenceVisuals,
            )
        })
    });
    get_user_profile_impl(
        &client,
        media_cache,
        &user_id,
        room_id.as_deref(),
        avatar_presence_visuals_enabled,
    )
    .await
}

/// Core logic behind [`get_user_profile`], shared with the web companion.
pub async fn get_user_profile_impl(
    client: &Client,
    media_cache: Option<&media::MediaCache>,
    user_id: &str,
    room_id: Option<&str>,
    avatar_presence_visuals_enabled: bool,
) -> Result<UserProfile, String> {
    let user_id = UserId::parse(user_id).map_err(|e| e.to_string())?;

    let room_member = match room_id {
        Some(room_id) => {
            let room_id = matrix_sdk::ruma::RoomId::parse(room_id).map_err(|e| e.to_string())?;
            let room = client
                .get_room(&room_id)
                .ok_or_else(|| format!("room {room_id} not found"))?;
            if room.state() != RoomState::Joined {
                return Err(format!("room {room_id} is not joined"));
            }
            room.get_member(&user_id).await.map_err(|e| e.to_string())?
        }
        None => None,
    };

    let room_display_name = room_member
        .as_ref()
        .and_then(|member| member.display_name().map(ToOwned::to_owned));
    let room_avatar_url = room_member
        .as_ref()
        .and_then(|member| member.avatar_url().map(ToString::to_string));

    // A homeserver may restrict the unauthenticated profile endpoint while
    // still exposing this user's membership profile in a shared room. Keep
    // the card usable in that case, but fail when neither source is
    // available so a typo or wholly unknown user is not presented as an
    // empty, valid profile.
    let global_profile = client.account().fetch_user_profile_of(&user_id).await;
    if let Err(error) = &global_profile {
        if room_member.is_none() {
            return Err(error.to_string());
        }
    }

    let (display_name, avatar_url) = match global_profile {
        Ok(profile) => {
            let display_name = profile
                .get_static::<DisplayName>()
                .map_err(|e| e.to_string())?;
            let avatar_url = profile
                .get_static::<AvatarUrl>()
                .map_err(|e| e.to_string())?
                .map(|url| url.to_string());
            (display_name, avatar_url)
        }
        Err(_) => (None, None),
    };

    let (avatar_path, presence) = tokio::join!(
        async {
            match avatar_url.as_deref() {
                Some(mxc) => resolve_avatar_path(client, media_cache, mxc).await,
                None => None,
            }
        },
        get_presence_impl(client, user_id.as_str(), avatar_presence_visuals_enabled)
    );
    let room_avatar_path = match room_avatar_url.as_deref() {
        Some(mxc) if Some(mxc) == avatar_url.as_deref() => avatar_path.clone(),
        Some(mxc) => resolve_avatar_path(client, media_cache, mxc).await,
        None => None,
    };

    Ok(UserProfile {
        user_id: user_id.to_string(),
        display_name,
        avatar_url,
        avatar_path,
        room_display_name,
        room_avatar_url,
        room_avatar_path,
        presence: presence?,
    })
}

/// Lists joined rooms where `user_id` is currently joined, using only the
/// authenticated account's synced membership state.
#[tauri::command]
pub async fn get_mutual_rooms(
    app: AppHandle,
    state: State<'_, MatrixState>,
    user_id: String,
) -> Result<Vec<MutualRoomSummary>, String> {
    let client = state.require_client().await?;
    let media_cache = state.require_media_cache(&app).await.ok();
    get_mutual_rooms_impl(&client, media_cache, &user_id).await
}

/// Core logic behind [`get_mutual_rooms`], shared with the web companion.
pub async fn get_mutual_rooms_impl(
    client: &Client,
    media_cache: Option<&media::MediaCache>,
    user_id: &str,
) -> Result<Vec<MutualRoomSummary>, String> {
    let user_id = UserId::parse(user_id).map_err(|e| e.to_string())?;

    let candidates = futures_util::stream::iter(client.joined_rooms().into_iter().map(|room| {
        let user_id = &user_id;
        async move {
            let member = room
                .get_member(user_id)
                .await
                .map_err(|error| error.to_string())?;
            let Some(member) = member else {
                return Ok(None);
            };
            if member.membership() != &MembershipState::Join {
                return Ok(None);
            }

            let (name, is_direct) = tokio::join!(room.display_name(), room.is_direct());
            let is_direct = is_direct.unwrap_or(false);
            let avatar_url = room.avatar_url().map(|url| url.to_string()).or_else(|| {
                is_direct
                    .then(|| room.heroes())
                    .and_then(|heroes| match heroes.as_slice() {
                        [hero] => hero.avatar_url.as_ref().map(ToString::to_string),
                        _ => None,
                    })
            });
            let avatar_path = match avatar_url.as_deref() {
                Some(mxc) => resolve_avatar_path(client, media_cache, mxc).await,
                None => None,
            };

            Ok::<_, String>(Some(MutualRoomSummary {
                room_id: room.room_id().to_string(),
                name: name.ok().map(|name| name.to_string()),
                avatar_url,
                avatar_path,
                is_direct,
                is_space: room.is_space(),
            }))
        }
    }))
    .buffer_unordered(16)
    .collect::<Vec<_>>()
    .await;
    let mut rooms = candidates
        .into_iter()
        .collect::<Result<Vec<_>, _>>()?
        .into_iter()
        .flatten()
        .collect::<Vec<_>>();

    rooms.sort_by(|a, b| {
        a.name
            .as_deref()
            .unwrap_or_default()
            .cmp(b.name.as_deref().unwrap_or_default())
            .then_with(|| a.room_id.cmp(&b.room_id))
    });
    Ok(rooms)
}

/// Opens the first existing one-to-one room for `user_id`, or creates an
/// encrypted direct room when none exists. Returning the room id lets every
/// shell (desktop and web companion) use its normal room-selection path.
#[tauri::command]
pub async fn start_direct_message(
    state: State<'_, MatrixState>,
    user_id: String,
) -> Result<String, String> {
    let client = state.require_client().await?;
    start_direct_message_impl(&client, &user_id).await
}

pub async fn start_direct_message_impl(client: &Client, user_id: &str) -> Result<String, String> {
    let user_id = UserId::parse(user_id).map_err(|error| error.to_string())?;
    if client.user_id() == Some(user_id.as_ref()) {
        return Err("cannot start a direct message with yourself".to_string());
    }
    if let Some(room) = client.get_dm_room(&user_id) {
        return Ok(room.room_id().to_string());
    }
    client
        .create_dm(&user_id)
        .await
        .map(|room| room.room_id().to_string())
        .map_err(|error| error.to_string())
}

/// Replaces the signed-in user's room-scoped display name and avatar while
/// preserving every other field of their current `m.room.member` event.
#[tauri::command]
pub async fn set_room_profile(
    state: State<'_, MatrixState>,
    room_id: String,
    display_name: Option<String>,
    avatar_url: Option<String>,
) -> Result<(), String> {
    let client = state.require_client().await?;
    set_room_profile_impl(&client, &room_id, display_name, avatar_url).await
}

pub async fn set_room_profile_impl(
    client: &Client,
    room_id: &str,
    display_name: Option<String>,
    avatar_url: Option<String>,
) -> Result<(), String> {
    let room_id = RoomId::parse(room_id).map_err(|error| error.to_string())?;
    let room = client
        .get_room(&room_id)
        .ok_or_else(|| format!("room {room_id} not found"))?;
    if room.state() != RoomState::Joined {
        return Err(format!("room {room_id} is not joined"));
    }
    let user_id = client
        .user_id()
        .ok_or_else(|| "not logged in".to_string())?;
    let member_event = room
        .get_state_event_static_for_key::<RoomMemberEventContent, _>(user_id)
        .await
        .map_err(|error| error.to_string())?
        .ok_or_else(|| "own room membership event not found".to_string())?;
    let mut content = match member_event {
        RawSyncOrStrippedState::Sync(raw_event) => {
            match raw_event.deserialize().map_err(|error| error.to_string())? {
                SyncStateEvent::Original(event) => event.content,
                SyncStateEvent::Redacted(event) => {
                    RoomMemberEventContent::new(event.content.membership)
                }
            }
        }
        RawSyncOrStrippedState::Stripped(_) => {
            return Err(format!("room {room_id} is not joined"));
        }
    };

    content = apply_room_profile(content, display_name, avatar_url)?;
    room.send_state_event_for_key(user_id, content)
        .await
        .map_err(|error| error.to_string())?;
    Ok(())
}

fn apply_room_profile(
    mut content: RoomMemberEventContent,
    display_name: Option<String>,
    avatar_url: Option<String>,
) -> Result<RoomMemberEventContent, String> {
    let avatar_url = avatar_url.map(OwnedMxcUri::from);
    if let Some(url) = &avatar_url {
        url.validate().map_err(|error| error.to_string())?;
    }
    content.displayname = display_name;
    content.avatar_url = avatar_url;
    Ok(content)
}

/// Pure: given the signed-in user's id and an incoming `m.room.member`
/// event's state key + content, returns the profile update to push if (and
/// only if) this event is about the signed-in user themself. Unit-tested
/// directly below, same rationale as `mod.rs::sso_state_tests`.
pub fn self_profile_update(
    own_user_id: &UserId,
    state_key: &UserId,
    content: &RoomMemberEventContent,
) -> Option<SelfProfileUpdate> {
    if state_key != own_user_id {
        return None;
    }
    Some(SelfProfileUpdate {
        display_name: content.displayname.clone(),
        avatar_url: content.avatar_url.clone().map(|url| url.to_string()),
    })
}

/// Registers the handler described in this module's doc comment. Mirrors
/// `presence::register_presence_handler` — called once, right after the
/// client is built (login or session restore).
///
/// A membership event about the signed-in user fires for *any* membership
/// change in a shared room (join/leave/kick/invite elsewhere, not just a
/// profile edit), and every such event's content carries the user's *current*
/// full display name/avatar regardless of why it fired — so without
/// deduping, `profile:self` (and the frontend's `useOwnProfile` refetch it
/// triggers) would fire on every membership change, not just ones that
/// actually changed the profile. `last_emitted` tracks the last pushed value
/// across event-handler invocations so an unrelated membership event that
/// carries the same, unchanged profile is silently dropped.
pub fn register_self_profile_handler(app: AppHandle, client: &Client) {
    let own_user_id = client.user_id().map(ToOwned::to_owned);
    let last_emitted: std::sync::Arc<std::sync::Mutex<Option<SelfProfileUpdate>>> =
        std::sync::Arc::new(std::sync::Mutex::new(None));
    client.add_event_handler(move |ev: SyncRoomMemberEvent| {
        let app = app.clone();
        let own_user_id = own_user_id.clone();
        let last_emitted = last_emitted.clone();
        async move {
            let Some(own_user_id) = own_user_id else {
                return;
            };
            let SyncRoomMemberEvent::Original(ev) = ev else {
                // A redacted membership event carries no display name/avatar
                // to report — nothing to compare or push.
                return;
            };
            let Some(update) = self_profile_update(&own_user_id, &ev.state_key, &ev.content) else {
                return;
            };
            let mut last_emitted = last_emitted.lock().unwrap_or_else(|e| e.into_inner());
            if last_emitted.as_ref() == Some(&update) {
                return;
            }
            *last_emitted = Some(update.clone());
            drop(last_emitted);
            let _ = app.emit("profile:self", update);
        }
    });
}

#[cfg(test)]
mod self_profile_update_tests {
    use matrix_sdk::ruma::events::room::member::MembershipState;
    use matrix_sdk::ruma::{user_id, OwnedMxcUri};
    use matrix_sdk::test_utils::mocks::MatrixMockServer;
    use serde_json::json;
    use wiremock::matchers::{method, path_regex};
    use wiremock::{Mock, ResponseTemplate};

    use super::*;

    fn member_content(
        displayname: Option<&str>,
        avatar_url: Option<&str>,
    ) -> RoomMemberEventContent {
        let mut content = RoomMemberEventContent::new(MembershipState::Join);
        content.displayname = displayname.map(str::to_owned);
        content.avatar_url = avatar_url.map(OwnedMxcUri::from);
        content
    }

    #[test]
    fn returns_none_for_a_different_users_membership_event() {
        let own = user_id!("@me:example.org");
        let other = user_id!("@someone-else:example.org");
        let content = member_content(Some("New Name"), None);

        assert!(self_profile_update(own, other, &content).is_none());
    }

    #[test]
    fn returns_the_update_for_the_signed_in_users_own_membership_event() {
        let own = user_id!("@me:example.org");
        let content = member_content(Some("New Name"), Some("mxc://example.org/avatar"));

        let update = self_profile_update(own, own, &content).expect("own event yields an update");
        assert_eq!(update.display_name.as_deref(), Some("New Name"));
        assert_eq!(
            update.avatar_url.as_deref(),
            Some("mxc://example.org/avatar")
        );
    }

    #[test]
    fn carries_none_fields_through_when_unset() {
        let own = user_id!("@me:example.org");
        let content = member_content(None, None);

        let update = self_profile_update(own, own, &content).expect("own event yields an update");
        assert_eq!(update.display_name, None);
        assert_eq!(update.avatar_url, None);
    }

    #[test]
    fn room_profile_update_preserves_membership_metadata() {
        let mut content = RoomMemberEventContent::new(MembershipState::Join);
        content.reason = Some("preserve me".to_string());
        content.is_direct = Some(true);

        let updated = apply_room_profile(
            content,
            Some("Room Alice".to_string()),
            Some("mxc://example.org/room-avatar".to_string()),
        )
        .expect("valid room profile");

        assert_eq!(updated.displayname.as_deref(), Some("Room Alice"));
        assert_eq!(
            updated.avatar_url.as_deref().map(|url| url.as_str()),
            Some("mxc://example.org/room-avatar")
        );
        assert_eq!(updated.membership, MembershipState::Join);
        assert_eq!(updated.reason.as_deref(), Some("preserve me"));
        assert_eq!(updated.is_direct, Some(true));
    }

    #[test]
    fn room_profile_update_rejects_non_mxc_avatar_urls() {
        let content = RoomMemberEventContent::new(MembershipState::Join);
        let error = apply_room_profile(
            content,
            None,
            Some("https://example.org/avatar.png".to_string()),
        )
        .expect_err("non-MXC avatar must be rejected");

        assert!(!error.is_empty());
    }

    #[tokio::test]
    async fn get_user_profile_maps_global_profile_fields() {
        let server = MatrixMockServer::new().await;
        let client = server.client_builder().build().await;

        Mock::given(method("GET"))
            .and(path_regex(r"^/_matrix/client/v3/profile/.*alice.*$"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "displayname": "Alice",
                "avatar_url": "mxc://example.org/alice",
            })))
            .mount(server.server())
            .await;

        let profile = get_user_profile_impl(&client, None, "@alice:example.org", None, false)
            .await
            .expect("profile lookup succeeds");

        assert_eq!(profile.display_name.as_deref(), Some("Alice"));
        assert_eq!(
            profile.avatar_url.as_deref(),
            Some("mxc://example.org/alice")
        );
    }
}
