//! Shared Sentry redaction/filtering primitives — used by both this crate's
//! own desktop Sentry setup (`lib.rs`'s `init_sentry_from_settings` and
//! friends, which additionally gate on the user's runtime consent toggle,
//! not modeled here) and `charm-web-server`'s server-side Sentry setup
//! (`charm_web_server::observability`, which has no per-user consent concept
//! — a backend process's single opt-in gate is simply "was a DSN
//! configured"). Pulled out to its own module so the redaction rules (what
//! counts as a secret field, what a Matrix ID/MXC URI looks like) can't
//! silently drift between the two call sites; the desktop-only consent
//! gating stays in `lib.rs` where the settings store it reads lives.

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

pub fn scrub_secrets(text: &str) -> String {
    SECRET_FIELD_PATTERN
        .replace_all(text, "$1$2[redacted]")
        .into_owned()
}

pub fn scrub_matrix_ids(text: &str) -> String {
    let without_mxc = MXC_URI_PATTERN
        .replace_all(text, "mxc://[redacted]/[redacted]")
        .into_owned();
    MATRIX_ID_PATTERN
        .replace_all(&without_mxc, "$1[redacted]:[redacted]")
        .into_owned()
}

pub fn scrub_sensitive_text(text: &str) -> String {
    scrub_secrets(&scrub_matrix_ids(text))
}

pub fn scrub_json_value(value: &mut serde_json::Value) {
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
/// the event ever leaves the process. Consent-independent by design — the
/// caller decides *whether* to send Sentry events at all (desktop via its
/// settings-store toggle, `charm-web-server` via whether a DSN is
/// configured); this only ever runs once that decision has already been
/// made, so it never itself needs to check consent.
pub fn scrub_event(
    event: sentry::protocol::Event<'static>,
) -> Option<sentry::protocol::Event<'static>> {
    let Ok(mut value) = serde_json::to_value(&event) else {
        return Some(event);
    };
    scrub_json_value(&mut value);
    serde_json::from_value(value).ok()
}

/// Redacts a Sentry structured log's body and attributes in place — the pure
/// counterpart to `lib.rs`'s desktop-only `scrub_log`, which wraps this with
/// an additional runtime-consent check and a debug-level drop that don't
/// apply to a backend process with no per-user consent toggle.
pub fn scrub_log_in_place(log: &mut sentry::protocol::Log) {
    log.body = scrub_sensitive_text(&log.body);
    for attribute in log.attributes.values_mut() {
        scrub_json_value(&mut attribute.0);
    }
}

/// Whether `target` (a `tracing::Metadata::target()`, e.g. `"charm_lib::matrix"`)
/// belongs to one of `allowed_crates` — either exactly one of them, or
/// namespaced under one via `::`. Used to keep the Sentry tracing bridge
/// scoped to this codebase's own log/span targets rather than also
/// forwarding every `matrix_sdk`/`axum`/dependency-internal `tracing` event,
/// which would otherwise drown out (and blow through rate limits on) the
/// events this bridge actually exists to capture.
pub fn is_tracing_target_allowed(target: &str, allowed_crates: &[&str]) -> bool {
    // Runs on every tracing event/span decision — `strip_prefix` + a `"::"`
    // check on the remainder gets the same "exact match, or namespaced under
    // it via `::`" semantics as `target.starts_with(&format!("{allowed}::"))`
    // without allocating a new `String` per candidate on every call.
    allowed_crates.iter().any(|allowed| {
        target == *allowed
            || target
                .strip_prefix(allowed)
                .is_some_and(|rest| rest.starts_with("::"))
    })
}

/// Maps a `tracing` level + target to the Sentry `EventFilter` that should
/// apply, for targets in `allowed_crates` — shared level policy between
/// desktop and `charm-web-server`: `ERROR` becomes a Sentry event (plus a
/// breadcrumb and, if `logs_enabled`, a structured log), `WARN` becomes a
/// breadcrumb (+ log), `INFO` becomes a breadcrumb only, `DEBUG`/`TRACE`
/// never reach Sentry at all. Anything outside `allowed_crates`, or with
/// `logs_enabled` false, is ignored outright.
pub fn sentry_event_filter_for_level_target(
    level: &tracing::Level,
    target: &str,
    logs_enabled: bool,
    allowed_crates: &[&str],
) -> sentry::integrations::tracing::EventFilter {
    use sentry::integrations::tracing::EventFilter;

    if !is_tracing_target_allowed(target, allowed_crates) || !logs_enabled {
        return EventFilter::Ignore;
    }

    match *level {
        tracing::Level::ERROR => EventFilter::Event | EventFilter::Breadcrumb | EventFilter::Log,
        tracing::Level::WARN => EventFilter::Breadcrumb | EventFilter::Log,
        tracing::Level::INFO => EventFilter::Breadcrumb,
        tracing::Level::DEBUG | tracing::Level::TRACE => EventFilter::Ignore,
    }
}

