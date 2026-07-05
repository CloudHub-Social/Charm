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

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let _sentry_guard = sentry::init((
        std::env::var("SENTRY_DSN").unwrap_or_default(),
        sentry::ClientOptions {
            release: sentry::release_name!(),
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
        .manage(matrix::MatrixState::default())
        .invoke_handler(tauri::generate_handler![
            greet,
            matrix::login,
            matrix::register,
            matrix::discover_homeserver,
            matrix::start_sso_login,
            matrix::complete_sso_login,
            matrix::cancel_sso_login,
            matrix::try_restore_session,
            matrix::list_rooms,
            matrix::resolve_room_alias,
            matrix::timeline::get_timeline_page,
            matrix::send::send_message,
            matrix::actions::edit_message,
            matrix::actions::redact_event,
            matrix::actions::can_redact,
            matrix::actions::toggle_reaction,
            matrix::actions::send_reply,
            matrix::verification::bootstrap_cross_signing,
            matrix::verification::cross_signing_status,
            matrix::verification::accept_verification_request,
            matrix::verification::cancel_verification,
            matrix::verification::start_sas_verification,
            matrix::verification::confirm_sas_verification,
            matrix::qr_login::start_qr_login,
            matrix::qr_login::submit_qr_check_code,
            matrix::qr_login::cancel_qr_login
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
