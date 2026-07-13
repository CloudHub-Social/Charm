// Deeply nested #[instrument] async fns in matrix-sdk-crypto's Store trait can
// overflow the default trait-solver recursion limit while proving Send-ness
// (rustc issue class: "overflow evaluating the requirement ... Send"), which
// is sensitive to the exact compiler/runner environment — observed on CI's
// macos-latest runner but not locally. Raising the limit avoids the overflow.
#![recursion_limit = "512"]

pub mod matrix;
pub mod observability_scrub;
pub mod observability_trace;
pub mod push;

use std::borrow::Cow;
use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};
use tauri::Manager;
use tracing_subscriber::prelude::*;

// Learn more about Tauri commands at https://tauri.app/develop/calling-rust/
#[tauri::command]
fn greet(name: &str) -> String {
    format!("Hello, {}! You've been greeted from Rust!", name)
}

/// The `charm.platform` Sentry tag's real per-OS value (Spec 23):
/// `std::env::consts::OS` returns the same `linux`/`macos`/`ios`/`android`/
/// `windows` set `@tauri-apps/plugin-os`'s `platform()` does — a plain app
/// command exposing just this one string, rather than registering the whole
/// OS plugin (which also injects arch/exe-extension/family/locale/version
/// fingerprinting into the frontend for a single tag's worth of need; see
/// PR #169 review discussion).
#[tauri::command]
fn get_platform() -> &'static str {
    std::env::consts::OS
}

/// Crate targets the desktop Sentry tracing bridge forwards — see
/// `observability_scrub::is_tracing_target_allowed`.
const DESKTOP_SENTRY_TRACING_CRATES: &[&str] = &["charm", "charm_lib"];

/// Spec 24's canonical build identifier (`{version}+{short_sha}`,
/// `{version}+pr{number}.{short_sha}`, or `{version}+nightly.{short_sha}`),
/// baked in at *compile* time via `option_env!` — mirroring how
/// `sentry::release_name!()` below captures `CARGO_PKG_VERSION` at compile
/// time. A runtime `std::env::var` lookup (like `SENTRY_RELEASE` still
/// supports, for explicit overrides) isn't enough on its own: an installed
/// app's launch environment won't have CI's `BUILD_ID` set, so without this
/// compile-time capture every shipped binary would silently fall back to the
/// bare Cargo version and never show the SHA. CI sets `BUILD_ID` before
/// invoking `cargo build`/`pnpm tauri build` — see
/// `.github/scripts/configure-sentry-release-env.sh` and the
/// nightly-platform-builds.yml / sentry-release-artifacts.yml workflow
/// steps. Absent (e.g. a local dev build), this is `None` and every
/// consumer below falls back the same way `release_name!()` already did.
const BUILD_ID: Option<&str> = option_env!("BUILD_ID");

static SENTRY_TRACING_INSTALLED: AtomicBool = AtomicBool::new(false);
static RUNTIME_LOG_CONSENT: AtomicBool = AtomicBool::new(false);

/// Consent-gated wrapper around `observability_scrub::scrub_log_in_place` —
/// desktop is the one Sentry call site with a per-user runtime toggle (the
/// Observability settings panel), so the gating lives here rather than in
/// the shared module `charm-web-server` also uses (which has no such
/// toggle).
fn scrub_log(mut log: sentry::protocol::Log) -> Option<sentry::protocol::Log> {
    if !RUNTIME_LOG_CONSENT.load(Ordering::SeqCst) {
        return None;
    }
    if matches!(log.level, sentry::protocol::LogLevel::Debug) && !cfg!(debug_assertions) {
        return None;
    }
    observability_scrub::scrub_log_in_place(&mut log);
    Some(log)
}

#[allow(dead_code)]
struct SentryGuard {
    _client: sentry::ClientInitGuard,
    tracing_installed: bool,
    logs_enabled: bool,
}

