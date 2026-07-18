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

/// Snapshots the current client together with the account key derived from
/// *that same client* — a single, consistent pairing.
///
/// Review fix: `set_privacy_settings` used to call `account_key_for` (which
/// internally resolves its own client) up front, then separately call
/// `state.require_client()` again after the locked load/save/transition
/// calculation to push the presence change. If the user logged out and a
/// different account logged in during that window (awaiting the
/// `PRIVACY_PREFS_LOCK` and doing disk I/O), the second `require_client()`
/// call could return account B's client while `account_key`/`settings` still
/// referred to account A — silently applying account A's appear-offline
/// toggle to account B's presence. Resolving the client once and deriving
/// the account key from it means the whole command operates on one
/// consistent user/client pairing throughout.
async fn client_and_account_key_for(
    state: &State<'_, MatrixState>,
) -> Result<(matrix_sdk::Client, String), String> {
    let client = state.require_client().await?;
    let user_id = client
        .user_id()
        .ok_or_else(|| "not logged in".to_string())?
        .to_owned();
    let account_key = super::persistence::account_key(user_id.as_str());
    Ok((client, account_key))
}

/// Best-effort helper other command modules (`ephemeral.rs`, `sync.rs`) use
/// to check current privacy settings before deciding whether to suppress an
/// outgoing receipt/typing event or apply appear-offline presence. Falls
/// back to all-off defaults (never suppress) if the account key can't be
/// resolved or the file can't be read, so a transient read error never
/// silently blocks message-read/typing UX.
///
/// Review fix: this used to return whatever was persisted regardless of
/// whether `presence_privacy_controls` is currently enabled — if a rollout
/// is killed (or a local override cleared) after a user had already turned
/// on `hide_read_receipts`/`hide_typing`/`appear_offline`, enforcement would
/// keep silently suppressing/forcing based on a setting the Settings UI no
/// longer exposes at all, with no way for the user to see or undo it. All
/// callers go through this one function, so gating it here once covers
/// every enforcement site uniformly rather than needing the flag check
/// duplicated at each call site.
pub async fn current_settings(app: &AppHandle, state: &State<'_, MatrixState>) -> PrivacySettings {
    let Ok(client) = state.require_client().await else {
        return PrivacySettings::default();
    };
    current_settings_for_client(app, &client).await
}

/// Same as [`current_settings`], but derives the account key from an
/// already-resolved `Client` instead of re-resolving one from `state`.
///
/// Review fix (P1): `ephemeral.rs`'s `send_read_receipt`/`send_typing`/
/// `mark_room_read` each used to call `current_settings(&app, &state)` (which
/// internally re-resolves the account via `state.require_client()`) and
/// *then* separately call `state.require_client()` again to actually send.
/// A logout/login landing in that window meant the privacy check ran against
/// one account while the send used another — e.g. reading account A's
/// `hide_read_receipts`/`hide_typing` but sending on account B's client,
/// leaking a receipt/typing notice account B never agreed to hide (or
/// suppressing one account B *did* want sent). Callers now resolve the
/// client once and pass it here, so the settings lookup and the send that
/// follows always agree on the same client/account.
pub async fn current_settings_for_client(
    app: &AppHandle,
    client: &matrix_sdk::Client,
) -> PrivacySettings {
    let flag_enabled = app.path().app_data_dir().is_ok_and(|dir| {
        crate::feature_flags::flag(
            &dir,
            crate::feature_flags::FeatureFlagKey::PresencePrivacyControls,
        )
    });
    if !flag_enabled {
        return PrivacySettings::default();
    }
    let Some(user_id) = client.user_id() else {
        return PrivacySettings::default();
    };
    let account_key = super::persistence::account_key(user_id.as_str());
    // Review fix: `set_privacy_settings` holds `PRIVACY_PREFS_LOCK` while it
    // rewrites the settings file with `std::fs::write` — not an atomic
    // replace, so a read landing mid-write could see a truncated or
    // partial file. Any read/parse error here falls back to all-off
    // defaults (fail-*open*, so a transient error never blocks message-
    // read/typing UX) — but that means a read racing an in-progress save
    // would momentarily un-suppress hide_read_receipts/hide_typing/
    // appear_offline right as the user turned them *on*, sending exactly
    // the public receipt/typing notice they'd just asked to hide. Taking
    // the same lock here serializes reads with writes, so a read can never
    // observe a half-written file in the first place.
    let _guard = PRIVACY_PREFS_LOCK.lock().await;
    load_settings(app, &account_key).unwrap_or_default()
}

