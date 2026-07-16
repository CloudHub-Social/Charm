//! Continues a Sentry trace started in the frontend into a Tauri IPC command
//! handler — the Rust-side half of `src/observability/ipc.ts`'s
//! `Sentry.getTraceData()` header injection (Charm 2.0's distributed-tracing
//! rollout; see `SENTRY.md`).
//!
//! Mirrors `matrix::send::ipc_operation_id`'s shape: read headers off the
//! IPC request, `None` if absent — desktop builds can't rely on Sentry's
//! browser SDK auto-instrumenting this transport (it isn't `fetch`/`XHR`),
//! so this is the manual equivalent of what `browserTracingIntegration` does
//! for HTTP. Operates on `&tauri::http::HeaderMap` rather than
//! `tauri::ipc::Request` directly (call sites pass `request.headers()`) —
//! `Request`'s fields are private with no public constructor outside
//! `CommandArg::from_command`, so a `HeaderMap`-based signature is what
//! keeps this testable without a live Tauri invoke.

const SENTRY_TRACE_HEADER: &str = "sentry-trace";
const BAGGAGE_HEADER: &str = "baggage";

/// Parses the `sentry-trace`/`baggage` headers `ipc.ts` attaches to every
/// Tauri invoke and returns a `sentry::TransactionContext` continuing that
/// trace, or `None` when `sentry-trace` is absent or not valid UTF-8 (no
/// active span on the frontend at call time, or an older frontend build that
/// predates this header). `baggage` is optional on top of that — its
/// absence still yields a continued trace, just without extra
/// dynamic-sampling context.
///
/// Callers pass this straight to `sentry::start_transaction` and bind the
/// result as the current transaction/scope for the duration of the command
/// (see `matrix::send::send_attachment` for the first wiring).
pub fn continue_ipc_trace(
    headers: &tauri::http::HeaderMap,
    name: &str,
    op: &str,
) -> Option<sentry::TransactionContext> {
    let sentry_trace = headers.get(SENTRY_TRACE_HEADER)?.to_str().ok()?;
    let baggage = headers
        .get(BAGGAGE_HEADER)
        .and_then(|value| value.to_str().ok());

    let trace_headers = std::iter::once((SENTRY_TRACE_HEADER, sentry_trace))
        .chain(baggage.map(|value| (BAGGAGE_HEADER, value)));

    Some(sentry::TransactionContext::continue_from_headers(
        name,
        op,
        trace_headers,
    ))
}

