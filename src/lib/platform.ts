/**
 * Whether this build is running inside the Tauri shell (desktop or mobile
 * app) as opposed to the plain-browser companion web client (Spec 16), which
 * has no `__TAURI_INTERNALS__` bridge at all. Used to hide native-only
 * settings (autostart, OS notification permission) that make no sense in a
 * browser tab.
 */
export function isTauri(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}
