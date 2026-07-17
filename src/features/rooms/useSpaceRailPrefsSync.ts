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
  // Mirrors `prefs`/`userId` on every render (not just in an effect) so a
  // write queued for one account can check, at the moment it actually runs,
  // whether the session has since moved to a different account and bail —
  // resetting `writeQueueRef` on switch only stops *future* writes from
  // chaining behind a slow one, it doesn't stop an already-queued write's
  // own `.then()` continuation from firing late.
  const prefsRef = useRef(prefs);
  prefsRef.current = prefs;
  const latestUserIdRef = useRef(userId);
  latestUserIdRef.current = userId;
  // Set right before the load effect applies a remote value via
  // `setPrefsAtom`, so the mirror-write effect below can tell "this change
  // came from the read I just did" apart from a genuine local edit and skip
  // writing it straight back. Without this, opening the app on a second
  // device could write back a stale snapshot of what was just read — racing
  // (and, since account data is last-write-wins, potentially clobbering) a
  // newer write another device makes in the gap between the read landing
  // here and this redundant write reaching the server.
  const skipNextMirrorRef = useRef(false);

  const queueWrite = useCallback((forUserId: string, value: SpaceRailPrefs) => {
    writeQueueRef.current = writeQueueRef.current.then(async () => {
      if (latestUserIdRef.current !== forUserId) return;
      try {
        await setAccountData(SPACE_RAIL_PREFS_ACCOUNT_DATA_TYPE, value satisfies SpaceRailPrefs);
      } catch {
        // Best-effort — the local write already succeeded via the atom's
        // own storage effect; a failed remote mirror just means this
        // device's change won't show up elsewhere until the next
        // successful write. Caught here (not left to reject the queue)
        // so one failed write doesn't permanently stall every write after it.
      }
    });
  }, []);

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
    skipNextMirrorRef.current = false;
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
          skipNextMirrorRef.current = true;
          setPrefsAtom(remote);
        }
      })
      .catch(() => {
        // Offline or not-yet-signed-in — the local cache stays authoritative
        // until the next successful sync.
      })
      .finally(() => {
        if (cancelled) return;
        loadedRef.current = true;
        if (dirtySinceLoadStartRef.current) {
          // A local edit already landed while this read was still in
          // flight (and was correctly kept above, not clobbered) — but the
          // mirror-write effect below bailed out on that edit's own render
          // because `loadedRef` wasn't true yet, and its `[prefs]` deps
          // won't fire again on their own since `prefs` hasn't changed
          // since. Flush that edit out explicitly now that writes are
          // allowed, so a cold-start edit doesn't stay local-only until the
          // user happens to make a second change.
          queueWrite(userId, prefsRef.current);
        }
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
    if (skipNextMirrorRef.current) {
      skipNextMirrorRef.current = false;
      return;
    }
    queueWrite(userId, prefs);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [prefs, userId]);

  return [prefs, setPrefs] as const;
}
