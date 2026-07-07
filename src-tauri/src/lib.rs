// Deeply nested #[instrument] async fns in matrix-sdk-crypto's Store trait can
// overflow the default trait-solver recursion limit while proving Send-ness
// (rustc issue class: "overflow evaluating the requirement ... Send"), which
// is sensitive to the exact compiler/runner environment — observed on CI's
// macos-latest runner but not locally. Raising the limit avoids the overflow.
#![recursion_limit = "512"]

pub mod matrix;

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

fn scrub_secrets(text: &str) -> String {
    SECRET_FIELD_PATTERN
        .replace_all(text, "$1$2[redacted]")
        .into_owned()
}

/// Sentry `before_send` hook: redacts anything matching [`SECRET_FIELD_PATTERN`]
/// from the event's top-level message, exception values, and breadcrumb
/// messages before the event ever leaves the process.
fn scrub_event(
    mut event: sentry::protocol::Event<'static>,
) -> Option<sentry::protocol::Event<'static>> {
    if let Some(message) = &mut event.message {
        *message = scrub_secrets(message);
    }
    for exception in event.exception.iter_mut() {
        if let Some(value) = &mut exception.value {
            *value = scrub_secrets(value);
        }
    }
    for breadcrumb in event.breadcrumbs.iter_mut() {
        if let Some(message) = &mut breadcrumb.message {
            *message = scrub_secrets(message);
        }
    }
    Some(event)
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
    let _sentry_guard = sentry::init((
        std::env::var("SENTRY_DSN").unwrap_or_default(),
        sentry::ClientOptions {
            release: sentry::release_name!(),
            before_send: Some(std::sync::Arc::new(scrub_event)),
            ..Default::default()
        },
    ));

    let builder = tauri::Builder::default();

    #[cfg(desktop)]
    let builder = builder
        .plugin(tauri_plugin_single_instance::init(|_app, _args, _cwd| {}))
        .plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            None,
        ))
        .plugin(tauri_plugin_window_state::Builder::new().build());

    builder
        .plugin(tauri_plugin_deep_link::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_notification::init())
        .manage(matrix::MatrixState::default())
        .setup(|app| {
            let handle = app.handle().clone();
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
        .invoke_handler(tauri::generate_handler![
            greet,
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
            matrix::shell::get_autostart,
            matrix::shell::set_autostart
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
