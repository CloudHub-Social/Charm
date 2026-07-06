//! Notification settings panel backing: per-room mode, a single default mode,
//! keyword alerts, and a client-local global mute — all `m.push_rules`
//! *rules*, not the push *transport* (a separate spec writes pushers/gateway
//! delivery; see Spec 08's non-goals).
//!
//! Global mute has no native Matrix representation (there's no "muted until"
//! push rule), so it's implemented as client-local state — persisted to a
//! small per-account JSON file rather than `m.push_rules` — that remembers
//! the default mode in effect before muting and temporarily overrides every
//! room's default to `Mute` while active. A device that's offline won't
//! honor this; see Spec 08's "Risks & open questions".

use std::path::PathBuf;

use matrix_sdk::notification_settings::{NotificationSettings, RoomNotificationMode};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager, State};
use ts_rs::TS;

use super::persistence;
use super::MatrixState;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../src/bindings/")]
#[serde(rename_all = "snake_case")]
pub enum RoomNotificationModeKind {
    AllMessages,
    MentionsAndKeywordsOnly,
    Mute,
}

impl From<RoomNotificationMode> for RoomNotificationModeKind {
    fn from(mode: RoomNotificationMode) -> Self {
        match mode {
            RoomNotificationMode::AllMessages => Self::AllMessages,
            RoomNotificationMode::MentionsAndKeywordsOnly => Self::MentionsAndKeywordsOnly,
            RoomNotificationMode::Mute => Self::Mute,
        }
    }
}

