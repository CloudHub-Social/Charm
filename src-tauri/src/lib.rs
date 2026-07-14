// Deeply nested #[instrument] async fns in matrix-sdk-crypto's Store trait can
// overflow the default trait-solver recursion limit while proving Send-ness
// (rustc issue class: "overflow evaluating the requirement ... Send"), which
// is sensitive to the exact compiler/runner environment — observed on CI's
// macos-latest runner but not locally. Raising the limit avoids the overflow.
#![recursion_limit = "512"]

pub mod feature_flags;
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

/// Compile-time-baked fallback for `SENTRY_ENVIRONMENT` — same reasoning as
/// `BAKED_SENTRY_DSN` above, and needed for the same reason: a review bot on
/// PR #228 caught that once the baked DSN lets native Rust Sentry actually
/// activate in an installed nightly, `init_sentry_from_settings`'s
/// `std::env::var("SENTRY_ENVIRONMENT")` read would still find nothing at
/// runtime, filing Rust events under Sentry's default environment while the
/// frontend (`import.meta.env.VITE_SENTRY_ENVIRONMENT`, inlined by Vite at
/// compile time) correctly tags them `nightly`/`production`.
const BAKED_SENTRY_ENVIRONMENT: Option<&str> = option_env!("SENTRY_ENVIRONMENT");

/// Shared by `resolve_sentry_dsn`/`resolve_sentry_environment`: prefers a
/// present, non-empty runtime env var, falling back to a present, non-empty
/// compile-time-baked value. Pulled out as a pure function so this priority
/// order (including the empty-string-is-unset case) is unit-testable
/// without an actual process environment — same reasoning as
/// `resolve_build_id_tag`.
fn resolve_env_or_baked(env_value: Option<String>, baked: Option<&str>) -> Option<String> {
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
    resolve_env_or_baked(std::env::var("SENTRY_DSN").ok(), BAKED_SENTRY_DSN)
}

fn resolve_sentry_environment() -> Option<String> {
    resolve_env_or_baked(
        std::env::var("SENTRY_ENVIRONMENT").ok(),
        BAKED_SENTRY_ENVIRONMENT,
    )
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
    if let Err(error) = std::fs::create_dir_all(app_data_dir) {
        tracing::warn!(%error, "failed to create app data dir for the crash marker");
        return false;
    }
    let path = crash_marker_path(app_data_dir);
    let previous_session_unclean = path.exists();
    // Best-effort: a failure here (disk full, permissions) just means this
    // session's own marker doesn't get written, so a crash mid-session
    // wouldn't be detected next launch — logged (not propagated) since
    // there's no reasonable recovery action and the crash-recovery prompt
    // is itself only a nice-to-have nudge, not safety-critical.
    if let Err(error) = std::fs::write(&path, b"running") {
        tracing::warn!(%error, "failed to write the crash marker file");
    }
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

/// Keeps `tracing-appender`'s background flush thread alive for the app's
/// lifetime — dropping this guard (e.g. if it were a local in `.setup()`)
/// stops the writer and silently truncates the log file.
#[allow(dead_code)]
struct TracingFileGuard(tracing_appender::non_blocking::WorkerGuard);

/// Redacts each formatted event the same way `scrub_log` already does for
/// Sentry logs before writing it to the persistent file. Unlike the Sentry
/// path, this file layer is unconditional (not gated on the user's logs
/// consent — see `install_tracing`'s doc comment), so without this a native
/// error containing a Matrix ID, homeserver URL, or MXC URI (e.g. the
/// `%error` fields logged in `matrix::sync`/`matrix::verification`) would
/// land in cleartext on disk regardless of consent.
///
/// Buffers every `write()` call instead of scrubbing each one independently:
/// `tracing_subscriber::fmt` can — and does, for a structured field like
/// `access_token = %token` — split a single event's formatted output across
/// several `write()` calls (field name, `=`, value written separately), so
/// scrubbing per-call could see e.g. `access_token=` and the token itself as
/// two unrelated chunks and redact neither. `MakeWriter::make_writer` is
/// called once per event (a fresh `Self::Writer` each time — see
/// `ScrubbingMakeWriter` below), so accumulating everything written through
/// one instance and scrubbing it as a whole on `Drop` covers exactly one
/// event's complete output, however many `write()` calls it took to produce.
struct ScrubbingWriter<W: std::io::Write> {
    inner: W,
    buffer: Vec<u8>,
}

impl<W: std::io::Write> ScrubbingWriter<W> {
    /// Scrubs and forwards whatever is currently buffered, then clears the
    /// buffer — shared by `flush()` and `Drop` so both actually deliver
    /// buffered data to `inner` rather than only one of them.
    fn flush_buffer(&mut self) {
        if self.buffer.is_empty() {
            return;
        }
        let scrubbed =
            observability_scrub::scrub_sensitive_text(&String::from_utf8_lossy(&self.buffer));
        let _ = self.inner.write_all(scrubbed.as_bytes());
        self.buffer.clear();
    }
}

impl<W: std::io::Write> std::io::Write for ScrubbingWriter<W> {
    fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
        self.buffer.extend_from_slice(buf);
        Ok(buf.len())
    }

    fn flush(&mut self) -> std::io::Result<()> {
        // `Write::flush`'s contract is that any buffered data has reached
        // the underlying sink once this returns — calling `inner.flush()`
        // alone (the previous bug) left our own buffer un-forwarded, so
        // data was only ever written on `Drop`, not on an explicit `flush()`.
        self.flush_buffer();
        self.inner.flush()
    }
}

