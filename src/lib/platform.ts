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

export function isWebBuild(): boolean {
  return (
    import.meta.env.VITE_CHARM_BUILD_TARGET === "web" ||
    (!isTauri() && Boolean(import.meta.env.VITE_CHARM_WEB_API_BASE_URL))
  );
}
