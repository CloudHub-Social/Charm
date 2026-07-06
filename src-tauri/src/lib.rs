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
    let builder = builder.plugin(tauri_plugin_single_instance::init(|_app, _args, _cwd| {}));

    builder
        .plugin(tauri_plugin_deep_link::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_dialog::init())
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
            matrix::rooms::set_room_favourite,
            matrix::rooms::set_room_low_priority,
            matrix::rooms::set_room_muted,
            matrix::rooms::set_room_marked_unread,
            matrix::rooms::set_room_manual_order,
            matrix::spaces::list_space_children,
            matrix::spaces::join_room,
            matrix::spaces::knock_room,
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
            matrix::notifications::set_sound_enabled
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
