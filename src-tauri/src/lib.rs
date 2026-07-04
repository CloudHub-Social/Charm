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
            matrix::try_restore_session,
            matrix::list_rooms,
            matrix::resolve_room_alias,
            matrix::timeline::get_timeline_page,
            matrix::send::send_message,
            matrix::verification::bootstrap_cross_signing,
            matrix::verification::cross_signing_status,
            matrix::verification::accept_verification_request,
            matrix::verification::cancel_verification,
            matrix::verification::start_sas_verification,
            matrix::verification::confirm_sas_verification
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
