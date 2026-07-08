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
export function logAndIgnore(error: unknown): void {
  console.error(error);
}
