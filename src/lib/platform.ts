import { invoke } from "@tauri-apps/api/core";

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

let cachedPlatformTag = "web";
let platformTagPromise: Promise<string> | null = null;

/**
 * Real per-OS platform for the `charm.platform` Sentry tag (Spec 23):
 * `macos`/`windows`/`linux`/`android`/`ios` on native builds (via a plain
 * `get_platform` Tauri command returning `std::env::consts::OS` — a single
 * app command rather than the whole `@tauri-apps/plugin-os` plugin, which
 * would also expose arch/exe-extension/family/locale/version fingerprinting
 * to the frontend for a single tag's worth of need; see PR #169 review
 * discussion), `web` outside the Tauri shell.
 *
 * The underlying `invoke` call is async, but `initializeSentry` needs a
 * synchronous value to put in `Sentry.init`'s `initialScope`. `main.tsx`
 * awaits {@link preloadPlatformTag} as part of `bootstrapSentry` before the
 * app renders, so by the time `initializeSentry` runs (both on that initial
 * bootstrap and later Observability-panel toggles) the cache is already
 * warm; this synchronous getter just reads it.
 */
export function platformTag(): string {
  return cachedPlatformTag;
}

/** Warms {@link platformTag}'s cache. Safe to call more than once — later calls reuse the first in-flight/resolved request. */
export function preloadPlatformTag(): Promise<string> {
  if (!isTauri()) {
    cachedPlatformTag = "web";
    return Promise.resolve(cachedPlatformTag);
  }
  platformTagPromise ??= invoke<string>("get_platform")
    .then((value) => {
      cachedPlatformTag = value;
      return value;
    })
    .catch(() => {
      cachedPlatformTag = "webview";
      return cachedPlatformTag;
    });
  return platformTagPromise;
}

export const platformTestHooks = {
  reset() {
    cachedPlatformTag = "web";
    platformTagPromise = null;
  },
};
