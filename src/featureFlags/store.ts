import type { FeatureFlagKey } from "@bindings/FeatureFlagKey";
import { FEATURE_FLAG_CATALOG } from "./catalog";
import type { FeatureFlagOverrides } from "./resolve";
import { isTauri } from "@/lib/platform";

/**
 * Local-override persistence, mirroring `src/observability/persistence.ts`:
 * a `tauri-plugin-store` file is the durable location (also read synchronously
 * by the Rust core at startup — see `feature_flags.rs`), with a `localStorage`
 * mirror so plain-browser/dev builds and tests work without the native shell.
 *
 * Envelope shape matches observability's (`{ <KEY>: { state, updatedAt } }`)
 * so the Rust reader (`overrides_from_value`) can parse it.
 */
export const FEATURE_FLAGS_STORE_FILENAME = "feature-flags.json";
export const FEATURE_FLAGS_STORE_KEY = "featureFlags";
export const FEATURE_FLAGS_LOCAL_STORAGE_KEY = "charm:featureFlags";

interface OverridesState {
  overrides: FeatureFlagOverrides;
}

interface PersistedEnvelope {
  state: OverridesState;
  updatedAt: number;
}

function isKnownFlagKey(key: string): key is FeatureFlagKey {
  return Object.prototype.hasOwnProperty.call(FEATURE_FLAG_CATALOG, key);
}

/** Drops unknown keys and non-boolean values — a stale override for a retired
 * flag, or a malformed file, must never resolve to a truthy value. */
function normalizeOverrides(value: unknown): FeatureFlagOverrides {
  if (typeof value !== "object" || value === null) return {};
  const source = (value as { overrides?: unknown }).overrides ?? value;
  if (typeof source !== "object" || source === null) return {};
  const result: FeatureFlagOverrides = {};
  for (const [key, raw] of Object.entries(source as Record<string, unknown>)) {
    if (typeof raw === "boolean" && isKnownFlagKey(key)) {
      result[key] = raw;
    }
  }
  return result;
}

function envelopeFromUnknown(value: unknown): PersistedEnvelope | null {
  if (typeof value !== "object" || value === null) return null;
  const record = value as { state?: unknown; updatedAt?: unknown };
  if (record.state !== undefined) {
    return {
      state: { overrides: normalizeOverrides(record.state) },
      updatedAt: typeof record.updatedAt === "number" ? record.updatedAt : 0,
    };
  }
  return { state: { overrides: normalizeOverrides(value) }, updatedAt: 0 };
}

function readLocalEnvelope(): PersistedEnvelope | null {
  try {
    const raw = localStorage.getItem(FEATURE_FLAGS_LOCAL_STORAGE_KEY);
    return raw ? envelopeFromUnknown(JSON.parse(raw)) : null;
  } catch {
    return null;
  }
}

function writeLocalEnvelope(envelope: PersistedEnvelope): void {
  try {
    localStorage.setItem(FEATURE_FLAGS_LOCAL_STORAGE_KEY, JSON.stringify(envelope));
  } catch {
    // Best-effort mirror; the Tauri store remains the durable location.
  }
}

async function getStore() {
  // `load()` hangs forever outside the native shell (its IPC callback never
  // arrives), so gate on isTauri() the same way persistence.ts does.
  if (!isTauri()) return null;
  const { load } = await import("@tauri-apps/plugin-store");
  return load(FEATURE_FLAGS_STORE_FILENAME, { autoSave: false, defaults: {} });
}

async function readStoreEnvelope(): Promise<PersistedEnvelope | null> {
  try {
    const store = await getStore();
    if (!store) return null;
    return envelopeFromUnknown(await store.get<unknown>(FEATURE_FLAGS_STORE_KEY));
  } catch {
    return null;
  }
}

/** Reads the effective overrides, preferring whichever of the durable store /
 * local mirror was written most recently (same conflict rule as observability). */
export async function readOverrides(): Promise<FeatureFlagOverrides> {
  const [store, local] = await Promise.all([
    readStoreEnvelope(),
    Promise.resolve(readLocalEnvelope()),
  ]);
  const envelope =
    store && local ? (store.updatedAt >= local.updatedAt ? store : local) : (store ?? local);
  return envelope?.state.overrides ?? {};
}

/** Persists overrides to the local mirror and (in Tauri) the durable store. */
export async function persistOverrides(
  overrides: FeatureFlagOverrides,
  updatedAt: number = Date.now(),
): Promise<void> {
  const envelope: PersistedEnvelope = { state: { overrides }, updatedAt };
  writeLocalEnvelope(envelope);
  try {
    const store = await getStore();
    if (!store) return;
    await store.set(FEATURE_FLAGS_STORE_KEY, envelope);
    await store.save();
  } catch {
    // The local mirror already landed; dev/browser builds rely on it.
  }
}
