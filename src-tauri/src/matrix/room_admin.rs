//! Room settings, power levels, and member management (Spec 07) — the third
//! right-panel column's backing commands. Distinct from `rooms.rs` (tags,
//! mute, manual order — organizational, not governance) and `members.rs`
//! (the thin autocomplete lookup, whose type this module extends rather than
//! duplicates — see [`super::members::RoomMemberSummary`]).

use matrix_sdk::room::power_levels::RoomPowerLevelChanges;
use matrix_sdk::ruma::api::client::room::aliases;
use matrix_sdk::ruma::events::room::avatar::RoomAvatarEventContent;
use matrix_sdk::ruma::events::room::canonical_alias::RoomCanonicalAliasEventContent;
use matrix_sdk::ruma::events::room::history_visibility::{
    HistoryVisibility, RoomHistoryVisibilityEventContent,
};
use matrix_sdk::ruma::events::room::join_rules::{JoinRule, Restricted, RoomJoinRulesEventContent};
use matrix_sdk::ruma::events::room::member::MembershipState;
use matrix_sdk::ruma::events::room::power_levels::{RoomPowerLevels, UserPowerLevel};
use matrix_sdk::ruma::events::StateEventType;
use matrix_sdk::ruma::{Int, OwnedRoomAliasId, RoomAliasId, RoomId, UserId};
use matrix_sdk::{Client, Room, RoomMemberships};
use serde::{Deserialize, Serialize};
use tauri::State;
use ts_rs::TS;

use super::members;
use super::MatrixState;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../src/bindings/")]
#[serde(rename_all = "snake_case")]
pub enum JoinRuleKind {
    Public,
    Invite,
    Knock,
    Restricted,
    Private,
}

impl From<&JoinRule> for JoinRuleKind {
    fn from(rule: &JoinRule) -> Self {
        match rule {
            JoinRule::Public => Self::Public,
            JoinRule::Invite => Self::Invite,
            JoinRule::Knock => Self::Knock,
            // Day-1 exposes the enum value but has no allow-list editor (see
            // Spec 07's risks section) — `KnockRestricted` collapses into the
            // same bucket as `Restricted` for display purposes.
            JoinRule::Restricted(_) | JoinRule::KnockRestricted(_) => Self::Restricted,
            JoinRule::Private => Self::Private,
            // `JoinRule` is `#[non_exhaustive]`; a homeserver-specific custom
            // rule falls back to the most restrictive documented value.
            _ => Self::Invite,
        }
    }
}