/// Runs `fut` inside a self-contained Sentry performance transaction named
/// `name`/`op` — self-contained meaning it doesn't continue any existing
/// trace (unlike [`continue_ipc_trace`]) and isn't published onto the
/// ambient/current scope (unlike `sentry::configure_scope`), for the same
/// "two overlapping calls racing to set/clear the current span would corrupt
/// each other" reason `send_attachment`'s trace handling calls out.
///
/// For hot paths this project's performance investigations flagged as slow
/// (login, the room-list snapshot loop, opening a room's timeline) but that
/// have no natural way to continue a frontend-originated trace — a plain
/// typed `#[tauri::command]` has no `sentry-trace` header to read, and a
/// background sync-loop tick isn't triggered by any single user action to
/// begin with. Reports `duration_ms` as span data and `Ok`/`UnknownError` as
/// the span status (based on `Result::is_ok`), matching the shape
/// `send_attachment` already reports by hand.
///
/// Gated on `crate::runtime_observability_sentry_enabled()` — deliberately
/// *not* `runtime_observability_logs_enabled()`: `sentryEnabled` (the
/// primary opt-in, covering crash reports/performance/breadcrumbs) and
/// `logsEnabled` (a stricter sub-toggle for native log events only) are
/// independent settings, and a user can have Sentry on with logs off — a
/// legitimate, likely common combination that gating on the logs flag would
/// silently drop these transactions for.
///
/// On desktop, the Observability settings panel can be toggled off
/// mid-session, which closes the frontend Sentry client and flips this
/// in-process flag, but leaves the backend's `SentryGuard` itself alive for
/// the rest of the process (see its own doc comment on why it's initialized
/// once at startup). Without this check, a call from a still-running
/// background task (the sync loop, an open room's timeline) would keep
/// starting real transactions after a same-session opt-out. When disabled,
/// `fut` still runs — only the tracing wrapper around it is skipped — so
/// callers never lose functionality over a user's telemetry choice.
///
/// Note for any future caller from `charm-web-server`: that flag is only
/// ever toggled by desktop's `update_observability_sentry_consent` Tauri
/// command (the companion server has no equivalent per-user runtime toggle —
/// see `scrub_log`'s doc comment for the same distinction on the logs flag),
/// so it reads as permanently `false` in that binary. A web-server call site
/// would need its own gating, not this one.
///
/// Also requires `sentry::Hub::current().client().is_some()` (Codex review on
/// #289, P2), not just the consent flag: `sentry::init` only ever runs once,
/// in `init_sentry_from_settings`, and only when `sentry_enabled` was already
/// `true` at *launch*. A user who launches with Sentry off and enables it
/// mid-session gets the consent flag flipped `true` (via
/// `update_observability_sentry_consent`) but no native client was ever
/// initialized to submit through — without this check, every transaction for
/// the rest of that session would silently start against nothing rather than
/// either reporting or cleanly no-op'ing. `sentry::Hub::current().client()`
/// is the authoritative live signal sentry-rust itself keeps (cheap: an
/// `Arc` clone/check, no I/O). Actually initializing a client mid-session on
/// same-session opt-in — client lifecycle, thread safety of swapping the
/// global client — is a larger change than this PR's job of wiring tracing
/// through the *existing* consent infrastructure; native logs have had this
/// identical launch-time-only limitation since before this PR (not a
/// regression this PR introduces, just a corner the new consent flag could
/// otherwise have made worse by not checking it).
pub async fn traced<T, E>(
    name: &str,
    op: &str,
    fut: impl std::future::Future<Output = Result<T, E>>,
) -> Result<T, E> {
    run_traced(sentry::TransactionContext::new(name, op), fut).await
}

/// Shared core behind [`traced`] and [`traced_infallible_sampled`], taking an
/// already-built `TransactionContext` so the latter can attach a custom
/// sampling decision (`TransactionContext::set_sampled`) without duplicating
/// the consent-gating/finish/re-check logic below.
async fn run_traced<T, E>(
    ctx: sentry::TransactionContext,
    fut: impl std::future::Future<Output = Result<T, E>>,
) -> Result<T, E> {
    // One lock acquisition for both reads, not two separate ones — pairs
    // with the atomic decision-and-finish in `with_current_sentry_consent`
    // below rather than reintroducing the same class of gap at the start.
    let (enabled_at_start, generation_at_start) =
        crate::with_current_sentry_consent(|enabled, generation| (enabled, generation));
    if !enabled_at_start || sentry::Hub::current().client().is_none() {
        return fut.await;
    }

    let transaction = sentry::start_transaction(ctx);
    let started_at = std::time::Instant::now();

    let result = fut.await;

    // Consent can change mid-flight for a slow call (a slow login, a first
    // timeline load) via the frontend's `update_observability_sentry_consent`
    // (see `persistObservabilitySettings`) — checking only the *current*
    // consent value here isn't enough (Codex review on #289): an off→on flip
    // during the call would leave the current value looking unchanged from
    // before the call even though the transaction spans an interval where
    // the user had opted out. Comparing the consent *generation* (bumped on
    // every toggle, any direction) instead of just re-reading the boolean
    // catches that case too — any change at all during the call means drop.
    //
    // The decision and the `finish()` call both happen inside
    // `with_current_sentry_consent`'s closure, under its lock (Codex review
    // on #289, P2 follow-up) — checking consent and then calling `finish()`
    // as two separate steps left a window where a consent update landing in
    // between would still let a since-revoked transaction submit. If
    // consent changed, drop `transaction` here without calling `finish()` —
    // sentry-rust only submits a transaction when `finish()` is called;
    // letting this binding go out of scope un-finished discards it instead
    // of reporting data captured across a telemetry-consent change mid-call.
    crate::with_current_sentry_consent(|enabled, generation| {
        if enabled && generation == generation_at_start {
            transaction.set_data(
                "duration_ms",
                u64::try_from(started_at.elapsed().as_millis())
                    .unwrap_or(u64::MAX)
                    .into(),
            );
            transaction.set_status(if result.is_ok() {
                sentry::protocol::SpanStatus::Ok
            } else {
                sentry::protocol::SpanStatus::UnknownError
            });
            transaction.finish();
        }
    });

    result
}

