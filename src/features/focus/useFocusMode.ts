import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect } from "react";
import { getDndState, onDndChanged, setDndState } from "@/lib/matrix";

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

  const { data } = useQuery({
    queryKey: DND_QUERY_KEY,
    queryFn: getDndState,
  });

  useEffect(() => {
    const unlistenPromise = onDndChanged((state) => {
      queryClient.setQueryData(DND_QUERY_KEY, state);
    });
    return () => {
      void unlistenPromise.then((unlisten) => unlisten());
    };
  }, [queryClient]);

  const enabled = data?.enabled ?? false;
  const until = data?.until ?? null;

  const apply = (nextEnabled: boolean, nextUntil: number | null) => {
    // Optimistic: the tray-menu path already feels instant, so the panel
    // toggle should too rather than waiting a round trip.
    queryClient.setQueryData(DND_QUERY_KEY, { enabled: nextEnabled, until: nextUntil });
    void setDndState(nextEnabled, nextUntil).then((confirmed) => {
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
