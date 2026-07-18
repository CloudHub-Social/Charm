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
  const timeoutMinutes = settings?.idle_timeout_minutes ?? null;
  const appearOffline = settings?.appear_offline ?? false;
  // Review fix: auto-idle disabled (`timeoutMinutes == null`) is the
  // default/common case — the previous version still added these global
  // activity listeners unconditionally, tracking `lastActivityRef` for a
  // feature that was never going to use it. Only listen while there's
  // actually a timeout to measure against.
  const autoIdleEnabled = timeoutMinutes != null;

  useEffect(() => {
    if (!autoIdleEnabled) return undefined;
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
  }, [autoIdleEnabled]);

  useEffect(() => {
    if (appearOffline) {
      // Review fix: this branch used to be shared with the "auto-idle
      // disabled" case below, restoring `online` whenever either condition
      // was true. That's wrong specifically for `appearOffline` — turning
      // "Appear offline" *on* while already idle hit this same branch and
      // sent `setPresence("online")`, racing (and sometimes beating) the
      // Rust `set_privacy_settings` command's own `offline` push, so the
      // user could stay/appear online right after asking to look offline.
      // `appearOffline` owns presence entirely while it's on (this hook is
      // a documented no-op for it) — never send anything here, just stop
      // tracking idle state so a later disable doesn't see a stale
      // `isIdleRef`.
      isIdleRef.current = false;
      return undefined;
    }
    if (timeoutMinutes == null) {
      // Review fix: this used to just reset `isIdleRef` to `false` without
      // ever calling `setPresence("online")` when auto-idle was disabled
      // *while already idle* — e.g. the user changes the timeout to "Never"
      // after presence has already gone `unavailable`. Since the interval
      // below is also torn down here, nothing would ever restore `online`
      // afterward: the next real activity no longer has a running interval
      // to notice it, and `isIdleRef` already reads `false` so even a later
      // re-enable wouldn't see a stale-idle state to correct. Explicitly
      // restore `online` here before resetting, whenever this transition
      // happens while genuinely idle.
      if (isIdleRef.current) {
        setPresence("online").catch(logAndIgnore);
      }
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
  }, [timeoutMinutes, appearOffline]);
}
