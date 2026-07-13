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

/// Compile-time-baked fallback for `SENTRY_DSN`, same reasoning as
/// `BUILD_ID` above: an installed app's launch environment has no
/// `SENTRY_DSN` set (that's only ever present in the CI job that built it),
/// so a pure `std::env::var` lookup at runtime would silently find nothing
/// in every shipped desktop/Android build — both `init_sentry_from_settings`
/// and `forward_sentry_envelope` need this baked-in value as their fallback.
/// CI sets `SENTRY_DSN` before invoking `pnpm tauri build`/
/// `pnpm tauri android build` (see nightly.yml/release-builds.yml) purely so
/// this `option_env!` captures it; `std::env::var("SENTRY_DSN")` still wins
/// when actually present (e.g. a local dev override), matching
/// `resolve_build_id_tag`'s priority order.
const BAKED_SENTRY_DSN: Option<&str> = option_env!("SENTRY_DSN");

/// Pulled out from `resolve_sentry_dsn` as a pure function so the
/// empty-string-is-unset priority order is unit-testable without an actual
/// process environment — same reasoning as `resolve_build_id_tag`.
fn resolve_sentry_dsn_from(env_value: Option<String>, baked: Option<&str>) -> Option<String> {
    env_value.filter(|value| !value.is_empty()).or_else(|| {
        // CI build steps that pass `SENTRY_DSN: ${{ ... && secrets.X || '' }}`
        // (e.g. nightly runs without HAS_SENTRY_CREDS) bake in `Some("")`,
        // not `None` — `option_env!` only sees "was this env var present at
        // compile time", not "was it non-empty". Filtering here the same way
        // as the runtime value above keeps an unconfigured build correctly
        // disabled instead of treating an empty string as a real (and then
        // invalid, once parsed as a Dsn) DSN.
        baked.filter(|value| !value.is_empty()).map(str::to_owned)
    })
}

fn resolve_sentry_dsn() -> Option<String> {
    resolve_sentry_dsn_from(std::env::var("SENTRY_DSN").ok(), BAKED_SENTRY_DSN)
}

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

/// Name of the marker file used to detect an unclean previous exit (Spec
/// 27-ish "crash recovery prompt"): written as soon as this session starts,
/// removed on a clean `RunEvent::Exit`. If it's still present at the *next*
/// launch, the previous process never reached a clean shutdown — either a
/// hard crash (segfault, OOM kill) or the OS killing the process outright,
/// neither of which run our own exit handler. This is a coarse yes/no signal
/// only; it carries no stack trace or diagnostic payload, since a native
/// panic captured mid-session already goes to Sentry via the tracing bridge
/// above *if* consent was already granted before the crash. Its purpose is
/// to close the gap for users who never opted in: nudge them, after the
/// fact, to turn on crash reporting for next time (see
/// `had_unclean_previous_session` and the frontend's `crashRecovery.ts`),
/// not to retroactively manufacture a report for a crash we have no data on.
const CRASH_MARKER_FILENAME: &str = "last_session.marker";

fn crash_marker_path(app_data_dir: &Path) -> std::path::PathBuf {
    app_data_dir.join(CRASH_MARKER_FILENAME)
}

/// Reads whether the previous session's marker is still present (= unclean
/// exit), then immediately overwrites it to mark *this* session as running.
/// Consumes the signal in the sense that a second call within the same
/// process still reports the same thing (the marker now says "running", not
/// "crashed") — callers should ask once, e.g. at boot.
fn take_previous_session_crash_flag(app_data_dir: &Path) -> bool {
    if std::fs::create_dir_all(app_data_dir).is_err() {
        return false;
    }
    let path = crash_marker_path(app_data_dir);
    let previous_session_unclean = path.exists();
    let _ = std::fs::write(&path, b"running");
    previous_session_unclean
}

fn mark_clean_exit(app_data_dir: &Path) {
    let _ = std::fs::remove_file(crash_marker_path(app_data_dir));
}

/// Frontend-visible result of `take_previous_session_crash_flag`, captured
/// once during `setup()` and handed out by `had_unclean_previous_session` —
/// the frontend calls that once at boot, same lifetime as this state.
struct PreviousSessionCrash(bool);

#[tauri::command]
fn had_unclean_previous_session(state: tauri::State<PreviousSessionCrash>) -> bool {
    state.0
}

/// What `forward_sentry_envelope` hands back to the frontend transport —
/// mirrors the SDK's own `TransportMakeRequestResponse` shape
/// (`src/observability/instrument.ts`) so `makeTauriIpcTransport` can pass
/// rate-limit headers straight through instead of only ever seeing a status
/// code. Sentry's browser SDK uses `X-Sentry-Rate-Limits`/`Retry-After` to
/// back off per-category (errors vs. replays vs. logs) rather than treating
/// every 429 the same, so dropping these here would make the webview keep
/// sending envelopes a category-specific limit already asked it to pause.
#[derive(serde::Serialize)]
struct SentryEnvelopeForwardResult {
    status_code: u16,
    #[serde(rename = "x-sentry-rate-limits")]
    rate_limits: Option<String>,
    #[serde(rename = "retry-after")]
    retry_after: Option<String>,
}

