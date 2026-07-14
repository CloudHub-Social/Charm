import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef } from "react";
import { getDndState, onDndChanged, setDndState } from "@/lib/matrix";
import { isTauri } from "@/lib/platform";

export const DND_QUERY_KEY = ["settings", "dnd"] as const;

/** Preset Do Not Disturb durations offered by both the Settings panel and
 * the tray menu (`setup_tray_and_menu` in `lib.rs`) — kept in one place so
 * the two surfaces can't drift apart. */
export const DND_PRESETS = [
  { label: "30 minutes", ms: 30 * 60_000 },
  { label: "1 hour", ms: 60 * 60_000 },
  { label: "8 hours", ms: 8 * 60 * 60_000 },
] as const;

/**
 * Reads and writes Do Not Disturb (Spec 30) state. Rust (`matrix::dnd`) is
 * the single source of truth — this hook is a thin read/write + live-sync
 * wrapper, not a second copy of the state: a change made from the tray menu
 * emits `dnd:changed`, which this listens for and folds straight into the
 * query cache so the Settings panel reflects a tray-triggered change without
 * polling.
 */
export function useFocusMode() {
  const queryClient = useQueryClient();
  // Review fix: Do Not Disturb is a Tauri/native concept (tray icon, OS
  // notifications) — `invokeWeb` (matrixTransport.ts) has no case for
  // `get_dnd_state`/`set_dnd_state`, so calling them on the web companion
  // build would only ever reject with an `UnsupportedCommand` error. Callers
  // that render regardless of platform (e.g. `RoomList`'s chrome indicator,
  // unlike `FocusPanel` which is already excluded from web builds via
  // `SettingsScreen`'s `webUnsupported` filter) still need this to no-op
  // cleanly rather than spam a perpetually-erroring query.
  //
  // Gate on `isTauri()` rather than `isWebBuild()`: the latter is false in
  // *any* plain-browser context that isn't specifically configured as the
  // web companion build (e.g. Storybook, Vite dev server without
  // `VITE_CHARM_WEB_API_BASE_URL`) — there's no `window.__TAURI_INTERNALS__`
  // there either, so both `invoke` and `listen` (which synchronously touches
  // `transformCallback`) would throw. `isTauri()` is the actual "is there a
  // Tauri bridge to call" check.
  const inTauri = isTauri();

  const { data } = useQuery({
    queryKey: DND_QUERY_KEY,
    queryFn: getDndState,
    enabled: inTauri,
  });

  useEffect(() => {
    if (!inTauri) return undefined;
    const unlistenPromise = onDndChanged((state) => {
      queryClient.setQueryData(DND_QUERY_KEY, state);
    });
    return () => {
      void unlistenPromise.then((unlisten) => unlisten());
    };
  }, [queryClient, inTauri]);

  const enabled = data?.enabled ?? false;
  const until = data?.until ?? null;

  // Rust auto-clears an expired timed DND lazily, only on its next read — it
  // never proactively pushes a `dnd:changed` event for an expiry with no
  // triggering action. Without this timer, a Settings panel or tray icon
  // left open past `until` would keep showing DND as active (and hide the
  // preset-duration buttons) even though enforcement already stopped
  // suppressing notifications, until some unrelated refetch happened to
  // land. Re-query on expiry instead of just clearing locally so Rust's
  // `effective()` (the actual source of truth) confirms the clear.
  useEffect(() => {
    if (!enabled || until == null) return undefined;
    const msRemaining = until - Date.now();
    if (msRemaining <= 0) {
      void queryClient.invalidateQueries({ queryKey: DND_QUERY_KEY });
      return undefined;
    }
    const timer = setTimeout(() => {
      void queryClient.invalidateQueries({ queryKey: DND_QUERY_KEY });
    }, msRemaining);
    return () => clearTimeout(timer);
  }, [enabled, until, queryClient]);

  // Review fix: rapid double-toggles (e.g. enable a preset then immediately
  // disable) fire two overlapping setDndState calls; if the earlier one
  // resolves after the later one, its `confirmed` response would overwrite
  // the newer selection in the cache. `latestRequestId` tags each apply()
  // call so a response only gets written back if it's still the most
  // recent one in flight — a superseded response is silently dropped
  // rather than fighting the newer optimistic/confirmed state.
  const latestRequestId = useRef(0);

  const apply = (nextEnabled: boolean, nextUntil: number | null) => {
    const requestId = ++latestRequestId.current;
    // Optimistic: the tray-menu path already feels instant, so the panel
    // toggle should too rather than waiting a round trip.
    queryClient.setQueryData(DND_QUERY_KEY, { enabled: nextEnabled, until: nextUntil });
    void setDndState(nextEnabled, nextUntil).then((confirmed) => {
      if (requestId !== latestRequestId.current) return;
      queryClient.setQueryData(DND_QUERY_KEY, confirmed);
    });
  };

  return {
    enabled,
    until,
    /** Turns DND on for `ms` milliseconds from now, or indefinitely if `ms` is omitted. */
    enable: (ms?: number) => apply(true, ms == null ? null : Date.now() + ms),
    disable: () => apply(false, null),
  };
}
