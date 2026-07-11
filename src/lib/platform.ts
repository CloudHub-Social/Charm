import { platform } from "@tauri-apps/plugin-os";

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

/**
 * Real per-OS platform for the `charm.platform` Sentry tag (Spec 23):
 * `macos`/`windows`/`linux`/`android`/`ios` on native builds, `web` for the
 * plain-browser companion client. `@tauri-apps/plugin-os`'s `platform()`
 * reads a `window.__TAURI_OS_PLUGIN_INTERNALS__` global the Rust plugin
 * injects at startup rather than making an IPC call, so it throws if that
 * global isn't present — true for the web build, and for any test/mock
 * environment (jsdom, Playwright's `mockTauri.ts`) that fakes
 * `__TAURI_INTERNALS__` without also faking the OS plugin's internals.
 */
export function platformTag(): string {
  if (!isTauri()) return "web";
  try {
    return platform();
  } catch {
    return "webview";
  }
}