/// Forwards a Sentry envelope from the frontend SDK to Sentry's ingest API
/// over a plain Rust-side HTTP request instead of the webview's own
/// fetch/XHR — the desktop CSP's `connect-src` doesn't allow the webview to
/// reach Sentry's ingest host directly (see `instrument.ts`'s
/// `makeTauriIpcTransport` doc comment), so the frontend SDK is configured
/// with a custom `transport` that pipes every outgoing envelope through this
/// IPC command instead. `envelope_base64` because Tauri IPC arguments are
/// JSON-encoded strings and Sentry envelopes (especially replay/profiling
/// attachments) are binary. Gated on the same `observability.json` consent
/// check `init_sentry_from_settings` uses — belt-and-suspenders, since the
/// frontend only calls this after its own `Sentry.init` already checked
/// `settings.sentryEnabled`.
///
/// Builds its own `X-Sentry-Auth` header via `Dsn::to_auth` — unlike
/// `store_api_url`/`envelope_api_url`, which are bare endpoint URLs with no
/// embedded credentials, Sentry's ingest API rejects an envelope POST that
/// doesn't authenticate this way (the browser SDK's own transport builds the
/// same header; this just replicates it on the Rust side of the tunnel).
#[tauri::command]
async fn forward_sentry_envelope<R: tauri::Runtime>(
    app: tauri::AppHandle<R>,
    envelope_base64: String,
) -> Result<SentryEnvelopeForwardResult, String> {
    use base64::Engine as _;

    let app_data_dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    if !observability_enabled_from_store(&app_data_dir) {
        return Err("observability consent not granted".to_string());
    }

    let dsn = resolve_sentry_dsn().ok_or_else(|| "SENTRY_DSN not configured".to_string())?;
    let parsed: sentry::types::Dsn = dsn
        .parse()
        .map_err(|e| format!("invalid Sentry DSN: {e}"))?;
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(envelope_base64)
        .map_err(|e| format!("invalid envelope encoding: {e}"))?;

    let auth = parsed
        .to_auth(Some("sentry.charm-tauri-tunnel/1.0"))
        .to_string();
    let client = reqwest::Client::new();
    let response = client
        .post(parsed.envelope_api_url().as_str())
        .header("Content-Type", "application/x-sentry-envelope")
        .header("X-Sentry-Auth", auth)
        .body(bytes)
        .send()
        .await
        .map_err(|e| format!("envelope forward failed: {e}"))?;

    let status = response.status();
    let header = |name: &str| {
        response
            .headers()
            .get(name)
            .and_then(|value| value.to_str().ok())
            .map(str::to_owned)
    };
    let rate_limits = header("x-sentry-rate-limits");
    let retry_after = header("retry-after");
    if !status.is_success() {
        tracing::warn!(
            status = status.as_u16(),
            "Sentry envelope forward returned a non-success status"
        );
    }
    Ok(SentryEnvelopeForwardResult {
        status_code: status.as_u16(),
        rate_limits,
        retry_after,
    })
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
    let dsn = resolve_sentry_dsn()?;
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

/// Enables getUserMedia and grants its camera/mic requests on WebKitGTK
/// (Spec 13). Two separate gates, both closed by default:
///
/// 1. `Settings:enable-media-stream` (and `enable-webrtc`) default to
///    `FALSE` in WebKitGTK — wry's own webview setup only turns on
///    WebGL/WebAudio/page-cache, not these, so without enabling them here
///    `getUserMedia` is undefined at the JS layer and the permission signal
///    below is never even reached.
/// 2. The `permission-request` signal itself has no default handler and no
///    OS-level consent gate behind it (no TCC-style prompt) — left
///    unhandled, it silently denies.
///
/// Tauri's own webview only ever loads this app's first-party frontend,
/// never arbitrary web content, so granting unconditionally here matches
/// wry's own macOS/iOS `WKUIDelegate` behavior — that also grants
/// unconditionally at the webview layer, relying on the OS's own TCC prompt
/// (triggered separately by AVFoundation) as the real consent gate. Linux has
/// no equivalent OS-level camera/mic permission system for a non-sandboxed
/// native binary, so there is no such second gate to rely on here.
#[cfg(target_os = "linux")]
fn linux_wire_user_media_permission(platform_webview: tauri::webview::PlatformWebview) {
    use webkit2gtk::glib::Cast;
    use webkit2gtk::{PermissionRequestExt, SettingsExt, WebViewExt};

    let webview: webkit2gtk::WebView = platform_webview.inner();

    if let Some(settings) = webview.settings() {
        settings.set_enable_media_stream(true);
        settings.set_enable_webrtc(true);
    }

    webview.connect_permission_request(|_webview, request| {
        match request.downcast_ref::<webkit2gtk::UserMediaPermissionRequest>() {
            Some(user_media) => {
                user_media.allow();
                true
            }
            None => false,
        }
    });
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
            // Desktop-only: a review bot on PR #228 correctly pointed out
            // that Android/iOS routinely have their process killed by the
            // OS during normal backgrounding lifecycle management, which
            // never reaches `RunEvent::Exit` — treating that as "crashed"
            // would show the crash-recovery prompt on ordinary mobile
            // launches that never actually crashed. Desktop's tray-menu
            // Quit/window-close paths don't have this ambiguity (see the
            // `RunEvent::Exit` comment below).
            #[cfg(desktop)]
            {
                if let Ok(app_data_dir) = app.path().app_data_dir() {
                    let crashed = take_previous_session_crash_flag(&app_data_dir);
                    app.manage(PreviousSessionCrash(crashed));
                } else {
                    app.manage(PreviousSessionCrash(false));
                }
            }
            #[cfg(not(desktop))]
            app.manage(PreviousSessionCrash(false));
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
            // Spec 13: WebKitGTK's `permission-request` signal has no default
            // handler and, unlike macOS/Windows/Android, no OS-level consent
            // gate behind it — left unhandled, it silently denies and
            // getUserMedia never resolves. See `linux_wire_user_media_permission`.
            #[cfg(target_os = "linux")]
            if let Some(webview) = app.get_webview_window("main") {
                if let Err(e) = webview.with_webview(linux_wire_user_media_permission) {
                    eprintln!("failed to wire WebKitGTK user-media permission handling: {e}");
                }
            }
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
            had_unclean_previous_session,
            forward_sentry_envelope,
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
        .build(tauri::generate_context!())
        .expect("error while running tauri application")
        .run(|app_handle, event| {
            // Mirror of `take_previous_session_crash_flag` in `setup()`: a
            // clean `Exit` means this process is shutting down in an orderly
            // way, so clear the marker before it happens. A crash/kill never
            // reaches this callback, which is exactly what leaves the marker
            // behind for the next launch to notice.
            #[cfg(desktop)]
            if let tauri::RunEvent::Exit = event {
                if let Ok(app_data_dir) = app_handle.path().app_data_dir() {
                    mark_clean_exit(&app_data_dir);
                }
            }
            #[cfg(not(desktop))]
            let _ = (app_handle, event);
        });
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

    #[test]
    fn crash_flag_is_false_on_first_launch() {
        let dir = tempfile::tempdir().expect("tempdir");
        assert!(!take_previous_session_crash_flag(dir.path()));
    }

    #[test]
    fn crash_flag_is_true_after_an_unclean_exit() {
        let dir = tempfile::tempdir().expect("tempdir");
        // First launch: no marker yet, so no crash reported, but this
        // session's own marker is now written...
        assert!(!take_previous_session_crash_flag(dir.path()));
        // ...and never cleared (simulating a crash/kill instead of the
        // `RunEvent::Exit` handler running `mark_clean_exit`), so the next
        // launch sees it and reports true.
        assert!(take_previous_session_crash_flag(dir.path()));
    }

    #[test]
    fn crash_flag_is_false_after_a_clean_exit() {
        let dir = tempfile::tempdir().expect("tempdir");
        assert!(!take_previous_session_crash_flag(dir.path()));
        mark_clean_exit(dir.path());
        assert!(!take_previous_session_crash_flag(dir.path()));
    }

    #[test]
    fn sentry_dsn_prefers_runtime_env_over_baked() {
        let resolved = resolve_sentry_dsn_from(
            Some("https://runtime@example/1".to_owned()),
            Some("https://baked@example/2"),
        );
        assert_eq!(resolved.as_deref(), Some("https://runtime@example/1"));
    }

    #[test]
    fn sentry_dsn_falls_back_to_baked_value() {
        let resolved = resolve_sentry_dsn_from(None, Some("https://baked@example/2"));
        assert_eq!(resolved.as_deref(), Some("https://baked@example/2"));
    }

    #[test]
    fn sentry_dsn_treats_empty_env_value_as_unset() {
        let resolved =
            resolve_sentry_dsn_from(Some(String::new()), Some("https://baked@example/2"));
        assert_eq!(resolved.as_deref(), Some("https://baked@example/2"));
    }

    #[test]
    fn sentry_dsn_treats_empty_baked_value_as_unset() {
        // The bug a review bot caught: `SENTRY_DSN: ${{ cond && secrets.X || '' }}`
        // bakes `Some("")` via option_env! when `cond` is false, not `None`.
        let resolved = resolve_sentry_dsn_from(None, Some(""));
        assert_eq!(resolved, None);
    }

    #[test]
    fn sentry_dsn_is_none_without_env_or_baked_value() {
        assert_eq!(resolve_sentry_dsn_from(None, None), None);
    }
}
