//! Sentry error/log capture for this crate — mirrors desktop's Sentry setup
//! (`src-tauri/src/lib.rs`'s `init_sentry_from_settings` and friends) but
//! without a per-user consent toggle: this is a headless backend process
//! with no settings UI and no single end user to ask, so its one and only
//! opt-in gate is operator-controlled — whether [`SENTRY_DSN_ENV`] is set at
//! all, the same "absent env var means the feature is off" shape
//! `persistence.rs`'s `PersistenceStore::from_env` already uses for session
//! persistence.
//!
//! Shares its actual redaction rules (secret-field patterns, Matrix
//! ID/MXC URI scrubbing) and Sentry tracing-bridge filtering with desktop via
//! `charm_lib::observability_scrub`, so the two can't silently drift apart —
//! see that module's doc comment.
//!
//! **Consent/PII note:** even though there's no per-*operator* consent
//! toggle here, the events this crate could ever emit are about *users of
//! the service* (Matrix IDs, room IDs, error text derived from a session's
//! own state), not the operator — so redaction is unconditional and always
//! on whenever Sentry is configured at all, matching `PRIVACY.md`'s
//! guarantee that Matrix identifiers never reach Sentry regardless of
//! platform.

use std::borrow::Cow;

use tracing_subscriber::prelude::*;

/// Set to opt into Sentry error/log capture for this process — unset (the
/// default) means no `sentry::init` call happens at all, and this crate logs
/// only via the existing `tracing_subscriber::fmt` layer to stdout (what
/// DigitalOcean App Platform's log viewer/`doctl apps logs` already reads).
pub const SENTRY_DSN_ENV: &str = "CHARM_WEB_SERVER_SENTRY_DSN";

/// Optional; passed through to `sentry::ClientOptions::environment`. Common
/// values: `production`, `dev`. Unset means Sentry's own default (no
/// environment tag on events).
pub const SENTRY_ENVIRONMENT_ENV: &str = "CHARM_WEB_SERVER_SENTRY_ENVIRONMENT";

/// Optional override for `sentry::ClientOptions::release`; falls back to
/// `sentry::release_name!()` (this crate's `CARGO_PKG_NAME@CARGO_PKG_VERSION`)
/// when unset. Unlike the frontend/desktop/Android release pipelines (see
/// `.github/scripts/configure-sentry-release-env.sh`), nothing in CI sets
/// this for `charm-web-server` today — the crate-version fallback is
/// intentionally the whole story until/unless a release process is built
/// for this deploy target too.
pub const SENTRY_RELEASE_ENV: &str = "CHARM_WEB_SERVER_SENTRY_RELEASE";

/// Crate targets the Sentry tracing bridge forwards — this crate's own
/// `tracing::info!`/`warn!` calls (`charm_web_server`) plus whatever it
/// calls into on `charm_lib` (e.g. `charm_lib::matrix::presence`). Deliberately
/// excludes `matrix_sdk`/`axum`/etc — see
/// `charm_lib::observability_scrub::is_tracing_target_allowed`'s doc comment
/// for why an unscoped bridge would be counterproductive.
///
/// Includes `"charm"` alongside `"charm_lib"` even though every module
/// actually compiled into *this* binary uses the `charm_lib` target (the
/// `[lib] name = "charm_lib"` in `src-tauri/Cargo.toml`; `"charm"` is only
/// the separate desktop *binary* target's own module path, which
/// `charm-web-server` never links against or executes) — matching desktop's
/// own `DESKTOP_SENTRY_TRACING_CRATES` list keeps the two from silently
/// drifting apart, and costs nothing here since no tracing event in this
/// process can ever actually carry a `"charm"`-prefixed target to begin
/// with.
const SENTRY_TRACING_CRATES: &[&str] = &["charm_web_server", "charm", "charm_lib"];

/// Holds the process alive for the life of `main` — dropping this flushes
/// and tears down the Sentry client. `None` when Sentry isn't configured
/// (`SENTRY_DSN_ENV` unset).
#[must_use = "dropping this immediately would flush/close the Sentry client right after opening it — bind it in `main` for the life of the process"]
pub struct SentryGuard {
    _client: sentry::ClientInitGuard,
}

