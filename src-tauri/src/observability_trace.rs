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
