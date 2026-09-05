import { useEffect } from "react";
import { refreshPushRegistration } from "@/lib/matrix";
import { preloadPlatformTag } from "@/lib/platform";

/** One listener per signed-in session, including restored and onboarding sessions. */
export function useApnsRefresh(userId?: string, deviceId?: string) {
  useEffect(() => {
    if (!userId || !deviceId) return;
    let active = true;
    let inFlight = false;
    async function refresh() {
      if (!active) return;
      if (inFlight) return;
      inFlight = true;
      try {
        await refreshPushRegistration(userId!, deviceId!);
      } catch {
        /* Native push:status exposes a safe, actionable failure. */
      } finally {
        inFlight = false;
      }
    }
    const foreground = () => {
      if (document.visibilityState === "visible") void refresh();
    };
    void preloadPlatformTag().then((platform) => {
      if (!active || platform !== "ios") return;
      // Rust obtains and deduplicates the APNs token. Refresh after session
      // restoration and whenever iOS foregrounds the app; the raw token never
      // enters the renderer or its caches.
      void refresh();
      document.addEventListener("visibilitychange", foreground);
    });
    return () => {
      active = false;
      document.removeEventListener("visibilitychange", foreground);
    };
  }, [userId, deviceId]);
}