fn sentry_event_filter(
    metadata: &tracing::Metadata<'_>,
) -> sentry::integrations::tracing::EventFilter {
    use sentry::integrations::tracing::EventFilter;

    match *metadata.level() {
        tracing::Level::ERROR | tracing::Level::WARN | tracing::Level::INFO => {
            let logs_enabled = runtime_observability_logs_enabled();
            observability_scrub::sentry_event_filter_for_level_target(
                metadata.level(),
                metadata.target(),
                logs_enabled,
                DESKTOP_SENTRY_TRACING_CRATES,
            )
        }
        tracing::Level::DEBUG | tracing::Level::TRACE => EventFilter::Ignore,
    }
}

fn sentry_span_filter(metadata: &tracing::Metadata<'_>) -> bool {
    observability_scrub::sentry_span_filter_for_level_target(
        metadata.level(),
        metadata.target(),
        DESKTOP_SENTRY_TRACING_CRATES,
    )
}

fn install_sentry_tracing() -> bool {
    if SENTRY_TRACING_INSTALLED.swap(true, Ordering::SeqCst) {
        return true;
    }

    let sentry_layer = sentry::integrations::tracing::layer()
        .event_filter(sentry_event_filter)
        .span_filter(|metadata| {
            sentry_span_filter(metadata) && runtime_observability_logs_enabled()
        });
    let subscriber = tracing_subscriber::registry().with(sentry_layer);

    match tracing::subscriber::set_global_default(subscriber) {
        Ok(()) => true,
        Err(error) => {
            eprintln!("failed to install Sentry tracing subscriber: {error}");
            SENTRY_TRACING_INSTALLED.store(false, Ordering::SeqCst);
            false
        }
    }
}

fn update_runtime_observability_logs_enabled(logs_enabled: bool) {
    RUNTIME_LOG_CONSENT.store(logs_enabled, Ordering::SeqCst);
}

#[tauri::command]
fn update_observability_log_consent<R: tauri::Runtime>(
    _app: tauri::AppHandle<R>,
    logs_enabled: bool,
) {
    update_runtime_observability_logs_enabled(logs_enabled);
}

fn observability_enabled_from_store(app_data_dir: &Path) -> bool {
    let Ok(raw) = std::fs::read_to_string(app_data_dir.join("observability.json")) else {
        return false;
    };
    let Ok(value) = serde_json::from_str::<serde_json::Value>(&raw) else {
        return false;
    };
    let Some(state) = value
        .get("observability")
        .and_then(|observability| observability.get("state"))
        .or_else(|| value.get("state"))
        .or_else(|| value.get("observability"))
    else {
        return false;
    };

    state
        .get("sentryEnabled")
        .and_then(serde_json::Value::as_bool)
        .unwrap_or(false)
}

fn observability_logs_enabled_from_store(app_data_dir: &Path) -> bool {
    let Ok(raw) = std::fs::read_to_string(app_data_dir.join("observability.json")) else {
        return false;
    };
    let Ok(value) = serde_json::from_str::<serde_json::Value>(&raw) else {
        return false;
    };
    let state = value
        .get("observability")
        .and_then(|observability| observability.get("state"))
        .or_else(|| value.get("state"))
        .or_else(|| value.get("observability"));

    state
        .and_then(|s| s.get("logsEnabled"))
        .and_then(serde_json::Value::as_bool)
        .unwrap_or(false)
}

fn runtime_observability_logs_enabled() -> bool {
    RUNTIME_LOG_CONSENT.load(Ordering::SeqCst)
}

/// Resolves the value for the `charm.build.id` Sentry tag (Spec 23/24):
/// an explicit runtime `SENTRY_RELEASE` override wins (empty values from
/// `std::env::var` are treated as unset), otherwise fall back to the
/// compile-time-baked `BUILD_ID` (see the `BUILD_ID` const doc comment).
/// Pulled out as a pure function so the priority order is unit-testable
/// without needing an actual Sentry client or process environment.
fn resolve_build_id_tag(
    sentry_release_env: Option<String>,
    build_id: Option<&str>,
) -> Option<String> {
    sentry_release_env
        .filter(|value| !value.is_empty())
        .or_else(|| build_id.map(str::to_owned))
}