/// Review fix (LOW): reads through the same `presence_privacy_controls`
/// flag check `current_settings`/`current_settings_for_client` enforce
/// with, instead of returning whatever's persisted on disk unconditionally.
/// Without this, a rollout kill (or a local override cleared) after a user
/// had already turned on e.g. `hide_typing` left the Settings UI showing
/// that toggle on — reading straight from the file — while every
/// enforcement site had already reverted to defaults, a UI/enforcement
/// mismatch the user has no way to see or reconcile from the panel itself.
#[tauri::command]
pub async fn get_privacy_settings(
    app: AppHandle,
    state: State<'_, MatrixState>,
) -> Result<PrivacySettings, String> {
    let flag_enabled = app.path().app_data_dir().is_ok_and(|dir| {
        crate::feature_flags::flag(
            &dir,
            crate::feature_flags::FeatureFlagKey::PresencePrivacyControls,
        )
    });
    if !flag_enabled {
        return Ok(PrivacySettings::default());
    }
    let account_key = account_key_for(&state).await?;
    let _guard = PRIVACY_PREFS_LOCK.lock().await;
    load_settings(&app, &account_key)
}

/// Persists the full settings snapshot and, if `appear_offline` actually
/// *changed*, applies that transition immediately by calling the same
/// `set_presence_impl` the existing `set_presence` command uses (Spec 40's
/// data-flow: "wire existing setPresence to UI, no new command needed for
/// that one" — this reuses it rather than duplicating presence-setting
/// logic).
///
/// Review fix: this used to unconditionally force presence to `Online`
/// whenever `appear_offline` was `false` in the incoming snapshot — so
/// toggling an *unrelated* setting (e.g. `hide_typing`) while
/// `appear_offline` was already off would still fire, clobbering an idle
/// user's `unavailable` status back to `Online` for no reason the user
/// asked for. Now presence is only touched on an actual appear-offline
/// transition: turning it on forces `Offline`; turning it *off* (previously
/// on) restores `Online` (the auto-idle timer, if active, will re-apply
/// `unavailable` on its own next tick if the user is still away — this just
/// undoes the explicit hide, it doesn't need to also re-derive idle state).
/// Toggling any other field leaves presence untouched entirely.
/// Decides whether an `appear_offline` transition between two settings
/// snapshots requires an explicit presence push, and if so, which state to
/// push. Pulled out of [`set_privacy_settings`] as a pure function so the
/// "only touch presence on an actual transition" logic (the review fix
/// described on that command) is unit-testable without a live `Client`.
fn appear_offline_transition(
    previous: &PrivacySettings,
    settings: &PrivacySettings,
) -> Option<PresenceStateDto> {
    if settings.appear_offline == previous.appear_offline {
        return None;
    }
    Some(if settings.appear_offline {
        PresenceStateDto::Offline
    } else {
        PresenceStateDto::Online
    })
}

