import { useEffect, useRef } from "react";
import { setPresence } from "@/lib/matrix";
import { logAndIgnore } from "@/lib/logAndIgnore";
import { usePrivacySettings } from "./privacySettings";

/** DOM events that count as user activity for the idle timer. Deliberately
 * broad (mirrors common idle-detection recipes) rather than narrowly typing —
 * any of these resets the clock. */
const ACTIVITY_EVENTS = [
  "mousemove",
  "mousedown",
  "keydown",
  "touchstart",
  "scroll",
  "wheel",
] as const;

/**
 * Frontend idle-detection loop backing "appear offline" and "auto-idle after
 * N minutes" (Spec 40, item 3-4). Mount once near the app root, alongside
 * `usePresenceListener`.
 *
 * - `appearOffline` always wins: presence is forced `offline` and the idle
 *   timer doesn't run at all (there's nothing to go idle *from*).
 * - Otherwise, while `autoIdleEnabled`, activity resets a timer; expiry sets
 *   presence to `unavailable`, and the next activity sets it back to
 *   `online`.
 * - When neither is on, this hook is a no-op — Spec 05's own post-login
 *   `set_presence_online` and any explicit user action are the only writers.
 *
 * This is a frontend timer, not OS-idle-driven (see the spec's "what I'd
 * revisit" section) — it only tracks activity within this window/webview.
 *
 * `flagEnabled` gates the whole hook (Spec 40's feature flag) — while off,
 * this is a no-op regardless of any persisted setting, so a user who can't
 * even see the Privacy panel yet never has their presence silently altered.
 */
export function usePresenceIdle(flagEnabled: boolean): void {
  const { appearOffline, autoIdleEnabled, idleTimeoutMins } = usePrivacySettings();
  const idleRef = useRef(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  useEffect(() => {
    if (!flagEnabled) {
      return undefined;
    }

    if (appearOffline) {
      setPresence("offline").catch(logAndIgnore);
      return undefined;
    }

    if (!autoIdleEnabled) {
      return undefined;
    }

    const timeoutMs = idleTimeoutMins * 60_000;

    function goIdle() {
      idleRef.current = true;
      setPresence("unavailable").catch(logAndIgnore);
    }

    function resetTimer() {
      if (idleRef.current) {
        idleRef.current = false;
        setPresence("online").catch(logAndIgnore);
      }
      clearTimeout(timerRef.current);
      timerRef.current = setTimeout(goIdle, timeoutMs);
    }

    resetTimer();
    for (const event of ACTIVITY_EVENTS) {
      window.addEventListener(event, resetTimer, { passive: true });
    }

    return () => {
      clearTimeout(timerRef.current);
      for (const event of ACTIVITY_EVENTS) {
        window.removeEventListener(event, resetTimer);
      }
    };
  }, [flagEnabled, appearOffline, autoIdleEnabled, idleTimeoutMins]);
}
