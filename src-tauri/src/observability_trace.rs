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
pub async fn traced<T, E>(
    name: &str,
    op: &str,
    fut: impl std::future::Future<Output = Result<T, E>>,
) -> Result<T, E> {
    let transaction = sentry::start_transaction(sentry::TransactionContext::new(name, op));
    let started_at = std::time::Instant::now();

    let result = fut.await;

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
    match traced(name, op, async {
        Ok::<T, std::convert::Infallible>(fut.await)
    })
    .await
    {
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
