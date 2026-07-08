// Deeply nested #[instrument] async fns in matrix-sdk-crypto's Store trait can
// overflow the default trait-solver recursion limit while proving Send-ness
// (rustc issue class: "overflow evaluating the requirement ... Send"), which
// is sensitive to the exact compiler/runner environment — observed on CI's
// macos-latest runner but not locally. Raising the limit avoids the overflow.
#![recursion_limit = "512"]

pub mod matrix;
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

/// Matches `key = value` / `key: "value"` pairs (JSON-ish or Debug/Display
/// formatted) for field names that should never reach Sentry, case
/// insensitively. Not a general-purpose secret scanner — just a
/// defense-in-depth backstop: nothing in this codebase today formats a
/// token/passphrase/key into a panic or error string, but `Result<_, String>`
/// is pervasive here (see `persistence.rs`, `qr_login.rs`), so a single
/// future `.expect()`/`unwrap()` added against one of those `Err`s could
/// otherwise ship a secret verbatim to Sentry with nothing catching it.
static SECRET_FIELD_PATTERN: std::sync::LazyLock<regex::Regex> = std::sync::LazyLock::new(|| {
    regex::Regex::new(
        r#"(?i)(access_token|refresh_token|password|passphrase|recovery_key|secret_storage_key|session_key)("?\s*[:=]\s*"?)([^"'\s,}\]]+)"#,
    )
    .expect("SECRET_FIELD_PATTERN is a valid static regex")
});

static SECRET_FIELD_NAME_PATTERN: std::sync::LazyLock<regex::Regex> = std::sync::LazyLock::new(
    || {
        regex::Regex::new(
        r#"(?i)^(access_token|refresh_token|password|passphrase|recovery_key|secret_storage_key|session_key)$"#,
    )
    .expect("SECRET_FIELD_NAME_PATTERN is a valid static regex")
    },
);

