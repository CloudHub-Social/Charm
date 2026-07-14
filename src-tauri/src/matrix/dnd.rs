//! Focus mode / Do Not Disturb (Charm 2.0 Spec 30).
//!
//! Rust owns the DND state as the single source of truth: it is both the
//! enforcement point for local (`shell::maybe_send_notification`) and
//! push-decrypted (`push::handle_push`) notification dispatch, *and* the
//! tray menu (Spec 10) needs to read/write it without going through the
//! frontend at all. Making Rust the sole writer of `focus.json` — rather
//! than mirroring `appearance.json`'s frontend-owned
//! `tauri-plugin-store`-via-JS pattern (Spec 09/27) — avoids two writers
//! (tray + Settings panel) racing on the same file, while still using the
//! same on-disk mechanism (a `tauri-plugin-store`-compatible JSON file in
//! the app data dir) `appearance.json`/`feature-flags.json` use, per the
//! "match it exactly, don't invent a new persistence layer" instruction:
//! same storage location and envelope shape, single writer instead of two.
//!
//! `DndState::is_active` auto-clears an expired `until` lazily on read
//! (`effective`/`is_dnd_active`) rather than via a background timer — every
//! read site already has to check `enabled` anyway, and a wall-clock compare
//! is cheap enough to redo on every notification dispatch and every Settings
//! panel poll.

use serde::{Deserialize, Serialize};
use std::path::Path;
use tauri::{AppHandle, Emitter, Manager};
use ts_rs::TS;

use super::MatrixState;

const STORE_FILENAME: &str = "focus.json";
const STORE_KEY: &str = "focus";

/// Do Not Disturb state: whether it's on, and (if timed) when it ends.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../src/bindings/")]
#[serde(rename_all = "camelCase")]
pub struct DndState {
    pub enabled: bool,
    /// Epoch ms the DND period ends, or `None` for indefinite ("until I turn
    /// it off"). Ignored when `enabled` is `false`.
    #[ts(type = "number | null")]
    pub until: Option<i64>,
}

impl DndState {
    /// Whether DND is actually in effect at `now_ms`, auto-clearing an
    /// expired timed period rather than trusting a stale `enabled: true`.
    pub fn is_active(&self, now_ms: i64) -> bool {
        if !self.enabled {
            return false;
        }
        match self.until {
            Some(until) => now_ms <= until,
            None => true,
        }
    }
}

pub fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

/// Reads `focus.json` at `dir`, tolerant of a missing/corrupt file (returns
/// the off default) and of either the plugin-store envelope
/// (`{ focus: { state, updatedAt } }`) or a bare `{ state }` shape — same
/// tolerance policy as `feature_flags::read_overrides`.
fn read_persisted_at(dir: &Path) -> DndState {
    let path = dir.join(STORE_FILENAME);
    let Ok(raw) = std::fs::read_to_string(path) else {
        return DndState::default();
    };
    let Ok(value) = serde_json::from_str::<serde_json::Value>(&raw) else {
        return DndState::default();
    };
    let state = value
        .get(STORE_KEY)
        .and_then(|envelope| envelope.get("state"))
        .or_else(|| value.get("state"));
    state
        .and_then(|s| serde_json::from_value::<DndState>(s.clone()).ok())
        .unwrap_or_default()
}

fn write_persisted_at(dir: &Path, state: DndState) {
    let envelope = serde_json::json!({ STORE_KEY: { "state": state, "updatedAt": now_ms() } });
    if std::fs::create_dir_all(dir).is_err() {
        return;
    }
    let _ = std::fs::write(dir.join(STORE_FILENAME), envelope.to_string());
}

