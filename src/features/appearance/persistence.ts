import type { AppearanceState, Density, FontSize, ReducedMotion, Theme } from "./atoms";
import {
  DEFAULT_APPEARANCE,
  VALID_DENSITIES,
  VALID_FONT_SIZES,
  VALID_REDUCED_MOTIONS,
  VALID_THEMES,
} from "./atoms";

/** Type guard: is `value` one of the members of `allowed`? Used to validate
 * a field read back from JSON (localStorage/tauri-plugin-store) against its
 * supported union before trusting it — see `mergeAppearance`'s doc comment. */
function isValid<T extends string>(value: unknown, allowed: readonly T[]): value is T {
  return typeof value === "string" && (allowed as readonly string[]).includes(value);
}

/**
 * Persistence for appearance settings. `tauri-plugin-store` (a separate
 * `appearance.json` store, distinct from any other feature's store file) is
 * normally the source of truth, reconciled into the atoms on mount by
 * `ThemeProvider`. Because the store plugin's reads/writes are async, every
 * write also mirrors synchronously to `localStorage` under
 * `LOCAL_STORAGE_KEY` — that mirror is what `index.html`'s inline boot
 * script reads before first paint to avoid a flash of the default theme.
 *
 * Both locations store a `PersistedEnvelope` (state + `updatedAt` epoch ms),
 * not a bare `AppearanceState`. Reconciliation picks whichever of the two
 * has the newer `updatedAt` rather than unconditionally trusting the store.
 * This matters because `persistAppearance`'s two writes (localStorage,
 * store) aren't atomic: the localStorage write is synchronous and always
 * lands, but the store write is an async round-trip through
 * `tauri-plugin-store` that can still be in flight (or can fail) when the
 * app quits — e.g. the user changes the theme and immediately quits, or a
 * transient disk error drops the store write. Without a version to compare,
 * reconciliation would see a *non-null* (just stale) store value and let it
 * silently overwrite the newer localStorage value on next launch, reverting
 * the user's last change. Last-write-wins by timestamp is sufficient here —
 * there's exactly one writer (this process) and no need for full CRDT
 * merge semantics.
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

/** What's actually persisted at each location — the appearance state plus
 * the epoch-ms time it was written, so reconciliation can prefer whichever
 * of localStorage/store is newer instead of unconditionally trusting the
 * store. See this module's doc comment. */
export interface PersistedEnvelope {
  state: Partial<AppearanceState>;
  updatedAt: number;
}

function isPersistedEnvelope(value: unknown): value is PersistedEnvelope {
  return (
    typeof value === "object" &&
    value !== null &&
    "state" in value &&
    "updatedAt" in value &&
    typeof (value as { updatedAt: unknown }).updatedAt === "number" &&
    typeof (value as { state: unknown }).state === "object" &&
    (value as { state: unknown }).state !== null
  );
}

/** Reads the localStorage mirror. Accepts both the current envelope shape
 * (`{ state, updatedAt }`) and the pre-envelope bare-`AppearanceState` shape
 * (treated as `updatedAt: 0`, i.e. always loses to any versioned value) so a
 * mirror written by a previous build doesn't throw or get silently
 * discarded — see `mergeAppearance` for how an invalid/partial `state` is
 * further validated. */
export function readLocalMirror(): PersistedEnvelope | null {
  try {
    const raw = localStorage.getItem(LOCAL_STORAGE_KEY);
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    if (isPersistedEnvelope(parsed)) return parsed;
    if (typeof parsed === "object" && parsed !== null) {
      return { state: parsed as Partial<AppearanceState>, updatedAt: 0 };
    }
    return null;
  } catch {
    return null;
  }
}

export function writeLocalMirror(state: AppearanceState, updatedAt: number): void {
  try {
    const envelope: PersistedEnvelope = { state, updatedAt };
    localStorage.setItem(LOCAL_STORAGE_KEY, JSON.stringify(envelope));
  } catch {
    // Best-effort — a private-browsing/quota failure shouldn't break appearance changes.
  }
}

async function getStore() {
  const { load } = await import("@tauri-apps/plugin-store");
  return load(STORE_FILENAME, { autoSave: true, defaults: {} });
}

/** Reads the persisted appearance envelope from `tauri-plugin-store`,
 * falling back to `null` if the plugin isn't available (e.g. plain-browser
 * e2e) or nothing has been persisted yet. Same pre-envelope fallback as
 * `readLocalMirror`. */
export async function readPersistedAppearance(): Promise<PersistedEnvelope | null> {
  try {
    const store = await getStore();
    const value = await store.get<unknown>(STORE_KEY);
    if (value == null) return null;
    if (isPersistedEnvelope(value)) return value;
    if (typeof value === "object") {
      return { state: value as Partial<AppearanceState>, updatedAt: 0 };
    }
    return null;
  } catch {
    return null;
  }
}

/** Writes the full appearance state (with an `updatedAt` timestamp) to
 * `tauri-plugin-store` and mirrors it to `localStorage` write-through.
 * Accepts an explicit `updatedAt` (rather than always calling `Date.now()`
 * internally) purely so tests can pass deterministic values; real callers
 * (`useAppearance`) always pass `Date.now()`. */
export async function persistAppearance(
  state: AppearanceState,
  updatedAt: number = Date.now(),
): Promise<void> {
  writeLocalMirror(state, updatedAt);
  try {
    const store = await getStore();
    const envelope: PersistedEnvelope = { state, updatedAt };
    await store.set(STORE_KEY, envelope);
  } catch {
    // Best-effort — see module doc. The localStorage mirror already landed.
  }
}

/** Picks whichever of the store/localStorage envelopes is newer (by
 * `updatedAt`), falling back to whichever one is non-null if only one
 * exists. This is `ThemeProvider`'s reconciliation policy — see this
 * module's doc comment for why a version compare is needed instead of
 * unconditionally preferring the store. */
export function pickNewerEnvelope(
  store: PersistedEnvelope | null,
  local: PersistedEnvelope | null,
): Partial<AppearanceState> | null {
  if (store && local) return store.updatedAt >= local.updatedAt ? store.state : local.state;
  return (store ?? local)?.state ?? null;
}

/** Merges a partial persisted/mirrored record over the defaults, validating
 * each field against its supported union (`VALID_THEMES`/etc. in atoms.ts)
 * and falling back to the default on anything missing OR invalid — not just
 * missing. `localStorage`/`tauri-plugin-store` are both plain JSON with no
 * schema enforcement, so a corrupted-but-parseable value (e.g. a
 * hand-edited `theme: "banana"`, or a future downgrade reading a store file
 * written by a newer version with a value this build doesn't know) would
 * otherwise sail through a bare `??` and get written straight to the DOM
 * dataset, where it matches no CSS override and silently breaks theming. */
export function mergeAppearance(partial: Partial<AppearanceState> | null): AppearanceState {
  if (!partial) return DEFAULT_APPEARANCE;
  return {
    theme: isValid<Theme>(partial.theme, VALID_THEMES) ? partial.theme : DEFAULT_APPEARANCE.theme,
    fontSize: isValid<FontSize>(partial.fontSize, VALID_FONT_SIZES)
      ? partial.fontSize
      : DEFAULT_APPEARANCE.fontSize,
    density: isValid<Density>(partial.density, VALID_DENSITIES)
      ? partial.density
      : DEFAULT_APPEARANCE.density,
    reducedMotion: isValid<ReducedMotion>(partial.reducedMotion, VALID_REDUCED_MOTIONS)
      ? partial.reducedMotion
      : DEFAULT_APPEARANCE.reducedMotion,
  };
}