impl From<JoinRuleKind> for JoinRule {
    fn from(kind: JoinRuleKind) -> Self {
        match kind {
            JoinRuleKind::Public => JoinRule::Public,
            JoinRuleKind::Invite => JoinRule::Invite,
            JoinRuleKind::Knock => JoinRule::Knock,
            // No allow-list editor exists yet — an empty allow-list, same as
            // the frontend disabling this option until Day-2 builds one.
            JoinRuleKind::Restricted => JoinRule::Restricted(Restricted::new(vec![])),
            JoinRuleKind::Private => JoinRule::Private,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../src/bindings/")]
#[serde(rename_all = "snake_case")]
pub enum HistoryVisibilityKind {
    Shared,
    Invited,
    Joined,
    WorldReadable,
}

impl From<&HistoryVisibility> for HistoryVisibilityKind {
    fn from(visibility: &HistoryVisibility) -> Self {
        match visibility {
            HistoryVisibility::Invited => Self::Invited,
            HistoryVisibility::Joined => Self::Joined,
            HistoryVisibility::Shared => Self::Shared,
            HistoryVisibility::WorldReadable => Self::WorldReadable,
            // `HistoryVisibility` is `#[non_exhaustive]` — `Shared` is the
            // spec-defined default for an unset/unrecognized value.
            _ => Self::Shared,
        }
    }
}

impl From<HistoryVisibilityKind> for HistoryVisibility {
    fn from(kind: HistoryVisibilityKind) -> Self {
        match kind {
            HistoryVisibilityKind::Shared => HistoryVisibility::Shared,
            HistoryVisibilityKind::Invited => HistoryVisibility::Invited,
            HistoryVisibilityKind::Joined => HistoryVisibility::Joined,
            HistoryVisibilityKind::WorldReadable => HistoryVisibility::WorldReadable,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../src/bindings/")]
#[serde(rename_all = "snake_case")]
pub enum MembershipKind {
    Join,
    Invite,
    Ban,
    Leave,
    Knock,
}

impl From<&MembershipState> for MembershipKind {
    fn from(state: &MembershipState) -> Self {
        match state {
            MembershipState::Ban => Self::Ban,
            MembershipState::Invite => Self::Invite,
            MembershipState::Join => Self::Join,
            MembershipState::Knock => Self::Knock,
            MembershipState::Leave => Self::Leave,
            // `MembershipState` is `#[non_exhaustive]`.
            _ => Self::Leave,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../src/bindings/")]
pub struct PowerLevelThresholds {
    // Power levels are always small ints in practice (0-100) — `number`
    // rather than ts-rs's default `bigint` so the frontend can do plain
    // arithmetic/comparisons on them (preset roles, threshold checks).
    #[ts(type = "number")]
    pub invite: i64,
    #[ts(type = "number")]
    pub kick: i64,
    #[ts(type = "number")]
    pub ban: i64,
    #[ts(type = "number")]
    pub redact: i64,
    #[ts(type = "number")]
    pub events_default: i64,
    #[ts(type = "number")]
    pub state_default: i64,
    #[ts(type = "number")]
    pub users_default: i64,
}

impl From<&RoomPowerLevels> for PowerLevelThresholds {
    fn from(power_levels: &RoomPowerLevels) -> Self {
        Self {
            invite: power_levels.invite.into(),
            kick: power_levels.kick.into(),
            ban: power_levels.ban.into(),
            redact: power_levels.redact.into(),
            events_default: power_levels.events_default.into(),
            state_default: power_levels.state_default.into(),
            users_default: power_levels.users_default.into(),
        }
    }
}

impl From<PowerLevelThresholds> for RoomPowerLevelChanges {
    fn from(thresholds: PowerLevelThresholds) -> Self {
        let mut changes = RoomPowerLevelChanges::new();
        changes.invite = Some(thresholds.invite);
        changes.kick = Some(thresholds.kick);
        changes.ban = Some(thresholds.ban);
        changes.redact = Some(thresholds.redact);
        changes.events_default = Some(thresholds.events_default);
        changes.state_default = Some(thresholds.state_default);
        changes.users_default = Some(thresholds.users_default);
        changes
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../src/bindings/")]
pub struct RoomPermissions {
    pub set_name: bool,
    pub set_topic: bool,
    pub set_avatar: bool,
    pub set_join_rules: bool,
    pub set_history_visibility: bool,
    pub set_encryption: bool,
    pub set_power_levels: bool,
    pub invite: bool,
    pub kick: bool,
    pub ban: bool,
    /// Gates both the canonical-alias selector and add/remove-alias controls
    /// (Spec 32) — Matrix has no separate power-level requirement for
    /// publishing/unpublishing a room-directory alias, only for the
    /// `m.room.canonical_alias` *state event* itself, so this single check
    /// covers the whole alias-management surface per the spec's power-level
    /// gating requirement.
    pub set_canonical_alias: bool,
    /// Gates the "Pin"/"Unpin" entry in `MessageActions` and any other
    /// pin/unpin affordance (Spec day-2/04) — power level required to send
    /// `m.room.pinned_events`, same pattern as every other `set_*` field
    /// above.
    pub set_pinned_events: bool,
    /// Gates `SpaceRail`'s "Add existing…", "Mark/Unmark as suggested", and
    /// "Remove from space" actions (Spec 63) — power level required to send
    /// `m.space.child` in *this* room. "Add existing" checks it against the
    /// target space being added to; "Suggested"/"Remove" check it against
    /// the child's *parent* space (a second, separately-fetched
    /// `RoomDetails`), since that's whose `m.space.child` edge is mutated.
    pub set_space_child: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../src/bindings/")]
pub struct RoomDetails {
    pub room_id: String,
    pub name: Option<String>,
    pub topic: Option<String>,
    pub avatar_url: Option<String>,
    pub is_encrypted: bool,
    pub join_rule: JoinRuleKind,
    pub history_visibility: HistoryVisibilityKind,
    #[ts(type = "number")]
    pub member_count: u64,
    #[ts(type = "number")]
    pub my_power_level: i64,
    pub power_levels: PowerLevelThresholds,
    pub can: RoomPermissions,
    /// The room's current `m.room.canonical_alias` (`alias`), if any — see
    /// [`build_room_details`] for how this is read off live room state.
    pub canonical_alias: Option<String>,
    /// `m.room.canonical_alias`'s `alt_aliases` — aliases the room
    /// acknowledges but doesn't treat as primary. Distinct from the
    /// server-published-alias list returned by [`get_room_local_aliases`]:
    /// an alias can be published on the directory without being listed here
    /// (or vice versa, if the state event lists a stale/foreign alias) —
    /// see Spec 32's non-goals about directory vs. canonical-alias state.
    pub alt_aliases: Vec<String>,
    /// The room's current `m.room.pinned_events` `pinned` array, in the
    /// order the state event lists them (oldest-pinned-first, per the
    /// event's own semantics — Matrix has no separate ordering field). Read
    /// straight off already-synced room state via `Room::pinned_event_ids`
    /// (no network round-trip), so the pinned-messages panel and the room
    /// header's pin-count badge stay live via the same `room_details:update`
    /// push every other `RoomDetails` field already relies on — no new
    /// sync-side plumbing needed (Spec day-2/04's stated data flow).
    pub pinned_event_ids: Vec<String>,
}

/// Room v12+ creators have an "infinite" power level (see [`UserPowerLevel::Infinite`]),
/// which has no `Int` (Matrix's own power-level type, itself JS-safe-integer-bounded)
/// representation to fall back to. `i64::MAX` would round-trip incorrectly once it
/// crosses into JS (`#[ts(type = "number")]` fields are plain `number`s, and
/// `Number.MAX_SAFE_INTEGER` is `2^53 - 1`) — displaying a silently-rounded value, and
/// potentially a different value than what's shown if ever sent back to
/// `set_member_power_level`. Capping to that same bound instead keeps whatever value
/// the frontend sees exact, even though it's no longer literally "infinite".
pub(crate) const JS_SAFE_INFINITE_POWER_LEVEL: i64 = 9_007_199_254_740_991;

fn user_power_level_to_i64(level: UserPowerLevel) -> i64 {
    match level {
        UserPowerLevel::Infinite => JS_SAFE_INFINITE_POWER_LEVEL,
        UserPowerLevel::Int(value) => value.into(),
        _ => 0,
    }
}

pub(crate) fn require_room(client: &Client, room_id: &str) -> Result<Room, String> {
    let id = RoomId::parse(room_id).map_err(|e| e.to_string())?;
    client
        .get_room(&id)
        .ok_or_else(|| format!("room {room_id} not found"))
}

/// Builds the full [`RoomDetails`] snapshot for `room_id` — shared by
/// [`get_room_details`] and the sync loop's `room_details:update` emission in
/// `mod.rs`, so both read the identical fields off the identical live `Room`.
///
/// `pub` (not `pub(crate)`) so the network-dependent test for this lives in
/// `tests/room_admin.rs` rather than the `--lib` unit-test target CI runs
/// without a local Synapse available — same rationale as [`super::resolve_alias`].
pub async fn build_room_details(client: &Client, room_id: &str) -> Result<RoomDetails, String> {
    let room = require_room(client, room_id)?;
    let own_user_id = client
        .user_id()
        .ok_or_else(|| "not logged in".to_string())?;

    let power_levels = room.power_levels().await.map_err(|e| e.to_string())?;
    let my_power_level = user_power_level_to_i64(power_levels.for_user(own_user_id));

    let can = RoomPermissions {
        set_name: power_levels.user_can_send_state(own_user_id, StateEventType::RoomName),
        set_topic: power_levels.user_can_send_state(own_user_id, StateEventType::RoomTopic),
        set_avatar: power_levels.user_can_send_state(own_user_id, StateEventType::RoomAvatar),
        set_join_rules: power_levels
            .user_can_send_state(own_user_id, StateEventType::RoomJoinRules),
        set_history_visibility: power_levels
            .user_can_send_state(own_user_id, StateEventType::RoomHistoryVisibility),
        set_encryption: power_levels
            .user_can_send_state(own_user_id, StateEventType::RoomEncryption),
        set_power_levels: power_levels
            .user_can_send_state(own_user_id, StateEventType::RoomPowerLevels),
        invite: power_levels.user_can_invite(own_user_id),
        kick: power_levels.user_can_kick(own_user_id),
        ban: power_levels.user_can_ban(own_user_id),
        set_canonical_alias: power_levels
            .user_can_send_state(own_user_id, StateEventType::RoomCanonicalAlias),
        set_pinned_events: power_levels
            .user_can_send_state(own_user_id, StateEventType::RoomPinnedEvents),
        set_space_child: power_levels.user_can_send_state(own_user_id, StateEventType::SpaceChild),
    };

    let is_encrypted = room
        .latest_encryption_state()
        .await
        .map(|state| state.is_encrypted())
        .unwrap_or(false);

    let join_rule = room.join_rule().unwrap_or(JoinRule::Invite);

    Ok(RoomDetails {
        room_id: room.room_id().to_string(),
        name: room.name(),
        topic: room.topic(),
        avatar_url: room.avatar_url().map(|url| url.to_string()),
        is_encrypted,
        join_rule: (&join_rule).into(),
        history_visibility: (&room.history_visibility_or_default()).into(),
        member_count: room.active_members_count(),
        my_power_level,
        power_levels: (&power_levels).into(),
        can,
        canonical_alias: room.canonical_alias().map(|alias| alias.to_string()),
        alt_aliases: room
            .alt_aliases()
            .into_iter()
            .map(|alias| alias.to_string())
            .collect(),
        pinned_event_ids: room
            .pinned_event_ids()
            .unwrap_or_default()
            .into_iter()
            .map(|id| id.to_string())
            .collect(),
    })
}

#[tauri::command]
pub async fn get_room_details(
    state: State<'_, MatrixState>,
    room_id: String,
) -> Result<RoomDetails, String> {
    let client = state.require_client().await?;
    build_room_details(&client, &room_id).await
}

/// Active + banned memberships, unlike [`members::get_room_members`]'s
/// active-only autocomplete scope — the right panel's Members tab must show
/// banned users under their own grouping (see Spec 07 acceptance criteria).
/// `LEAVE`/`KNOCK` are deliberately excluded: the panel never renders them,
/// and a long-lived room can accumulate a lot of left members, so fetching
/// them here would just be wasted work.
///
/// Uses the network-aware `members()` (not `members_no_sync`) — this is a
/// moderation surface the admin explicitly opened, unlike the mention
/// autocomplete's latency-sensitive path, so it's worth a round-trip to
/// cover a lazy-loaded room whose banned/older members aren't in the local
/// store yet.
#[tauri::command]
pub async fn get_room_member_list(
    state: State<'_, MatrixState>,
    room_id: String,
) -> Result<Vec<members::RoomMemberSummary>, String> {
    let client = state.require_client().await?;
    get_room_member_list_impl(&client, &room_id).await
}

/// Core logic behind [`get_room_member_list`].
pub async fn get_room_member_list_impl(
    client: &Client,
    room_id: &str,
) -> Result<Vec<members::RoomMemberSummary>, String> {
    let room = require_room(client, room_id)?;
    let members = room
        .members(RoomMemberships::ACTIVE | RoomMemberships::BAN)
        .await
        .map_err(|e| e.to_string())?;
    Ok(members.iter().map(members::member_to_summary).collect())
}

#[tauri::command]
pub async fn set_room_name(
    state: State<'_, MatrixState>,
    room_id: String,
    name: String,
) -> Result<(), String> {
    let client = state.require_client().await?;
    set_room_name_impl(&client, &room_id, name).await
}

/// Core logic behind [`set_room_name`].
pub async fn set_room_name_impl(
    client: &Client,
    room_id: &str,
    name: String,
) -> Result<(), String> {
    let room = require_room(client, room_id)?;
    room.set_name(name).await.map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub async fn set_room_topic(
    state: State<'_, MatrixState>,
    room_id: String,
    topic: String,
) -> Result<(), String> {
    let client = state.require_client().await?;
    set_room_topic_impl(&client, &room_id, &topic).await
}

/// Core logic behind [`set_room_topic`].
pub async fn set_room_topic_impl(
    client: &Client,
    room_id: &str,
    topic: &str,
) -> Result<(), String> {
    let room = require_room(client, room_id)?;
    room.set_room_topic(topic)
        .await
        .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub async fn set_room_avatar(
    state: State<'_, MatrixState>,
    room_id: String,
    file_path: String,
) -> Result<(), String> {
    let client = state.require_client().await?;
    set_room_avatar_impl(&client, &room_id, &file_path).await
}

/// Core logic behind [`set_room_avatar`].
pub async fn set_room_avatar_impl(
    client: &Client,
    room_id: &str,
    file_path: &str,
) -> Result<(), String> {
    // Same frontend-supplied-file-picker-path convention as `set_avatar`
    // (account avatar) — and the same arbitrary-file-read risk, so it goes
    // through the same validation: canonicalize, cap size (checked both via
    // metadata and against the actual bytes read), decode fully (not just
    // sniff), cap decoded dimensions, and restrict to the picker's supported
    // formats. See `super::account::validate_avatar_path`'s doc comment for
    // the full threat-model rationale.
    let (_path, data, mime) = super::account::validate_avatar_path(file_path).await?;

    let room = require_room(client, room_id)?;
    room.upload_avatar(&mime, data, None)
        .await
        .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub async fn remove_room_avatar(
    state: State<'_, MatrixState>,
    room_id: String,
) -> Result<(), String> {
    let client = state.require_client().await?;
    remove_room_avatar_impl(&client, &room_id).await
}

/// Core logic behind [`remove_room_avatar`].
pub async fn remove_room_avatar_impl(client: &Client, room_id: &str) -> Result<(), String> {
    let room = require_room(client, room_id)?;
    room.send_state_event(RoomAvatarEventContent::new())
        .await
        .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub async fn set_room_join_rule(
    state: State<'_, MatrixState>,
    room_id: String,
    join_rule: JoinRuleKind,
) -> Result<(), String> {
    let client = state.require_client().await?;
    set_room_join_rule_impl(&client, &room_id, join_rule).await
}

/// Core logic behind [`set_room_join_rule`].
pub async fn set_room_join_rule_impl(
    client: &Client,
    room_id: &str,
    join_rule: JoinRuleKind,
) -> Result<(), String> {
    let room = require_room(client, room_id)?;
    room.send_state_event(RoomJoinRulesEventContent::new(join_rule.into()))
        .await
        .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub async fn set_room_history_visibility(
    state: State<'_, MatrixState>,
    room_id: String,
    visibility: HistoryVisibilityKind,
) -> Result<(), String> {
    let client = state.require_client().await?;
    set_room_history_visibility_impl(&client, &room_id, visibility).await
}

/// Core logic behind [`set_room_history_visibility`].
pub async fn set_room_history_visibility_impl(
    client: &Client,
    room_id: &str,
    visibility: HistoryVisibilityKind,
) -> Result<(), String> {
    let room = require_room(client, room_id)?;
    room.send_state_event(RoomHistoryVisibilityEventContent::new(visibility.into()))
        .await
        .map_err(|e| e.to_string())?;
    Ok(())
}

/// One-way: matrix-rust-sdk (and the Matrix protocol itself) has no
/// "disable encryption" operation — see Spec 07's design notes. The frontend
/// presents this as an irreversible action behind a confirm dialog.
#[tauri::command]
pub async fn enable_room_encryption(
    state: State<'_, MatrixState>,
    room_id: String,
) -> Result<(), String> {
    let client = state.require_client().await?;
    enable_room_encryption_impl(&client, &room_id).await
}

/// Core logic behind [`enable_room_encryption`].
pub async fn enable_room_encryption_impl(client: &Client, room_id: &str) -> Result<(), String> {
    let room = require_room(client, room_id)?;
    room.enable_encryption().await.map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub async fn set_member_power_level(
    state: State<'_, MatrixState>,
    room_id: String,
    user_id: String,
    power_level: i64,
) -> Result<(), String> {
    let client = state.require_client().await?;
    set_member_power_level_impl(&client, &room_id, &user_id, power_level).await
}

/// Core logic behind [`set_member_power_level`].
pub async fn set_member_power_level_impl(
    client: &Client,
    room_id: &str,
    user_id: &str,
    power_level: i64,
) -> Result<(), String> {
    let room = require_room(client, room_id)?;
    let parsed_user_id = UserId::parse(user_id).map_err(|e| e.to_string())?;
    let level = Int::try_from(power_level).map_err(|e| e.to_string())?;
    room.update_power_levels(vec![(&parsed_user_id, level)])
        .await
        .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub async fn set_room_power_level_thresholds(
    state: State<'_, MatrixState>,
    room_id: String,
    changes: PowerLevelThresholds,
) -> Result<(), String> {
    let client = state.require_client().await?;
    set_room_power_level_thresholds_impl(&client, &room_id, changes).await
}

/// Core logic behind [`set_room_power_level_thresholds`].
pub async fn set_room_power_level_thresholds_impl(
    client: &Client,
    room_id: &str,
    changes: PowerLevelThresholds,
) -> Result<(), String> {
    let room = require_room(client, room_id)?;
    room.apply_power_level_changes(changes.into())
        .await
        .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub async fn invite_member(
    state: State<'_, MatrixState>,
    room_id: String,
    user_id: String,
) -> Result<(), String> {
    let client = state.require_client().await?;
    invite_member_impl(&client, &room_id, &user_id).await
}

/// Core logic behind [`invite_member`].
pub async fn invite_member_impl(
    client: &Client,
    room_id: &str,
    user_id: &str,
) -> Result<(), String> {
    let room = require_room(client, room_id)?;
    let parsed_user_id = UserId::parse(user_id).map_err(|e| e.to_string())?;
    room.invite_user_by_id(&parsed_user_id)
        .await
        .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub async fn kick_member(
    state: State<'_, MatrixState>,
    room_id: String,
    user_id: String,
    reason: Option<String>,
) -> Result<(), String> {
    let client = state.require_client().await?;
    kick_member_impl(&client, &room_id, &user_id, reason.as_deref()).await
}

/// Core logic behind [`kick_member`].
pub async fn kick_member_impl(
    client: &Client,
    room_id: &str,
    user_id: &str,
    reason: Option<&str>,
) -> Result<(), String> {
    let room = require_room(client, room_id)?;
    let parsed_user_id = UserId::parse(user_id).map_err(|e| e.to_string())?;
    room.kick_user(&parsed_user_id, reason)
        .await
        .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub async fn ban_member(
    state: State<'_, MatrixState>,
    room_id: String,
    user_id: String,
    reason: Option<String>,
) -> Result<(), String> {
    let client = state.require_client().await?;
    ban_member_impl(&client, &room_id, &user_id, reason.as_deref()).await
}

/// Core logic behind [`ban_member`].
pub async fn ban_member_impl(
    client: &Client,
    room_id: &str,
    user_id: &str,
    reason: Option<&str>,
) -> Result<(), String> {
    let room = require_room(client, room_id)?;
    let parsed_user_id = UserId::parse(user_id).map_err(|e| e.to_string())?;
    room.ban_user(&parsed_user_id, reason)
        .await
        .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub async fn unban_member(
    state: State<'_, MatrixState>,
    room_id: String,
    user_id: String,
    reason: Option<String>,
) -> Result<(), String> {
    let client = state.require_client().await?;
    unban_member_impl(&client, &room_id, &user_id, reason.as_deref()).await
}

/// Core logic behind [`unban_member`].
pub async fn unban_member_impl(
    client: &Client,
    room_id: &str,
    user_id: &str,
    reason: Option<&str>,
) -> Result<(), String> {
    let room = require_room(client, room_id)?;
    let parsed_user_id = UserId::parse(user_id).map_err(|e| e.to_string())?;
    room.unban_user(&parsed_user_id, reason)
        .await
        .map_err(|e| e.to_string())?;
    Ok(())
}

/// A single pinned message resolved for display in the pinned-messages
/// panel (Spec day-2/04). Deliberately its own small DTO rather than reusing
/// `timeline::RoomMessageSummary`: a pinned event may be arbitrarily old and
/// outside any currently-loaded timeline window, may be undecrypted, or may
/// already be redacted (unpinning doesn't automatically follow a redaction),
/// so this only carries the handful of fields the panel actually renders
/// plus enough state to render each of those cases distinctly.
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../src/bindings/")]
pub struct PinnedMessageSummary {
    pub event_id: String,
    pub sender: String,
    pub sender_display_name: Option<String>,
    /// Message body, or `""` if the event is redacted, undecrypted, or
    /// isn't a `m.room.message` at all (e.g. someone pinned a state event —
    /// Matrix's spec allows pinning any event, not just messages). Check
    /// `is_redacted`/`is_undecrypted` before treating an empty body as "no
    /// content".
    pub preview: String,
    #[ts(type = "number")]
    pub timestamp_ms: u64,
    pub is_redacted: bool,
    pub is_undecrypted: bool,
    /// `true` when the pinned event itself couldn't be resolved at all —
    /// e.g. the homeserver returns 404 for a stale/foreign event id, or
    /// history visibility denies access. Distinct from `is_redacted`
    /// (event resolved, content deliberately removed) and `is_undecrypted`
    /// (event resolved, content unreadable): here every other field is a
    /// placeholder (`sender`/`preview` empty, `timestamp_ms` 0), since
    /// nothing about the event could be read. Review fix: this row used to
    /// be silently dropped instead of returned, so `pinned_event_ids`
    /// could report a nonzero pin count with no corresponding row — and so
    /// no Unpin control — to actually remove the broken pin from Charm.
    pub is_unresolved: bool,
}

/// Resolves each of `room_id`'s currently-pinned event ids (per
/// `RoomDetails.pinned_event_ids`) against synced timeline/event-fetch
/// machinery, for the pinned-messages panel. Uses `Room::load_or_fetch_event`
/// — checks the local event cache first, only falling back to a
/// `/rooms/{id}/event` homeserver request on a cache miss — rather than
/// `Room::event` (review fix: that always issues a homeserver request
/// unconditionally, decrypting only afterward, even for an event the cache
/// already has decrypted and ready). Doesn't require every pinned event to
/// already be inside the currently-loaded timeline window, since a message
/// pinned long ago is routinely outside it.
///
/// A pinned event id that fails to resolve at all (deleted room, network
/// error) is dropped from the result rather than failing the whole call —
/// one bad pin shouldn't blank the entire panel.
#[tauri::command]
pub async fn get_pinned_messages(
    state: State<'_, MatrixState>,
    room_id: String,
) -> Result<Vec<PinnedMessageSummary>, String> {
    let client = state.require_client().await?;
    get_pinned_messages_impl(state.inner(), &client, &room_id).await
}

/// Appends `sender`'s MXID to `name` when it's ambiguous (shared with
/// another room member), matching `timeline::sender_profile_fields`'s
/// disambiguation convention — pulled out as a pure function so it's
/// unit-testable without a mocked homeserver's `/members` endpoint (which
/// `RoomMember::name_ambiguous` needs a live/synced member list to compute).
fn disambiguated_display_name(
    name: &str,
    ambiguous: bool,
    sender: &matrix_sdk::ruma::UserId,
) -> String {
    if ambiguous {
        format!("{name} ({sender})")
    } else {
        name.to_string()
    }
}

/// Resolves the current body of `event_id` after any `m.replace` edits, or
/// `None` if there is no (valid) edit (or the lookup fails) — the caller
/// falls back to the original event's own body in that case. Fetches the
/// event's `m.replace` relations directly (network, falling back to a cached
/// copy on a later call) rather than depending on the main timeline's own
/// edit-collapsing, since a pinned event routinely isn't part of the
/// currently-loaded timeline window at all.
///
/// Review fix: a replacement is only valid per the spec
/// (https://spec.matrix.org/v1.11/client-server-api/#validity-of-replacement-events)
/// if its sender matches `original_sender` — anyone else in the room can
/// send an `m.replace` event targeting someone else's message, and without
/// this check the pinned panel would render that attacker-supplied
/// `m.new_content` as if the original sender had edited their own pinned
/// message. Fetches a small batch (not just the single most recent
/// relation) and skips any whose sender doesn't match, so one invalid edit
/// sent after a legitimate one can't hide it.
///
/// Review fix: a single page only covers the 20 most recent relations. If
/// more than 20 newer `m.replace` events from other users (invalid, per the
/// sender check above) target the same pinned event, the original sender's
/// actual latest valid edit could sit just past that page — this used to
/// give up after one page and silently fall back to the stale/original
/// body, even though the main timeline's own edit-collapsing (which has no
/// such page limit) would still show the real edit. Now pages forward
/// (`next_batch_token`) until a same-sender replacement is found or the
/// relation stream is exhausted, bounded by `MAX_EDIT_RELATION_PAGES` as a
/// deliberate safety cap against an unbounded fetch loop.
const MAX_EDIT_RELATION_PAGES: usize = 10;

async fn latest_edit_body(
    room: &Room,
    event_id: &matrix_sdk::ruma::EventId,
    original_sender: &matrix_sdk::ruma::UserId,
) -> Option<String> {
    use matrix_sdk::room::{IncludeRelations, RelationsOptions};
    use matrix_sdk::ruma::events::relation::RelationType;
    use matrix_sdk::ruma::events::room::message::Relation;
    use matrix_sdk::ruma::events::{
        AnySyncMessageLikeEvent, AnySyncTimelineEvent, SyncMessageLikeEvent,
    };

    let mut from: Option<String> = None;

    for _ in 0..MAX_EDIT_RELATION_PAGES {
        let relations = room
            .relations(
                event_id.to_owned(),
                RelationsOptions {
                    dir: matrix_sdk::ruma::api::Direction::Backward,
                    include_relations: IncludeRelations::RelationsOfType(RelationType::Replacement),
                    limit: matrix_sdk::ruma::UInt::new(20),
                    from: from.clone(),
                    ..Default::default()
                },
            )
            .await
            .ok()?;

        // Review fix: `dir: Direction::Backward` is a request for the
        // homeserver to return relations newest-first, but nothing in the
        // response guarantees that ordering was actually honored — sorting
        // explicitly by `origin_server_ts` here means a homeserver that
        // returns them in a different order still resolves to the
        // genuinely most recent valid edit within this page, not just
        // whichever happened to come first in the response.
        let mut candidates: Vec<_> = relations
            .chunk
            .iter()
            .filter_map(|candidate| {
                let raw_edit = candidate.raw().deserialize().ok()?;
                let AnySyncTimelineEvent::MessageLike(AnySyncMessageLikeEvent::RoomMessage(
                    SyncMessageLikeEvent::Original(edit),
                )) = raw_edit
                else {
                    return None;
                };
                if edit.sender != *original_sender {
                    return None;
                }
                let Relation::Replacement(replacement) = edit.content.relates_to? else {
                    return None;
                };
                // Review fix (P2): the relations request is scoped to
                // `event_id`, but nothing guarantees a homeserver/aggregation
                // response actually honors that scoping — the reaction scan
                // in `actions.rs` defensively checks its own relation target
                // for the same reason. Without this, a same-sender
                // `m.replace` whose `m.relates_to.event_id` targets some
                // *other* event could still be accepted here purely because
                // it showed up in this response, letting the pinned-messages
                // panel show an unrelated edit body as this message's preview.
                if replacement.event_id != *event_id {
                    return None;
                }
                Some((
                    edit.origin_server_ts,
                    replacement.new_content.msgtype.body().to_string(),
                ))
            })
            .collect();
        candidates.sort_by_key(|(ts, _)| std::cmp::Reverse(*ts));
        if let Some((_, body)) = candidates.into_iter().next() {
            return Some(body);
        }

        match relations.next_batch_token {
            Some(next) => from = Some(next),
            None => return None,
        }
    }

    None
}

/// A placeholder row for a pinned event id that couldn't be resolved at
/// all — see `PinnedMessageSummary::is_unresolved`'s own doc comment.
fn unresolved_pinned_message_summary(event_id: &matrix_sdk::ruma::EventId) -> PinnedMessageSummary {
    PinnedMessageSummary {
        event_id: event_id.to_string(),
        sender: String::new(),
        sender_display_name: None,
        preview: String::new(),
        timestamp_ms: 0,
        is_redacted: false,
        is_undecrypted: false,
        is_unresolved: true,
    }
}

/// Core logic behind [`get_pinned_messages`].
///
/// Review fix: reads through `pinned_event_cache_get_or_seed` (this
/// module's own authoritative list — see `pin_event`'s doc comment) instead
/// of `Room::pinned_event_ids()` directly. The latter is local, synced room
/// state that lags a full `/sync` round-trip behind a just-completed local
/// `pin_event`/`unpin_event` call, so opening the panel immediately after
/// pinning a message used to show the pre-pin list until the next sync
/// landed.
pub async fn get_pinned_messages_impl(
    state: &MatrixState,
    client: &Client,
    room_id: &str,
) -> Result<Vec<PinnedMessageSummary>, String> {
    let room = require_room(client, room_id)?;
    let parsed_room_id = RoomId::parse(room_id).map_err(|e| e.to_string())?;
    // Review fix (HIGH): `pinned_event_locks` serializes *every* read/write
    // of `pinned_event_cache` — see that field's own doc comment — but this
    // read path called `pinned_event_cache_get_or_seed` without holding it.
    // A concurrent cache-miss seed here racing a `pin_event`/`unpin_event`
    // write could insert a stale (pre-pin) list into the cache *after* that
    // write's own fresher insert, silently reverting a just-completed pin.
    // Held only around the seed/read below, not the slower per-event
    // fetch loop after it — unlike `pin_event`/`unpin_event`, nothing here
    // writes back to the cache, so there's nothing later in this function
    // that needs the lock's protection.
    let pinned_event_ids = {
        let lock = state.pinned_event_lock(&parsed_room_id).await;
        let _guard = lock.lock().await;
        pinned_event_cache_get_or_seed(state, client, &parsed_room_id, room_id).await?
    };

    let mut summaries = Vec::with_capacity(pinned_event_ids.len());
    for event_id in pinned_event_ids {
        // Review fix: return a placeholder instead of dropping the row —
        // see `PinnedMessageSummary::is_unresolved`'s own doc comment.
        let Ok(timeline_event) = room.load_or_fetch_event(&event_id, None).await else {
            summaries.push(unresolved_pinned_message_summary(&event_id));
            continue;
        };
        let Ok(raw_event) = timeline_event.raw().deserialize() else {
            summaries.push(unresolved_pinned_message_summary(&event_id));
            continue;
        };

        let sender = raw_event.sender().to_owned();
        // Review fix: disambiguate a shared display name the same way
        // `timeline::sender_profile_fields` does for the main timeline — the
        // Matrix spec requires this (`RoomMember::name_ambiguous`) so one
        // member can't pick a display name matching another's to impersonate
        // them; the pinned-messages panel is a second surface showing a
        // sender name, so it needs the same treatment.
        let sender_display_name =
            room.get_member(&sender)
                .await
                .ok()
                .flatten()
                .and_then(|member| {
                    member.display_name().map(|name| {
                        disambiguated_display_name(name, member.name_ambiguous(), &sender)
                    })
                });
        let timestamp_ms: u64 = raw_event.origin_server_ts().0.into();
        let is_redacted = raw_event.is_redacted();

        let (preview, is_undecrypted) = if is_redacted {
            (String::new(), false)
        } else {
            match &raw_event {
                matrix_sdk::ruma::events::AnySyncTimelineEvent::MessageLike(
                    matrix_sdk::ruma::events::AnySyncMessageLikeEvent::RoomMessage(
                        matrix_sdk::ruma::events::SyncMessageLikeEvent::Original(msg),
                    ),
                ) => {
                    // Review fix: a pinned message that's since been edited
                    // would otherwise always show its pre-edit body here —
                    // unlike the main timeline (which applies `m.replace`
                    // relations via `matrix-sdk-ui`'s own item processing),
                    // this path reads the original `m.room.message` event
                    // directly. Resolves the latest replacement relation (if
                    // any) the same way the client-server API's own
                    // aggregation endpoint would, falling back to the
                    // original body if there is no edit or the lookup fails.
                    let body = latest_edit_body(&room, &event_id, &sender)
                        .await
                        .unwrap_or_else(|| msg.content.body().to_string());
                    (body, false)
                }
                matrix_sdk::ruma::events::AnySyncTimelineEvent::MessageLike(
                    matrix_sdk::ruma::events::AnySyncMessageLikeEvent::RoomEncrypted(_),
                ) => (String::new(), true),
                _ => (String::new(), false),
            }
        };

        summaries.push(PinnedMessageSummary {
            event_id: event_id.to_string(),
            sender: sender.to_string(),
            sender_display_name,
            preview,
            timestamp_ms,
            is_redacted,
            is_undecrypted,
            is_unresolved: false,
        });
    }

    Ok(summaries)
}

/// Pins `event_id` in `room_id` by sending an updated `m.room.pinned_events`
/// state event. Granular (`pin_event`/`unpin_event`) rather than a single
/// `set_pinned_events(room_id, event_ids[])` command taking the frontend's
/// full desired list — see this module's doc comment / the PR description
/// for the trade-off: matrix-sdk's own `Room::pin_event` already does the
/// fetch-current-list-then-append read-modify-write itself (falling back to
/// `load_pinned_events` over the network if the list isn't in local state
/// yet), so a granular command avoids a second, frontend-driven
/// read-modify-write race window on top of it — two clients unpinning two
/// different messages at once won't clobber each other's change the way a
/// last-write-wins full-array `set_pinned_events` could.
#[tauri::command]
pub async fn pin_event(
    state: State<'_, MatrixState>,
    room_id: String,
    event_id: String,
) -> Result<(), String> {
    let client = state.require_client().await?;
    // Review fix: captured before this command's own network send below —
    // if a logout/re-login/account-switch happens while that send is still
    // in flight (this call is still holding a clone of the *old* `Client`,
    // which can complete the request against the old session regardless),
    // `clear_pinned_event_cache` bumps this and the write below becomes a
    // no-op instead of resurrecting a stale entry into the new session's
    // freshly-cleared cache.
    let generation = state
        .pinned_event_cache_generation
        .load(std::sync::atomic::Ordering::SeqCst);
    // Review fix: serializes this room's pin/unpin state writes — see
    // `MatrixState::pinned_event_locks`'s own doc comment for why
    // matrix-sdk's `Room::pin_event`/`unpin_event` need this held across the
    // call rather than relying on them to serialize themselves.
    let parsed_room_id = RoomId::parse(&room_id).map_err(|e| e.to_string())?;
    let lock = state.pinned_event_lock(&parsed_room_id).await;
    let _guard = lock.lock().await;
    // Review fix: holding the lock alone isn't enough — matrix-sdk's own
    // `Room::pin_event`/`unpin_event` build their replacement list from
    // `Room::pinned_event_ids()`, which reads *local, synced* room state.
    // Sending our state event doesn't retroactively update that local
    // state; it only lands once a later `/sync` response processes it. So
    // even fully serialized, a second call arriving before that sync
    // round-trip completes would still read the same pre-first-write list
    // matrix-sdk has cached and silently drop the first call's change.
    //
    // Review fix (P2): an earlier version of this fix used
    // `pinned_event_cache` (this module's own cache, kept current by every
    // pin/unpin write) as that base instead — correct for *this client's*
    // own quick-succession calls, but not for a genuinely concurrent edit
    // from a *different* client: if that other client's change lands on
    // the homeserver after this cache was seeded but before this client's
    // own sync reconciliation has processed it, the cached list is stale
    // and this write would silently drop the other client's change too.
    // Always fetching fresh from the homeserver here — a real GET
    // immediately before this call's own PUT, both against the same
    // client/session — sidesteps that: it reflects this client's own
    // just-written state (GET-after-PUT is consistent on a single
    // homeserver) *and* any other client's already-landed change, with no
    // reliance on this client's own sync/cache having caught up.
    // Review fix (P2): even with the lock and the fresh-GET base above, a
    // *different* client's concurrent pin/unpin can still land on the
    // homeserver in the gap between our GET and our PUT — `m.room.
    // pinned_events` has no compare-and-swap primitive, so whichever PUT the
    // homeserver processes last simply replaces the whole state content,
    // silently discarding the other client's change. `pin_event_with_retry`
    // re-reads the state immediately after sending and retries (rebuilding
    // the list from the newer read) if the event we meant to pin isn't
    // actually present in what's now live — narrowing, though not fully
    // eliminating (there is no atomic primitive to eliminate it with), the
    // window in which a genuinely simultaneous write from another client
    // gets silently dropped.
    let new_list =
        pin_event_with_retry(&client, &room_id, &event_id, MAX_PINNED_EVENT_RETRIES).await?;
    if state
        .pinned_event_cache_generation
        .load(std::sync::atomic::Ordering::SeqCst)
        == generation
    {
        state
            .pinned_event_cache
            .lock()
            .await
            .insert(parsed_room_id.clone(), new_list);
        // Review fix (P2): bumped after a successful, *verified* write —
        // see `pinned_event_local_write_seq`'s own doc comment. Lets
        // `sync.rs`'s pin-cache reconciliation (which can be waiting on
        // this same room's lock right now) detect that a local write
        // completed while it waited, so it skips overwriting this
        // just-cached, homeserver-verified list with a synced-state read
        // that may predate it.
        let mut local_write_seq = state.pinned_event_local_write_seq.lock().await;
        *local_write_seq.entry(parsed_room_id).or_insert(0) += 1;
    }
    Ok(())
}

/// Bounded retries for [`pin_event`]'s cross-client race — see that
/// command's own comment. Each attempt re-reads the freshest state, so a
/// retry naturally incorporates whatever the other client just wrote instead
/// of blindly resending the same (now stale) list.
const MAX_PINNED_EVENT_RETRIES: u8 = 3;

async fn pin_event_with_retry(
    client: &Client,
    room_id: &str,
    event_id: &str,
    max_attempts: u8,
) -> Result<Vec<matrix_sdk::ruma::OwnedEventId>, String> {
    let parsed_event_id = matrix_sdk::ruma::EventId::parse(event_id).map_err(|e| e.to_string())?;
    for attempt in 0..max_attempts {
        let current = fresh_pinned_event_ids(client, room_id).await?;
        pin_event_impl(client, room_id, event_id, current).await?;
        // Review fix (P2): the final attempt used to return `new_list`
        // unverified, skipping the same post-send re-read every earlier
        // attempt uses to prove the write actually won. In the same
        // cross-client race this whole retry loop exists to catch, another
        // client's write could still land after this final PUT — reporting
        // success and caching a list that was never actually live on the
        // homeserver. Verifying every attempt (including the last) means a
        // still-unverified final attempt now returns an error instead of a
        // false success.
        let after_send = fresh_pinned_event_ids(client, room_id).await?;
        if after_send.contains(&parsed_event_id) {
            return Ok(after_send);
        }
        if attempt + 1 == max_attempts {
            return Err(format!(
                "pin for {event_id} did not survive after {max_attempts} attempts (concurrent writes from another client keep winning)"
            ));
        }
        // Our pin didn't survive — a concurrent write from another client
        // landed after ours and won. Loop again with a freshly-read base.
    }
    unreachable!("loop always returns on its final attempt")
}

/// Core logic behind [`pin_event`] — pure computation over an explicit
/// `current_pinned` list (rather than reading `Room::pinned_event_ids()`
/// itself) so the command wrapper's authoritative-cache re-check (see its
/// own comment) is the only source of truth for what's currently pinned.
/// Returns the new list on success, for the caller to update that cache
/// with.
pub async fn pin_event_impl(
    client: &Client,
    room_id: &str,
    event_id: &str,
    current_pinned: Vec<matrix_sdk::ruma::OwnedEventId>,
) -> Result<Vec<matrix_sdk::ruma::OwnedEventId>, String> {
    let room = require_room(client, room_id)?;
    let parsed_event_id = matrix_sdk::ruma::EventId::parse(event_id).map_err(|e| e.to_string())?;
    if current_pinned.contains(&parsed_event_id) {
        return Ok(current_pinned);
    }
    let mut new_list = current_pinned;
    new_list.push(parsed_event_id);
    let content = matrix_sdk::ruma::events::room::pinned_events::RoomPinnedEventsEventContent::new(
        new_list.clone(),
    );
    room.send_state_event(content)
        .await
        .map_err(|e| e.to_string())?;
    Ok(new_list)
}

/// Unpins `event_id` in `room_id`. See [`pin_event`]'s doc comment for the
/// granular-vs-array trade-off shared by both commands.
#[tauri::command]
pub async fn unpin_event(
    state: State<'_, MatrixState>,
    room_id: String,
    event_id: String,
) -> Result<(), String> {
    let client = state.require_client().await?;
    // Review fix: same session-generation guard as `pin_event` — see that
    // command's own comment.
    let generation = state
        .pinned_event_cache_generation
        .load(std::sync::atomic::Ordering::SeqCst);
    // Review fix: same per-room serialization and always-fresh-from-network
    // base as `pin_event` — see that command's own comments.
    let parsed_room_id = RoomId::parse(&room_id).map_err(|e| e.to_string())?;
    let lock = state.pinned_event_lock(&parsed_room_id).await;
    let _guard = lock.lock().await;
    // Review fix (P2): same cross-client race and bounded-retry mitigation
    // as `pin_event` — see that command's own comment.
    let new_list =
        unpin_event_with_retry(&client, &room_id, &event_id, MAX_PINNED_EVENT_RETRIES).await?;
    if state
        .pinned_event_cache_generation
        .load(std::sync::atomic::Ordering::SeqCst)
        == generation
    {
        state
            .pinned_event_cache
            .lock()
            .await
            .insert(parsed_room_id.clone(), new_list);
        // Review fix (P2): same as `pin_event` — see
        // `pinned_event_local_write_seq`'s own doc comment.
        let mut local_write_seq = state.pinned_event_local_write_seq.lock().await;
        *local_write_seq.entry(parsed_room_id).or_insert(0) += 1;
    }
    Ok(())
}

/// Bounded retries for [`unpin_event`]'s cross-client race — see
/// [`pin_event_with_retry`]'s own comment; identical shape, just checking
/// the event's *absence* after send instead of its presence.
async fn unpin_event_with_retry(
    client: &Client,
    room_id: &str,
    event_id: &str,
    max_attempts: u8,
) -> Result<Vec<matrix_sdk::ruma::OwnedEventId>, String> {
    let parsed_event_id = matrix_sdk::ruma::EventId::parse(event_id).map_err(|e| e.to_string())?;
    for attempt in 0..max_attempts {
        let current = fresh_pinned_event_ids(client, room_id).await?;
        unpin_event_impl(client, room_id, event_id, current).await?;
        // Review fix (P2): same as `pin_event_with_retry` — verify the final
        // attempt too, instead of returning `new_list` unverified.
        let after_send = fresh_pinned_event_ids(client, room_id).await?;
        if !after_send.contains(&parsed_event_id) {
            return Ok(after_send);
        }
        if attempt + 1 == max_attempts {
            return Err(format!(
                "unpin for {event_id} did not survive after {max_attempts} attempts (concurrent writes from another client keep winning)"
            ));
        }
        // Our unpin didn't survive — a concurrent write from another client
        // landed after ours and won. Loop again with a freshly-read base.
    }
    unreachable!("loop always returns on its final attempt")
}

/// Core logic behind [`unpin_event`]. See [`pin_event_impl`]'s doc comment
/// for why this takes an explicit `current_pinned` list.
pub async fn unpin_event_impl(
    client: &Client,
    room_id: &str,
    event_id: &str,
    current_pinned: Vec<matrix_sdk::ruma::OwnedEventId>,
) -> Result<Vec<matrix_sdk::ruma::OwnedEventId>, String> {
    let room = require_room(client, room_id)?;
    let parsed_event_id = matrix_sdk::ruma::EventId::parse(event_id).map_err(|e| e.to_string())?;
    if !current_pinned.contains(&parsed_event_id) {
        return Ok(current_pinned);
    }
    let new_list: Vec<_> = current_pinned
        .into_iter()
        .filter(|id| *id != parsed_event_id)
        .collect();
    let content = matrix_sdk::ruma::events::room::pinned_events::RoomPinnedEventsEventContent::new(
        new_list.clone(),
    );
    room.send_state_event(content)
        .await
        .map_err(|e| e.to_string())?;
    Ok(new_list)
}

/// Always-fresh (network) read of `room_id`'s currently-pinned event ids —
/// the base [`pin_event`]/[`unpin_event`] build their next full-replacement
/// write from. See `pin_event`'s own comment for why this reads from the
/// homeserver directly rather than `pinned_event_cache` or matrix-sdk's
/// local `Room::pinned_event_ids()`: only a real GET immediately before the
/// following PUT is guaranteed to reflect a concurrent edit from a
/// *different* client, not just this client's own prior writes.
async fn fresh_pinned_event_ids(
    client: &Client,
    room_id: &str,
) -> Result<Vec<matrix_sdk::ruma::OwnedEventId>, String> {
    let room = require_room(client, room_id)?;
    Ok(room
        .load_pinned_events()
        .await
        .map_err(|e| e.to_string())?
        .unwrap_or_default())
}

/// Returns this module's authoritative last-known pinned list for
/// `room_id` — read path only (see [`get_pinned_messages`]); a slightly
/// stale read here is far less harmful than a write built on stale data,
/// so this cache — updated by every [`pin_event`]/[`unpin_event`] write and
/// by sync reconciliation — is an acceptable, network-free convenience for
/// the panel to read from, unlike the always-fresh network read those write
/// paths need (see `fresh_pinned_event_ids`, and [`pin_event`]'s own
/// comment on why they parted ways). Seeds the cache from local state (or a
/// network fallback) on first use for the room.
async fn pinned_event_cache_get_or_seed(
    state: &MatrixState,
    client: &Client,
    parsed_room_id: &matrix_sdk::ruma::RoomId,
    room_id: &str,
) -> Result<Vec<matrix_sdk::ruma::OwnedEventId>, String> {
    if let Some(existing) = state.pinned_event_cache.lock().await.get(parsed_room_id) {
        return Ok(existing.clone());
    }
    // Review fix: same session-generation guard `pin_event`/`unpin_event`
    // use for their own post-send cache write — captured before the
    // network read below so a logout/re-login/account-switch racing this
    // seed can't have its result resurrect a stale (previous-session) list
    // into the newly-cleared cache. This is the one seed path shared by
    // every caller of this function (`pin_event`, `unpin_event`,
    // `get_pinned_messages_impl`), so guarding it here covers all of them
    // — `get_pinned_messages_impl` in particular had no guard of its own
    // at all before this.
    let generation = state
        .pinned_event_cache_generation
        .load(std::sync::atomic::Ordering::SeqCst);
    let room = require_room(client, room_id)?;
    // Review fix: `Room::pinned_event_ids()` returns `None` both when the
    // room genuinely has no pins *and* when local state simply hasn't
    // caught up yet (e.g. right after joining, before the first full
    // `/sync` of this room's state has landed). Treating `None` as "no
    // pins" and seeding the cache with an empty list in the latter case
    // meant the very next pin/unpin call's full-replacement write would
    // silently drop every pin already on the homeserver. Fall back to an
    // explicit network read — the same fallback matrix-sdk's own
    // `Room::pin_event`/`unpin_event` used before this cache replaced them
    // — so a `None` only ever seeds an empty list once the homeserver has
    // confirmed there's genuinely nothing pinned.
    //
    // Review fix (CRITICAL): the cache's own lock must never be held across
    // this network `.await` — this whole function runs under the caller's
    // `pinned_event_locks` guard already (see `pin_event`/`unpin_event`,
    // and the sync loop's reconciliation after this round's other fix), so
    // holding `pinned_event_cache`'s lock too for the duration of a
    // potentially slow homeserver round-trip would stall every *other*
    // room's pin/unpin calls and cache reconciliation for no reason — they
    // don't touch this room's entry at all. Look the cache up again after
    // the network read completes (another call for this exact room can't
    // have run concurrently, since the per-room `pinned_event_locks` guard
    // already serializes that), but re-checking costs nothing and keeps
    // this function correct even if that invariant ever changes.
    let seeded = match room.pinned_event_ids() {
        Some(ids) => ids,
        None => {
            let from_network = room
                .load_pinned_events()
                .await
                .map_err(|e| e.to_string())?
                .unwrap_or_default();
            if let Some(existing) = state.pinned_event_cache.lock().await.get(parsed_room_id) {
                return Ok(existing.clone());
            }
            from_network
        }
    };
    if state
        .pinned_event_cache_generation
        .load(std::sync::atomic::Ordering::SeqCst)
        == generation
    {
        state
            .pinned_event_cache
            .lock()
            .await
            .insert(parsed_room_id.to_owned(), seeded.clone());
    }
    Ok(seeded)
}

/// Local (server-published, room-directory) aliases for `room_id` — distinct
/// from `RoomDetails.canonical_alias`/`alt_aliases`, which come off the room's
/// `m.room.canonical_alias` *state event* rather than the directory (Spec 32's
/// non-goal note: alias CRUD and canonical-alias state are separate concerns).
/// Hits the network every call — the local-server alias list isn't part of
/// sync state, same rationale as [`super::rooms::resolve_alias`].
#[tauri::command]
pub async fn get_room_local_aliases(
    state: State<'_, MatrixState>,
    room_id: String,
) -> Result<Vec<String>, String> {
    let client = state.require_client().await?;
    get_room_local_aliases_impl(&client, &room_id).await
}

/// Core logic behind [`get_room_local_aliases`].
pub async fn get_room_local_aliases_impl(
    client: &Client,
    room_id: &str,
) -> Result<Vec<String>, String> {
    let parsed_room_id = RoomId::parse(room_id).map_err(|e| e.to_string())?;
    let request = aliases::v3::Request::new(parsed_room_id);
    let response = client.send(request).await.map_err(|e| e.to_string())?;
    Ok(response
        .aliases
        .into_iter()
        .map(|a| a.to_string())
        .collect())
}

/// Checks whether `alias` is free to publish on the user's homeserver — the
/// frontend's "Add alias" flow calls this before [`add_room_alias`] so a
/// taken alias surfaces as "already in use" without attempting (and having
/// to unwind) a doomed create.
#[tauri::command]
pub async fn check_room_alias_available(
    state: State<'_, MatrixState>,
    alias: String,
) -> Result<bool, String> {
    let client = state.require_client().await?;
    check_room_alias_available_impl(&client, &alias).await
}

/// Core logic behind [`check_room_alias_available`].
pub async fn check_room_alias_available_impl(client: &Client, alias: &str) -> Result<bool, String> {
    let parsed_alias = RoomAliasId::parse(alias).map_err(|e| e.to_string())?;
    client
        .is_room_alias_available(&parsed_alias)
        .await
        .map_err(|e| e.to_string())
}

/// Publishes `alias` in the homeserver's room directory pointing at
/// `room_id`. This is directory publishing, not `m.room.canonical_alias`
/// state — call [`set_canonical_alias`] separately to make it canonical (the
/// frontend's "offer to set it as canonical" flow does both in sequence).
/// The availability check above is advisory only (a TOCTOU race is possible),
/// so this call's own conflict error is still the source of truth.
#[tauri::command]
pub async fn add_room_alias(
    state: State<'_, MatrixState>,
    room_id: String,
    alias: String,
) -> Result<(), String> {
    let client = state.require_client().await?;
    add_room_alias_impl(&client, &room_id, &alias).await
}

/// Core logic behind [`add_room_alias`].
pub async fn add_room_alias_impl(
    client: &Client,
    room_id: &str,
    alias: &str,
) -> Result<(), String> {
    let parsed_room_id = RoomId::parse(room_id).map_err(|e| e.to_string())?;
    let parsed_alias = RoomAliasId::parse(alias).map_err(|e| e.to_string())?;
    client
        .create_room_alias(&parsed_alias, &parsed_room_id)
        .await
        .map_err(|e| e.to_string())?;
    Ok(())
}

/// Unpublishes `alias` from the homeserver's room directory. Does not touch
/// `m.room.canonical_alias` — if `alias` was canonical or listed in
/// `alt_aliases`, the frontend is responsible for calling
/// [`set_canonical_alias`] to clear/update that state too, same as removing a
/// member's admin rights doesn't retroactively undo what they did with them.
#[tauri::command]
pub async fn remove_room_alias(state: State<'_, MatrixState>, alias: String) -> Result<(), String> {
    let client = state.require_client().await?;
    remove_room_alias_impl(&client, &alias).await
}

/// Core logic behind [`remove_room_alias`].
pub async fn remove_room_alias_impl(client: &Client, alias: &str) -> Result<(), String> {
    let parsed_alias = RoomAliasId::parse(alias).map_err(|e| e.to_string())?;
    client
        .remove_room_alias(&parsed_alias)
        .await
        .map_err(|e| e.to_string())?;
    Ok(())
}

/// Sets or clears `m.room.canonical_alias`'s `alias` field. `alt_aliases` is
/// preserved as-is (Spec 32 doesn't offer alt-alias editing) unless the new
/// canonical `alias` was previously in `alt_aliases`, in which case it's
/// removed from there to avoid listing the same alias in both fields.
#[tauri::command]
pub async fn set_canonical_alias(
    state: State<'_, MatrixState>,
    room_id: String,
    alias: Option<String>,
) -> Result<(), String> {
    let client = state.require_client().await?;
    set_canonical_alias_impl(&client, &room_id, alias.as_deref()).await
}

/// Core logic behind [`set_canonical_alias`].
pub async fn set_canonical_alias_impl(
    client: &Client,
    room_id: &str,
    alias: Option<&str>,
) -> Result<(), String> {
    let room = require_room(client, room_id)?;
    let parsed_alias: Option<OwnedRoomAliasId> = alias
        .map(RoomAliasId::parse)
        .transpose()
        .map_err(|e| e.to_string())?;

    let mut content = RoomCanonicalAliasEventContent::new();
    content.alt_aliases = room.alt_aliases();
    if let Some(ref parsed) = parsed_alias {
        content.alt_aliases.retain(|existing| existing != parsed);
    }
    content.alias = parsed_alias;

    room.send_state_event(content)
        .await
        .map_err(|e| e.to_string())?;
    Ok(())
}

/// Removes `alias` from `m.room.canonical_alias`'s `alt_aliases` list,
/// leaving the `alias` (canonical) field untouched. Used by the frontend
/// when an alt alias is unpublished from the room directory — unlike
/// [`set_canonical_alias`], this never touches the canonical field, so it's
/// safe to call even when `alias` isn't (and never was) canonical.
#[tauri::command]
pub async fn remove_alt_alias(
    state: State<'_, MatrixState>,
    room_id: String,
    alias: String,
) -> Result<(), String> {
    let client = state.require_client().await?;
    remove_alt_alias_impl(&client, &room_id, &alias).await
}

/// Core logic behind [`remove_alt_alias`].
pub async fn remove_alt_alias_impl(
    client: &Client,
    room_id: &str,
    alias: &str,
) -> Result<(), String> {
    let room = require_room(client, room_id)?;
    let parsed_alias = RoomAliasId::parse(alias).map_err(|e| e.to_string())?;

    let mut content = RoomCanonicalAliasEventContent::new();
    content.alias = room.canonical_alias();
    content.alt_aliases = room.alt_aliases();
    content
        .alt_aliases
        .retain(|existing| existing != &parsed_alias);

    room.send_state_event(content)
        .await
        .map_err(|e| e.to_string())?;
    Ok(())
}

/// Leaves a room (or space, since a space is just a room with
/// `room_type: m.space`) on the caller's own behalf. Distinct from
/// [`kick_member`], which removes a *different* member — this always acts on
/// the signed-in user.
#[tauri::command]
pub async fn leave_room(state: State<'_, MatrixState>, room_id: String) -> Result<(), String> {
    let client = state.require_client().await?;
    leave_room_impl(&client, &room_id).await
}

/// Core logic behind [`leave_room`].
pub async fn leave_room_impl(client: &Client, room_id: &str) -> Result<(), String> {
    let room = require_room(client, room_id)?;
    room.leave().await.map_err(|e| e.to_string())?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use matrix_sdk::test_utils::mocks::MatrixMockServer;

    use super::*;

    /// `set_room_avatar_impl` must reject an invalid avatar path the same
    /// way `set_avatar` (account avatar) does, via the shared
    /// `account::validate_avatar_path` — it should fail before ever looking
    /// up a room, so a client with no joined rooms at all is enough to prove
    /// the validation runs (a non-existent `room_id` would otherwise fail
    /// for the wrong reason).
    #[tokio::test]
    async fn set_room_avatar_impl_rejects_a_non_image_file() {
        let server = MatrixMockServer::new().await;
        let client = server.client_builder().build().await;

        let dir = tempfile::tempdir().unwrap();
        let file_path = dir.path().join("not-an-avatar.png");
        tokio::fs::write(&file_path, b"not an image").await.unwrap();

        let result = set_room_avatar_impl(
            &client,
            "!nonexistent:example.org",
            file_path.to_str().unwrap(),
        )
        .await;
        assert!(
            result.is_err(),
            "expected a non-image file to be rejected before any room lookup, got {result:?}"
        );
    }

    #[tokio::test]
    async fn set_room_avatar_impl_rejects_a_nonexistent_path() {
        let server = MatrixMockServer::new().await;
        let client = server.client_builder().build().await;

        let result = set_room_avatar_impl(
            &client,
            "!nonexistent:example.org",
            "/nonexistent/path/to/avatar.png",
        )
        .await;
        assert!(
            result.is_err(),
            "expected a nonexistent avatar path to be rejected, got {result:?}"
        );
    }

    // --- Spec 32: room alias management ---

    #[tokio::test]
    async fn get_room_local_aliases_impl_returns_the_server_aliases() {
        let server = MatrixMockServer::new().await;
        let client = server.client_builder().build().await;

        wiremock::Mock::given(wiremock::matchers::method("GET"))
            .and(wiremock::matchers::path_regex(
                r"^/_matrix/client/v3/rooms/.*/aliases",
            ))
            .respond_with(
                wiremock::ResponseTemplate::new(200).set_body_json(serde_json::json!({
                    "aliases": ["#room-alias:example.org", "#another-alias:example.org"],
                })),
            )
            .mount(server.server())
            .await;

        let aliases = get_room_local_aliases_impl(&client, "!room:example.org")
            .await
            .expect("aliases should be fetched");

        assert_eq!(
            aliases,
            vec![
                "#room-alias:example.org".to_string(),
                "#another-alias:example.org".to_string()
            ]
        );
    }

    // --- Spec day-2/04: message pinning ---

    #[tokio::test]
    async fn pin_event_impl_sends_the_updated_pinned_events_state() {
        use matrix_sdk_test::{JoinedRoomBuilder, ALICE};

        let room_id = matrix_sdk::ruma::room_id!("!room:example.org");
        let server = MatrixMockServer::new().await;
        let client = server.client_builder().build().await;

        server.mock_room_state_encryption().plain().mount().await;
        server.sync_joined_room(&client, room_id).await;

        // Room starts with one already-pinned event — proves this is a
        // read-modify-write append, not a blind overwrite.
        let existing = matrix_sdk::ruma::owned_event_id!("$existing");
        let to_pin = matrix_sdk::ruma::owned_event_id!("$new-pin");
        let factory = matrix_sdk_test::event_factory::EventFactory::new()
            .room(room_id)
            .sender(&ALICE);
        let room_builder = JoinedRoomBuilder::new(room_id)
            .add_state_event(factory.room_pinned_events(vec![existing.clone()]));
        server.sync_room(&client, room_builder).await;

        wiremock::Mock::given(wiremock::matchers::method("PUT"))
            .and(wiremock::matchers::path_regex(
                r"^/_matrix/client/v3/rooms/.*/state/m\.room\.pinned_events/.*",
            ))
            .and(wiremock::matchers::body_json(serde_json::json!({
                "pinned": [existing, to_pin],
            })))
            .respond_with(
                wiremock::ResponseTemplate::new(200).set_body_json(serde_json::json!({
                    "event_id": "$pinned_events_updated",
                })),
            )
            .expect(1)
            .mount(server.server())
            .await;

        let result =
            pin_event_impl(&client, room_id.as_str(), to_pin.as_str(), vec![existing]).await;
        assert!(
            result.is_ok(),
            "expected the pin to succeed, got {result:?}"
        );
    }

    /// Review fix regression test: a *different* client's concurrent write
    /// can still land between this client's fresh-GET base and its own PUT,
    /// clobbering this client's pin — `m.room.pinned_events` has no
    /// compare-and-swap primitive. `pin_event_with_retry` must detect that
    /// (a post-send re-read that doesn't contain the event we just pinned)
    /// and retry from a freshly-read base rather than silently reporting
    /// success with a pin that didn't actually survive.
    #[tokio::test]
    async fn pin_event_with_retry_retries_when_a_concurrent_write_clobbers_the_first_attempt() {
        use matrix_sdk_test::{JoinedRoomBuilder, ALICE};

        let room_id = matrix_sdk::ruma::room_id!("!room:example.org");
        let server = MatrixMockServer::new().await;
        let client = server.client_builder().build().await;

        server.mock_room_state_encryption().plain().mount().await;
        server.sync_joined_room(&client, room_id).await;

        let to_pin = matrix_sdk::ruma::owned_event_id!("$to-pin");
        let other_clients_pin = matrix_sdk::ruma::owned_event_id!("$other-clients-pin");
        let factory = matrix_sdk_test::event_factory::EventFactory::new()
            .room(room_id)
            .sender(&ALICE);
        let room_builder = JoinedRoomBuilder::new(room_id).add_state_event(
            factory.room_pinned_events(Vec::<matrix_sdk::ruma::OwnedEventId>::new()),
        );
        server.sync_room(&client, room_builder).await;

        // Attempt 1's fresh-GET base: empty.
        wiremock::Mock::given(wiremock::matchers::method("GET"))
            .and(wiremock::matchers::path_regex(
                r"^/_matrix/client/v3/rooms/.*/state/m\.room\.pinned_events/.*",
            ))
            .respond_with(
                wiremock::ResponseTemplate::new(200)
                    .set_body_json(serde_json::json!({ "pinned": [] })),
            )
            .up_to_n_times(1)
            .mount(server.server())
            .await;
        // Attempt 1's post-send verification read: a *different* client's
        // write landed after this client's PUT and won, so the list this
        // client just wrote (`[to_pin]`) isn't there at all — simulating
        // the clobber.
        wiremock::Mock::given(wiremock::matchers::method("GET"))
            .and(wiremock::matchers::path_regex(
                r"^/_matrix/client/v3/rooms/.*/state/m\.room\.pinned_events/.*",
            ))
            .respond_with(
                wiremock::ResponseTemplate::new(200).set_body_json(serde_json::json!({
                    "pinned": [other_clients_pin.clone()],
                })),
            )
            .up_to_n_times(1)
            .mount(server.server())
            .await;
        // Attempt 2's fresh-GET base: the other client's write, now visible.
        wiremock::Mock::given(wiremock::matchers::method("GET"))
            .and(wiremock::matchers::path_regex(
                r"^/_matrix/client/v3/rooms/.*/state/m\.room\.pinned_events/.*",
            ))
            .respond_with(
                wiremock::ResponseTemplate::new(200).set_body_json(serde_json::json!({
                    "pinned": [other_clients_pin.clone()],
                })),
            )
            .up_to_n_times(1)
            .mount(server.server())
            .await;
        // Attempt 2's post-send verification read: this time our pin
        // actually survives (no further concurrent write raced in).
        wiremock::Mock::given(wiremock::matchers::method("GET"))
            .and(wiremock::matchers::path_regex(
                r"^/_matrix/client/v3/rooms/.*/state/m\.room\.pinned_events/.*",
            ))
            .respond_with(
                wiremock::ResponseTemplate::new(200).set_body_json(serde_json::json!({
                    "pinned": [other_clients_pin.clone(), to_pin.clone()],
                })),
            )
            .up_to_n_times(1)
            .mount(server.server())
            .await;

        wiremock::Mock::given(wiremock::matchers::method("PUT"))
            .and(wiremock::matchers::path_regex(
                r"^/_matrix/client/v3/rooms/.*/state/m\.room\.pinned_events/.*",
            ))
            .respond_with(
                wiremock::ResponseTemplate::new(200)
                    .set_body_json(serde_json::json!({ "event_id": "$updated" })),
            )
            .expect(2)
            .mount(server.server())
            .await;

        let result = pin_event_with_retry(&client, room_id.as_str(), to_pin.as_str(), 2).await;
        let new_list = result.expect("retry should eventually succeed");

        assert!(
            new_list.contains(&to_pin),
            "expected the retried pin to survive in the final list, got {new_list:?}"
        );
        assert!(
            new_list.contains(&other_clients_pin),
            "expected the other client's concurrent pin to be preserved too, got {new_list:?}"
        );
    }

    /// Review fix regression test: the *final* retry attempt must also be
    /// verified by a post-send re-read, not just returned unconditionally.
    /// In the same cross-client race the whole retry loop exists to catch,
    /// another client's write can still land after this final PUT — without
    /// verifying it too, `pin_event_with_retry` would report success and
    /// cache a list that was never actually live on the homeserver.
    #[tokio::test]
    async fn pin_event_with_retry_errors_when_the_final_attempt_is_also_clobbered() {
        use matrix_sdk_test::{JoinedRoomBuilder, ALICE};

        let room_id = matrix_sdk::ruma::room_id!("!room:example.org");
        let server = MatrixMockServer::new().await;
        let client = server.client_builder().build().await;

        server.mock_room_state_encryption().plain().mount().await;
        server.sync_joined_room(&client, room_id).await;

        let to_pin = matrix_sdk::ruma::owned_event_id!("$to-pin");
        let other_clients_pin = matrix_sdk::ruma::owned_event_id!("$other-clients-pin");
        let factory = matrix_sdk_test::event_factory::EventFactory::new()
            .room(room_id)
            .sender(&ALICE);
        let room_builder = JoinedRoomBuilder::new(room_id).add_state_event(
            factory.room_pinned_events(Vec::<matrix_sdk::ruma::OwnedEventId>::new()),
        );
        server.sync_room(&client, room_builder).await;

        // Every fresh-GET / post-send-verification read (only one attempt
        // this time, so both reads share the same mock) sees the other
        // client's pin winning — our own pin never actually sticks.
        wiremock::Mock::given(wiremock::matchers::method("GET"))
            .and(wiremock::matchers::path_regex(
                r"^/_matrix/client/v3/rooms/.*/state/m\.room\.pinned_events/.*",
            ))
            .respond_with(
                wiremock::ResponseTemplate::new(200).set_body_json(serde_json::json!({
                    "pinned": [other_clients_pin.clone()],
                })),
            )
            .mount(server.server())
            .await;
        wiremock::Mock::given(wiremock::matchers::method("PUT"))
            .and(wiremock::matchers::path_regex(
                r"^/_matrix/client/v3/rooms/.*/state/m\.room\.pinned_events/.*",
            ))
            .respond_with(
                wiremock::ResponseTemplate::new(200)
                    .set_body_json(serde_json::json!({ "event_id": "$updated" })),
            )
            .mount(server.server())
            .await;

        let result = pin_event_with_retry(&client, room_id.as_str(), to_pin.as_str(), 1).await;

        assert!(
            result.is_err(),
            "expected an error when even the final attempt doesn't survive verification, got {result:?}"
        );
    }

    /// Review fix regression test: composes two pins by feeding the first
    /// call's *returned* list into the second, rather than having the
    /// second independently re-derive its base list from
    /// `Room::pinned_event_ids()` (which wouldn't yet reflect the first
    /// call's not-actually-synced-yet write) — this is exactly what the
    /// `pin_event`/`unpin_event` command wrappers' authoritative cache does
    /// for two quick real-world calls. Asserts the second PUT still
    /// carries both pins, proving the first one isn't silently dropped.
    #[tokio::test]
    async fn pin_event_impl_composes_two_pins_fed_through_the_returned_list() {
        use matrix_sdk_test::{JoinedRoomBuilder, ALICE};

        let room_id = matrix_sdk::ruma::room_id!("!room:example.org");
        let server = MatrixMockServer::new().await;
        let client = server.client_builder().build().await;

        server.mock_room_state_encryption().plain().mount().await;
        server.sync_joined_room(&client, room_id).await;

        let first_pin = matrix_sdk::ruma::owned_event_id!("$first-pin");
        let second_pin = matrix_sdk::ruma::owned_event_id!("$second-pin");
        let factory = matrix_sdk_test::event_factory::EventFactory::new()
            .room(room_id)
            .sender(&ALICE);
        // Local synced state never advances between the two calls below —
        // simulating the sync round-trip lag the fix accounts for.
        let room_builder = JoinedRoomBuilder::new(room_id).add_state_event(
            factory.room_pinned_events(Vec::<matrix_sdk::ruma::OwnedEventId>::new()),
        );
        server.sync_room(&client, room_builder).await;

        wiremock::Mock::given(wiremock::matchers::method("PUT"))
            .and(wiremock::matchers::path_regex(
                r"^/_matrix/client/v3/rooms/.*/state/m\.room\.pinned_events/.*",
            ))
            .and(wiremock::matchers::body_json(serde_json::json!({
                "pinned": [second_pin],
            })))
            .respond_with(
                wiremock::ResponseTemplate::new(200).set_body_json(serde_json::json!({
                    "event_id": "$first_update",
                })),
            )
            .expect(1)
            .mount(server.server())
            .await;
        wiremock::Mock::given(wiremock::matchers::method("PUT"))
            .and(wiremock::matchers::path_regex(
                r"^/_matrix/client/v3/rooms/.*/state/m\.room\.pinned_events/.*",
            ))
            .and(wiremock::matchers::body_json(serde_json::json!({
                "pinned": [second_pin, first_pin],
            })))
            .respond_with(
                wiremock::ResponseTemplate::new(200).set_body_json(serde_json::json!({
                    "event_id": "$second_update",
                })),
            )
            .expect(1)
            .mount(server.server())
            .await;

        let after_first = pin_event_impl(&client, room_id.as_str(), second_pin.as_str(), vec![])
            .await
            .expect("first pin should succeed");
        let after_second =
            pin_event_impl(&client, room_id.as_str(), first_pin.as_str(), after_first)
                .await
                .expect("second pin should succeed");

        assert_eq!(after_second, vec![second_pin, first_pin]);
    }

    #[tokio::test]
    async fn unpin_event_impl_sends_the_updated_pinned_events_state() {
        use matrix_sdk_test::{JoinedRoomBuilder, ALICE};

        let room_id = matrix_sdk::ruma::room_id!("!room:example.org");
        let server = MatrixMockServer::new().await;
        let client = server.client_builder().build().await;

        server.mock_room_state_encryption().plain().mount().await;
        server.sync_joined_room(&client, room_id).await;

        let to_keep = matrix_sdk::ruma::owned_event_id!("$keep");
        let to_unpin = matrix_sdk::ruma::owned_event_id!("$unpin");
        let factory = matrix_sdk_test::event_factory::EventFactory::new()
            .room(room_id)
            .sender(&ALICE);
        let room_builder = JoinedRoomBuilder::new(room_id)
            .add_state_event(factory.room_pinned_events(vec![to_keep.clone(), to_unpin.clone()]));
        server.sync_room(&client, room_builder).await;

        wiremock::Mock::given(wiremock::matchers::method("PUT"))
            .and(wiremock::matchers::path_regex(
                r"^/_matrix/client/v3/rooms/.*/state/m\.room\.pinned_events/.*",
            ))
            .and(wiremock::matchers::body_json(serde_json::json!({
                "pinned": [to_keep],
            })))
            .respond_with(
                wiremock::ResponseTemplate::new(200).set_body_json(serde_json::json!({
                    "event_id": "$pinned_events_updated",
                })),
            )
            .expect(1)
            .mount(server.server())
            .await;

        let result = unpin_event_impl(
            &client,
            room_id.as_str(),
            to_unpin.as_str(),
            vec![to_keep, to_unpin.clone()],
        )
        .await;
        assert!(
            result.is_ok(),
            "expected the unpin to succeed, got {result:?}"
        );
    }

    /// Review fix regression test: `fresh_pinned_event_ids` (the base
    /// `pin_event`/`unpin_event` build their next write from) must reflect
    /// the homeserver's *current* state, not this client's own local
    /// synced state or cache — otherwise a concurrent edit from a
    /// different client that already landed on the server, but hasn't
    /// synced to this client yet, gets silently dropped by the next local
    /// pin/unpin's full-replacement write.
    #[tokio::test]
    async fn fresh_pinned_event_ids_reflects_the_server_not_stale_local_state() {
        use matrix_sdk_test::{JoinedRoomBuilder, ALICE};

        let room_id = matrix_sdk::ruma::room_id!("!room:example.org");
        let server = MatrixMockServer::new().await;
        let client = server.client_builder().build().await;

        server.mock_room_state_encryption().plain().mount().await;
        server.sync_joined_room(&client, room_id).await;

        // This client's own local synced state is stale — still shows the
        // pre-concurrent-edit list.
        let stale_local_pin = matrix_sdk::ruma::owned_event_id!("$stale-local-pin");
        let factory = matrix_sdk_test::event_factory::EventFactory::new()
            .room(room_id)
            .sender(&ALICE);
        let room_builder = JoinedRoomBuilder::new(room_id)
            .add_state_event(factory.room_pinned_events(vec![stale_local_pin.clone()]));
        server.sync_room(&client, room_builder).await;

        // A *different* client already pinned something else on the
        // homeserver; this client's own sync hasn't caught up to it yet.
        let concurrent_remote_pin = matrix_sdk::ruma::owned_event_id!("$concurrent-remote-pin");
        wiremock::Mock::given(wiremock::matchers::method("GET"))
            .and(wiremock::matchers::path_regex(
                r"^/_matrix/client/v3/rooms/.*/state/m\.room\.pinned_events/.*",
            ))
            .respond_with(
                wiremock::ResponseTemplate::new(200).set_body_json(serde_json::json!({
                    "pinned": [concurrent_remote_pin.clone(), stale_local_pin.clone()],
                })),
            )
            .mount(server.server())
            .await;

        let fresh = fresh_pinned_event_ids(&client, room_id.as_str())
            .await
            .expect("fresh read should succeed");

        assert_eq!(
            fresh,
            vec![concurrent_remote_pin, stale_local_pin],
            "expected the server's current list (including the concurrent client's pin), not this client's stale local/cached state"
        );
    }

    /// Review fix regression test: when local synced state hasn't caught up
    /// yet (`Room::pinned_event_ids()` returns `None`, e.g. right after
    /// joining), the cache must fall back to a network `load_pinned_events`
    /// read instead of assuming "no pins" and seeding an empty list — the
    /// latter would let a subsequent pin/unpin's full-replacement write
    /// silently drop pins that genuinely exist on the homeserver.
    #[tokio::test]
    async fn pinned_event_cache_get_or_seed_falls_back_to_network_when_local_state_is_unknown() {
        let room_id = matrix_sdk::ruma::room_id!("!room:example.org");
        let server = MatrixMockServer::new().await;
        let client = server.client_builder().build().await;

        server.mock_room_state_encryption().plain().mount().await;
        // Deliberately synced without ever sending an `m.room.pinned_events`
        // state event — `Room::pinned_event_ids()` reads `None` here, not
        // an empty list, since local state has no opinion either way.
        server.sync_joined_room(&client, room_id).await;

        let from_server = matrix_sdk::ruma::owned_event_id!("$already-pinned-on-server");
        wiremock::Mock::given(wiremock::matchers::method("GET"))
            .and(wiremock::matchers::path_regex(
                r"^/_matrix/client/v3/rooms/.*/state/m\.room\.pinned_events/.*",
            ))
            .respond_with(
                wiremock::ResponseTemplate::new(200).set_body_json(serde_json::json!({
                    "pinned": [from_server],
                })),
            )
            .expect(1)
            .mount(server.server())
            .await;

        let state = MatrixState::default();
        let seeded = pinned_event_cache_get_or_seed(&state, &client, room_id, room_id.as_str())
            .await
            .expect("seeding should fall back to the network read and succeed");

        assert_eq!(
            seeded,
            vec![from_server],
            "expected the cache to be seeded from the server's own pinned list, not an empty one"
        );
    }

    /// Review fix regression test (CRITICAL): the network-fallback seed
    /// must not hold `pinned_event_cache`'s lock for the duration of the
    /// homeserver round-trip — an unrelated room's cache read must be able
    /// to proceed while a slow `load_pinned_events` call for a *different*
    /// room is still in flight.
    #[tokio::test]
    async fn pinned_event_cache_get_or_seed_does_not_hold_the_cache_lock_across_the_network_await()
    {
        let slow_room_id = matrix_sdk::ruma::room_id!("!slow:example.org");
        let other_room_id = matrix_sdk::ruma::room_id!("!other:example.org");
        let server = MatrixMockServer::new().await;
        let client = server.client_builder().build().await;

        server.mock_room_state_encryption().plain().mount().await;
        server.sync_joined_room(&client, slow_room_id).await;

        wiremock::Mock::given(wiremock::matchers::method("GET"))
            .and(wiremock::matchers::path_regex(
                r"^/_matrix/client/v3/rooms/.*/state/m\.room\.pinned_events/.*",
            ))
            .respond_with(
                wiremock::ResponseTemplate::new(200)
                    .set_delay(std::time::Duration::from_secs(2))
                    .set_body_json(serde_json::json!({ "pinned": [] })),
            )
            .mount(server.server())
            .await;

        let state = std::sync::Arc::new(MatrixState::default());
        // Directly seed a cache entry for the *other* room — no network
        // call needed for it, so if the lock were genuinely held across
        // `slow_room_id`'s network await, reading it below would hang for
        // the same ~300ms instead of returning immediately.
        state
            .pinned_event_cache
            .lock()
            .await
            .insert(other_room_id.to_owned(), vec![]);

        let slow_state = std::sync::Arc::clone(&state);
        let slow_client = client.clone();
        let slow_call = tokio::spawn(async move {
            pinned_event_cache_get_or_seed(
                slow_state.as_ref(),
                &slow_client,
                slow_room_id,
                slow_room_id.as_str(),
            )
            .await
        });
        // Give the spawned call time to acquire-then-release the lock (if
        // fixed) or acquire-and-hold it (if regressed) before racing the
        // unrelated read below. Generous relative to CI/parallel-test
        // scheduling jitter — correctness only needs "well under the 2s
        // network delay," not tight sub-100ms precision.
        tokio::time::sleep(std::time::Duration::from_millis(500)).await;

        let unrelated_read = tokio::time::timeout(
            std::time::Duration::from_millis(500),
            state.pinned_event_cache.lock(),
        )
        .await;
        assert!(
            unrelated_read.is_ok(),
            "an unrelated room's cache lock acquisition must not block on another room's in-flight network read"
        );
        drop(unrelated_read);

        slow_call
            .await
            .expect("task should not panic")
            .expect("seeding should still succeed once the delayed response lands");
    }

    /// Review fix regression test: a logout/re-login/account-switch racing
    /// this seed's network read must not let the seed's own insert
    /// resurrect a stale (previous-session) list into the freshly-cleared
    /// cache — the same session-generation guard `pin_event`/`unpin_event`
    /// already had for their own post-send write, now also covering this
    /// seed path (which every caller, including `get_pinned_messages_impl`,
    /// shares and which previously had no guard at all).
    #[tokio::test]
    async fn pinned_event_cache_get_or_seed_skips_its_insert_when_the_session_changes_mid_seed() {
        let room_id = matrix_sdk::ruma::room_id!("!room:example.org");
        let server = MatrixMockServer::new().await;
        let client = server.client_builder().build().await;

        server.mock_room_state_encryption().plain().mount().await;
        server.sync_joined_room(&client, room_id).await;

        wiremock::Mock::given(wiremock::matchers::method("GET"))
            .and(wiremock::matchers::path_regex(
                r"^/_matrix/client/v3/rooms/.*/state/m\.room\.pinned_events/.*",
            ))
            .respond_with(
                wiremock::ResponseTemplate::new(200)
                    .set_delay(std::time::Duration::from_secs(1))
                    .set_body_json(serde_json::json!({
                        "pinned": [matrix_sdk::ruma::owned_event_id!("$stale-session-pin")],
                    })),
            )
            .mount(server.server())
            .await;

        let state = std::sync::Arc::new(MatrixState::default());
        let seed_state = std::sync::Arc::clone(&state);
        let seed_client = client.clone();
        let seed_call = tokio::spawn(async move {
            pinned_event_cache_get_or_seed(
                seed_state.as_ref(),
                &seed_client,
                room_id,
                room_id.as_str(),
            )
            .await
        });

        // Give the seed time to start its (delayed) network read before
        // simulating a logout/re-login racing it.
        tokio::time::sleep(std::time::Duration::from_millis(200)).await;
        state.clear_pinned_event_cache().await;

        seed_call
            .await
            .expect("task should not panic")
            .expect("the seed call itself should still succeed");

        assert!(
            state.pinned_event_cache.lock().await.get(room_id).is_none(),
            "a session change mid-seed must not let the stale seed resurrect an entry in the freshly-cleared cache"
        );
    }

    /// Review fix regression test (HIGH): `get_pinned_messages_impl` must
    /// hold the room's `pinned_event_lock` while it seeds the cache — the
    /// same lock `pin_event`/`unpin_event` hold for their own cache reads
    /// and writes (see `MatrixState::pinned_event_locks`'s own doc
    /// comment). Without it, a cache-miss seed here racing a concurrent
    /// pin/unpin could insert a stale (pre-pin) list *after* that write's
    /// own fresher insert, silently reverting a just-completed pin.
    /// Asserts the lock itself is actually held for the duration of the
    /// seed by trying to acquire it directly while the seed is still
    /// in flight — the inverse assertion of the CRITICAL test above,
    /// which covers a different lock (`pinned_event_cache`'s own mutex)
    /// that must specifically *not* be held across the same network await.
    #[tokio::test]
    async fn get_pinned_messages_impl_holds_the_room_lock_while_seeding() {
        let room_id = matrix_sdk::ruma::room_id!("!room:example.org");
        let server = MatrixMockServer::new().await;
        let client = server.client_builder().build().await;

        server.mock_room_state_encryption().plain().mount().await;
        // No `m.room.pinned_events` state ever synced — `Room::pinned_event_ids()`
        // reads `None`, forcing the network-fallback seed path.
        server.sync_joined_room(&client, room_id).await;

        wiremock::Mock::given(wiremock::matchers::method("GET"))
            .and(wiremock::matchers::path_regex(
                r"^/_matrix/client/v3/rooms/.*/state/m\.room\.pinned_events/.*",
            ))
            .respond_with(
                wiremock::ResponseTemplate::new(200)
                    .set_delay(std::time::Duration::from_secs(2))
                    .set_body_json(serde_json::json!({ "pinned": [] })),
            )
            .mount(server.server())
            .await;

        let state = std::sync::Arc::new(MatrixState::default());
        let read_state = std::sync::Arc::clone(&state);
        let read_client = client.clone();
        let read_call = tokio::spawn(async move {
            get_pinned_messages_impl(read_state.as_ref(), &read_client, room_id.as_str()).await
        });
        // Generous margin relative to CI/parallel-test scheduling jitter —
        // same rationale as the CRITICAL test above.
        tokio::time::sleep(std::time::Duration::from_millis(500)).await;

        let lock = state.pinned_event_lock(room_id).await;
        let racing_acquire =
            tokio::time::timeout(std::time::Duration::from_millis(500), lock.lock()).await;
        assert!(
            racing_acquire.is_err(),
            "expected the room's pin lock to still be held by the in-flight seed, but it was acquired"
        );

        read_call
            .await
            .expect("task should not panic")
            .expect("the read should still succeed once the delayed response lands");

        // Once the seed has finished (and released the lock), it must be
        // acquirable again promptly.
        let _guard = tokio::time::timeout(std::time::Duration::from_millis(500), lock.lock())
            .await
            .expect("the room lock should be released once the seed completes");
    }

    #[tokio::test]
    async fn get_pinned_messages_impl_resolves_pinned_events_in_order() {
        use matrix_sdk_test::{JoinedRoomBuilder, ALICE};

        let room_id = matrix_sdk::ruma::room_id!("!room:example.org");
        let server = MatrixMockServer::new().await;
        let client = server.client_builder().build().await;

        server.mock_room_state_encryption().plain().mount().await;
        server.sync_joined_room(&client, room_id).await;

        let first = matrix_sdk::ruma::owned_event_id!("$first");
        let second = matrix_sdk::ruma::owned_event_id!("$second");
        let factory = matrix_sdk_test::event_factory::EventFactory::new()
            .room(room_id)
            .sender(&ALICE);
        let room_builder = JoinedRoomBuilder::new(room_id)
            .add_state_event(factory.room_pinned_events(vec![first.clone(), second.clone()]));
        server.sync_room(&client, room_builder).await;

        wiremock::Mock::given(wiremock::matchers::method("GET"))
            .and(wiremock::matchers::path(format!(
                "/_matrix/client/v3/rooms/{room_id}/event/{first}"
            )))
            .respond_with(
                wiremock::ResponseTemplate::new(200).set_body_json(serde_json::json!({
                    "type": "m.room.message",
                    "event_id": first,
                    "room_id": room_id,
                    "sender": *ALICE,
                    "origin_server_ts": 1_700_000_000_000u64,
                    "content": { "msgtype": "m.text", "body": "read this first" },
                })),
            )
            .mount(server.server())
            .await;

        wiremock::Mock::given(wiremock::matchers::method("GET"))
            .and(wiremock::matchers::path(format!(
                "/_matrix/client/v3/rooms/{room_id}/event/{second}"
            )))
            .respond_with(
                wiremock::ResponseTemplate::new(200).set_body_json(serde_json::json!({
                    "type": "m.room.message",
                    "event_id": second,
                    "room_id": room_id,
                    "sender": *ALICE,
                    "origin_server_ts": 1_700_000_001_000u64,
                    "content": { "msgtype": "m.text", "body": "then this" },
                })),
            )
            .mount(server.server())
            .await;

        let summaries =
            get_pinned_messages_impl(&MatrixState::default(), &client, room_id.as_str())
                .await
                .expect("pinned messages should resolve");

        assert_eq!(summaries.len(), 2);
        assert_eq!(summaries[0].event_id, first.to_string());
        assert_eq!(summaries[0].preview, "read this first");
        assert!(!summaries[0].is_redacted);
        assert!(!summaries[0].is_undecrypted);
        assert_eq!(summaries[1].event_id, second.to_string());
        assert_eq!(summaries[1].preview, "then this");
    }

    /// Review fix regression test: a pinned message that's since been
    /// edited must show its current (edited) body, not the original
    /// `m.room.message` event's pre-edit body — this call reads the event
    /// directly rather than going through `matrix-sdk-ui`'s own
    /// edit-collapsing timeline processing, so it needs its own resolution
    /// of the `m.replace` relation.
    #[tokio::test]
    async fn get_pinned_messages_impl_resolves_the_latest_edit_of_a_pinned_message() {
        use matrix_sdk_test::{JoinedRoomBuilder, ALICE};

        let room_id = matrix_sdk::ruma::room_id!("!room:example.org");
        let server = MatrixMockServer::new().await;
        let client = server.client_builder().build().await;

        server.mock_room_state_encryption().plain().mount().await;
        server.sync_joined_room(&client, room_id).await;

        let original = matrix_sdk::ruma::owned_event_id!("$original");
        let edit = matrix_sdk::ruma::owned_event_id!("$edit");
        let factory = matrix_sdk_test::event_factory::EventFactory::new()
            .room(room_id)
            .sender(&ALICE);
        let room_builder = JoinedRoomBuilder::new(room_id)
            .add_state_event(factory.room_pinned_events(vec![original.clone()]));
        server.sync_room(&client, room_builder).await;

        wiremock::Mock::given(wiremock::matchers::method("GET"))
            .and(wiremock::matchers::path(format!(
                "/_matrix/client/v3/rooms/{room_id}/event/{original}"
            )))
            .respond_with(
                wiremock::ResponseTemplate::new(200).set_body_json(serde_json::json!({
                    "type": "m.room.message",
                    "event_id": original,
                    "room_id": room_id,
                    "sender": *ALICE,
                    "origin_server_ts": 1_700_000_000_000u64,
                    "content": { "msgtype": "m.text", "body": "pre-edit body" },
                })),
            )
            .mount(server.server())
            .await;

        wiremock::Mock::given(wiremock::matchers::method("GET"))
            .and(wiremock::matchers::path(format!(
                "/_matrix/client/v1/rooms/{room_id}/relations/{original}/m.replace"
            )))
            .respond_with(
                wiremock::ResponseTemplate::new(200).set_body_json(serde_json::json!({
                    "chunk": [{
                        "type": "m.room.message",
                        "event_id": edit,
                        "room_id": room_id,
                        "sender": *ALICE,
                        "origin_server_ts": 1_700_000_001_000u64,
                        "content": {
                            "msgtype": "m.text",
                            "body": "* edited body",
                            "m.new_content": { "msgtype": "m.text", "body": "edited body" },
                            "m.relates_to": { "rel_type": "m.replace", "event_id": original },
                        },
                    }],
                })),
            )
            .mount(server.server())
            .await;

        let summaries =
            get_pinned_messages_impl(&MatrixState::default(), &client, room_id.as_str())
                .await
                .expect("pinned messages should resolve");

        assert_eq!(summaries.len(), 1);
        assert_eq!(summaries[0].preview, "edited body");
    }

    /// Review fix regression test: picks the edit with the latest
    /// `origin_server_ts`, not just whichever happens to come first in the
    /// `/relations` response — doesn't rely on the homeserver having
    /// actually honored `dir: Direction::Backward`.
    #[tokio::test]
    async fn get_pinned_messages_impl_resolves_the_latest_edit_even_when_the_server_returns_them_out_of_order(
    ) {
        use matrix_sdk_test::{JoinedRoomBuilder, ALICE};

        let room_id = matrix_sdk::ruma::room_id!("!room:example.org");
        let server = MatrixMockServer::new().await;
        let client = server.client_builder().build().await;

        server.mock_room_state_encryption().plain().mount().await;
        server.sync_joined_room(&client, room_id).await;

        let original = matrix_sdk::ruma::owned_event_id!("$original");
        let older_edit = matrix_sdk::ruma::owned_event_id!("$older-edit");
        let newer_edit = matrix_sdk::ruma::owned_event_id!("$newer-edit");
        let factory = matrix_sdk_test::event_factory::EventFactory::new()
            .room(room_id)
            .sender(&ALICE);
        let room_builder = JoinedRoomBuilder::new(room_id)
            .add_state_event(factory.room_pinned_events(vec![original.clone()]));
        server.sync_room(&client, room_builder).await;

        wiremock::Mock::given(wiremock::matchers::method("GET"))
            .and(wiremock::matchers::path(format!(
                "/_matrix/client/v3/rooms/{room_id}/event/{original}"
            )))
            .respond_with(
                wiremock::ResponseTemplate::new(200).set_body_json(serde_json::json!({
                    "type": "m.room.message",
                    "event_id": original,
                    "room_id": room_id,
                    "sender": *ALICE,
                    "origin_server_ts": 1_700_000_000_000u64,
                    "content": { "msgtype": "m.text", "body": "pre-edit body" },
                })),
            )
            .mount(server.server())
            .await;

        // The newer edit (higher origin_server_ts) is listed *second* in
        // the chunk — out of the backward/newest-first order the request
        // asked for.
        wiremock::Mock::given(wiremock::matchers::method("GET"))
            .and(wiremock::matchers::path(format!(
                "/_matrix/client/v1/rooms/{room_id}/relations/{original}/m.replace"
            )))
            .respond_with(
                wiremock::ResponseTemplate::new(200).set_body_json(serde_json::json!({
                    "chunk": [
                        {
                            "type": "m.room.message",
                            "event_id": older_edit,
                            "room_id": room_id,
                            "sender": *ALICE,
                            "origin_server_ts": 1_700_000_001_000u64,
                            "content": {
                                "msgtype": "m.text",
                                "body": "* older edit",
                                "m.new_content": { "msgtype": "m.text", "body": "older edit" },
                                "m.relates_to": { "rel_type": "m.replace", "event_id": original },
                            },
                        },
                        {
                            "type": "m.room.message",
                            "event_id": newer_edit,
                            "room_id": room_id,
                            "sender": *ALICE,
                            "origin_server_ts": 1_700_000_002_000u64,
                            "content": {
                                "msgtype": "m.text",
                                "body": "* newer edit",
                                "m.new_content": { "msgtype": "m.text", "body": "newer edit" },
                                "m.relates_to": { "rel_type": "m.replace", "event_id": original },
                            },
                        },
                    ],
                })),
            )
            .mount(server.server())
            .await;

        let summaries =
            get_pinned_messages_impl(&MatrixState::default(), &client, room_id.as_str())
                .await
                .expect("pinned messages should resolve");

        assert_eq!(summaries.len(), 1);
        assert_eq!(summaries[0].preview, "newer edit");
    }

    /// Review fix regression test: a replacement is only valid if its
    /// sender matches the original event's sender
    /// (https://spec.matrix.org/v1.11/client-server-api/#validity-of-replacement-events).
    /// An `m.replace` from a *different* sender must be ignored — otherwise
    /// any room member could inject arbitrary text into someone else's
    /// pinned message preview.
    #[tokio::test]
    async fn get_pinned_messages_impl_ignores_a_replacement_from_a_different_sender() {
        use matrix_sdk_test::{JoinedRoomBuilder, ALICE, BOB};

        let room_id = matrix_sdk::ruma::room_id!("!room:example.org");
        let server = MatrixMockServer::new().await;
        let client = server.client_builder().build().await;

        server.mock_room_state_encryption().plain().mount().await;
        server.sync_joined_room(&client, room_id).await;

        let original = matrix_sdk::ruma::owned_event_id!("$original");
        let forged_edit = matrix_sdk::ruma::owned_event_id!("$forged");
        let factory = matrix_sdk_test::event_factory::EventFactory::new()
            .room(room_id)
            .sender(&ALICE);
        let room_builder = JoinedRoomBuilder::new(room_id)
            .add_state_event(factory.room_pinned_events(vec![original.clone()]));
        server.sync_room(&client, room_builder).await;

        wiremock::Mock::given(wiremock::matchers::method("GET"))
            .and(wiremock::matchers::path(format!(
                "/_matrix/client/v3/rooms/{room_id}/event/{original}"
            )))
            .respond_with(
                wiremock::ResponseTemplate::new(200).set_body_json(serde_json::json!({
                    "type": "m.room.message",
                    "event_id": original,
                    "room_id": room_id,
                    "sender": *ALICE,
                    "origin_server_ts": 1_700_000_000_000u64,
                    "content": { "msgtype": "m.text", "body": "original body" },
                })),
            )
            .mount(server.server())
            .await;

        wiremock::Mock::given(wiremock::matchers::method("GET"))
            .and(wiremock::matchers::path(format!(
                "/_matrix/client/v1/rooms/{room_id}/relations/{original}/m.replace"
            )))
            .respond_with(
                wiremock::ResponseTemplate::new(200).set_body_json(serde_json::json!({
                    "chunk": [{
                        "type": "m.room.message",
                        "event_id": forged_edit,
                        "room_id": room_id,
                        // Different sender than the original event — an invalid
                        // replacement per the spec.
                        "sender": *BOB,
                        "origin_server_ts": 1_700_000_001_000u64,
                        "content": {
                            "msgtype": "m.text",
                            "body": "* attacker text",
                            "m.new_content": { "msgtype": "m.text", "body": "attacker text" },
                            "m.relates_to": { "rel_type": "m.replace", "event_id": original },
                        },
                    }],
                })),
            )
            .mount(server.server())
            .await;

        let summaries =
            get_pinned_messages_impl(&MatrixState::default(), &client, room_id.as_str())
                .await
                .expect("pinned messages should resolve");

        assert_eq!(summaries.len(), 1);
        assert_eq!(summaries[0].preview, "original body");
    }

    /// Review fix regression test: a same-sender `m.replace` whose own
    /// `m.relates_to.event_id` targets a *different* event must be ignored,
    /// even though the relations request was scoped to the pinned event's
    /// id — nothing guarantees a homeserver/aggregation response actually
    /// honors that scoping, and the reaction scan in `actions.rs`
    /// defensively checks its own relation target for the identical reason.
    #[tokio::test]
    async fn get_pinned_messages_impl_ignores_a_replacement_targeting_a_different_event() {
        use matrix_sdk_test::{JoinedRoomBuilder, ALICE};

        let room_id = matrix_sdk::ruma::room_id!("!room:example.org");
        let server = MatrixMockServer::new().await;
        let client = server.client_builder().build().await;

        server.mock_room_state_encryption().plain().mount().await;
        server.sync_joined_room(&client, room_id).await;

        let original = matrix_sdk::ruma::owned_event_id!("$original");
        let other_event = matrix_sdk::ruma::owned_event_id!("$other-event");
        let mistargeted_edit = matrix_sdk::ruma::owned_event_id!("$mistargeted");
        let factory = matrix_sdk_test::event_factory::EventFactory::new()
            .room(room_id)
            .sender(&ALICE);
        let room_builder = JoinedRoomBuilder::new(room_id)
            .add_state_event(factory.room_pinned_events(vec![original.clone()]));
        server.sync_room(&client, room_builder).await;

        wiremock::Mock::given(wiremock::matchers::method("GET"))
            .and(wiremock::matchers::path(format!(
                "/_matrix/client/v3/rooms/{room_id}/event/{original}"
            )))
            .respond_with(
                wiremock::ResponseTemplate::new(200).set_body_json(serde_json::json!({
                    "type": "m.room.message",
                    "event_id": original,
                    "room_id": room_id,
                    "sender": *ALICE,
                    "origin_server_ts": 1_700_000_000_000u64,
                    "content": { "msgtype": "m.text", "body": "original body" },
                })),
            )
            .mount(server.server())
            .await;

        // Same sender as the original (would otherwise pass that check),
        // but this event's own `m.relates_to.event_id` targets a
        // *different* event entirely — the relations endpoint returned it
        // for `original`'s request anyway, simulating a homeserver/
        // aggregation response that didn't honor the request's scoping.
        wiremock::Mock::given(wiremock::matchers::method("GET"))
            .and(wiremock::matchers::path(format!(
                "/_matrix/client/v1/rooms/{room_id}/relations/{original}/m.replace"
            )))
            .respond_with(
                wiremock::ResponseTemplate::new(200).set_body_json(serde_json::json!({
                    "chunk": [{
                        "type": "m.room.message",
                        "event_id": mistargeted_edit,
                        "room_id": room_id,
                        "sender": *ALICE,
                        "origin_server_ts": 1_700_000_001_000u64,
                        "content": {
                            "msgtype": "m.text",
                            "body": "* unrelated edit",
                            "m.new_content": { "msgtype": "m.text", "body": "unrelated edit" },
                            "m.relates_to": { "rel_type": "m.replace", "event_id": other_event },
                        },
                    }],
                })),
            )
            .mount(server.server())
            .await;

        let summaries =
            get_pinned_messages_impl(&MatrixState::default(), &client, room_id.as_str())
                .await
                .expect("pinned messages should resolve");

        assert_eq!(summaries.len(), 1);
        assert_eq!(
            summaries[0].preview, "original body",
            "a replacement targeting a different event must not be accepted as this event's edit"
        );
    }

    /// Review fix regression test: the original sender's genuinely latest
    /// valid edit can sit past the first page of relations if more than 20
    /// newer invalid (different-sender) replacements were sent after it.
    /// `latest_edit_body` must page forward (`from`/`next_batch_token`)
    /// until it finds a same-sender replacement, instead of giving up after
    /// one page and falling back to the stale/original body.
    #[tokio::test]
    async fn get_pinned_messages_impl_pages_past_invalid_replacements_to_find_the_valid_edit() {
        use matrix_sdk_test::{JoinedRoomBuilder, ALICE, BOB};

        let room_id = matrix_sdk::ruma::room_id!("!room:example.org");
        let server = MatrixMockServer::new().await;
        let client = server.client_builder().build().await;

        server.mock_room_state_encryption().plain().mount().await;
        server.sync_joined_room(&client, room_id).await;

        let original = matrix_sdk::ruma::owned_event_id!("$original");
        let valid_edit = matrix_sdk::ruma::owned_event_id!("$valid-edit");
        let factory = matrix_sdk_test::event_factory::EventFactory::new()
            .room(room_id)
            .sender(&ALICE);
        let room_builder = JoinedRoomBuilder::new(room_id)
            .add_state_event(factory.room_pinned_events(vec![original.clone()]));
        server.sync_room(&client, room_builder).await;

        wiremock::Mock::given(wiremock::matchers::method("GET"))
            .and(wiremock::matchers::path(format!(
                "/_matrix/client/v3/rooms/{room_id}/event/{original}"
            )))
            .respond_with(
                wiremock::ResponseTemplate::new(200).set_body_json(serde_json::json!({
                    "type": "m.room.message",
                    "event_id": original,
                    "room_id": room_id,
                    "sender": *ALICE,
                    "origin_server_ts": 1_700_000_000_000u64,
                    "content": { "msgtype": "m.text", "body": "original body" },
                })),
            )
            .mount(server.server())
            .await;

        // First page: 20 invalid (different-sender) replacements, no
        // `from` query param, with a `next_batch` pointing at page two.
        wiremock::Mock::given(wiremock::matchers::method("GET"))
            .and(wiremock::matchers::path(format!(
                "/_matrix/client/v1/rooms/{room_id}/relations/{original}/m.replace"
            )))
            .and(wiremock::matchers::query_param_is_missing("from"))
            .respond_with(
                wiremock::ResponseTemplate::new(200).set_body_json(serde_json::json!({
                    "chunk": (0..20).map(|i| serde_json::json!({
                        "type": "m.room.message",
                        "event_id": format!("$forged-{i}"),
                        "room_id": room_id,
                        "sender": *BOB,
                        "origin_server_ts": 1_700_000_001_000u64 + i,
                        "content": {
                            "msgtype": "m.text",
                            "body": "* attacker text",
                            "m.new_content": { "msgtype": "m.text", "body": "attacker text" },
                            "m.relates_to": { "rel_type": "m.replace", "event_id": original },
                        },
                    })).collect::<Vec<_>>(),
                    "next_batch": "page2",
                })),
            )
            .mount(server.server())
            .await;

        // Second page: the original sender's genuinely valid edit.
        wiremock::Mock::given(wiremock::matchers::method("GET"))
            .and(wiremock::matchers::path(format!(
                "/_matrix/client/v1/rooms/{room_id}/relations/{original}/m.replace"
            )))
            .and(wiremock::matchers::query_param("from", "page2"))
            .respond_with(
                wiremock::ResponseTemplate::new(200).set_body_json(serde_json::json!({
                    "chunk": [{
                        "type": "m.room.message",
                        "event_id": valid_edit,
                        "room_id": room_id,
                        "sender": *ALICE,
                        "origin_server_ts": 1_700_000_002_000u64,
                        "content": {
                            "msgtype": "m.text",
                            "body": "* valid edit",
                            "m.new_content": { "msgtype": "m.text", "body": "valid edit" },
                            "m.relates_to": { "rel_type": "m.replace", "event_id": original },
                        },
                    }],
                })),
            )
            .mount(server.server())
            .await;

        let summaries =
            get_pinned_messages_impl(&MatrixState::default(), &client, room_id.as_str())
                .await
                .expect("pinned messages should resolve");

        assert_eq!(summaries.len(), 1);
        assert_eq!(summaries[0].preview, "valid edit");
    }

    /// Review fix regression test: a sender whose display name is shared
    /// with another room member must have the MXID appended, matching
    /// `timeline::sender_profile_fields`'s disambiguation convention for the
    /// main timeline — otherwise a member could pick a display name matching
    /// another's to impersonate them in the pinned-messages panel too.
    #[test]
    fn disambiguated_display_name_appends_mxid_only_when_ambiguous() {
        let alice = matrix_sdk::ruma::user_id!("@alice:example.org");
        assert_eq!(disambiguated_display_name("Alex", false, alice), "Alex");
        assert_eq!(
            disambiguated_display_name("Alex", true, alice),
            "Alex (@alice:example.org)"
        );
    }

    #[tokio::test]
    async fn get_pinned_messages_impl_returns_a_placeholder_for_events_that_fail_to_resolve() {
        use matrix_sdk_test::{JoinedRoomBuilder, ALICE};

        let room_id = matrix_sdk::ruma::room_id!("!room:example.org");
        let server = MatrixMockServer::new().await;
        let client = server.client_builder().build().await;

        server.mock_room_state_encryption().plain().mount().await;
        server.sync_joined_room(&client, room_id).await;

        let missing = matrix_sdk::ruma::owned_event_id!("$missing");
        let factory = matrix_sdk_test::event_factory::EventFactory::new()
            .room(room_id)
            .sender(&ALICE);
        let room_builder = JoinedRoomBuilder::new(room_id)
            .add_state_event(factory.room_pinned_events(vec![missing.clone()]));
        server.sync_room(&client, room_builder).await;

        wiremock::Mock::given(wiremock::matchers::method("GET"))
            .and(wiremock::matchers::path(format!(
                "/_matrix/client/v3/rooms/{room_id}/event/{missing}"
            )))
            .respond_with(
                wiremock::ResponseTemplate::new(404).set_body_json(serde_json::json!({
                    "errcode": "M_NOT_FOUND",
                    "error": "Event not found",
                })),
            )
            .mount(server.server())
            .await;

        let summaries =
            get_pinned_messages_impl(&MatrixState::default(), &client, room_id.as_str())
                .await
                .expect("a resolve failure shouldn't fail the whole call");
        // Review fix: an unresolvable pin must still come back as a row
        // (with `is_unresolved: true`) rather than being silently dropped
        // — otherwise a nonzero pinned-event count has no corresponding
        // row (and so no Unpin control) to actually remove it with.
        assert_eq!(
            summaries.len(),
            1,
            "expected a placeholder row for the unresolvable pin, got {summaries:?}"
        );
        assert_eq!(summaries[0].event_id, missing.to_string());
        assert!(summaries[0].is_unresolved);
        assert!(!summaries[0].is_redacted);
        assert!(!summaries[0].is_undecrypted);
    }

    #[tokio::test]
    async fn check_room_alias_available_impl_true_when_unresolved() {
        let server = MatrixMockServer::new().await;
        let client = server.client_builder().build().await;

        server
            .mock_room_directory_resolve_alias()
            .not_found()
            .mock_once()
            .mount()
            .await;

        let available = check_room_alias_available_impl(&client, "#free-alias:example.org")
            .await
            .expect("availability check should succeed");
        assert!(
            available,
            "expected an unresolved alias to be reported available"
        );
    }

    #[tokio::test]
    async fn check_room_alias_available_impl_false_when_resolved() {
        let server = MatrixMockServer::new().await;
        let client = server.client_builder().build().await;

        server
            .mock_room_directory_resolve_alias()
            .ok("!room:example.org", Vec::new())
            .mock_once()
            .mount()
            .await;

        let available = check_room_alias_available_impl(&client, "#taken-alias:example.org")
            .await
            .expect("availability check should succeed");
        assert!(
            !available,
            "expected a resolved alias to be reported unavailable"
        );
    }

    #[tokio::test]
    async fn check_room_alias_available_impl_rejects_a_malformed_alias() {
        let server = MatrixMockServer::new().await;
        let client = server.client_builder().build().await;

        let result = check_room_alias_available_impl(&client, "not-a-valid-alias").await;
        assert!(
            result.is_err(),
            "expected a malformed alias to be rejected before any network call, got {result:?}"
        );
    }

    #[tokio::test]
    async fn add_room_alias_impl_succeeds() {
        let server = MatrixMockServer::new().await;
        let client = server.client_builder().build().await;

        server
            .mock_room_directory_create_room_alias()
            .ok()
            .mock_once()
            .mount()
            .await;

        let result =
            add_room_alias_impl(&client, "!room:example.org", "#new-alias:example.org").await;
        assert!(
            result.is_ok(),
            "expected alias creation to succeed, got {result:?}"
        );
    }

    /// A homeserver rejects `PUT /directory/room/{alias}` with `409
    /// M_ROOM_IN_USE` when the alias is already taken by another room — this
    /// must surface as an error, not be swallowed.
    #[tokio::test]
    async fn add_room_alias_impl_surfaces_an_alias_already_taken_conflict() {
        let server = MatrixMockServer::new().await;
        let client = server.client_builder().build().await;

        wiremock::Mock::given(wiremock::matchers::method("PUT"))
            .and(wiremock::matchers::path_regex(
                r"^/_matrix/client/v3/directory/room/.*",
            ))
            .respond_with(
                wiremock::ResponseTemplate::new(409).set_body_json(serde_json::json!({
                    "errcode": "M_ROOM_IN_USE",
                    "error": "Room alias already taken",
                })),
            )
            .mount(server.server())
            .await;

        let result =
            add_room_alias_impl(&client, "!room:example.org", "#taken-alias:example.org").await;
        assert!(
            result.is_err(),
            "expected an already-taken alias to be rejected, got {result:?}"
        );
    }

    /// A homeserver rejects alias creation with `403 M_FORBIDDEN` when the
    /// user lacks permission to publish aliases in the room directory.
    #[tokio::test]
    async fn add_room_alias_impl_surfaces_insufficient_permission() {
        let server = MatrixMockServer::new().await;
        let client = server.client_builder().build().await;

        wiremock::Mock::given(wiremock::matchers::method("PUT"))
            .and(wiremock::matchers::path_regex(
                r"^/_matrix/client/v3/directory/room/.*",
            ))
            .respond_with(
                wiremock::ResponseTemplate::new(403).set_body_json(serde_json::json!({
                    "errcode": "M_FORBIDDEN",
                    "error": "You don't have permission to create this alias",
                })),
            )
            .mount(server.server())
            .await;

        let result =
            add_room_alias_impl(&client, "!room:example.org", "#no-permission:example.org").await;
        assert!(
            result.is_err(),
            "expected insufficient permission to be rejected, got {result:?}"
        );
    }

    #[tokio::test]
    async fn add_room_alias_impl_rejects_a_malformed_alias() {
        let server = MatrixMockServer::new().await;
        let client = server.client_builder().build().await;

        let result = add_room_alias_impl(&client, "!room:example.org", "not-a-valid-alias").await;
        assert!(
            result.is_err(),
            "expected a malformed alias to be rejected before any network call, got {result:?}"
        );
    }

    #[tokio::test]
    async fn remove_room_alias_impl_succeeds() {
        let server = MatrixMockServer::new().await;
        let client = server.client_builder().build().await;

        server
            .mock_room_directory_remove_room_alias()
            .ok()
            .mock_once()
            .mount()
            .await;

        let result = remove_room_alias_impl(&client, "#existing-alias:example.org").await;
        assert!(
            result.is_ok(),
            "expected alias removal to succeed, got {result:?}"
        );
    }

    #[tokio::test]
    async fn remove_room_alias_impl_surfaces_insufficient_permission() {
        let server = MatrixMockServer::new().await;
        let client = server.client_builder().build().await;

        wiremock::Mock::given(wiremock::matchers::method("DELETE"))
            .and(wiremock::matchers::path_regex(
                r"^/_matrix/client/v3/directory/room/.*",
            ))
            .respond_with(
                wiremock::ResponseTemplate::new(403).set_body_json(serde_json::json!({
                    "errcode": "M_FORBIDDEN",
                    "error": "You don't have permission to remove this alias",
                })),
            )
            .mount(server.server())
            .await;

        let result = remove_room_alias_impl(&client, "#no-permission:example.org").await;
        assert!(
            result.is_err(),
            "expected insufficient permission to be rejected, got {result:?}"
        );
    }

    #[tokio::test]
    async fn set_canonical_alias_impl_sets_the_alias() {
        let room_id = matrix_sdk::ruma::room_id!("!room:example.org");
        let server = MatrixMockServer::new().await;
        let client = server.client_builder().build().await;

        server.mock_room_state_encryption().plain().mount().await;
        server.sync_joined_room(&client, room_id).await;

        let event_id = matrix_sdk::ruma::event_id!("$canonical_alias_event");
        server
            .mock_room_send_state()
            .for_type(StateEventType::RoomCanonicalAlias)
            .ok(event_id)
            .mock_once()
            .mount()
            .await;

        let result =
            set_canonical_alias_impl(&client, room_id.as_str(), Some("#canonical:example.org"))
                .await;
        assert!(
            result.is_ok(),
            "expected canonical alias to be set, got {result:?}"
        );
    }

    #[tokio::test]
    async fn set_canonical_alias_impl_clears_the_alias() {
        let room_id = matrix_sdk::ruma::room_id!("!room:example.org");
        let server = MatrixMockServer::new().await;
        let client = server.client_builder().build().await;

        server.mock_room_state_encryption().plain().mount().await;
        server.sync_joined_room(&client, room_id).await;

        let event_id = matrix_sdk::ruma::event_id!("$canonical_alias_cleared");
        server
            .mock_room_send_state()
            .for_type(StateEventType::RoomCanonicalAlias)
            .ok(event_id)
            .mock_once()
            .mount()
            .await;

        let result = set_canonical_alias_impl(&client, room_id.as_str(), None).await;
        assert!(
            result.is_ok(),
            "expected canonical alias to be cleared, got {result:?}"
        );
    }

    /// A homeserver rejects `m.room.canonical_alias` with `403 M_FORBIDDEN`
    /// when the sender's power level is below `state_default` (or a
    /// per-event override) for that event type.
    #[tokio::test]
    async fn set_canonical_alias_impl_surfaces_insufficient_permission() {
        let room_id = matrix_sdk::ruma::room_id!("!room:example.org");
        let server = MatrixMockServer::new().await;
        let client = server.client_builder().build().await;

        server.mock_room_state_encryption().plain().mount().await;
        server.sync_joined_room(&client, room_id).await;

        wiremock::Mock::given(wiremock::matchers::method("PUT"))
            .and(wiremock::matchers::path_regex(
                r"^/_matrix/client/v3/rooms/.*/state/m\.room\.canonical_alias/.*",
            ))
            .respond_with(
                wiremock::ResponseTemplate::new(403).set_body_json(serde_json::json!({
                    "errcode": "M_FORBIDDEN",
                    "error": "You don't have permission to set the canonical alias",
                })),
            )
            .mount(server.server())
            .await;

        let result =
            set_canonical_alias_impl(&client, room_id.as_str(), Some("#canonical:example.org"))
                .await;
        assert!(
            result.is_err(),
            "expected insufficient permission to be rejected, got {result:?}"
        );
    }

    #[tokio::test]
    async fn set_canonical_alias_impl_rejects_a_malformed_alias() {
        let room_id = matrix_sdk::ruma::room_id!("!room:example.org");
        let server = MatrixMockServer::new().await;
        let client = server.client_builder().build().await;

        server.mock_room_state_encryption().plain().mount().await;
        server.sync_joined_room(&client, room_id).await;

        let result =
            set_canonical_alias_impl(&client, room_id.as_str(), Some("not-a-valid-alias")).await;
        assert!(
            result.is_err(),
            "expected a malformed alias to be rejected before any network call, got {result:?}"
        );
    }

    /// `remove_alt_alias_impl` must strip only the given alias out of
    /// `alt_aliases`, leaving both the canonical `alias` field and any other
    /// `alt_aliases` entries untouched — this is the fix for the frontend's
    /// "removed alias left stale in alt_aliases" bug found by review (see
    /// `RoomAliasManagement.tsx`'s `handleRemoveAlias`).
    #[tokio::test]
    async fn remove_alt_alias_impl_strips_only_the_given_alias() {
        use matrix_sdk_test::event_factory::EventFactory;
        use matrix_sdk_test::{JoinedRoomBuilder, ALICE};

        let room_id = matrix_sdk::ruma::room_id!("!room:example.org");
        let server = MatrixMockServer::new().await;
        let client = server.client_builder().build().await;

        server.mock_room_state_encryption().plain().mount().await;
        server.sync_joined_room(&client, room_id).await;

        let factory = EventFactory::new().room(room_id).sender(&ALICE);
        let canonical = matrix_sdk::ruma::owned_room_alias_id!("#canonical:example.org");
        let alt_to_remove = matrix_sdk::ruma::owned_room_alias_id!("#stale:example.org");
        let alt_to_keep = matrix_sdk::ruma::owned_room_alias_id!("#keep:example.org");
        let room_builder =
            JoinedRoomBuilder::new(room_id).add_state_event(factory.canonical_alias(
                Some(canonical.clone()),
                vec![alt_to_remove.clone(), alt_to_keep.clone()],
            ));
        server.sync_room(&client, room_builder).await;

        // Assert the exact request body sent to the homeserver, not just
        // that *some* canonical_alias PUT succeeded — this is what actually
        // proves `alt_to_remove` is gone while `canonical` and
        // `alt_to_keep` survive untouched.
        wiremock::Mock::given(wiremock::matchers::method("PUT"))
            .and(wiremock::matchers::path_regex(
                r"^/_matrix/client/v3/rooms/.*/state/m\.room\.canonical_alias/.*",
            ))
            .and(wiremock::matchers::body_json(serde_json::json!({
                "alias": canonical,
                "alt_aliases": [alt_to_keep],
            })))
            .respond_with(
                wiremock::ResponseTemplate::new(200).set_body_json(serde_json::json!({
                    "event_id": "$alt_alias_removed",
                })),
            )
            .expect(1)
            .mount(server.server())
            .await;

        let result = remove_alt_alias_impl(&client, room_id.as_str(), alt_to_remove.as_str()).await;
        assert!(
            result.is_ok(),
            "expected the alt alias to be removed, got {result:?}"
        );
    }

    #[tokio::test]
    async fn remove_alt_alias_impl_rejects_a_malformed_alias() {
        let room_id = matrix_sdk::ruma::room_id!("!room:example.org");
        let server = MatrixMockServer::new().await;
        let client = server.client_builder().build().await;

        server.mock_room_state_encryption().plain().mount().await;
        server.sync_joined_room(&client, room_id).await;

        let result = remove_alt_alias_impl(&client, room_id.as_str(), "not-a-valid-alias").await;
        assert!(
            result.is_err(),
            "expected a malformed alias to be rejected before any network call, got {result:?}"
        );
    }

    #[tokio::test]
    async fn leave_room_impl_sends_a_leave_request_for_the_given_room() {
        let room_id = matrix_sdk::ruma::room_id!("!room:example.org");
        let server = MatrixMockServer::new().await;
        let client = server.client_builder().build().await;

        server.mock_room_state_encryption().plain().mount().await;
        server.sync_joined_room(&client, room_id).await;

        wiremock::Mock::given(wiremock::matchers::method("POST"))
            .and(wiremock::matchers::path(format!(
                "/_matrix/client/v3/rooms/{room_id}/leave"
            )))
            .respond_with(wiremock::ResponseTemplate::new(200).set_body_json(serde_json::json!({})))
            .expect(1)
            .mount(server.server())
            .await;

        let result = leave_room_impl(&client, room_id.as_str()).await;
        assert!(
            result.is_ok(),
            "expected the room to be left, got {result:?}"
        );
    }

    #[tokio::test]
    async fn leave_room_impl_errors_for_an_unknown_room() {
        let server = MatrixMockServer::new().await;
        let client = server.client_builder().build().await;

        let result = leave_room_impl(&client, "!not-joined:example.org").await;
        assert!(
            result.is_err(),
            "expected leaving a room the client hasn't synced/joined to error, got {result:?}"
        );
    }
}