/// Whether DND is active right now, purely from an on-disk `focus.json` at
/// `store_root`'s *parent* directory — used by the Android headless push
/// path (`push::handle_headless_push`), which runs with no live
/// `AppHandle`/`MatrixState` to consult.
///
/// `focus.json` lives directly under the app data dir (see `init`/`apply`
/// above), not under `store_root` itself: `store_root` is always
/// `<app_data_dir>/matrix_store` (`persistence::matrix_store_root_at`), so
/// this walks up one level to find it. Falls back to treating DND as
/// inactive if `store_root` unexpectedly has no parent (would only happen
/// for a root path, which `matrix_store_root_at` never produces).
pub fn is_active_at(store_root: &Path) -> bool {
    let Some(app_data_dir) = store_root.parent() else {
        return false;
    };
    if !read_persisted_at(app_data_dir).is_active(now_ms()) {
        return false;
    }
    // Spec 30 review fix: enforcement is gated on `focus_mode` too, not just
    // the persisted state. Without this, a user who enabled indefinite DND
    // while the flag was on, then had it rolled back off, would have no
    // in-app way to turn DND back off (the Settings entry and tray submenu
    // are both flag-gated too, per `FocusPanel`/`setup_tray_and_menu`) —
    // notifications would stay silently suppressed until someone hand-edited
    // `focus.json` or re-enabled the flag. Tying enforcement to the same
    // flag means disabling it is itself the off-ramp: suppression stops
    // immediately, no separate affordance needed.
    crate::feature_flags::flag(
        app_data_dir,
        crate::feature_flags::FeatureFlagKey::FocusMode,
    )
}

/// Loads persisted DND state into `MatrixState::dnd` at app startup.
pub fn init(app: &AppHandle) {
    let Ok(dir) = app.path().app_data_dir() else {
        return;
    };
    let persisted = read_persisted_at(&dir);
    *app.state::<MatrixState>()
        .dnd
        .lock()
        .unwrap_or_else(|e| e.into_inner()) = persisted;
}

/// Applies a new DND state: updates in-memory state, persists to disk, and
/// emits `dnd:changed` so whichever surface (Settings panel or tray menu)
/// didn't trigger this change stays in sync.
pub fn apply(app: &AppHandle, next: DndState) {
    *app.state::<MatrixState>()
        .dnd
        .lock()
        .unwrap_or_else(|e| e.into_inner()) = next;
    if let Ok(dir) = app.path().app_data_dir() {
        write_persisted_at(&dir, next);
    }
    let _ = app.emit("dnd:changed", next);
}

/// Reads the current effective in-memory state, auto-clearing an expired
/// timed period (without persisting the clear — the next `effective`/
/// `is_dnd_active` call just re-derives it the same way).
pub fn effective(app: &AppHandle) -> DndState {
    let current = *app
        .state::<MatrixState>()
        .dnd
        .lock()
        .unwrap_or_else(|e| e.into_inner());
    if current.is_active(now_ms()) {
        current
    } else {
        DndState::default()
    }
}

/// Whether local/push notification dispatch should be suppressed right now —
/// the single enforcement check shared by `shell::maybe_send_notification`
/// and `push::handle_push`, so neither re-derives DND logic independently.
///
/// Also gated on the `focus_mode` flag (see `is_active_at`'s doc comment for
/// why): a killed rollout stops enforcement immediately rather than leaving
/// a persisted DND with no in-app way to clear it.
pub fn is_dnd_active(app: &AppHandle) -> bool {
    if !effective(app).enabled {
        return false;
    }
    let Ok(dir) = app.path().app_data_dir() else {
        return false;
    };
    crate::feature_flags::flag(&dir, crate::feature_flags::FeatureFlagKey::FocusMode)
}

#[tauri::command]
pub fn get_dnd_state(app: AppHandle) -> DndState {
    effective(&app)
}