/// Env-derived Sentry client configuration — split out from [`init`] so the
/// "does the environment actually opt into Sentry, and with what settings"
/// decision is unit-testable without touching `sentry::init`/
/// `tracing_subscriber`'s process-global state (each is one-shot per
/// process — a test calling either more than once, or racing another test
/// that also calls them, panics or silently no-ops depending on which).
struct SentryConfig {
    dsn: String,
    environment: Option<Cow<'static, str>>,
    release: Option<Cow<'static, str>>,
}

/// Reads [`SENTRY_DSN_ENV`]/[`SENTRY_ENVIRONMENT_ENV`]/[`SENTRY_RELEASE_ENV`]
/// — `None` when the DSN is unset or empty, the same "absent means off"
/// contract `PersistenceStore::from_env` uses for
/// `CHARM_WEB_SERVER_MASTER_KEY`. Pure aside from the env reads themselves,
/// so tests can exercise it directly.
/// Reads and trims an env var, returning `None` for unset *or* whitespace-only
/// (including a lone trailing newline, which secret managers commonly inject)
/// — same trim-then-check-empty shape `PersistenceStore::from_env` already
/// uses for `CHARM_WEB_SERVER_MASTER_KEY`, so a trailing newline can't
/// silently turn into part of a DSN/environment/release value, or make an
/// effectively-blank value read as "configured".
fn trimmed_env_var(key: &str) -> Option<String> {
    std::env::var(key)
        .ok()
        .map(|value| value.trim().to_owned())
        .filter(|value| !value.is_empty())
}

fn resolve_sentry_config_from_env() -> Option<SentryConfig> {
    let dsn = trimmed_env_var(SENTRY_DSN_ENV)?;
    let environment = trimmed_env_var(SENTRY_ENVIRONMENT_ENV).map(Cow::Owned);
    let release = trimmed_env_var(SENTRY_RELEASE_ENV)
        .map(Cow::Owned)
        .or_else(|| sentry::release_name!());
    Some(SentryConfig {
        dsn,
        environment,
        release,
    })
}

/// Sets up `tracing_subscriber` (always: a plain `fmt` layer to stdout, same
/// as before this module existed) and, if [`SENTRY_DSN_ENV`] is set,
/// initializes a Sentry client and layers its tracing bridge on top. Call
/// this once, at the very top of `main`, before anything else logs —
/// `tracing_subscriber::fmt::init()`'s old call site.
///
/// Returns `None` when Sentry isn't configured; the caller doesn't need to
/// do anything with that beyond binding the `Option` so a `Some` guard lives
/// for the rest of `main` (an unbound temporary would drop — and tear down
/// the client — immediately).
pub fn init() -> Option<SentryGuard> {
    let Some(config) = resolve_sentry_config_from_env() else {
        tracing_subscriber::registry()
            .with(default_env_filter())
            .with(tracing_subscriber::fmt::layer())
            .init();
        tracing::info!(
            "{SENTRY_DSN_ENV} not set — error/log capture is stdout-only for this process"
        );
        return None;
    };

    let client = sentry::init((
        config.dsn,
        sentry::ClientOptions {
            release: config.release,
            environment: config.environment,
            send_default_pii: false,
            traces_sample_rate: if cfg!(debug_assertions) { 1.0 } else { 0.2 },
            auto_session_tracking: true,
            session_mode: sentry::SessionMode::Application,
            enable_logs: true,
            before_send: Some(std::sync::Arc::new(
                charm_lib::observability_scrub::scrub_event,
            )),
            before_send_log: Some(std::sync::Arc::new(scrub_log)),
            ..Default::default()
        },
    ));

    let sentry_layer = sentry::integrations::tracing::layer()
        .event_filter(sentry_event_filter)
        .span_filter(sentry_span_filter);
    tracing_subscriber::registry()
        .with(default_env_filter())
        .with(tracing_subscriber::fmt::layer())
        .with(sentry_layer)
        .init();

    tracing::info!("Sentry error/log capture initialized for charm-web-server");
    Some(SentryGuard { _client: client })
}

