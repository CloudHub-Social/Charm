import { useAtomValue, useSetAtom } from "jotai";
import { type ReactNode, useEffect } from "react";
import { densityAtom, fontSizeAtom, reducedMotionAtom, themeAtom } from "./atoms";
import { applyAppearanceToDom, resolveEffectiveTheme } from "./dom";
import {
  mergeAppearance,
  pickNewerEnvelope,
  readLocalMirror,
  readPersistedAppearance,
} from "./persistence";

/**
 * Mounted once near the root (see `main.tsx`). Two jobs:
 *
 * 1. **Reconcile on load** — `index.html`'s inline boot script already
 *    applied the localStorage-mirrored appearance to `<html>` before first
 *    paint (flash-free). This effect re-reads the authoritative
 *    `tauri-plugin-store` value once the JS runtime is up, updates the atoms
 *    to match, and re-applies to the DOM if the store had drifted from the
 *    mirror (e.g. a change made in another window).
 * 2. **Live system-theme tracking** — subscribes to
 *    `matchMedia('(prefers-color-scheme: dark)')` so a `system` theme choice
 *    reacts to OS changes at runtime, not just at boot.
 *
 * Renders `children` unconditionally — it never blocks first paint (that's
 * the whole point of the boot script), it only reconciles afterward.
 */
export function ThemeProvider({ children }: { children: ReactNode }) {
  const theme = useAtomValue(themeAtom);
  const setTheme = useSetAtom(themeAtom);
  const setFontSize = useSetAtom(fontSizeAtom);
  const setDensity = useSetAtom(densityAtom);
  const setReducedMotion = useSetAtom(reducedMotionAtom);

  useEffect(() => {
    let cancelled = false;

    async function reconcile() {
      const persisted = await readPersistedAppearance();
      const local = readLocalMirror();
      // Prefer whichever of the store/localStorage is actually newer rather
      // than unconditionally trusting the store — see persistence.ts's doc
      // comment: the store write in `persistAppearance` is async and can
      // still be in flight (or can fail) when the app quits, in which case
      // a stale-but-non-null store value must not silently win over a
      // newer localStorage write.
      const state = mergeAppearance(pickNewerEnvelope(persisted, local));
      if (cancelled) return;
      setTheme(state.theme);
      setFontSize(state.fontSize);
      setDensity(state.density);
      setReducedMotion(state.reducedMotion);
      applyAppearanceToDom(state);
    }

    void reconcile();
    return () => {
      cancelled = true;
    };
  }, [setDensity, setFontSize, setReducedMotion, setTheme]);

  useEffect(() => {
    if (theme !== "system") return undefined;
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") return undefined;
    const mql = window.matchMedia("(prefers-color-scheme: dark)");

    // Re-subscribed whenever `theme` changes, so this only listens for OS
    // changes while the user's choice is actually "system" — a literal
    // dark/light/midnight pick is never perturbed by an OS change.
    const onChange = () => {
      document.documentElement.dataset.theme = resolveEffectiveTheme("system");
    };

    mql.addEventListener("change", onChange);
    return () => mql.removeEventListener("change", onChange);
  }, [theme]);

  return children;
}
