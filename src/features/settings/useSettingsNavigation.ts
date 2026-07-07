import { useAtom } from "jotai";
import { useCallback, useEffect } from "react";
import {
  parseSettingsHash,
  settingsHash,
  settingsOpenAtom,
  type SettingsSection,
} from "./settingsAtoms";

/**
 * Opens settings at `section`, updating the atom directly (so this works
 * even where `useSettingsHashSync` isn't mounted — tests, Storybook) and
 * setting a matching `#/settings/<section>` hash so the location stays
 * addressable (bookmarkable, back/forward-navigable, and deep-linkable from
 * elsewhere in the app — e.g. an unverified-session banner linking straight
 * to Devices) without pulling in a full router for what's otherwise a single
 * overlay/page.
 */
export function useSettingsNavigation() {
  const [section, setSection] = useAtom(settingsOpenAtom);

  const openSettings = useCallback(
    (next: SettingsSection) => {
      setSection(next);
      const hash = settingsHash(next);
      // Push only for the actual open (settings wasn't showing a section
      // yet) — that's the one entry Back should land on to close it.
      // Switching sections while already open reuses this same function
      // (the tab nav's onSectionChange), and pushing there too would stack
      // one more history entry per tab click; replacing keeps just the one
      // "settings is open" entry regardless of how many sections were
      // visited before Back/closing.
      if (section) {
        history.replaceState(null, "", window.location.pathname + window.location.search + hash);
      } else {
        window.location.hash = hash;
      }
    },
    [section, setSection],
  );

  const closeSettings = useCallback(() => {
    // Replaces, not pushes: the open already pushed one history entry for
    // `#/settings/<section>` — closing must collapse back to wherever the
    // user was, not add a second entry that Back would land on before
    // reaching that. A push here would make Back reopen settings via
    // `useSettingsHashSync` instead of leaving the app where it was closed.
    if (parseSettingsHash(window.location.hash)) {
      history.replaceState(null, "", window.location.pathname + window.location.search);
    }
    setSection(null);
  }, [setSection]);

  return { section, openSettings, closeSettings };
}

/**
 * Keeps `settingsOpenAtom` in sync with `window.location.hash` in both
 * directions: mount once near the app root so a page load (or a deep link
 * set from outside React) with `#/settings/<section>` in the URL opens
 * straight to that section, and so browser back/forward through
 * `hashchange` events closes/switches settings accordingly.
 */
export function useSettingsHashSync() {
  const [, setSection] = useAtom(settingsOpenAtom);

  useEffect(() => {
    const syncFromHash = () => setSection(parseSettingsHash(window.location.hash));
    syncFromHash();
    window.addEventListener("hashchange", syncFromHash);
    return () => window.removeEventListener("hashchange", syncFromHash);
  }, [setSection]);
}