/// Whether a `tracing` span at `level`/`target` should be tracked by the
/// Sentry tracing bridge at all — same crate-scoping as
/// [`is_tracing_target_allowed`], restricted to `INFO`/`WARN`/`ERROR` spans
/// (a `DEBUG`/`TRACE` span tracked here would otherwise show up in Sentry's
/// span tree even though [`sentry_event_filter_for_level_target`] would
/// never let its *events* through).
pub fn sentry_span_filter_for_level_target(
    level: &tracing::Level,
    target: &str,
    allowed_crates: &[&str],
) -> bool {
    is_tracing_target_allowed(target, allowed_crates)
        && matches!(
            *level,
            tracing::Level::ERROR | tracing::Level::WARN | tracing::Level::INFO
        )
}

#[cfg(test)]
mod tests {
    use super::*;

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
    fn scrub_log_in_place_redacts_body_and_attributes() {
        let mut log = sentry::protocol::Log {
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

        scrub_log_in_place(&mut log);

        assert_eq!(
            log.body,
            "failed for @[redacted]:[redacted] access_token=[redacted]"
        );
        assert_eq!(
            log.attributes.get("room").map(|value| &value.0),
            Some(&sentry::protocol::Value::String(
                "![redacted]:[redacted]".to_owned()
            ))
        );
    }

    #[test]
    fn is_tracing_target_allowed_matches_exact_and_namespaced() {
        let allowed = &["charm", "charm_lib"];
        assert!(is_tracing_target_allowed("charm_lib", allowed));
        assert!(is_tracing_target_allowed("charm_lib::matrix", allowed));
        assert!(is_tracing_target_allowed("charm", allowed));
        assert!(!is_tracing_target_allowed("matrix_sdk::sync", allowed));
        assert!(!is_tracing_target_allowed("charm_lib_other", allowed));
    }

    #[test]
    fn sentry_event_filter_keeps_bridge_scoped_to_allowed_crates() {
        use sentry::integrations::tracing::EventFilter;
        let allowed = &["charm", "charm_lib"];

        fn assert_event_filter(actual: EventFilter, expected: EventFilter) {
            assert_eq!(actual.bits(), expected.bits());
        }

        assert_event_filter(
            sentry_event_filter_for_level_target(
                &tracing::Level::INFO,
                "matrix_sdk::sync",
                true,
                allowed,
            ),
            EventFilter::Ignore,
        );
        assert_event_filter(
            sentry_event_filter_for_level_target(
                &tracing::Level::INFO,
                "charm_lib::matrix",
                true,
                allowed,
            ),
            EventFilter::Breadcrumb,
        );
        assert_event_filter(
            sentry_event_filter_for_level_target(
                &tracing::Level::WARN,
                "charm_lib::matrix",
                true,
                allowed,
            ),
            EventFilter::Breadcrumb | EventFilter::Log,
        );
        assert_event_filter(
            sentry_event_filter_for_level_target(
                &tracing::Level::ERROR,
                "charm_lib::matrix",
                true,
                allowed,
            ),
            EventFilter::Event | EventFilter::Breadcrumb | EventFilter::Log,
        );
        assert_event_filter(
            sentry_event_filter_for_level_target(
                &tracing::Level::WARN,
                "charm_lib::matrix",
                false,
                allowed,
            ),
            EventFilter::Ignore,
        );
        assert_event_filter(
            sentry_event_filter_for_level_target(
                &tracing::Level::ERROR,
                "charm_lib::matrix",
                false,
                allowed,
            ),
            EventFilter::Ignore,
        );
    }

    #[test]
    fn sentry_span_filter_keeps_bridge_scoped_to_allowed_crates() {
        let allowed = &["charm", "charm_lib"];
        assert!(!sentry_span_filter_for_level_target(
            &tracing::Level::INFO,
            "matrix_sdk::sync",
            allowed
        ));
        assert!(sentry_span_filter_for_level_target(
            &tracing::Level::INFO,
            "charm_lib::matrix",
            allowed
        ));
        assert!(!sentry_span_filter_for_level_target(
            &tracing::Level::DEBUG,
            "charm_lib::matrix",
            allowed
        ));
    }
}
