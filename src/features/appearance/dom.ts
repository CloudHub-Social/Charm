import type { AppearanceState, Theme } from "./atoms";

/** Resolves the OS color-scheme preference. Used when the user's `theme`
 * choice is `"system"`; falls back to `"dark"` (Charm's dark-first default)
 * when `matchMedia` is unavailable (e.g. some test environments). */
export function resolveSystemTheme(): "dark" | "light" {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return "dark";
  return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

/** The theme actually applied to the DOM: `system` resolves against the OS,
 * every other choice applies literally. */
export function resolveEffectiveTheme(theme: Theme): "dark" | "light" | "midnight" {
  return theme === "system" ? resolveSystemTheme() : theme;
}

/**
 * Applies the full appearance state to `<html>`'s dataset. This is the one
 * function that touches `document.documentElement` for live updates — the
 * inline boot script in `index.html` duplicates the same attribute names
 * (kept in sync manually; see its comment) for the pre-paint case, since it
 * can't import this module.
 */
export function applyAppearanceToDom(state: AppearanceState): void {
  if (typeof document === "undefined") return;
  const root = document.documentElement;
  root.dataset.theme = resolveEffectiveTheme(state.theme);
  root.dataset.density = state.density;
  root.dataset.fontSize = state.fontSize;
  root.dataset.reducedMotion = state.reducedMotion;
}
