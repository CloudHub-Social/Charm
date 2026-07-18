import { atom } from "jotai";

export type Theme = "dark" | "light" | "midnight" | "system";
export type FontSize = "sm" | "md" | "lg" | "xl";
export type Density = "compact" | "cozy";
export type ReducedMotion = "system" | "on" | "off";
/** Charm 2.0 Spec 27: how message rows are shelled — bubble (default),
 * flat Discord-style, or single-line-per-message IRC-style. Unlike the
 * other appearance fields this never applies to `<html>`'s dataset (see
 * `dom.ts`) — it's a structural JSX choice consumed directly by
 * `MessageRow`, not a CSS variable. */
export type MessageLayout = "bubble" | "discord" | "irc";
export type JumboEmojiSize = "off" | "sm" | "md" | "lg";

export interface AppearanceState {
  theme: Theme;
  fontSize: FontSize;
  density: Density;
  reducedMotion: ReducedMotion;
  messageLayout: MessageLayout;
  jumboEmojiSize: JumboEmojiSize;
  showUnreadCounts: boolean;
  /** Spec 42: autoplay animated images (GIFs) inline in the timeline instead
   * of showing a static thumbnail until opened in the lightbox. */
  autoplayGifs: boolean;
  /** Spec 42: strip EXIF/metadata (GPS location, camera info, capture
   * timestamp) from images before upload. Default-on — a real privacy leak
   * otherwise, since sharing a photo would silently share where it was
   * taken. */
  stripExifOnUpload: boolean;
}

/**
 * Single source of truth for the allowed value set of each appearance
 * field, consumed by `mergeAppearance` (persistence.ts) to validate
 * anything read back from `localStorage`/`tauri-plugin-store` — both are
 * plain JSON, so a corrupted-but-parseable value (e.g. `theme: "banana"`)
 * would otherwise sail through the `??` null-coalescing in `mergeAppearance`
 * and get written straight to the DOM dataset, where it matches no
 * `[data-theme="…"]`/etc. CSS override and silently breaks theming.
 *
 * `index.html`'s inline boot script can't import this (it must run before
 * any module bundle), so it duplicates these same literal value lists —
 * kept in sync by hand; see that script's comment.
 */
export const VALID_THEMES: readonly Theme[] = ["dark", "light", "midnight", "system"];
export const VALID_FONT_SIZES: readonly FontSize[] = ["sm", "md", "lg", "xl"];
export const VALID_DENSITIES: readonly Density[] = ["compact", "cozy"];
export const VALID_REDUCED_MOTIONS: readonly ReducedMotion[] = ["system", "on", "off"];
export const VALID_MESSAGE_LAYOUTS: readonly MessageLayout[] = ["bubble", "discord", "irc"];
export const VALID_JUMBO_EMOJI_SIZES: readonly JumboEmojiSize[] = ["off", "sm", "md", "lg"];

/** Matches the defaults baked into `index.html`'s inline boot script and
 * `tokens.css` (dark-first, cozy density, M font size, system motion).
 * `messageLayout` defaults to `"bubble"` — Spec 27 is additive, matching
 * current/shipped behavior for existing users. */
export const DEFAULT_APPEARANCE: AppearanceState = {
  theme: "dark",
  fontSize: "md",
  density: "cozy",
  reducedMotion: "system",
  messageLayout: "bubble",
  jumboEmojiSize: "lg",
  showUnreadCounts: false,
  autoplayGifs: true,
  stripExifOnUpload: true,
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
export const messageLayoutAtom = atom<MessageLayout>(DEFAULT_APPEARANCE.messageLayout);
export const jumboEmojiSizeAtom = atom<JumboEmojiSize>(DEFAULT_APPEARANCE.jumboEmojiSize);
export const showUnreadCountsAtom = atom<boolean>(DEFAULT_APPEARANCE.showUnreadCounts);
export const autoplayGifsAtom = atom<boolean>(DEFAULT_APPEARANCE.autoplayGifs);
export const stripExifOnUploadAtom = atom<boolean>(DEFAULT_APPEARANCE.stripExifOnUpload);
