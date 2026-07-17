//! Presence and receipt privacy controls (Spec 40), behind the
//! `presence_privacy_controls` feature flag.
//!
//! Mirrors `notifications.rs`'s client-local-preferences shape: these
//! toggles have no `m.push_rules`/account-data representation of their own,
//! so they're persisted to a small per-account JSON file (same
//! `app_data_dir()` convention, same `PREFS_LOCK`-style serialization to
//! avoid a lost-update race between two near-simultaneous toggles) rather
//! than living in `persistence.rs` (session/keychain material).
//!
//! Enforcement lives here, not just in the frontend: `send_read_receipt` and
//! `send_typing` (in `ephemeral.rs`) load these settings and suppress the
//! outgoing event server-side, so a stale/buggy frontend caller can't
//! accidentally leak a receipt or typing notice the user asked to hide.

use std::path::PathBuf;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager, State};
use ts_rs::TS;

use super::presence::{set_presence_impl, PresenceStateDto};
use super::MatrixState;

/// Client-local privacy preferences. `idle_timeout_minutes: None` means
/// auto-idle is disabled; the frontend idle timer (Spec 40 item 4) reads
/// this to know whether/when to flip presence to `unavailable`.
#[derive(Debug, Clone, Copy, Default, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../src/bindings/")]
pub struct PrivacySettings {
    /// When `true`, don't send `m.read`/`m.read.private` receipts (the
    /// `m.fully_read` marker — a private, per-user pointer never shown to
    /// others — is still sent so local "jump to unread" tracking keeps
    /// working).
    pub hide_read_receipts: bool,
    /// When `true`, don't send `m.typing` notices from the composer.
    pub hide_typing: bool,
    /// "Appear offline": force presence to `offline` regardless of what the
    /// sync loop or auto-idle timer would otherwise set.
    pub appear_offline: bool,
    /// Minutes of inactivity before the frontend idle timer sets presence to
    /// `unavailable`. `None` disables auto-idle.
    pub idle_timeout_minutes: Option<u32>,
}

fn settings_path(app: &AppHandle, account_key: &str) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?
        .join("privacy_settings");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir.join(format!("{account_key}.json")))
}

fn load_settings(app: &AppHandle, account_key: &str) -> Result<PrivacySettings, String> {
    let path = settings_path(app, account_key)?;
    match std::fs::read_to_string(&path) {
        Ok(json) => serde_json::from_str(&json).map_err(|e| e.to_string()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(PrivacySettings::default()),
        Err(e) => Err(e.to_string()),
    }
}

fn save_settings(
    app: &AppHandle,
    account_key: &str,
    settings: &PrivacySettings,
) -> Result<(), String> {
    let path = settings_path(app, account_key)?;
    let json = serde_json::to_string(settings).map_err(|e| e.to_string())?;
    std::fs::write(path, json).map_err(|e| e.to_string())
}

/// Serializes the load-mutate-save cycle, same rationale as
/// `notifications::PREFS_LOCK`.
static PRIVACY_PREFS_LOCK: std::sync::LazyLock<tokio::sync::Mutex<()>> =
    std::sync::LazyLock::new(|| tokio::sync::Mutex::new(()));

async fn account_key_for(state: &State<'_, MatrixState>) -> Result<String, String> {
    let client = state.require_client().await?;
    let user_id = client
        .user_id()
        .ok_or_else(|| "not logged in".to_string())?
        .to_owned();
    Ok(super::persistence::account_key(user_id.as_str()))
}

/// Best-effort helper other command modules (`ephemeral.rs`) use to check
/// current privacy settings before deciding whether to suppress an outgoing
/// receipt/typing event. Falls back to all-off defaults (never suppress) if
/// the account key can't be resolved or the file can't be read, so a
/// transient read error never silently blocks message-read/typing UX.
pub async fn current_settings(app: &AppHandle, state: &State<'_, MatrixState>) -> PrivacySettings {
    let Ok(account_key) = account_key_for(state).await else {
        return PrivacySettings::default();
    };
    load_settings(app, &account_key).unwrap_or_default()
}

#[tauri::command]
pub async fn get_privacy_settings(
    app: AppHandle,
    state: State<'_, MatrixState>,
) -> Result<PrivacySettings, String> {
    let account_key = account_key_for(&state).await?;
    let _guard = PRIVACY_PREFS_LOCK.lock().await;
    load_settings(&app, &account_key)
}

/// Persists the full settings snapshot and, if `appear_offline` changed,
/// applies it immediately by calling the same `set_presence_impl` the
/// existing `set_presence` command uses (Spec 40's data-flow: "wire existing
/// setPresence to UI, no new command needed for that one" — this reuses it
/// rather than duplicating presence-setting logic).
#[tauri::command]
pub async fn set_privacy_settings(
    app: AppHandle,
    state: State<'_, MatrixState>,
    settings: PrivacySettings,
) -> Result<(), String> {
    let account_key = account_key_for(&state).await?;
    let _guard = PRIVACY_PREFS_LOCK.lock().await;
    save_settings(&app, &account_key, &settings)?;

    let client = state.require_client().await?;
    let presence = if settings.appear_offline {
        PresenceStateDto::Offline
    } else {
        PresenceStateDto::Online
    };
    // Best-effort: a homeserver that disables presence shouldn't block
    // saving the rest of the privacy preferences.
    if set_presence_impl(&client, presence, None).await.is_ok() {
        *state
            .sync_presence
            .lock()
            .unwrap_or_else(|e| e.into_inner()) = presence;
    }

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn defaults_never_suppress_anything() {
        let settings = PrivacySettings::default();
        assert!(!settings.hide_read_receipts);
        assert!(!settings.hide_typing);
        assert!(!settings.appear_offline);
        assert_eq!(settings.idle_timeout_minutes, None);
    }

    #[test]
    fn round_trips_through_json() {
        let settings = PrivacySettings {
            hide_read_receipts: true,
            hide_typing: true,
            appear_offline: true,
            idle_timeout_minutes: Some(10),
        };
        let json = serde_json::to_string(&settings).unwrap();
        let parsed: PrivacySettings = serde_json::from_str(&json).unwrap();
        assert!(parsed.hide_read_receipts);
        assert!(parsed.hide_typing);
        assert!(parsed.appear_offline);
        assert_eq!(parsed.idle_timeout_minutes, Some(10));
    }
}