/// [`traced`] for a future that can't fail — `snapshot_rooms` has no
/// `Result` to report a status from, so this always finishes the
/// transaction as `Ok`.
pub async fn traced_infallible<T>(
    name: &str,
    op: &str,
    fut: impl std::future::Future<Output = T>,
) -> T {
    match run_traced(sentry::TransactionContext::new(name, op), async {
        Ok::<T, std::convert::Infallible>(fut.await)
    })
    .await
    {
        Ok(value) => value,
        Err(never) => match never {},
    }
}

/// [`traced_infallible`], but samples at `sample_rate` (0.0–1.0) instead of
/// deferring to the client-wide `traces_sample_rate` config. For a call site
/// invoked far more often than the events it's meant to help diagnose
/// deserve a full share of trace quota — `sync::emit_room_list_and_badge`'s
/// call, the motivating case, runs on every `/sync` long-poll response
/// (including ordinary empty ones) for as long as the app is open, so at the
/// global rate it would keep submitting a standalone transaction
/// continuously and crowd out comparatively rare login/cold-timeline traces
/// (Codex review on #289). `TransactionContext::set_sampled` overrides the
/// global rate's own random decision with this one, per-transaction.
pub async fn traced_infallible_sampled<T>(
    name: &str,
    op: &str,
    sample_rate: f64,
    fut: impl std::future::Future<Output = T>,
) -> T {
    let sampled = rand::random::<f64>() < sample_rate;
    let mut ctx = sentry::TransactionContext::new(name, op);
    ctx.set_sampled(Some(sampled));
    match run_traced(ctx, async { Ok::<T, std::convert::Infallible>(fut.await) }).await {
        Ok(value) => value,
        Err(never) => match never {},
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tauri::http::{HeaderMap, HeaderName, HeaderValue};

    fn headers(pairs: &[(&str, &str)]) -> HeaderMap {
        let mut map = HeaderMap::new();
        for (key, value) in pairs {
            map.insert(
                HeaderName::from_bytes(key.as_bytes()).unwrap(),
                HeaderValue::from_str(value).unwrap(),
            );
        }
        map
    }

    #[test]
    fn returns_none_without_a_sentry_trace_header() {
        let map = headers(&[]);

        assert!(continue_ipc_trace(&map, "send_attachment", "tauri.ipc").is_none());
    }

    #[test]
    fn continues_a_trace_from_sentry_trace_and_baggage_headers() {
        let map = headers(&[
            (
                "sentry-trace",
                "12345678901234567890123456789012-1234567890123456-1",
            ),
            (
                "baggage",
                "sentry-trace_id=12345678901234567890123456789012",
            ),
        ]);

        assert!(continue_ipc_trace(&map, "send_attachment", "tauri.ipc").is_some());
    }

    #[test]
    fn continues_a_trace_without_a_baggage_header() {
        let map = headers(&[(
            "sentry-trace",
            "12345678901234567890123456789012-1234567890123456-1",
        )]);

        assert!(continue_ipc_trace(&map, "send_attachment", "tauri.ipc").is_some());
    }
}
