import { useEffect, useRef } from "react";
import { setPresence } from "@/lib/matrix";
import { logAndIgnore } from "@/lib/logAndIgnore";
import type { PrivacySettings } from "@/lib/matrix";

/** Activity events that count as "not idle" — matches the common browser
 * idle-detection event set (mouse, keyboard, touch, scroll). */
const ACTIVITY_EVENTS = ["mousemove", "mousedown", "keydown", "touchstart", "scroll"] as const;

/** How often the idle check runs, in ms. Small relative to any realistic
 * timeout (minutes), so the actual idle transition never lags by more than
 * this. */
const CHECK_INTERVAL_MS = 15_000;

/**
 * Spec 40 item 4 — auto-idle/away: after `idleTimeoutMinutes` of no
 * mouse/keyboard/touch/scroll activity, sets presence to `unavailable`;
 * resumes to `online` on the next activity. A no-op whenever
 * `idleTimeoutMinutes` is `null` (auto-idle disabled) or `appearOffline` is
 * on (that toggle already forces `offline` — an idle transition to
 * `unavailable` would fight it every time the user came back and this timer
 * next fired).
 *
 * Charm 2.0 has no native (OS-level) idle-detection API wired up yet, so
 * this is a frontend DOM-activity timer — see Spec 40's data-flow note
 * ("check if the native shell already exposes activity signals; otherwise
 * implement a frontend idle-timer").
 */
export function useIdlePresence(settings: PrivacySettings | undefined): void {
  const lastActivityRef = useRef(Date.now());
  const isIdleRef = useRef(false);

  useEffect(() => {
    const handleActivity = () => {
      lastActivityRef.current = Date.now();
    };
    for (const event of ACTIVITY_EVENTS) {
      window.addEventListener(event, handleActivity, { passive: true });
    }
    return () => {
      for (const event of ACTIVITY_EVENTS) {
        window.removeEventListener(event, handleActivity);
      }
    };
  }, []);

  useEffect(() => {
    const timeoutMinutes = settings?.idle_timeout_minutes ?? null;
    const appearOffline = settings?.appear_offline ?? false;
    if (timeoutMinutes == null || appearOffline) {
      isIdleRef.current = false;
      return undefined;
    }
    const timeoutMs = timeoutMinutes * 60_000;

    const interval = setInterval(() => {
      const idleFor = Date.now() - lastActivityRef.current;
      const shouldBeIdle = idleFor >= timeoutMs;
      if (shouldBeIdle && !isIdleRef.current) {
        isIdleRef.current = true;
        setPresence("unavailable").catch(logAndIgnore);
      } else if (!shouldBeIdle && isIdleRef.current) {
        isIdleRef.current = false;
        setPresence("online").catch(logAndIgnore);
      }
    }, CHECK_INTERVAL_MS);

    return () => clearInterval(interval);
  }, [settings?.idle_timeout_minutes, settings?.appear_offline]);
}
