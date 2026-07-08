/**
 * Shared `.catch()` handler for fire-and-forget IPC calls whose failure has
 * no user-visible recovery path (e.g. tearing down an event listener, or a
 * best-effort state sync like focused-room tracking) — logs to the devtools
 * console so the failure isn't completely invisible, without throwing or
 * surfacing anything to the user.
 *
 * Deliberately doesn't retry or toast: call sites that need either of those
 * should handle their own `.catch()` instead of reaching for this. This just
 * replaces the repeated `.catch(console.error)` idiom so every call site
 * doesn't independently re-decide "log and swallow" is the right behavior —
 * see https://github.com/CloudHub-Social/Charm/issues/68.
 */
// A thin wrapper, not a cached `console.error.bind(console)` reference:
// `main.tsx` statically imports `App` (and everything it pulls in, including
// this module) before calling `Sentry.init`, which patches `console.error`
// in place for breadcrumb capture. Binding at module-eval time would freeze
// in the pre-Sentry `console.error` and silently skip that instrumentation
// for every call site using this helper. Looking it up at call time instead
// picks up whatever `console.error` currently is.
export function logAndIgnore(error: unknown): void {
  console.error(error);
}
