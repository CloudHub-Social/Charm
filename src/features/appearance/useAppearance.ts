import { useAtom } from "jotai";
import { useCallback } from "react";
import {
  densityAtom,
  fontSizeAtom,
  reducedMotionAtom,
  themeAtom,
  type Density,
  type FontSize,
  type ReducedMotion,
  type Theme,
} from "./atoms";
import { applyAppearanceToDom } from "./dom";
import { persistAppearance } from "./persistence";

/**
 * Reads and writes the current appearance settings. Every setter here is the
 * single write path used by both the Settings Appearance panel and any
 * future caller: it updates the atom, mutates the DOM dataset immediately
 * (live, no reload), and persists (store + localStorage write-through) —
 * so callers never need to remember those three steps themselves.
 */
export function useAppearance() {
  const [theme, setThemeAtom] = useAtom(themeAtom);
  const [fontSize, setFontSizeAtom] = useAtom(fontSizeAtom);
  const [density, setDensityAtom] = useAtom(densityAtom);
  const [reducedMotion, setReducedMotionAtom] = useAtom(reducedMotionAtom);

  const commit = useCallback(
    (next: {
      theme: Theme;
      fontSize: FontSize;
      density: Density;
      reducedMotion: ReducedMotion;
    }) => {
      applyAppearanceToDom(next);
      void persistAppearance(next);
    },
    [],
  );

  const setTheme = useCallback(
    (next: Theme) => {
      setThemeAtom(next);
      commit({ theme: next, fontSize, density, reducedMotion });
    },
    [commit, density, fontSize, reducedMotion, setThemeAtom],
  );

  const setFontSize = useCallback(
    (next: FontSize) => {
      setFontSizeAtom(next);
      commit({ theme, fontSize: next, density, reducedMotion });
    },
    [commit, density, reducedMotion, setFontSizeAtom, theme],
  );

  const setDensity = useCallback(
    (next: Density) => {
      setDensityAtom(next);
      commit({ theme, fontSize, density: next, reducedMotion });
    },
    [commit, fontSize, reducedMotion, setDensityAtom, theme],
  );

  const setReducedMotion = useCallback(
    (next: ReducedMotion) => {
      setReducedMotionAtom(next);
      commit({ theme, fontSize, density, reducedMotion: next });
    },
    [commit, density, fontSize, setReducedMotionAtom, theme],
  );

  return {
    theme,
    fontSize,
    density,
    reducedMotion,
    setTheme,
    setFontSize,
    setDensity,
    setReducedMotion,
  };
}
