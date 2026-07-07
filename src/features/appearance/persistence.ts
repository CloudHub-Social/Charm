import type { AppearanceState } from "./atoms";
import { DEFAULT_APPEARANCE } from "./atoms";

/**
 * Persistence for appearance settings. `tauri-plugin-store` (a separate
 * `appearance.json` store, distinct from any other feature's store file) is
 * the source of truth, reconciled into the atoms on mount by
 * `ThemeProvider`. Because the store plugin's reads are async, every write
 * also mirrors synchronously to `localStorage` under `LOCAL_STORAGE_KEY` —
 * that mirror is what `index.html`'s inline boot script reads before first
 * paint to avoid a flash of the default theme.
 *
 * In the Playwright/browser e2e environment there is no real Tauri host, so
 * `@tauri-apps/plugin-store`'s `load()` call (which goes over
 * `__TAURI_INTERNALS__.invoke`) either throws or hangs against
 * `mockTauri.ts`'s narrow command surface. Every store call below is
 * best-effort: failures are swallowed and we fall back to the localStorage
 * mirror (or in-memory defaults), so the app degrades gracefully rather than
 * crashing when the plugin isn't available.
 */
export const LOCAL_STORAGE_KEY = "charm:appearance";
const STORE_FILENAME = "appearance.json";
const STORE_KEY = "appearance";

export function readLocalMirror(): Partial<AppearanceState> | null {
  try {
    const raw = localStorage.getItem(LOCAL_STORAGE_KEY);
    if (!raw) return null;
    return JSON.parse(raw) as Partial<AppearanceState>;
  } catch {
    return null;
  }
}

export function writeLocalMirror(state: AppearanceState): void {
  try {
    localStorage.setItem(LOCAL_STORAGE_KEY, JSON.stringify(state));
  } catch {
    // Best-effort — a private-browsing/quota failure shouldn't break appearance changes.
  }
}

async function getStore() {
  const { load } = await import("@tauri-apps/plugin-store");
  return load(STORE_FILENAME, { autoSave: true, defaults: {} });
}

/** Reads the persisted appearance from `tauri-plugin-store`, falling back to
 * `null` if the plugin isn't available (e.g. plain-browser e2e) or nothing
 * has been persisted yet. */
export async function readPersistedAppearance(): Promise<Partial<AppearanceState> | null> {
  try {
    const store = await getStore();
    const value = await store.get<Partial<AppearanceState>>(STORE_KEY);
    return value ?? null;
  } catch {
    return null;
  }
}

/** Writes the full appearance state to `tauri-plugin-store` and mirrors it
 * to `localStorage` write-through. */
export async function persistAppearance(state: AppearanceState): Promise<void> {
  writeLocalMirror(state);
  try {
    const store = await getStore();
    await store.set(STORE_KEY, state);
  } catch {
    // Best-effort — see module doc. The localStorage mirror already landed.
  }
}

/** Merges a partial persisted/mirrored record over the defaults, ignoring
 * any keys with unexpected values (e.g. a future downgrade reading a store
 * file written by a newer version with values this build doesn't know). */
export function mergeAppearance(partial: Partial<AppearanceState> | null): AppearanceState {
  if (!partial) return DEFAULT_APPEARANCE;
  return {
    theme: partial.theme ?? DEFAULT_APPEARANCE.theme,
    fontSize: partial.fontSize ?? DEFAULT_APPEARANCE.fontSize,
    density: partial.density ?? DEFAULT_APPEARANCE.density,
    reducedMotion: partial.reducedMotion ?? DEFAULT_APPEARANCE.reducedMotion,
  };
}
