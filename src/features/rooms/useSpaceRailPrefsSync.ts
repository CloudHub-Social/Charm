import { useAtom } from "jotai";
import { useEffect, useRef } from "react";
import { getAccountData, setAccountData } from "@/lib/matrix";
import {
  isSpaceRailPrefs,
  SPACE_RAIL_PREFS_ACCOUNT_DATA_TYPE,
  spaceRailPrefsAtomFamily,
  type SpaceRailPrefs,
} from "./spaceRailPrefs";

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
 * one opaque blob everywhere else in this feature.
 */
export function useSpaceRailPrefsSync(userId: string) {
  const [prefs, setPrefs] = useAtom(spaceRailPrefsAtomFamily(userId));
  const loadedRef = useRef(false);

  useEffect(() => {
    // Re-arms on every account switch — a different `userId` means a
    // different atom-family instance (see `spaceRailPrefsAtomFamily`), whose
    // local cache the mirror effect below must not write back to account
    // data until *this* account's own read has resolved.
    loadedRef.current = false;
    let cancelled = false;
    getAccountData(SPACE_RAIL_PREFS_ACCOUNT_DATA_TYPE)
      .then((remote) => {
        if (cancelled) return;
        if (isSpaceRailPrefs(remote)) {
          setPrefs(remote);
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
    // `setPrefs` is a stable jotai setter; re-running only on `userId`
    // change is intentional (see comment above).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [userId]);

  useEffect(() => {
    // Skip the write this effect would otherwise fire for the very first
    // render (before the read above has had a chance to complete) — that
    // would race the read and could clobber a remote value with the local
    // (possibly stale, possibly just-reset-to-default) cache.
    if (!loadedRef.current) return;
    setAccountData(SPACE_RAIL_PREFS_ACCOUNT_DATA_TYPE, prefs satisfies SpaceRailPrefs).catch(() => {
      // Best-effort — the local write already succeeded via the atom's own
      // storage effect; a failed remote mirror just means this device's
      // change won't show up elsewhere until the next successful write.
    });
  }, [prefs]);

  return [prefs, setPrefs] as const;
}
