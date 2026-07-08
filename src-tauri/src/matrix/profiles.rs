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

use matrix_sdk::ruma::events::room::member::{RoomMemberEventContent, SyncRoomMemberEvent};
use matrix_sdk::ruma::UserId;
use matrix_sdk::Client;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, State};
use ts_rs::TS;

use super::media;
use super::presence::PresenceStateDto;
use super::MatrixState;

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
    let presence = *state.sync_presence.lock().unwrap();
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
}