fn init_sentry_from_settings<R: tauri::Runtime>(app: &tauri::App<R>) -> Option<SentryGuard> {
    let dsn = std::env::var("SENTRY_DSN")
        .ok()
        .filter(|value| !value.is_empty())?;
    let app_data_dir = app.path().app_data_dir().ok()?;
    if !observability_enabled_from_store(&app_data_dir) {
        return None;
    }

    let logs_enabled = observability_logs_enabled_from_store(&app_data_dir);
    update_runtime_observability_logs_enabled(logs_enabled);
    let environment = std::env::var("SENTRY_ENVIRONMENT")
        .ok()
        .filter(|value| !value.is_empty())
        .map(Cow::Owned);
    // Priority: an explicit runtime SENTRY_RELEASE override, then the
    // compile-time-baked BUILD_ID (Spec 24 — present on every CI-built
    // binary), then the bare Cargo-version fallback release_name!() already
    // provided before this spec.
    let release = std::env::var("SENTRY_RELEASE")
        .ok()
        .filter(|value| !value.is_empty())
        .map(Cow::Owned)
        .or_else(|| BUILD_ID.map(Cow::Borrowed))
        .or_else(|| sentry::release_name!());

    // charm.build.id mirrors `release` (or BUILD_ID directly when no
    // SENTRY_RELEASE override is present) so a Sentry event's tag matches
    // what AboutPanel displays for the same build — see Spec 24, which
    // introduced this build id and whose AboutPanel consumes it for
    // feedback/error context. Exception: local/dev builds where neither
    // SENTRY_RELEASE nor BUILD_ID is set. There, this tag is absent
    // (`None`) while AboutPanel's `formatBuildIdForDisplay`
    // (src/lib/buildId.ts) still renders a `{version}-dev` fallback from
    // the bare package.json version — so the two surfaces diverge in that
    // one case.
    let build_id_tag = resolve_build_id_tag(std::env::var("SENTRY_RELEASE").ok(), BUILD_ID);

    let client = sentry::init((
        dsn,
        sentry::ClientOptions {
            release,
            environment,
            send_default_pii: false,
            traces_sample_rate: if cfg!(debug_assertions) { 1.0 } else { 0.5 },
            auto_session_tracking: true,
            session_mode: sentry::SessionMode::Application,
            // Keep Sentry Logs initialized for same-session opt-in; scrub_log
            // drops every native log unless runtime log consent is enabled.
            enable_logs: true,
            before_send: Some(std::sync::Arc::new(observability_scrub::scrub_event)),
            before_send_log: Some(std::sync::Arc::new(scrub_log)),
            ..Default::default()
        },
    ));
    if let Some(build_id) = build_id_tag {
        sentry::configure_scope(|scope| scope.set_tag("charm.build.id", build_id));
    }
    let tracing_installed = install_sentry_tracing();
    if tracing_installed {
        tracing::info!(logs_enabled, "Rust Sentry tracing/log bridge initialized");
    }

    // Backend-side counterpart to the frontend's own `app.boot` metric
    // (`src/observability/instrument.ts`'s `initializeSentry`) — this one
    // fires once per native process launch rather than once per webview
    // load, so the two together distinguish a fresh OS-level app start from
    // a webview reload within the same running process.
    sentry::metrics::counter("app.boot", 1)
        .attribute("charm.platform", get_platform())
        .capture();

    Some(SentryGuard {
        _client: client,
        tracing_installed,
        logs_enabled,
    })
}

