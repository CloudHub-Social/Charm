import { useAtom } from "jotai";
import { useEffect, useRef } from "react";
import { getAccountData, setAccountData } from "@/lib/matrix";
import {
  isSpaceRailPrefs,
  SPACE_RAIL_PREFS_ACCOUNT_DATA_TYPE,
  spaceRailPrefsAtom,
  type SpaceRailPrefs,
} from "./spaceRailPrefs";

/**
 * Layers Spec 63's cross-device account-data sync on top of the local-storage
 * `spaceRailPrefsAtom` — mirrors `useOnboardingGate`'s local-flag + account-
 * data pattern (Spec 12), not a new one. On mount, an account-data read (if
 * it returns a well-formed value) overwrites the local cache; every local
 * change after that point is mirrored back to account data. The overwrite
 * direction is deliberately "remote wins on load" rather than merging — Spec
 * 63's own account-data structure has no per-field timestamps to merge by,
 * and a full clobber matches how `SpaceRailPrefs` is already read/written as
 * one opaque blob everywhere else in this feature.
 */
export function useSpaceRailPrefsSync() {
  const [prefs, setPrefs] = useAtom(spaceRailPrefsAtom);
  const loadedRef = useRef(false);

  useEffect(() => {
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
    // Only ever runs once per mount — `setPrefs` is a stable jotai setter.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

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