impl From<RoomNotificationModeKind> for RoomNotificationMode {
    fn from(mode: RoomNotificationModeKind) -> Self {
        match mode {
            RoomNotificationModeKind::AllMessages => Self::AllMessages,
            RoomNotificationModeKind::MentionsAndKeywordsOnly => Self::MentionsAndKeywordsOnly,
            RoomNotificationModeKind::Mute => Self::Mute,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../src/bindings/")]
pub struct NotificationSettingsSummary {
    pub default_mode: RoomNotificationModeKind,
    pub keywords: Vec<String>,
    pub global_mute: bool,
    pub sound_enabled: bool,
}

/// The four (is_encrypted, is_one_to_one) combinations `NotificationSettings`
/// tracks separate default-mode push rules for. The settings UI exposes a
/// single "default mode" control (a Day-1 simplification), so reads/writes
/// fan out across all four here instead of the frontend juggling four
/// separate defaults.
const DEFAULT_MODE_DIMENSIONS: [(bool, bool); 4] =
    [(false, false), (false, true), (true, false), (true, true)];

/// Client-local notification preferences with no `m.push_rules`
/// representation — see this module's doc comment. Kept separate from
/// `persistence.rs` (session/keychain data) since this is plain-JSON,
/// non-secret UI preference, not session material.
#[derive(Debug, Clone, Serialize, Deserialize)]
struct LocalNotificationPrefs {
    /// The default mode to restore when global mute is turned back off —
    /// `None` whenever mute isn't active.
    muted_from_mode: Option<RoomNotificationModeKind>,
    /// Every room with a user-defined push-rule override (from
    /// `set_room_notification_mode`) at the moment global mute was turned
    /// on, keyed by room id, so it can be restored verbatim on unmute — see
    /// `set_global_mute`'s doc comment for why overriding the default alone
    /// isn't enough.
    #[serde(default)]
    muted_room_overrides: std::collections::HashMap<String, RoomNotificationModeKind>,
    sound_enabled: bool,
}

impl Default for LocalNotificationPrefs {
    fn default() -> Self {
        Self {
            muted_from_mode: None,
            muted_room_overrides: std::collections::HashMap::new(),
            sound_enabled: true,
        }
    }
}

fn prefs_path(app: &AppHandle, account_key: &str) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?
        .join("notification_prefs");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir.join(format!("{account_key}.json")))
}

fn load_prefs(app: &AppHandle, account_key: &str) -> Result<LocalNotificationPrefs, String> {
    let path = prefs_path(app, account_key)?;
    match std::fs::read_to_string(&path) {
        Ok(json) => serde_json::from_str(&json).map_err(|e| e.to_string()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(LocalNotificationPrefs::default()),
        Err(e) => Err(e.to_string()),
    }
}

fn save_prefs(
    app: &AppHandle,
    account_key: &str,
    prefs: &LocalNotificationPrefs,
) -> Result<(), String> {
    let path = prefs_path(app, account_key)?;
    let json = serde_json::to_string(prefs).map_err(|e| e.to_string())?;
    std::fs::write(path, json).map_err(|e| e.to_string())
}

async fn apply_default_mode(
    settings: &NotificationSettings,
    mode: RoomNotificationMode,
) -> Result<(), String> {
    for (is_encrypted, is_one_to_one) in DEFAULT_MODE_DIMENSIONS {
        settings
            .set_default_room_notification_mode(is_encrypted.into(), is_one_to_one.into(), mode)
            .await
            .map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// Snapshots every room with a user-defined push-rule override and forces
/// each one to `Mute`. A room-level override (set via
/// `set_room_notification_mode`) always takes precedence over the default
/// rules `apply_default_mode` changes, so without this, a room the user had
/// explicitly set to e.g. `AllMessages` would keep notifying right through
/// "Mute all rooms" being shown as active.
async fn mute_room_overrides(
    settings: &NotificationSettings,
) -> Result<std::collections::HashMap<String, RoomNotificationModeKind>, String> {
    let room_ids = settings.get_rooms_with_user_defined_rules(None).await;
    let mut snapshot = std::collections::HashMap::new();
    for room_id_str in room_ids {
        let Ok(room_id) = matrix_sdk::ruma::RoomId::parse(&room_id_str) else {
            continue;
        };
        let Some(mode) = settings
            .get_user_defined_room_notification_mode(&room_id)
            .await
        else {
            continue;
        };
        settings
            .set_room_notification_mode(&room_id, RoomNotificationMode::Mute)
            .await
            .map_err(|e| e.to_string())?;
        snapshot.insert(room_id_str, mode.into());
    }
    Ok(snapshot)
}

/// Restores every room-level override captured by `mute_room_overrides`.
async fn restore_room_overrides(
    settings: &NotificationSettings,
    overrides: &std::collections::HashMap<String, RoomNotificationModeKind>,
) -> Result<(), String> {
    for (room_id_str, mode) in overrides {
        let Ok(room_id) = matrix_sdk::ruma::RoomId::parse(room_id_str) else {
            continue;
        };
        settings
            .set_room_notification_mode(&room_id, (*mode).into())
            .await
            .map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// Serializes the load-mutate-save cycle across every command below that
/// touches `LocalNotificationPrefs` — without this, two concurrent commands
/// (e.g. toggling global mute and the sound preference in quick succession)
/// could each load a stale copy and the last write clobbers the other's
/// change. Not a hot path, so a single process-wide lock (rather than
/// per-account) is the simplest correct fix — same rationale/shape as
/// `persistence::RELOCATE_LOCK`.
static PREFS_LOCK: std::sync::LazyLock<tokio::sync::Mutex<()>> =
    std::sync::LazyLock::new(|| tokio::sync::Mutex::new(()));

#[tauri::command]
pub async fn get_notification_settings(
    app: AppHandle,
    state: State<'_, MatrixState>,
) -> Result<NotificationSettingsSummary, String> {
    let client = state.require_client().await?;
    let user_id = client
        .user_id()
        .ok_or_else(|| "not logged in".to_string())?
        .to_owned();
    let account_key = persistence::account_key(user_id.as_str());
    let prefs = load_prefs(&app, &account_key)?;

    let settings = client.notification_settings().await;
    // Representative default: Day-1 applies one mode across all four
    // dimensions anyway (see `apply_default_mode`), so any one of them
    // reflects the effective default when not muted.
    let current_default = settings
        .get_default_room_notification_mode(false.into(), false.into())
        .await;
    // While muted, the mode a user would see/expect back is the remembered
    // pre-mute mode, not the transient `Mute` override currently in effect.
    let default_mode = prefs
        .muted_from_mode
        .unwrap_or_else(|| current_default.into());
    let keywords = settings.enabled_keywords().await.into_iter().collect();

    Ok(NotificationSettingsSummary {
        default_mode,
        keywords,
        global_mute: prefs.muted_from_mode.is_some(),
        sound_enabled: prefs.sound_enabled,
    })
}

/// While global mute is active, this only updates *what to restore* when the
/// user unmutes — it deliberately leaves the live push rules at `Mute`
/// rather than silently unmuting every room out from under an active "Mute
/// all rooms" toggle (see Spec 08 review: changing the default while muted
/// used to desync the `global_mute` flag from the actual server state).
#[tauri::command]
pub async fn set_default_notification_mode(
    app: AppHandle,
    state: State<'_, MatrixState>,
    mode: RoomNotificationModeKind,
) -> Result<(), String> {
    let client = state.require_client().await?;
    let user_id = client
        .user_id()
        .ok_or_else(|| "not logged in".to_string())?
        .to_owned();
    let account_key = persistence::account_key(user_id.as_str());
    let _guard = PREFS_LOCK.lock().await;
    let mut prefs = load_prefs(&app, &account_key)?;

    if prefs.muted_from_mode.is_some() {
        prefs.muted_from_mode = Some(mode);
    } else {
        apply_default_mode(&client.notification_settings().await, mode.into()).await?;
    }

    save_prefs(&app, &account_key, &prefs)
}

#[tauri::command]
pub async fn set_room_notification_mode(
    state: State<'_, MatrixState>,
    room_id: String,
    mode: RoomNotificationModeKind,
) -> Result<(), String> {
    let client = state.require_client().await?;
    let parsed_room_id = matrix_sdk::ruma::RoomId::parse(&room_id).map_err(|e| e.to_string())?;
    client
        .notification_settings()
        .await
        .set_room_notification_mode(&parsed_room_id, mode.into())
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn add_notification_keyword(
    state: State<'_, MatrixState>,
    keyword: String,
) -> Result<(), String> {
    let client = state.require_client().await?;
    client
        .notification_settings()
        .await
        .add_keyword(keyword)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn remove_notification_keyword(
    state: State<'_, MatrixState>,
    keyword: String,
) -> Result<(), String> {
    let client = state.require_client().await?;
    client
        .notification_settings()
        .await
        .remove_keyword(&keyword)
        .await
        .map_err(|e| e.to_string())
}

/// Turning mute on remembers the current default mode and every room-level
/// override in effect (if not already remembered — a second `muted(true)`
/// call is a no-op on that front, otherwise it would clobber the real
/// pre-mute snapshot with "everything reads Mute now"), then overrides every
/// room's default *and* every room-level override to `Mute`; turning it off
/// restores whatever was remembered for both. Room-level overrides need
/// their own snapshot/override pass — separate from the four default rules
/// `apply_default_mode` touches — because a room-level override always
/// takes precedence over the default, so a room the user had explicitly set
/// to e.g. `AllMessages` would otherwise keep notifying right through "Mute
/// all rooms" being shown as active. See this module's doc comment for why
/// this is client-local rather than a push rule.
#[tauri::command]
pub async fn set_global_mute(
    app: AppHandle,
    state: State<'_, MatrixState>,
    muted: bool,
) -> Result<(), String> {
    let client = state.require_client().await?;
    let user_id = client
        .user_id()
        .ok_or_else(|| "not logged in".to_string())?
        .to_owned();
    let account_key = persistence::account_key(user_id.as_str());
    let _guard = PREFS_LOCK.lock().await;
    let mut prefs = load_prefs(&app, &account_key)?;
    let settings = client.notification_settings().await;

    // `prefs` is only mutated *after* the fallible push-rule call below
    // succeeds — mutating first (the old code did `.take()` up front) would
    // leave the in-memory copy showing "restored"/"remembered" even though
    // the server-side change that was supposed to match it never landed.
    if muted {
        if prefs.muted_from_mode.is_none() {
            let current = settings
                .get_default_room_notification_mode(false.into(), false.into())
                .await;
            prefs.muted_room_overrides = mute_room_overrides(&settings).await?;
            prefs.muted_from_mode = Some(current.into());
        }
        apply_default_mode(&settings, RoomNotificationMode::Mute).await?;
    } else if let Some(restore_mode) = prefs.muted_from_mode {
        restore_room_overrides(&settings, &prefs.muted_room_overrides).await?;
        apply_default_mode(&settings, restore_mode.into()).await?;
        prefs.muted_from_mode = None;
        prefs.muted_room_overrides.clear();
    }

    save_prefs(&app, &account_key, &prefs)
}

/// Sound playback is Day-2 (depends on the push-transport spec) — this only
/// persists the user's preference for when that lands.
#[tauri::command]
pub async fn set_sound_enabled(
    app: AppHandle,
    state: State<'_, MatrixState>,
    enabled: bool,
) -> Result<(), String> {
    let client = state.require_client().await?;
    let user_id = client
        .user_id()
        .ok_or_else(|| "not logged in".to_string())?
        .to_owned();
    let account_key = persistence::account_key(user_id.as_str());
    let _guard = PREFS_LOCK.lock().await;
    let mut prefs = load_prefs(&app, &account_key)?;
    prefs.sound_enabled = enabled;
    save_prefs(&app, &account_key, &prefs)
}
