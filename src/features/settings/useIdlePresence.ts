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

/** Delay between retry attempts for `restoreOnlineWithRetry` below. */
const RESTORE_ONLINE_RETRY_DELAY_MS = 2_000;
/** Bounded retry count — a deliberate cap, not an infinite retry loop. */
const RESTORE_ONLINE_MAX_ATTEMPTS = 3;

/**
 * Retries `setPresence("online")` a bounded number of times, only resolving
 * `true` once it actually succeeds.
 *
 * Review fix (P3): disabling auto-away while already idle used to send this
 * once and unconditionally clear `isIdleRef` regardless of whether it
 * succeeded — since disabling auto-idle also tears down the polling
 * interval that's the *only* other path that ever retries a presence
 * transition, a single transient IPC/network failure here left `sync_presence`
 * stuck at `unavailable` indefinitely even though the user explicitly chose
 * "Never", with nothing left to notice and correct it. A bounded retry gives
 * a transient failure a real chance to recover before giving up.
 */
async function restoreOnlineWithRetry(): Promise<boolean> {
  for (let attempt = 0; attempt < RESTORE_ONLINE_MAX_ATTEMPTS; attempt++) {
    try {
      await setPresence("online");
      return true;
    } catch (err) {
      if (attempt + 1 === RESTORE_ONLINE_MAX_ATTEMPTS) {
        logAndIgnore(err);
        return false;
      }
      await new Promise((resolve) => setTimeout(resolve, RESTORE_ONLINE_RETRY_DELAY_MS));
    }
  }
  return false;
}

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
    // Review fix: `lastActivityRef` is otherwise never touched while
    // auto-idle is disabled (the listeners below aren't even registered
    // then) — so it can still hold its initial mount-time value, or
    // whatever it was last set to before being disabled, however long ago
    // that was. Enabling auto-idle after a period of inactivity would
    // otherwise immediately treat the user as already idle-for-the-whole-
    // timeout on the very next `CHECK_INTERVAL_MS` poll, even though they
    // just interacted with the app to enable the setting. Reset it here,
    // the moment the timer actually starts tracking again.
    lastActivityRef.current = Date.now();
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
        // Review fix (P3): keeps `isIdleRef` `true` until the restore
        // actually succeeds — see `restoreOnlineWithRetry`'s own comment.
        // Deliberately not `await`ed (this effect can't be async); the ref
        // is written once the retried call resolves, whichever tick that is.
        restoreOnlineWithRetry().then((succeeded) => {
          if (succeeded) isIdleRef.current = false;
        });
      } else {
        isIdleRef.current = false;
      }
      return undefined;
    }
    const timeoutMs = timeoutMinutes * 60_000;

    const interval = setInterval(() => {
      const idleFor = Date.now() - lastActivityRef.current;
      const shouldBeIdle = idleFor >= timeoutMs;
      // Review fix: only flip `isIdleRef` once `setPresence` has actually
      // succeeded. Flipping it optimistically first meant a transient IPC
      // failure left the Rust side's presence state un-updated while the
      // JS-side ref already reflected the new state — the next poll would
      // then see `shouldBeIdle === isIdleRef.current` and skip retrying,
      // silently leaving presence wrong until the user next crossed the
      // idle/active boundary.
      if (shouldBeIdle && !isIdleRef.current) {
        setPresence("unavailable")
          .then(() => {
            isIdleRef.current = true;
          })
          .catch(logAndIgnore);
      } else if (!shouldBeIdle && isIdleRef.current) {
        setPresence("online")
          .then(() => {
            isIdleRef.current = false;
          })
          .catch(logAndIgnore);
      }
    }, CHECK_INTERVAL_MS);

    return () => clearInterval(interval);
  }, [timeoutMinutes, appearOffline]);
}
