import { atom } from "jotai";

export type Theme = "dark" | "light" | "midnight" | "system";
export type FontSize = "sm" | "md" | "lg" | "xl";
export type Density = "compact" | "cozy";
export type ReducedMotion = "system" | "on" | "off";

export interface AppearanceState {
  theme: Theme;
  fontSize: FontSize;
  density: Density;
  reducedMotion: ReducedMotion;
}

/** Matches the defaults baked into `index.html`'s inline boot script and
 * `tokens.css` (dark-first, cozy density, M font size, system motion). */
export const DEFAULT_APPEARANCE: AppearanceState = {
  theme: "dark",
  fontSize: "md",
  density: "cozy",
  reducedMotion: "system",
};

/**
 * Source-of-truth appearance atoms. Plain value atoms (not derived/effect
 * atoms) so `useAppearance` can read/write them directly; DOM + persistence
 * side effects live in `ThemeProvider`/`useAppearance`, not here, to keep
 * these testable in isolation without touching `document`.
 */
export const themeAtom = atom<Theme>(DEFAULT_APPEARANCE.theme);
export const fontSizeAtom = atom<FontSize>(DEFAULT_APPEARANCE.fontSize);
export const densityAtom = atom<Density>(DEFAULT_APPEARANCE.density);
export const reducedMotionAtom = atom<ReducedMotion>(DEFAULT_APPEARANCE.reducedMotion);