#[tauri::command]
pub fn set_dnd_state(app: AppHandle, enabled: bool, until: Option<i64>) -> DndState {
    let next = DndState { enabled, until };
    apply(&app, next);
    next
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn inactive_when_disabled() {
        let state = DndState {
            enabled: false,
            until: Some(i64::MAX),
        };
        assert!(!state.is_active(0));
    }

    #[test]
    fn active_indefinitely_when_until_is_none() {
        let state = DndState {
            enabled: true,
            until: None,
        };
        assert!(state.is_active(0));
        assert!(state.is_active(i64::MAX));
    }

    #[test]
    fn active_before_until_expires() {
        let state = DndState {
            enabled: true,
            until: Some(1_000),
        };
        assert!(state.is_active(999));
        assert!(state.is_active(1_000));
    }

    #[test]
    fn inactive_after_until_expires() {
        let state = DndState {
            enabled: true,
            until: Some(1_000),
        };
        assert!(!state.is_active(1_001));
    }

    #[test]
    fn read_persisted_tolerates_missing_file() {
        let dir = std::env::temp_dir().join(format!("charm-dnd-test-{}", now_ms()));
        assert_eq!(read_persisted_at(&dir), DndState::default());
    }

    #[test]
    fn write_then_read_round_trips() {
        let dir = std::env::temp_dir().join(format!("charm-dnd-test-rw-{}", now_ms()));
        let state = DndState {
            enabled: true,
            until: Some(12345),
        };
        write_persisted_at(&dir, state);
        assert_eq!(read_persisted_at(&dir), state);
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// Writes a `feature-flags.json` override enabling `focus_mode` at
    /// `app_data_dir`, mirroring the on-disk shape `feature_flags::flag`
    /// reads (see `feature_flags::read_overrides`'s doc comment) — needed
    /// because enforcement now also requires the flag (see `is_active_at`'s
    /// doc comment), so a bare `focus.json` is no longer enough to test it.
    fn enable_focus_mode_flag_at(app_data_dir: &Path) {
        std::fs::create_dir_all(app_data_dir).unwrap();
        std::fs::write(
            app_data_dir.join("feature-flags.json"),
            r#"{"featureFlags":{"state":{"overrides":{"focus_mode":true}}}}"#,
        )
        .unwrap();
    }

    /// `is_active_at` takes a `store_root` (e.g. `<app_data_dir>/matrix_store`)
    /// and must read `focus.json` from its *parent* (`app_data_dir`), not
    /// from `store_root` itself — see the doc comment above. This pins that
    /// after a review caught the mismatch (an earlier version read
    /// `focus.json` from `store_root` directly, so a real Android headless
    /// push would never see DND state set from Settings/the tray).
    #[test]
    fn is_active_at_reads_focus_json_from_store_roots_parent() {
        let app_data_dir = std::env::temp_dir().join(format!("charm-dnd-test-parent-{}", now_ms()));
        let store_root = app_data_dir.join("matrix_store");
        let _ = std::fs::remove_dir_all(&app_data_dir);
        write_persisted_at(
            &app_data_dir,
            DndState {
                enabled: true,
                until: None,
            },
        );
        enable_focus_mode_flag_at(&app_data_dir);

        assert!(is_active_at(&store_root));

        let _ = std::fs::remove_dir_all(&app_data_dir);
    }

    /// Review fix: a killed `focus_mode` rollout must stop enforcement
    /// immediately, even with an indefinite DND persisted — otherwise a user
    /// would have no in-app way to turn notifications back on once both the
    /// Settings entry and tray submenu disappear with the flag. This is the
    /// "off-ramp" this repo's review comment asked for: disabling the flag
    /// *is* the off-ramp, rather than a separate always-visible affordance.
    #[test]
    fn is_active_at_is_false_when_focus_mode_flag_is_off_despite_persisted_dnd() {
        let app_data_dir =
            std::env::temp_dir().join(format!("charm-dnd-test-flag-off-{}", now_ms()));
        let store_root = app_data_dir.join("matrix_store");
        let _ = std::fs::remove_dir_all(&app_data_dir);
        write_persisted_at(
            &app_data_dir,
            DndState {
                enabled: true,
                until: None,
            },
        );
        // Deliberately no `enable_focus_mode_flag_at` call: the flag is off
        // by default (no override file at all), matching a killed rollout.

        assert!(!is_active_at(&store_root));

        let _ = std::fs::remove_dir_all(&app_data_dir);
    }
}
