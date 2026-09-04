import { useEffect } from "react";
import { addPluginListener } from "@tauri-apps/api/core";
import { refreshPushRegistration } from "@/lib/matrix";
import { preloadPlatformTag } from "@/lib/platform";

/** One listener per signed-in session, including restored and onboarding sessions. */
export function useApnsRefresh(userId?: string, deviceId?: string) {
  useEffect(() => {
    if (!userId || !deviceId) return;
    let active = true;
    let inFlight = false;
    let again = false;
    let lastToken: string | null = null;
    let unregisterListener: (() => Promise<void>) | null = null;
    async function refresh() {
      if (!active) return;
      if (inFlight) {
        again = true;
        return;
      }
      inFlight = true;
      try {
        await refreshPushRegistration(userId!, deviceId!);
      } catch {
        /* Native push:status exposes a safe, actionable failure. */
      } finally {
        inFlight = false;
        if (again && active) {
          again = false;
          void refresh();
        }
      }
    }
    const foreground = () => {
      if (document.visibilityState === "visible") void refresh();
    };
    void preloadPlatformTag().then((platform) => {
      if (!active || platform !== "ios") return;
      const listener = addPluginListener<{ token: string }>(
        "notifications",
        "push-token",
        ({ token }) => {
          if (!active || typeof token !== "string" || token === lastToken) return;
          lastToken = token;
          // Do not forward the payload or log it. Ask Rust to obtain the OS token.
          void refresh();
        },
      );
      unregisterListener = () => listener.then((value) => value.unregister());
      // Subscribe first so registration callbacks cannot be lost. A failed
      // listener still permits restore-time refresh and a retry next foreground.
      void listener.then(
        () => refresh(),
        () => refresh(),
      );
      document.addEventListener("visibilitychange", foreground);
    });
    return () => {
      active = false;
      lastToken = null;
      document.removeEventListener("visibilitychange", foreground);
      void unregisterListener?.().catch(() => {});
    };
  }, [userId, deviceId]);
}
