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

fn require_room(client: &Client, room_id: &str) -> Result<Room, String> {
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
}
