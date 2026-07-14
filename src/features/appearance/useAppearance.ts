import { useAtom } from "jotai";
import { useCallback } from "react";
import {
  densityAtom,
  fontSizeAtom,
  jumboEmojiSizeAtom,
  messageLayoutAtom,
  reducedMotionAtom,
  themeAtom,
  type Density,
  type FontSize,
  type JumboEmojiSize,
  type MessageLayout,
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
 *
 * `messageLayout` (Charm 2.0 Spec 27) is the one field here that never
 * touches the DOM dataset — it's a structural choice read directly by
 * `MessageRow`, not a CSS variable — but still goes through the same
 * atom + persist commit as every other field for consistency.
 */
export function useAppearance() {
  const [theme, setThemeAtom] = useAtom(themeAtom);
  const [fontSize, setFontSizeAtom] = useAtom(fontSizeAtom);
  const [density, setDensityAtom] = useAtom(densityAtom);
  const [reducedMotion, setReducedMotionAtom] = useAtom(reducedMotionAtom);
  const [messageLayout, setMessageLayoutAtom] = useAtom(messageLayoutAtom);
  const [jumboEmojiSize, setJumboEmojiSizeAtom] = useAtom(jumboEmojiSizeAtom);

  const commit = useCallback(
    (next: {
      theme: Theme;
      fontSize: FontSize;
      density: Density;
      reducedMotion: ReducedMotion;
      messageLayout: MessageLayout;
      jumboEmojiSize: JumboEmojiSize;
    }) => {
      applyAppearanceToDom(next);
      void persistAppearance(next);
    },
    [],
  );

  const setTheme = useCallback(
    (next: Theme) => {
      setThemeAtom(next);
      commit({ theme: next, fontSize, density, reducedMotion, messageLayout, jumboEmojiSize });
    },
    [commit, density, fontSize, jumboEmojiSize, messageLayout, reducedMotion, setThemeAtom],
  );

  const setFontSize = useCallback(
    (next: FontSize) => {
      setFontSizeAtom(next);
      commit({ theme, fontSize: next, density, reducedMotion, messageLayout, jumboEmojiSize });
    },
    [commit, density, jumboEmojiSize, messageLayout, reducedMotion, setFontSizeAtom, theme],
  );

  const setDensity = useCallback(
    (next: Density) => {
      setDensityAtom(next);
      commit({ theme, fontSize, density: next, reducedMotion, messageLayout, jumboEmojiSize });
    },
    [commit, fontSize, jumboEmojiSize, messageLayout, reducedMotion, setDensityAtom, theme],
  );

  const setReducedMotion = useCallback(
    (next: ReducedMotion) => {
      setReducedMotionAtom(next);
      commit({ theme, fontSize, density, reducedMotion: next, messageLayout, jumboEmojiSize });
    },
    [commit, density, fontSize, jumboEmojiSize, messageLayout, setReducedMotionAtom, theme],
  );

  const setMessageLayout = useCallback(
    (next: MessageLayout) => {
      setMessageLayoutAtom(next);
      commit({ theme, fontSize, density, reducedMotion, messageLayout: next, jumboEmojiSize });
    },
    [commit, density, fontSize, jumboEmojiSize, reducedMotion, setMessageLayoutAtom, theme],
  );

  const setJumboEmojiSize = useCallback(
    (next: JumboEmojiSize) => {
      setJumboEmojiSizeAtom(next);
      commit({ theme, fontSize, density, reducedMotion, messageLayout, jumboEmojiSize: next });
    },
    [commit, density, fontSize, messageLayout, reducedMotion, setJumboEmojiSizeAtom, theme],
  );

  return {
    theme,
    fontSize,
    density,
    reducedMotion,
    messageLayout,
    jumboEmojiSize,
    setTheme,
    setFontSize,
    setDensity,
    setReducedMotion,
    setMessageLayout,
    setJumboEmojiSize,
  };
}
