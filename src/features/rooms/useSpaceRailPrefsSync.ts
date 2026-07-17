import { useAtom } from "jotai";
import { useCallback, useEffect, useRef } from "react";
import { getAccountData, setAccountData } from "@/lib/matrix";
import {
  isSpaceRailPrefs,
  SPACE_RAIL_PREFS_ACCOUNT_DATA_TYPE,
  spaceRailPrefsAtomFamily,
  type SpaceRailPrefs,
} from "./spaceRailPrefs";

type SetSpaceRailPrefs = (
  update: SpaceRailPrefs | ((prev: SpaceRailPrefs) => SpaceRailPrefs),
) => void;

/**
 * Layers Spec 63's cross-device account-data sync on top of the local-storage
 * `spaceRailPrefsAtomFamily` — mirrors `useOnboardingGate`'s local-flag +
 * account-data pattern (Spec 12), not a new one. On mount (and again on
 * account switch), an account-data read (if it returns a well-formed value)
 * overwrites the local cache for `userId`; every local change after that
 * point mirrors back to that same account's account data. The overwrite
 * direction is deliberately "remote wins on load" rather than merging — Spec
 * 63's own account-data structure has no per-field timestamps to merge by,
 * and a full clobber matches how `SpaceRailPrefs` is already read/written as
 * one opaque blob everywhere else in this feature — *unless* the caller
 * already made a local edit while the read was still in flight, in which
 * case that edit wins (see `dirtySinceLoadStartRef` below).
 */
export function useSpaceRailPrefsSync(userId: string) {
  const [prefs, setPrefsAtom] = useAtom(spaceRailPrefsAtomFamily(userId));
  const loadedRef = useRef(false);
  // Set only by the public `setPrefs` below (a genuine caller-driven edit),
  // never by this hook's own remote-load `setPrefsAtom` call — so the load
  // effect can tell "the user already changed something while I was
  // fetching" apart from "nothing happened yet" and skip clobbering it.
  const dirtySinceLoadStartRef = useRef(false);
  // Chains every account-data write behind the previous one's settlement.
  // Account data has no server-side ordering guarantee across concurrent
  // requests (it's a plain last-arrival-wins PUT), so firing one request per
  // rapid local change (e.g. clicking Move up/down repeatedly) let an older
  // request that happened to arrive later silently overwrite a newer one.
  const writeQueueRef = useRef<Promise<void>>(Promise.resolve());

  const setPrefs = useCallback<SetSpaceRailPrefs>(
    (update) => {
      dirtySinceLoadStartRef.current = true;
      setPrefsAtom(update);
    },
    [setPrefsAtom],
  );

  useEffect(() => {
    // Re-arms on every account switch — a different `userId` means a
    // different atom-family instance (see `spaceRailPrefsAtomFamily`), whose
    // local cache the mirror effect below must not write back to account
    // data until *this* account's own read has resolved.
    loadedRef.current = false;
    dirtySinceLoadStartRef.current = false;
    // Also re-arm the write queue: without this, a write still queued
    // behind a slow previous-account request would run its
    // `setAccountData` call only once that earlier write settles — by which
    // point the signed-in session may already belong to this new account,
    // so the stale write could land in the wrong account's data. Starting a
    // fresh queue here means any write from here on is chained only behind
    // other writes for *this* account.
    writeQueueRef.current = Promise.resolve();
    let cancelled = false;
    getAccountData(SPACE_RAIL_PREFS_ACCOUNT_DATA_TYPE)
      .then((remote) => {
        if (cancelled) return;
        if (isSpaceRailPrefs(remote) && !dirtySinceLoadStartRef.current) {
          setPrefsAtom(remote);
        }
      })
      .catch(() => {
        // Offline or not-yet-signed-in — the local cache stays authoritative
        // until the next successful sync.
      })
      .finally(() => {
        if (!cancelled) loadedRef.current = true;
      });
    return () => {
      cancelled = true;
    };
    // `setPrefsAtom` is a stable jotai setter; re-running only on `userId`
    // change is intentional (see comment above).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [userId]);

  useEffect(() => {
    // Skip the write this effect would otherwise fire for the very first
    // render (before the read above has had a chance to complete) — that
    // would race the read and could clobber a remote value with the local
    // (possibly stale, possibly just-reset-to-default) cache.
    if (!loadedRef.current) return;
    writeQueueRef.current = writeQueueRef.current.then(() =>
      setAccountData(SPACE_RAIL_PREFS_ACCOUNT_DATA_TYPE, prefs satisfies SpaceRailPrefs).catch(
        () => {
          // Best-effort — the local write already succeeded via the atom's
          // own storage effect; a failed remote mirror just means this
          // device's change won't show up elsewhere until the next
          // successful write. Caught here (not left to reject the queue)
          // so one failed write doesn't permanently stall every write after it.
        },
      ),
    );
  }, [prefs]);

  return [prefs, setPrefs] as const;
}