impl<W: std::io::Write> Drop for ScrubbingWriter<W> {
    fn drop(&mut self) {
        self.flush_buffer();
    }
}

/// `MakeWriter` adapter wrapping every writer produced (one per event, per
/// the `MakeWriter` contract) in `ScrubbingWriter` — this crate's
/// `tracing-subscriber` version has no `MakeWriterExt::map_writer`
/// combinator to do this inline.
struct ScrubbingMakeWriter<M>(M);

impl<'a, M> tracing_subscriber::fmt::MakeWriter<'a> for ScrubbingMakeWriter<M>
where
    M: tracing_subscriber::fmt::MakeWriter<'a>,
{
    type Writer = ScrubbingWriter<M::Writer>;

    fn make_writer(&'a self) -> Self::Writer {
        ScrubbingWriter {
            inner: self.0.make_writer(),
            buffer: Vec::new(),
        }
    }
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

/// Installs the process-global `tracing` subscriber exactly once, regardless
/// of whether Sentry consent is on: the native app's own diagnostics (e.g.
/// the sync-loop failures in `matrix::sync`) are emitted via `tracing::*!`
/// macros, not the `log` crate, so `tauri-plugin-log`'s `LogDir` target (which
/// only captures `log::*!` calls) never sees them on its own — before this,
/// a user who hadn't opted into Sentry had literally no persisted trail of
/// their own app's errors. The file layer here is unconditional; the Sentry
/// bridging layer is attached alongside it only when `sentry_enabled` (i.e.
/// `init_sentry_from_settings` is about to, or just did, call `sentry::init`).
/// Called once from `run()`'s `.setup()`, before `init_sentry_from_settings`,
/// since `tracing::subscriber::set_global_default` can only succeed once per
/// process. See the 2026-07-13 blank-page-on-launch investigation.
fn install_tracing<R: tauri::Runtime>(app: &tauri::App<R>, sentry_enabled: bool) -> bool {
    if SENTRY_TRACING_INSTALLED.swap(true, Ordering::SeqCst) {
        return true;
    }

    // Same Info/Debug split as the tauri-plugin-log registration below —
    // without this filter the layer accepts every level from every crate
    // (including matrix-sdk's own DEBUG/TRACE spans) into the persistent
    // file regardless of build type.
    let file_level = if cfg!(debug_assertions) {
        tracing::level_filters::LevelFilter::DEBUG
    } else {
        tracing::level_filters::LevelFilter::INFO
    };
    let file_layer = app.path().app_log_dir().ok().and_then(|dir| {
        std::fs::create_dir_all(&dir).ok()?;
        // The non-`Builder` `rolling::daily` constructor panics on an
        // unopenable file (e.g. permissions changed, disk full); go through
        // the fallible `Builder` instead so that case just disables file
        // logging for this run rather than aborting startup from inside
        // `.setup()`.
        let appender = tracing_appender::rolling::Builder::new()
            .rotation(tracing_appender::rolling::Rotation::DAILY)
            .filename_prefix("charm.log")
            .build(&dir)
            .inspect_err(|error| eprintln!("failed to open log file in {dir:?}: {error}"))
            .ok()?;
        let (writer, guard) = tracing_appender::non_blocking(appender);
        app.manage(TracingFileGuard(guard));
        Some(
            tracing_subscriber::fmt::layer()
                .with_ansi(false)
                .with_writer(ScrubbingMakeWriter(writer))
                .with_filter(file_level),
        )
    });
    if file_layer.is_none() {
        eprintln!("failed to resolve app log dir; file logging disabled for this run");
    }

    let sentry_layer = sentry_enabled.then(|| {
        sentry::integrations::tracing::layer()
            .event_filter(sentry_event_filter)
            .span_filter(|metadata| {
                sentry_span_filter(metadata) && runtime_observability_logs_enabled()
            })
    });

    let subscriber = tracing_subscriber::registry()
        .with(file_layer)
        .with(sentry_layer);

    match tracing::subscriber::set_global_default(subscriber) {
        Ok(()) => true,
        Err(error) => {
            eprintln!("failed to install tracing subscriber: {error}");
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

/// Returns every catalog flag resolved to a boolean for this install
/// (local override over static default). The frontend seeds its own resolver
/// cache from this so JS and the Rust core agree on flag state for the same
/// install. Read-only — the frontend owns override *writes* (Spec 34's Labs
/// panel persists them into `feature-flags.json`, which this reads).
#[tauri::command]
fn get_feature_flags<R: tauri::Runtime>(
    app: tauri::AppHandle<R>,
) -> Result<std::collections::BTreeMap<String, bool>, String> {
    let app_data_dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    let overrides = feature_flags::read_overrides(&app_data_dir);
    Ok(feature_flags::FeatureFlagKey::ALL
        .iter()
        .map(|&key| {
            (
                key.as_wire_key().to_string(),
                feature_flags::resolve(key, &overrides),
            )
        })
        .collect())
}

/// Returns the flag catalog metadata (key, default, description, owner) for the
/// Labs panel to render. Authoritative list lives in `feature_flags.rs`.
#[tauri::command]
fn get_feature_flag_catalog() -> Vec<feature_flags::FeatureFlagCatalogEntry> {
    feature_flags::catalog()
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

/// Whether `init_sentry_from_settings` is about to call `sentry::init` —
/// computed ahead of that call so `install_tracing` (which must run first,
/// see its doc comment) knows whether to attach the Sentry bridging layer.
/// Uses `resolve_sentry_dsn()` (not a bare runtime-only lookup) so this
/// agrees with `init_sentry_from_settings` on whether a compile-time-baked
/// DSN counts — see that function's own baked-DSN doc comment (PR #228).
fn sentry_enabled_at_launch<R: tauri::Runtime>(app: &tauri::App<R>) -> bool {
    resolve_sentry_dsn().is_some()
        && app
            .path()
            .app_data_dir()
            .ok()
            .is_some_and(|dir| observability_enabled_from_store(&dir))
}

fn init_sentry_from_settings<R: tauri::Runtime>(
    app: &tauri::App<R>,
    tracing_installed: bool,
    sentry_enabled: bool,
) -> Option<SentryGuard> {
    if !sentry_enabled {
        return None;
    }
    let dsn = resolve_sentry_dsn()?;
    let app_data_dir = app.path().app_data_dir().ok()?;

    let logs_enabled = observability_logs_enabled_from_store(&app_data_dir);
    update_runtime_observability_logs_enabled(logs_enabled);
    let environment = resolve_sentry_environment().map(Cow::Owned);
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

    // Registered first and independent of Sentry consent — mirrors `log::*!`
    // calls to stdout and the webview console. Deliberately omits
    // `TargetKind::LogDir`: that target's file open happens inside this
    // plugin's own `.setup()` and propagates any I/O error (permissions, a
    // root-owned leftover file, a full disk) through `?` — since `run()`
    // below `.expect()`s the overall `.run(...)` result, an unopenable log
    // file there would panic and abort the whole app before any window
    // renders, exactly the blank-page/no-page class of bug this file's
    // `install_tracing` exists to fix. Persistent file logging instead comes
    // entirely from `install_tracing`'s own tracing-appender layer, which
    // already treats an unopenable file as "disable file logging for this
    // run" rather than fatal (see its doc comment). See the 2026-07-13
    // blank-page-on-launch investigation.
    let builder = builder.plugin(
        tauri_plugin_log::Builder::new()
            .targets([
                tauri_plugin_log::Target::new(tauri_plugin_log::TargetKind::Stdout),
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
            // Read once and pass to both calls below, rather than letting
            // each independently re-read observability.json from disk: the
            // file can change between two reads (e.g. the frontend writing a
            // settings update at the same moment), which could otherwise
            // install_tracing's Sentry bridging layer for one value of
            // sentryEnabled while init_sentry_from_settings initializes the
            // client for a different one — silently dropping every
            // tracing::*! event Sentry would otherwise have received.
            let sentry_enabled = sentry_enabled_at_launch(app);
            // Must run before `init_sentry_from_settings`: both attach to the
            // one process-global `tracing` subscriber, which can only be set
            // once — see `install_tracing`'s doc comment.
            let tracing_installed = install_tracing(app, sentry_enabled);
            if let Some(sentry_guard) =
                init_sentry_from_settings(app, tracing_installed, sentry_enabled)
            {
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
            get_feature_flags,
            get_feature_flag_catalog,
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
    fn scrubbing_writer_redacts_matrix_ids_and_secrets_before_the_inner_write() {
        use std::io::Write;

        let mut buffer = Vec::new();
        {
            let mut writer = ScrubbingWriter {
                inner: &mut buffer,
                buffer: Vec::new(),
            };
            writer
                .write_all(b"failed for @alice:example.org access_token=secret")
                .expect("write to an in-memory Vec never fails");
            // Drop flushes the buffered-and-scrubbed output to `inner`.
        }

        assert_eq!(
            String::from_utf8(buffer).expect("scrubbed output is valid UTF-8"),
            "failed for @[redacted]:[redacted] access_token=[redacted]"
        );
    }

    #[test]
    fn scrubbing_writer_redacts_a_secret_split_across_multiple_write_calls() {
        // The exact failure mode Codex flagged on #227: tracing_subscriber's
        // fmt formatter can write a structured field's name, separator, and
        // value as separate `write()` calls — scrubbing each independently
        // would see "access_token=" and "secret" as unrelated chunks and
        // redact neither.
        use std::io::Write;

        let mut buffer = Vec::new();
        {
            let mut writer = ScrubbingWriter {
                inner: &mut buffer,
                buffer: Vec::new(),
            };
            writer.write_all(b"failed: access_token=").expect("write 1");
            writer.write_all(b"super-secret-value").expect("write 2");
        }

        assert_eq!(
            String::from_utf8(buffer).expect("scrubbed output is valid UTF-8"),
            "failed: access_token=[redacted]"
        );
    }

    #[test]
    fn scrubbing_writer_flush_delivers_buffered_data_without_needing_drop() {
        // Write::flush's contract is that buffered data has reached the
        // inner writer once it returns — a caller that flushes and inspects
        // the sink before the ScrubbingWriter is dropped must see the data.
        use std::io::Write;

        let mut buffer = Vec::new();
        let mut writer = ScrubbingWriter {
            inner: &mut buffer,
            buffer: Vec::new(),
        };
        writer
            .write_all(b"failed for @alice:example.org")
            .expect("write");
        writer.flush().expect("flush");
        drop(writer);

        assert_eq!(
            String::from_utf8(buffer).expect("scrubbed output is valid UTF-8"),
            "failed for @[redacted]:[redacted]"
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
        let resolved = resolve_env_or_baked(
            Some("https://runtime@example/1".to_owned()),
            Some("https://baked@example/2"),
        );
        assert_eq!(resolved.as_deref(), Some("https://runtime@example/1"));
    }

    #[test]
    fn sentry_dsn_falls_back_to_baked_value() {
        let resolved = resolve_env_or_baked(None, Some("https://baked@example/2"));
        assert_eq!(resolved.as_deref(), Some("https://baked@example/2"));
    }

    #[test]
    fn sentry_dsn_treats_empty_env_value_as_unset() {
        let resolved = resolve_env_or_baked(Some(String::new()), Some("https://baked@example/2"));
        assert_eq!(resolved.as_deref(), Some("https://baked@example/2"));
    }

    #[test]
    fn sentry_dsn_treats_empty_baked_value_as_unset() {
        // The bug a review bot caught: `SENTRY_DSN: ${{ cond && secrets.X || '' }}`
        // bakes `Some("")` via option_env! when `cond` is false, not `None`.
        let resolved = resolve_env_or_baked(None, Some(""));
        assert_eq!(resolved, None);
    }

    #[test]
    fn sentry_dsn_is_none_without_env_or_baked_value() {
        assert_eq!(resolve_env_or_baked(None, None), None);
    }

    #[test]
    fn sentry_environment_prefers_runtime_env_over_baked() {
        let resolved = resolve_env_or_baked(Some("staging".to_owned()), Some("production"));
        assert_eq!(resolved.as_deref(), Some("staging"));
    }

    #[test]
    fn sentry_environment_falls_back_to_baked_value() {
        let resolved = resolve_env_or_baked(None, Some("nightly"));
        assert_eq!(resolved.as_deref(), Some("nightly"));
    }
}