/// Builds the tray icon (with a Show/Quit menu) and, on macOS, the native app
/// menu bar (App/Edit/Window with standard shortcuts) — Spec 10. Desktop-only:
/// mobile has no tray and relies on the OS's own app-switcher/back gestures
/// instead of a native menu bar.
#[cfg(desktop)]
fn setup_tray_and_menu(app: &tauri::App) -> tauri::Result<()> {
    use tauri::menu::{Menu, MenuItem, PredefinedMenuItem, Submenu};
    use tauri::tray::TrayIconBuilder;
    use tauri::Manager;

    let show_item = MenuItem::with_id(app, "show", "Show Charm", true, None::<&str>)?;
    let quit_item = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;
    let tray_menu = Menu::with_items(app, &[&show_item, &quit_item])?;

    TrayIconBuilder::new()
        .icon(
            app.default_window_icon()
                .cloned()
                .unwrap_or_else(|| tauri::image::Image::new_owned(vec![0u8; 4], 1, 1)),
        )
        .menu(&tray_menu)
        .show_menu_on_left_click(true)
        .on_menu_event(|app, event| match event.id.as_ref() {
            "show" => {
                if let Some(window) = app.get_webview_window("main") {
                    let _ = window.show();
                    let _ = window.set_focus();
                }
            }
            "quit" => app.exit(0),
            _ => {}
        })
        .build(app)?;

    #[cfg(target_os = "macos")]
    {
        let app_menu = Submenu::with_items(
            app,
            "Charm",
            true,
            &[
                &PredefinedMenuItem::about(app, None, None)?,
                &PredefinedMenuItem::separator(app)?,
                &PredefinedMenuItem::services(app, None)?,
                &PredefinedMenuItem::separator(app)?,
                &PredefinedMenuItem::hide(app, None)?,
                &PredefinedMenuItem::hide_others(app, None)?,
                &PredefinedMenuItem::show_all(app, None)?,
                &PredefinedMenuItem::separator(app)?,
                &PredefinedMenuItem::quit(app, None)?,
            ],
        )?;
        let edit_menu = Submenu::with_items(
            app,
            "Edit",
            true,
            &[
                &PredefinedMenuItem::undo(app, None)?,
                &PredefinedMenuItem::redo(app, None)?,
                &PredefinedMenuItem::separator(app)?,
                &PredefinedMenuItem::cut(app, None)?,
                &PredefinedMenuItem::copy(app, None)?,
                &PredefinedMenuItem::paste(app, None)?,
                &PredefinedMenuItem::select_all(app, None)?,
            ],
        )?;
        let window_menu = Submenu::with_items(
            app,
            "Window",
            true,
            &[
                &PredefinedMenuItem::minimize(app, None)?,
                &PredefinedMenuItem::close_window(app, None)?,
            ],
        )?;
        let menu = Menu::with_items(app, &[&app_menu, &edit_menu, &window_menu])?;
        app.set_menu(menu)?;
    }

    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let builder = tauri::Builder::default();

    // Registered first and independent of Sentry consent — this is the one
    // thing that lets a launch problem (e.g. the app hanging/blanking before
    // any UI or Sentry state exists) leave a trail on disk at all. Writes to
    // the platform's standard app log dir (macOS: `~/Library/Logs/<bundle
    // id>/`) in addition to stdout/the webview console, so `tail -f` on that
    // directory works even for a release build launched from Finder with no
    // attached terminal. See the 2026-07-13 blank-page-on-launch
    // investigation — until this landed there was no persisted log for that
    // report at all.
    let builder = builder.plugin(
        tauri_plugin_log::Builder::new()
            .targets([
                tauri_plugin_log::Target::new(tauri_plugin_log::TargetKind::Stdout),
                tauri_plugin_log::Target::new(tauri_plugin_log::TargetKind::LogDir {
                    file_name: None,
                }),
                tauri_plugin_log::Target::new(tauri_plugin_log::TargetKind::Webview),
            ])
            .level(if cfg!(debug_assertions) {
                log::LevelFilter::Debug
            } else {
                log::LevelFilter::Info
            })
            .build(),
    );

    #[cfg(desktop)]
    let builder = builder
        .plugin(tauri_plugin_single_instance::init(|_app, _args, _cwd| {}))
        .plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            None,
        ))
        .plugin(tauri_plugin_window_state::Builder::new().build());

    #[cfg(target_os = "ios")]
    let builder = builder.plugin(push::ios::init());

    builder
        .plugin(tauri_plugin_deep_link::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_store::Builder::default().build())
        .manage(matrix::MatrixState::default())
        .setup(|app| {
            if let Some(sentry_guard) = init_sentry_from_settings(app) {
                app.manage(sentry_guard);
            }
            let handle = app.handle().clone();
            // Stashed for platform push callbacks (Android's JNI
            // `onMessage`; iOS's Notification Service Extension runs as a
            // separate process and doesn't use this) that arrive with no
            // Tauri command context to pull an `AppHandle` from — see
            // `push::global_app_handle`'s doc comment.
            #[cfg(any(target_os = "android", target_os = "ios"))]
            push::set_global_app_handle(handle.clone());
            // One-time dev wipe of the pre-Spec-15 single-account store
            // layout (see its doc comment) — debug-build-only. A release
            // build reaching a real user's machine with the legacy layout
            // still on disk should never silently delete their crypto
            // store; that migration path is dev-only by design (Charm 2.0
            // is pre-release, so every debug build is a dev/test install).
            if cfg!(debug_assertions) {
                if let Err(e) = matrix::persistence::migrate_legacy_single_account_store(&handle) {
                    eprintln!("legacy single-account store migration failed: {e}");
                }
            }
            // Best-effort sweep of any per-account temp stores stranded by a
            // crash mid-login (a clean cancel already cleans up its own).
            let sweep_result = tauri::async_runtime::block_on(async {
                let _restore_store_guard = matrix::auth::restore_store_lock().lock().await;
                matrix::persistence::sweep_orphan_temp_stores(&handle)
            });
            if let Err(e) = sweep_result {
                eprintln!("orphan temp-store sweep failed: {e}");
            }
            #[cfg(desktop)]
            setup_tray_and_menu(app)?;
            Ok(())
        })
        .on_window_event(|window, event| {
            // Desktop platforms destroy the app's only window (and, on
            // Windows/Linux, exit the whole process) when the user clicks
            // its close button unless something intercepts that — which
            // would take the tray icon down with it, so "Show" from the
            // tray menu could never bring the window back and background
            // sync/notifications would stop entirely. Hiding instead keeps
            // the process (and tray) alive; the tray menu's "Quit" still
            // exits for real via `app.exit(0)`, which doesn't go through a
            // window-close event at all.
            #[cfg(desktop)]
            if window.label() == "main" {
                if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                    api.prevent_close();
                    let _ = window.hide();
                }
            }
        })
        .invoke_handler(tauri::generate_handler![
            greet,
            get_platform,
            update_observability_log_consent,
            matrix::auth::login,
            matrix::auth::register,
            matrix::auth::discover_homeserver,
            matrix::auth::start_sso_login,
            matrix::auth::complete_sso_login,
            matrix::auth::cancel_sso_login,
            matrix::auth::try_restore_session,
            matrix::rooms::list_rooms,
            matrix::rooms::resolve_room_alias,
            matrix::timeline::get_timeline_page,
            matrix::send::send_message,
            matrix::send::send_attachment,
            matrix::media::resolve_media,
            matrix::actions::edit_message,
            matrix::actions::redact_event,
            matrix::actions::can_redact,
            matrix::actions::toggle_reaction,
            matrix::actions::send_reply,
            matrix::commands::run_command,
            matrix::members::get_room_members,
            matrix::verification::bootstrap_cross_signing,
            matrix::verification::cross_signing_status,
            matrix::verification::recovery_status,
            matrix::verification::recover_from_key,
            matrix::verification::accept_verification_request,
            matrix::verification::cancel_verification,
            matrix::verification::start_sas_verification,
            matrix::verification::confirm_sas_verification,
            matrix::qr_login::start_qr_login,
            matrix::qr_login::submit_qr_check_code,
            matrix::qr_login::cancel_qr_login,
            matrix::ephemeral::send_read_receipt,
            matrix::ephemeral::send_typing,
            matrix::ephemeral::mark_room_read,
            matrix::presence::set_presence,
            matrix::presence::get_presence,
            matrix::profiles::get_own_profile,
            matrix::rooms::set_room_favourite,
            matrix::rooms::set_room_low_priority,
            matrix::rooms::set_room_muted,
            matrix::rooms::set_room_marked_unread,
            matrix::rooms::set_room_manual_order,
            matrix::spaces::list_space_children,
            matrix::spaces::list_space_hierarchy,
            matrix::spaces::join_room,
            matrix::spaces::knock_room,
            matrix::spaces::create_space,
            matrix::room_admin::get_room_details,
            matrix::room_admin::get_room_member_list,
            matrix::room_admin::set_room_name,
            matrix::room_admin::set_room_topic,
            matrix::room_admin::set_room_avatar,
            matrix::room_admin::remove_room_avatar,
            matrix::room_admin::set_room_join_rule,
            matrix::room_admin::set_room_history_visibility,
            matrix::room_admin::enable_room_encryption,
            matrix::room_admin::set_member_power_level,
            matrix::room_admin::set_room_power_level_thresholds,
            matrix::room_admin::invite_member,
            matrix::room_admin::kick_member,
            matrix::room_admin::ban_member,
            matrix::room_admin::unban_member,
            matrix::account::logout,
            matrix::account::get_profile,
            matrix::account::resolve_avatar,
            matrix::account::set_display_name,
            matrix::account::set_avatar,
            matrix::account::remove_avatar,
            matrix::account::change_password,
            matrix::account::deactivate_account,
            matrix::account::get_account_deactivate_url,
            matrix::account::get_3pids,
            matrix::account::get_ignored_users,
            matrix::account::ignore_user,
            matrix::account::unignore_user,
            matrix::devices::list_devices,
            matrix::devices::delete_device,
            matrix::devices::request_device_verification,
            matrix::devices::get_cross_signing_reset_url,
            matrix::devices::get_device_delete_url,
            matrix::notifications::get_notification_settings,
            matrix::notifications::set_default_notification_mode,
            matrix::notifications::set_room_notification_mode,
            matrix::notifications::add_notification_keyword,
            matrix::notifications::remove_notification_keyword,
            matrix::notifications::set_global_mute,
            matrix::notifications::set_sound_enabled,
            matrix::shell::set_focused_room,
            matrix::shell::set_badge_count,
            matrix::shell::is_desktop_platform,
            matrix::shell::get_autostart,
            matrix::shell::set_autostart,
            matrix::account_data::get_account_data,
            matrix::account_data::set_account_data,
            matrix::account_data::get_local_onboarding_flag,
            matrix::account_data::set_local_onboarding_flag,
            push::register_push,
            push::unregister_push,
            push::get_push_status
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

#[cfg(test)]
mod observability_tests {
    use super::*;

    static LOG_CONSENT_TEST_LOCK: std::sync::LazyLock<std::sync::Mutex<()>> =
        std::sync::LazyLock::new(|| std::sync::Mutex::new(()));

    struct RuntimeLogConsentReset(bool);

    impl Drop for RuntimeLogConsentReset {
        fn drop(&mut self) {
            RUNTIME_LOG_CONSENT.store(self.0, Ordering::SeqCst);
        }
    }

    fn set_runtime_log_consent_for_test(logs_enabled: bool) -> RuntimeLogConsentReset {
        RuntimeLogConsentReset(RUNTIME_LOG_CONSENT.swap(logs_enabled, Ordering::SeqCst))
    }

    // Pure redaction-rule tests (matrix ID/secret patterns, JSON walking)
    // live in `observability_scrub`'s own test module now that the logic
    // does — this module keeps only what's actually desktop-specific:
    // consent gating and crate-scoped filtering wired to
    // `DESKTOP_SENTRY_TRACING_CRATES`.

    #[test]
    fn scrub_log_redacts_body_and_attributes() {
        let _guard = LOG_CONSENT_TEST_LOCK.lock().expect("log consent test lock");
        let _reset = set_runtime_log_consent_for_test(true);
        let log = sentry::protocol::Log {
            level: sentry::protocol::LogLevel::Info,
            body: "failed for @alice:example.org access_token=secret".to_owned(),
            trace_id: None,
            timestamp: std::time::SystemTime::UNIX_EPOCH,
            severity_number: None,
            attributes: sentry::protocol::Map::from_iter([(
                "room".to_owned(),
                sentry::protocol::LogAttribute::from("!room:example.org"),
            )]),
        };

        let scrubbed = scrub_log(log).expect("non-debug log is retained");

        assert_eq!(
            scrubbed.body,
            "failed for @[redacted]:[redacted] access_token=[redacted]"
        );
        assert_eq!(
            scrubbed.attributes.get("room").map(|value| &value.0),
            Some(&sentry::protocol::Value::String(
                "![redacted]:[redacted]".to_owned()
            ))
        );
    }

    #[test]
    fn observability_store_defaults_to_disabled_when_missing() {
        let dir =
            std::env::temp_dir().join(format!("charm-observability-test-{}", std::process::id()));
        let _ = std::fs::create_dir_all(&dir);

        assert!(!observability_enabled_from_store(&dir));

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn observability_store_reads_tauri_store_shape() {
        let dir = std::env::temp_dir().join(format!(
            "charm-observability-test-enabled-{}",
            std::process::id()
        ));
        std::fs::create_dir_all(&dir).expect("temp observability dir");
        std::fs::write(
            dir.join("observability.json"),
            r#"{"observability":{"state":{"sentryEnabled":true,"logsEnabled":true},"updatedAt":1}}"#,
        )
        .expect("observability fixture write");

        assert!(observability_enabled_from_store(&dir));
        assert!(observability_logs_enabled_from_store(&dir));

        std::fs::remove_dir_all(&dir).expect("temp observability dir cleanup");
    }

    #[test]
    fn runtime_log_consent_updates_after_notification() {
        let _guard = LOG_CONSENT_TEST_LOCK.lock().expect("log consent test lock");
        let _reset = set_runtime_log_consent_for_test(false);

        update_runtime_observability_logs_enabled(true);
        assert!(runtime_observability_logs_enabled());

        update_runtime_observability_logs_enabled(false);

        assert!(!runtime_observability_logs_enabled());
    }

    // Spec 24: charm.build.id tag resolution — an explicit runtime
    // SENTRY_RELEASE always wins over the compile-time BUILD_ID constant,
    // and an empty-string env value (std::env::var returns "" rather than
    // None when a var is set-but-empty) is treated the same as unset.

    #[test]
    fn build_id_tag_prefers_runtime_sentry_release_override() {
        let resolved =
            resolve_build_id_tag(Some("charm@override".to_owned()), Some("0.1.0+a1b2c3d"));
        assert_eq!(resolved.as_deref(), Some("charm@override"));
    }

    #[test]
    fn build_id_tag_falls_back_to_compile_time_build_id() {
        let resolved = resolve_build_id_tag(None, Some("0.1.0+a1b2c3d"));
        assert_eq!(resolved.as_deref(), Some("0.1.0+a1b2c3d"));
    }

    #[test]
    fn build_id_tag_treats_empty_env_value_as_unset() {
        let resolved = resolve_build_id_tag(Some(String::new()), Some("0.1.0+a1b2c3d"));
        assert_eq!(resolved.as_deref(), Some("0.1.0+a1b2c3d"));
    }

    #[test]
    fn build_id_tag_is_none_without_release_env_or_compile_time_build_id() {
        assert_eq!(resolve_build_id_tag(None, None), None);
    }
}
