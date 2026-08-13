import { useEffect } from "react";
import { useAtomValue, useSetAtom, useStore } from "jotai";
import { getPresence, onPresenceUpdate, type PresenceUpdate } from "@/lib/matrix";
import { presenceAtomFamily } from "./presenceAtoms";
import { logAndIgnore } from "@/lib/logAndIgnore";
import { useFlag } from "@/featureFlags";

/**
 * Subscribes to `presence:update` once per app (mount this near the root —
 * e.g. alongside the other `on*Update` listeners) and fans incoming updates
 * out to the per-user `presenceAtomFamily` atoms. Uses the Jotai store
 * directly (rather than `useSetAtom`, which needs a fixed atom instance)
 * since the target atom depends on each incoming update's `user_id`.
 */
export function usePresenceListener() {
  const store = useStore();

  useEffect(() => {
    const unlisten = onPresenceUpdate((update: PresenceUpdate) => {
      store.set(presenceAtomFamily(update.user_id), update);
    });
    return () => {
      unlisten.then((fn) => fn()).catch(logAndIgnore);
    };
  }, [store]);
}

/**
 * Reads the last-known presence for `userId`, kicking off a one-shot
 * `get_presence` fetch on mount if nothing has arrived yet (e.g. the user
 * hasn't changed presence since we started listening). Best-effort: a failed
 * or `null` lookup just leaves presence unknown, never surfaced as an error.
 */
export function usePresence(
  userId: string | null,
  { fetchInitial = true }: { fetchInitial?: boolean } = {},
): PresenceUpdate | null {
  const store = useStore();
  const presence = useAtomValue(presenceAtomFamily(userId ?? ""));
  const setPresenceAtom = useSetAtom(presenceAtomFamily(userId ?? ""));
  const avatarPresenceVisualsEnabled = useFlag("avatar_presence_visuals");

  useEffect(() => {
    // Presence fetched while avatar visuals are disabled deliberately maps
    // custom `dnd`/`busy` values to Offline in Rust. Fetch once more whenever
    // the flag becomes enabled so an already-cached Offline value can recover
    // the richer state immediately instead of waiting for another homeserver
    // event. With the flag disabled, cached values still retain the original
    // one-shot behavior.
    if (!userId || !fetchInitial || (presence && !avatarPresenceVisualsEnabled)) {
      return undefined;
    }
    let cancelled = false;
    // A `presence:update` push (via `usePresenceListener`) can set this
    // user's atom directly while this one-shot fetch is still in flight —
    // that's strictly more current than whatever the fetch eventually
    // resolves with (a snapshot from when it was issued), so track whether
    // that happened and skip applying the fetch result if it did. Without
    // this, a quick online-then-offline while the fetch is still in flight
    // could have the stale "online" fetch result win the race and clobber
    // the correct "offline" state indefinitely.
    let pushedWhileFetching = false;
    const unsubscribe = store.sub(presenceAtomFamily(userId), () => {
      pushedWhileFetching = true;
    });
    getPresence(userId, avatarPresenceVisualsEnabled)
      .then((update) => {
        if (!cancelled && !pushedWhileFetching && update) setPresenceAtom(update);
      })
      .catch(() => {
        // Best-effort — presence staying unknown is not an error state.
      });
    return () => {
      cancelled = true;
      unsubscribe();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `store`/`setPresenceAtom` are stable refs from jotai's useStore/useSetAtom; `presence` is deliberately excluded so atom updates do not refetch. The feature flag is included intentionally: enabling it refreshes any cached value that Rust normalized while the flag was off.
  }, [avatarPresenceVisualsEnabled, fetchInitial, userId]);

  return userId ? presence : null;
}
