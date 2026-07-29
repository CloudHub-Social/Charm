import { useAtom } from "jotai";
import { useCallback } from "react";
import {
  autoplayGifsAtom,
  densityAtom,
  fontSizeAtom,
  jumboEmojiSizeAtom,
  messageLayoutAtom,
  reducedMotionAtom,
  showUnreadCountsAtom,
  stripExifOnUploadAtom,
  themeAtom,
  type AppearanceState,
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
  const [showUnreadCounts, setShowUnreadCountsAtom] = useAtom(showUnreadCountsAtom);
  const [autoplayGifs, setAutoplayGifsAtom] = useAtom(autoplayGifsAtom);
  const [stripExifOnUpload, setStripExifOnUploadAtom] = useAtom(stripExifOnUploadAtom);

  const commit = useCallback(
    (patch: Partial<AppearanceState>) => {
      const next: AppearanceState = {
        theme,
        fontSize,
        density,
        reducedMotion,
        messageLayout,
        jumboEmojiSize,
        showUnreadCounts,
        autoplayGifs,
        stripExifOnUpload,
        ...patch,
      };
      applyAppearanceToDom(next);
      void persistAppearance(next);
    },
    [
      autoplayGifs,
      density,
      fontSize,
      jumboEmojiSize,
      messageLayout,
      reducedMotion,
      showUnreadCounts,
      stripExifOnUpload,
      theme,
    ],
  );

  const setTheme = useCallback(
    (next: Theme) => {
      setThemeAtom(next);
      commit({ theme: next });
    },
    [commit, setThemeAtom],
  );

  const setFontSize = useCallback(
    (next: FontSize) => {
      setFontSizeAtom(next);
      commit({ fontSize: next });
    },
    [commit, setFontSizeAtom],
  );

  const setDensity = useCallback(
    (next: Density) => {
      setDensityAtom(next);
      commit({ density: next });
    },
    [commit, setDensityAtom],
  );

  const setReducedMotion = useCallback(
    (next: ReducedMotion) => {
      setReducedMotionAtom(next);
      commit({ reducedMotion: next });
    },
    [commit, setReducedMotionAtom],
  );

  const setMessageLayout = useCallback(
    (next: MessageLayout) => {
      setMessageLayoutAtom(next);
      commit({ messageLayout: next });
    },
    [commit, setMessageLayoutAtom],
  );

  const setJumboEmojiSize = useCallback(
    (next: JumboEmojiSize) => {
      setJumboEmojiSizeAtom(next);
      commit({ jumboEmojiSize: next });
    },
    [commit, setJumboEmojiSizeAtom],
  );

  const setShowUnreadCounts = useCallback(
    (next: boolean) => {
      setShowUnreadCountsAtom(next);
      commit({ showUnreadCounts: next });
    },
    [commit, setShowUnreadCountsAtom],
  );

  const setAutoplayGifs = useCallback(
    (next: boolean) => {
      setAutoplayGifsAtom(next);
      commit({ autoplayGifs: next });
    },
    [commit, setAutoplayGifsAtom],
  );

  const setStripExifOnUpload = useCallback(
    (next: boolean) => {
      setStripExifOnUploadAtom(next);
      commit({ stripExifOnUpload: next });
    },
    [commit, setStripExifOnUploadAtom],
  );

  return {
    theme,
    fontSize,
    density,
    reducedMotion,
    messageLayout,
    jumboEmojiSize,
    showUnreadCounts,
    autoplayGifs,
    stripExifOnUpload,
    setTheme,
    setFontSize,
    setDensity,
    setReducedMotion,
    setMessageLayout,
    setJumboEmojiSize,
    setShowUnreadCounts,
    setAutoplayGifs,
    setStripExifOnUpload,
  };
}
