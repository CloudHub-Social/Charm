import { useEffect } from "react";
import { useAtomValue, useSetAtom, useStore } from "jotai";
import { getPresence, onPresenceUpdate, type PresenceUpdate } from "@/lib/matrix";
import { presenceAtomFamily } from "./presenceAtoms";
import { logAndIgnore } from "@/lib/logAndIgnore";

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
export function usePresence(userId: string | null): PresenceUpdate | null {
  const store = useStore();
  const presence = useAtomValue(presenceAtomFamily(userId ?? ""));
  const setPresenceAtom = useSetAtom(presenceAtomFamily(userId ?? ""));

  useEffect(() => {
    if (!userId || presence) return undefined;
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
    getPresence(userId)
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
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `store`/`setPresenceAtom` are stable refs from jotai's useStore/useSetAtom; `presence` is deliberately excluded so this one-shot fetch only re-runs on `userId` change, not on every atom update
  }, [userId]);

  return userId ? presence : null;
}