/// Same default `tracing_subscriber::fmt::init()` used before this module
/// existed — `RUST_LOG` if set and valid, otherwise `info`-level. Built
/// fresh per branch (rather than shared/cloned) since `EnvFilter` reads
/// `RUST_LOG` itself and constructing it is cheap; this keeps both call
/// sites in [`init`] honoring the exact same default.
fn default_env_filter() -> tracing_subscriber::EnvFilter {
    tracing_subscriber::EnvFilter::try_from_default_env()
        .unwrap_or_else(|_| tracing_subscriber::EnvFilter::new("info"))
}

/// Unconditional Sentry `before_send_log` hook — no consent gate to check
/// (see this module's doc comment), just the shared redaction rules.
fn scrub_log(mut log: sentry::protocol::Log) -> Option<sentry::protocol::Log> {
    charm_lib::observability_scrub::scrub_log_in_place(&mut log);
    Some(log)
}

fn sentry_event_filter(
    metadata: &tracing::Metadata<'_>,
) -> sentry::integrations::tracing::EventFilter {
    use sentry::integrations::tracing::EventFilter;

    match *metadata.level() {
        tracing::Level::ERROR | tracing::Level::WARN | tracing::Level::INFO => {
            charm_lib::observability_scrub::sentry_event_filter_for_level_target(
                metadata.level(),
                metadata.target(),
                true,
                SENTRY_TRACING_CRATES,
            )
        }
        tracing::Level::DEBUG | tracing::Level::TRACE => EventFilter::Ignore,
    }
}