#[tauri::command]
pub async fn set_privacy_settings(
    app: AppHandle,
    state: State<'_, MatrixState>,
    settings: PrivacySettings,
) -> Result<(), String> {
    let (client, account_key) = client_and_account_key_for(&state).await?;
    // Review fix (P2): the lock previously stayed held through the
    // best-effort presence push below too — while held, every other
    // `PRIVACY_PREFS_LOCK` caller (`current_settings`, read by
    // `send_read_receipt`/`send_typing`/`set_presence` on their own hot
    // paths) blocks behind that same network request. A slow/hanging
    // presence endpoint would then stall ordinary message actions, not
    // just this command. Scoped so the lock only covers the local
    // load/save/transition-calculation, and is released before any
    // Matrix I/O.
    let previous = {
        let _guard = PRIVACY_PREFS_LOCK.lock().await;
        let previous = load_settings(&app, &account_key)?;
        save_settings(&app, &account_key, &settings)?;
        previous
    };

    if let Some(presence) = appear_offline_transition(&previous, &settings) {
        // Review fix: reuse the client snapshotted above (paired with the
        // same `account_key` used for the load/save) instead of re-resolving
        // `state.require_client()` here — see `client_and_account_key_for`.
        // Review fix (P2): re-checked against the *currently* active
        // client's user id, immediately before writing — the snapshotted
        // `client` only proves this call's own Matrix request stays scoped
        // to the old account; it says nothing about whether logout/
        // account-switch has *already* installed a different client on
        // `state` by the time we get here (the local load/save above can
        // take a while under lock contention). `MatrixState.sync_presence`
        // is a single, process-wide cache — account B's sync loop would
        // otherwise inherit account A's stale appear-offline decision
        // (`Offline`) until some unrelated later presence write happened to
        // overwrite it. Comparing user ids is enough: matrix-sdk `Client`
        // itself has no cheap identity-equality, and a same-process
        // account switch always changes the active user id.
        //
        // Not covered by an automated test: this module's existing tests
        // (below) exercise `appear_offline_transition` as a pure function
        // against fixed `PrivacySettings` values, with no mocked `Client`/
        // `MatrixState` harness for `set_privacy_settings` itself. Simulating
        // an account switch landing on `state` mid-call would need such a
        // harness to swap the active client between two fake logged-in
        // accounts while this function is paused mid-execution, which
        // doesn't exist yet — verified by code review instead, consistent
        // with this session's other unrepeatable-race findings.
        let still_same_account = state
            .require_client()
            .await
            .ok()
            .and_then(|current| current.user_id().map(|id| id.to_owned()))
            == client.user_id().map(|id| id.to_owned());
        if still_same_account {
            // Review fix: `sync_presence` used to only get updated when this
            // one-shot push actually succeeded — a transient failure (network
            // blip, homeserver hiccup) left it holding the *previous* value, so
            // every later successful `sync_once` in the steady-state loop kept
            // resending that stale presence indefinitely, with the persisted
            // setting and the UI both already showing the new (unapplied)
            // state. Updating it unconditionally, before attempting the
            // best-effort immediate push, means a failed push here still gets
            // picked up and retried by the sync loop's own next iteration
            // instead of silently sticking forever.
            *state
                .sync_presence
                .lock()
                .unwrap_or_else(|e| e.into_inner()) = presence;
            // Best-effort: a homeserver that disables presence shouldn't block
            // saving the rest of the privacy preferences, and the update above
            // means a failure here isn't the last word on this transition.
            let _ = set_presence_impl(&client, presence, None).await;
        }
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

    #[test]
    fn appear_offline_transition_forces_offline_when_turned_on() {
        let previous = PrivacySettings::default();
        let settings = PrivacySettings {
            appear_offline: true,
            ..previous
        };
        assert_eq!(
            appear_offline_transition(&previous, &settings),
            Some(PresenceStateDto::Offline)
        );
    }

    #[test]
    fn appear_offline_transition_restores_online_when_turned_off() {
        let previous = PrivacySettings {
            appear_offline: true,
            ..PrivacySettings::default()
        };
        let settings = PrivacySettings {
            appear_offline: false,
            ..previous
        };
        assert_eq!(
            appear_offline_transition(&previous, &settings),
            Some(PresenceStateDto::Online)
        );
    }

    /// Review fix regression test: an unrelated field changing (e.g.
    /// `hide_typing`) while `appear_offline` stays the same must never touch
    /// presence — that's exactly the bug where toggling any privacy setting
    /// clobbered an idle user's `unavailable` status back to online.
    #[test]
    fn appear_offline_transition_is_none_when_only_an_unrelated_field_changes() {
        let previous = PrivacySettings::default();
        let settings = PrivacySettings {
            hide_typing: true,
            ..previous
        };
        assert_eq!(appear_offline_transition(&previous, &settings), None);

        let previous_offline = PrivacySettings {
            appear_offline: true,
            ..PrivacySettings::default()
        };
        let settings_offline_and_hide_typing = PrivacySettings {
            hide_typing: true,
            ..previous_offline
        };
        assert_eq!(
            appear_offline_transition(&previous_offline, &settings_offline_and_hide_typing),
            None
        );
    }

    #[test]
    fn appear_offline_transition_is_none_when_settings_are_identical() {
        let settings = PrivacySettings {
            appear_offline: true,
            hide_read_receipts: true,
            hide_typing: true,
            idle_timeout_minutes: Some(15),
        };
        assert_eq!(appear_offline_transition(&settings, &settings), None);
    }
}
