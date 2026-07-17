import { useAtom } from "jotai";
import { useCallback, useEffect, useRef } from "react";
import { getAccountData, setAccountData } from "@/lib/matrix";
import {
  hasUnsyncedSpaceRailPrefs,
  isSpaceRailPrefs,
  setSpaceRailPrefsPendingSync,
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
  // Flipped in the unmount cleanup below. `latestUserIdRef` only updates via
  // a render, so if this hook's owner unmounts entirely (e.g. on logout)
  // while a write is still queued behind a slow earlier request, no later
  // render ever happens to move `latestUserIdRef` off the stale user id —
  // the queued continuation would still see it match and write the old
  // account's prefs into whatever account is signed in by the time it runs.
  const unmountedRef = useRef(false);
  // Each `queueWrite` call claims the next generation; the pending-sync
  // marker is only cleared by the write that's *still* the latest one
  // claimed when its request succeeds. Without this, two rapid edits (write
  // A queued, then write B queued before A settles) could have A's success
  // clear the marker even though B — a newer edit — is still in flight or
  // hasn't been attempted yet; a restart before B settles would then treat
  // the cache as clean and let an older remote value silently win.
  const writeGenerationRef = useRef(0);
  useEffect(() => {
    // Re-arm on every (re-)mount, not just via the `useRef(false)` initial
    // value — React 18 StrictMode (see `src/main.tsx`) double-invokes this
    // effect in development, running setup -> cleanup -> setup again on a
    // single real mount. Without resetting here, that first synthetic
    // cleanup would permanently strand `unmountedRef.current` at `true` and
    // silently block every future write for the rest of the component's
    // actual lifetime.
    unmountedRef.current = false;
    return () => {
      unmountedRef.current = true;
    };
  }, []);

  const queueWrite = useCallback((forUserId: string, value: SpaceRailPrefs) => {
    // Set before the attempt (not just on failure) so a crash/kill mid-write
    // is treated the same as a failure — an edit isn't "synced" until the
    // request actually succeeds.
    setSpaceRailPrefsPendingSync(forUserId, true);
    const generation = ++writeGenerationRef.current;
    writeQueueRef.current = writeQueueRef.current.then(async () => {
      if (unmountedRef.current || latestUserIdRef.current !== forUserId) return;
      try {
        await setAccountData(SPACE_RAIL_PREFS_ACCOUNT_DATA_TYPE, value satisfies SpaceRailPrefs);
        // Only the *latest* claimed write clears the marker — if a newer
        // edit was queued after this one started, the cache is still
        // "unsynced" from that edit's perspective even though this older
        // write just succeeded. Also rechecked here, not just at the top of
        // this continuation: `setAccountData` can settle after the hook has
        // since unmounted or moved to a different account (e.g. log out,
        // log back in as the same user, edit again — that newer edit's own
        // write could still be queued or fail). Clearing the marker here
        // regardless would let this older write mask the newer local edit,
        // so the next mount treats it as clean and an older remote read
        // silently overwrites it.
        if (
          writeGenerationRef.current === generation &&
          !unmountedRef.current &&
          latestUserIdRef.current === forUserId
        ) {
          setSpaceRailPrefsPendingSync(forUserId, false);
        }
      } catch {
        // Best-effort — the local write already succeeded via the atom's
        // own storage effect; a failed remote mirror just means this
        // device's change won't show up elsewhere until the next
        // successful write. Caught here (not left to reject the queue)
        // so one failed write doesn't permanently stall every write after it.
        // The pending-sync marker (still set) is what lets the *next* mount
        // retry it instead of silently losing it — see the load effect.
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
    // A previous mount may have edited prefs and had its write to account
    // data fail (or never got the chance to retry, e.g. the app was killed
    // mid-write) — that's persisted via `setSpaceRailPrefsPendingSync`
    // specifically so it survives to this next mount. Seeding
    // `dirtySinceLoadStartRef` from it reuses the same "local edit wins"
    // logic below that already protects an in-flight edit from THIS mount,
    // so a remote value (which may be older than the unsynced local one)
    // doesn't silently clobber it, and the flush-on-load-complete logic
    // further down retries the write.
    dirtySinceLoadStartRef.current = hasUnsyncedSpaceRailPrefs(userId);
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