fn sentry_span_filter(metadata: &tracing::Metadata<'_>) -> bool {
    charm_lib::observability_scrub::sentry_span_filter_for_level_target(
        metadata.level(),
        metadata.target(),
        SENTRY_TRACING_CRATES,
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Serializes access to the process-global `SENTRY_DSN_ENV`/etc across
    /// this module's tests — `std::env::set_var`/`remove_var` affect the
    /// whole process, so concurrent tests touching the same var would
    /// otherwise race (same pattern `persistence.rs`'s `ENV_LOCK` uses for
    /// `CHARM_WEB_SERVER_MASTER_KEY`).
    static ENV_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

    struct EnvVarGuard {
        key: &'static str,
        previous: Option<String>,
    }

    impl EnvVarGuard {
        fn remove(key: &'static str) -> Self {
            let previous = std::env::var(key).ok();
            unsafe {
                std::env::remove_var(key);
            }
            Self { key, previous }
        }

        fn set(key: &'static str, value: &str) -> Self {
            let previous = std::env::var(key).ok();
            unsafe {
                std::env::set_var(key, value);
            }
            Self { key, previous }
        }
    }

    impl Drop for EnvVarGuard {
        fn drop(&mut self) {
            match &self.previous {
                Some(value) => unsafe { std::env::set_var(self.key, value) },
                None => unsafe { std::env::remove_var(self.key) },
            }
        }
    }

    /// Without `SENTRY_DSN_ENV` set, `init()` must not attempt
    /// `sentry::init` at all (which would otherwise try to reach out to
    /// whatever URL is left over from a stale/empty value) — it should just
    /// return `None` and fall back to plain stdout logging, the same
    /// "absent env var means the feature is off" contract
    /// `PersistenceStore::from_env` already guarantees for session
    /// persistence.
    #[test]
    fn resolve_sentry_config_is_none_without_a_dsn_configured() {
        let _lock = ENV_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let _no_dsn = EnvVarGuard::remove(SENTRY_DSN_ENV);

        assert!(resolve_sentry_config_from_env().is_none());
    }

    #[test]
    fn resolve_sentry_config_is_none_for_an_empty_dsn() {
        let _lock = ENV_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let _empty_dsn = EnvVarGuard::set(SENTRY_DSN_ENV, "");

        assert!(
            resolve_sentry_config_from_env().is_none(),
            "an empty string must be treated the same as unset, not as a real (invalid) DSN"
        );
    }

    #[test]
    fn resolve_sentry_config_reads_dsn_environment_and_release_from_env() {
        let _lock = ENV_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let _dsn = EnvVarGuard::set(SENTRY_DSN_ENV, "https://key@example.invalid/1");
        let _environment = EnvVarGuard::set(SENTRY_ENVIRONMENT_ENV, "dev");
        let _release = EnvVarGuard::set(SENTRY_RELEASE_ENV, "charm-web-server@test");

        let config = resolve_sentry_config_from_env().expect("dsn is set");

        assert_eq!(config.dsn, "https://key@example.invalid/1");
        assert_eq!(config.environment.as_deref(), Some("dev"));
        assert_eq!(config.release.as_deref(), Some("charm-web-server@test"));
    }

    #[test]
    fn resolve_sentry_config_falls_back_to_the_crate_release_name_when_unset() {
        let _lock = ENV_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let _dsn = EnvVarGuard::set(SENTRY_DSN_ENV, "https://key@example.invalid/1");
        let _no_environment = EnvVarGuard::remove(SENTRY_ENVIRONMENT_ENV);
        let _no_release = EnvVarGuard::remove(SENTRY_RELEASE_ENV);

        let config = resolve_sentry_config_from_env().expect("dsn is set");

        assert!(config.environment.is_none());
        assert_eq!(config.release, sentry::release_name!());
    }

    /// Regression test: a secret manager commonly injects a trailing
    /// newline into an env var's value — that must not silently become part
    /// of the DSN (which would fail to parse or connect at runtime) nor
    /// leak into the `environment`/`release` tags Sentry actually stores.
    #[test]
    fn resolve_sentry_config_trims_whitespace_from_every_field() {
        let _lock = ENV_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let _dsn = EnvVarGuard::set(SENTRY_DSN_ENV, "https://key@example.invalid/1\n");
        let _environment = EnvVarGuard::set(SENTRY_ENVIRONMENT_ENV, "  production\n");
        let _release = EnvVarGuard::set(SENTRY_RELEASE_ENV, "\tcharm-web-server@test \n");

        let config = resolve_sentry_config_from_env().expect("dsn is set");

        assert_eq!(config.dsn, "https://key@example.invalid/1");
        assert_eq!(config.environment.as_deref(), Some("production"));
        assert_eq!(config.release.as_deref(), Some("charm-web-server@test"));
    }

    /// A DSN that's whitespace-only (e.g. a secret manager injecting just a
    /// trailing newline for an otherwise-empty secret) must be treated the
    /// same as unset, not as "configured with a blank string" — the latter
    /// would call `sentry::init` with a value that fails to parse as a URL.
    #[test]
    fn resolve_sentry_config_is_none_for_a_whitespace_only_dsn() {
        let _lock = ENV_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let _whitespace_dsn = EnvVarGuard::set(SENTRY_DSN_ENV, "  \n\t");

        assert!(resolve_sentry_config_from_env().is_none());
    }

    #[test]
    fn sentry_event_filter_and_span_filter_stay_scoped_to_this_crate() {
        use sentry::integrations::tracing::EventFilter;

        assert_eq!(
            charm_lib::observability_scrub::sentry_event_filter_for_level_target(
                &tracing::Level::INFO,
                "charm_web_server::session",
                true,
                SENTRY_TRACING_CRATES,
            )
            .bits(),
            EventFilter::Breadcrumb.bits()
        );
        assert_eq!(
            charm_lib::observability_scrub::sentry_event_filter_for_level_target(
                &tracing::Level::INFO,
                "matrix_sdk::sync",
                true,
                SENTRY_TRACING_CRATES,
            )
            .bits(),
            EventFilter::Ignore.bits()
        );
        assert!(
            charm_lib::observability_scrub::sentry_span_filter_for_level_target(
                &tracing::Level::WARN,
                "charm_lib::matrix",
                SENTRY_TRACING_CRATES,
            )
        );
        assert!(
            !charm_lib::observability_scrub::sentry_span_filter_for_level_target(
                &tracing::Level::WARN,
                "axum::routing",
                SENTRY_TRACING_CRATES,
            )
        );
    }
}