static MATRIX_ID_PATTERN: std::sync::LazyLock<regex::Regex> = std::sync::LazyLock::new(|| {
    regex::Regex::new(r#"([!@#$])[^ \t\r\n"'<>]+:[A-Za-z0-9.-]+(?::\d+)?"#)
        .expect("MATRIX_ID_PATTERN is a valid static regex")
});

static MXC_URI_PATTERN: std::sync::LazyLock<regex::Regex> = std::sync::LazyLock::new(|| {
    regex::Regex::new(r#"mxc://[A-Za-z0-9.-]+/[A-Za-z0-9._~-]+"#)
        .expect("MXC_URI_PATTERN is a valid static regex")
});

static SENTRY_TRACING_INSTALLED: AtomicBool = AtomicBool::new(false);
static RUNTIME_LOG_CONSENT: AtomicBool = AtomicBool::new(false);

fn scrub_secrets(text: &str) -> String {
    SECRET_FIELD_PATTERN
        .replace_all(text, "$1$2[redacted]")
        .into_owned()
}

fn scrub_matrix_ids(text: &str) -> String {
    let without_mxc = MXC_URI_PATTERN
        .replace_all(text, "mxc://[redacted]/[redacted]")
        .into_owned();
    MATRIX_ID_PATTERN
        .replace_all(&without_mxc, "$1[redacted]:[redacted]")
        .into_owned()
}

fn scrub_sensitive_text(text: &str) -> String {
    scrub_secrets(&scrub_matrix_ids(text))
}

fn scrub_json_value(value: &mut serde_json::Value) {
    match value {
        serde_json::Value::String(text) => {
            *text = scrub_sensitive_text(text);
        }
        serde_json::Value::Array(items) => {
            for item in items {
                scrub_json_value(item);
            }
        }
        serde_json::Value::Object(fields) => {
            for (key, field) in fields.iter_mut() {
                if SECRET_FIELD_NAME_PATTERN.is_match(key) {
                    *field = serde_json::Value::String("[redacted]".to_owned());
                } else {
                    scrub_json_value(field);
                }
            }
        }
        serde_json::Value::Bool(_) | serde_json::Value::Number(_) | serde_json::Value::Null => {}
    }
}

/// Sentry `before_send` hook: redacts anything matching [`SECRET_FIELD_PATTERN`]
/// and Matrix identifier patterns from every serialized string field before
/// the event ever leaves the process.
fn scrub_event(
    event: sentry::protocol::Event<'static>,
) -> Option<sentry::protocol::Event<'static>> {
    let Ok(mut value) = serde_json::to_value(&event) else {
        return Some(event);
    };
    scrub_json_value(&mut value);
    serde_json::from_value(value).ok()
}

fn scrub_log(mut log: sentry::protocol::Log) -> Option<sentry::protocol::Log> {
    if !RUNTIME_LOG_CONSENT.load(Ordering::SeqCst) {
        return None;
    }
    if matches!(log.level, sentry::protocol::LogLevel::Debug) && !cfg!(debug_assertions) {
        return None;
    }
    log.body = scrub_sensitive_text(&log.body);
    for attribute in log.attributes.values_mut() {
        scrub_json_value(&mut attribute.0);
    }
    Some(log)
}

#[allow(dead_code)]
struct SentryGuard {
    _client: sentry::ClientInitGuard,
    tracing_installed: bool,
    logs_enabled: bool,
}

fn is_charm_tracing_target(target: &str) -> bool {
    matches!(target, "charm" | "charm_lib")
        || target.starts_with("charm::")
        || target.starts_with("charm_lib::")
}

fn sentry_event_filter_for_level_target(
    level: &tracing::Level,
    target: &str,
    logs_enabled: bool,
) -> sentry::integrations::tracing::EventFilter {
    use sentry::integrations::tracing::EventFilter;

    if !is_charm_tracing_target(target) {
        return EventFilter::Ignore;
    }

    if !logs_enabled {
        return EventFilter::Ignore;
    }

    match *level {
        tracing::Level::ERROR => EventFilter::Event | EventFilter::Breadcrumb | EventFilter::Log,
        tracing::Level::WARN => EventFilter::Breadcrumb | EventFilter::Log,
        tracing::Level::INFO => EventFilter::Breadcrumb,
        tracing::Level::DEBUG => EventFilter::Ignore,
        tracing::Level::TRACE => EventFilter::Ignore,
    }
}

fn sentry_event_filter(
    metadata: &tracing::Metadata<'_>,
) -> sentry::integrations::tracing::EventFilter {
    use sentry::integrations::tracing::EventFilter;

    if !is_charm_tracing_target(metadata.target()) {
        return EventFilter::Ignore;
    }

    match *metadata.level() {
        tracing::Level::ERROR | tracing::Level::WARN | tracing::Level::INFO => {
            let logs_enabled = runtime_observability_logs_enabled();
            sentry_event_filter_for_level_target(metadata.level(), metadata.target(), logs_enabled)
        }
        tracing::Level::DEBUG | tracing::Level::TRACE => EventFilter::Ignore,
    }
}

fn sentry_span_filter(metadata: &tracing::Metadata<'_>) -> bool {
    sentry_span_filter_for_level_target(metadata.level(), metadata.target())
}

fn sentry_span_filter_for_level_target(level: &tracing::Level, target: &str) -> bool {
    is_charm_tracing_target(target)
        && matches!(
            *level,
            tracing::Level::ERROR | tracing::Level::WARN | tracing::Level::INFO
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
    let release = std::env::var("SENTRY_RELEASE")
        .ok()
        .filter(|value| !value.is_empty())
        .map(Cow::Owned)
        .or_else(|| sentry::release_name!());

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
            before_send: Some(std::sync::Arc::new(scrub_event)),
            before_send_log: Some(std::sync::Arc::new(scrub_log)),
            ..Default::default()
        },
    ));
    let tracing_installed = install_sentry_tracing();
    if tracing_installed {
        tracing::info!(logs_enabled, "Rust Sentry tracing/log bridge initialized");
    }

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
            if let Err(e) = matrix::persistence::sweep_orphan_temp_stores(&handle) {
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
            matrix::spaces::join_room,
            matrix::spaces::knock_room,
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

    #[test]
    fn scrub_sensitive_text_redacts_matrix_ids_and_secret_fields() {
        let input = r#"room !abcdef:matrix.example user @alice:example.org alias #general:example.org event $event:example.org mxc://example.org/media password="secret""#;

        assert_eq!(
            scrub_sensitive_text(input),
            r#"room ![redacted]:[redacted] user @[redacted]:[redacted] alias #[redacted]:[redacted] event $[redacted]:[redacted] mxc://[redacted]/[redacted] password="[redacted]""#
        );
    }

    #[test]
    fn scrub_json_value_redacts_secret_field_values() {
        let mut value = serde_json::json!({
            "message": "failed in !room:example.org",
            "extra": {
                "password": "secret",
                "access_token": "token",
                "nested": ["@user:example.org", "plain string"]
            }
        });

        scrub_json_value(&mut value);

        assert_eq!(
            value,
            serde_json::json!({
                "message": "failed in ![redacted]:[redacted]",
                "extra": {
                    "password": "[redacted]",
                    "access_token": "[redacted]",
                    "nested": ["@[redacted]:[redacted]", "plain string"]
                }
            })
        );
    }

    #[test]
    fn scrub_log_redacts_body_and_attributes() {
        let _guard = LOG_CONSENT_TEST_LOCK.lock().expect("log consent test lock");
        RUNTIME_LOG_CONSENT.store(true, Ordering::SeqCst);
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
    fn sentry_tracing_filter_keeps_bridge_charm_scoped() {
        use sentry::integrations::tracing::EventFilter;

        fn assert_event_filter(actual: EventFilter, expected: EventFilter) {
            assert_eq!(actual.bits(), expected.bits());
        }

        assert_event_filter(
            sentry_event_filter_for_level_target(&tracing::Level::INFO, "matrix_sdk::sync", true),
            EventFilter::Ignore,
        );
        assert_event_filter(
            sentry_event_filter_for_level_target(&tracing::Level::INFO, "charm_lib::matrix", true),
            EventFilter::Breadcrumb,
        );
        assert_event_filter(
            sentry_event_filter_for_level_target(&tracing::Level::WARN, "charm_lib::matrix", true),
            EventFilter::Breadcrumb | EventFilter::Log,
        );
        assert_event_filter(
            sentry_event_filter_for_level_target(&tracing::Level::ERROR, "charm_lib::matrix", true),
            EventFilter::Event | EventFilter::Breadcrumb | EventFilter::Log,
        );
        assert_event_filter(
            sentry_event_filter_for_level_target(&tracing::Level::WARN, "charm_lib::matrix", false),
            EventFilter::Ignore,
        );
        assert_event_filter(
            sentry_event_filter_for_level_target(
                &tracing::Level::ERROR,
                "charm_lib::matrix",
                false,
            ),
            EventFilter::Ignore,
        );
        assert!(!sentry_span_filter_for_level_target(
            &tracing::Level::INFO,
            "matrix_sdk::sync"
        ));
        assert!(sentry_span_filter_for_level_target(
            &tracing::Level::INFO,
            "charm_lib::matrix"
        ));
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
    fn runtime_log_consent_updates_after_opt_out_notification() {
        let _guard = LOG_CONSENT_TEST_LOCK.lock().expect("log consent test lock");
        let dir = std::env::temp_dir().join(format!(
            "charm-observability-test-runtime-consent-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .expect("system clock after unix epoch")
                .as_nanos()
        ));
        std::fs::create_dir_all(&dir).expect("temp observability dir");
        std::fs::write(
            dir.join("observability.json"),
            r#"{"observability":{"state":{"sentryEnabled":true,"logsEnabled":true},"updatedAt":1}}"#,
        )
        .expect("observability fixture write");

        update_runtime_observability_logs_enabled(true);
        assert!(runtime_observability_logs_enabled());

        std::fs::write(
            dir.join("observability.json"),
            r#"{"observability":{"state":{"sentryEnabled":true,"logsEnabled":false},"updatedAt":2}}"#,
        )
        .expect("observability opt-out fixture write");
        update_runtime_observability_logs_enabled(false);

        assert!(!runtime_observability_logs_enabled());

        std::fs::remove_dir_all(&dir).expect("temp observability dir cleanup");
    }
}
