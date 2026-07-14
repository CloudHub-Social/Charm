import type { FeatureFlagKey } from "@bindings/FeatureFlagKey";
import type { Store } from "@tauri-apps/plugin-store";
import { FEATURE_FLAG_CATALOG } from "./catalog";
import type { FeatureFlagOverrides, FeatureFlagRemote } from "./resolve";
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
// Remote (OFREP) last-known-good cache — a separate key so remote refreshes and
// override writes never clobber each other in the shared file. Rust reads both.
export const FEATURE_FLAGS_REMOTE_STORE_KEY = "featureFlagsRemote";
export const FEATURE_FLAGS_REMOTE_LOCAL_STORAGE_KEY = "charm:featureFlagsRemote";

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
  localStorage.setItem(FEATURE_FLAGS_LOCAL_STORAGE_KEY, JSON.stringify(envelope));
}

let storePromise: Promise<Store> | undefined;

async function getStore(): Promise<Store | null> {
  // `load()` hangs forever outside the native shell (its IPC callback never
  // arrives), so gate on isTauri() the same way persistence.ts does.
  if (!isTauri()) return null;
  storePromise ??= import("@tauri-apps/plugin-store")
    .then(({ load }) => load(FEATURE_FLAGS_STORE_FILENAME, { autoSave: false, defaults: {} }))
    .catch((error) => {
      storePromise = undefined;
      throw error;
    });
  return storePromise;
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

// Serializes durable writes, mirroring `observability/persistence.ts`. Without
// this, two `persistOverrides` calls in flight at once (e.g. the Labs panel
// toggling two flags quickly) each run their own `load`/`set`/`save`, and the
// older save can land last — leaving `feature-flags.json` with stale overrides
// that the Rust core (which reads only the durable file) then evaluates. The
// mutation counter also lets a superseded write short-circuit instead of
// racing to overwrite a newer one.
let persistMutationId = 0;
let durablePersistTail: Promise<void> = Promise.resolve();

async function restoreUnsavedStoreValue(store: Store, previous: unknown): Promise<void> {
  try {
    // Prefer the file as the authority: save() may fail after partially
    // updating the plugin's in-memory map, while reload() restores exactly
    // what Rust and the next launch will read.
    await store.reload();
    return;
  } catch {
    // If reload itself is unavailable, at least restore this key in memory.
  }
  try {
    if (previous === undefined) {
      await store.delete(FEATURE_FLAGS_STORE_KEY);
    } else {
      await store.set(FEATURE_FLAGS_STORE_KEY, previous);
    }
  } catch {
    // Preserve the original persistence error for the caller.
  }
}

/** Persists overrides to the local mirror and (in Tauri) the durable store. */
export async function persistOverrides(
  overrides: FeatureFlagOverrides,
  updatedAt: number = Date.now(),
): Promise<boolean> {
  const mutationId = ++persistMutationId;
  const envelope: PersistedEnvelope = { state: { overrides }, updatedAt };
  if (!isTauri()) {
    writeLocalEnvelope(envelope);
    return true;
  }

  const durablePersist = durablePersistTail.then(async () => {
    if (mutationId !== persistMutationId) return false;
    const store = await getStore();
    if (!store) throw new Error("Feature flag store is unavailable");
    if (mutationId !== persistMutationId) return false;
    const previous = await store.get<unknown>(FEATURE_FLAGS_STORE_KEY);
    await store.set(FEATURE_FLAGS_STORE_KEY, envelope);
    if (mutationId !== persistMutationId) {
      await restoreUnsavedStoreValue(store, previous);
      return false;
    }
    try {
      await store.save();
    } catch (error) {
      await restoreUnsavedStoreValue(store, previous);
      throw error;
    }
    // Once save starts, this envelope may have reached disk even if a newer
    // mutation arrives before the promise resolves. Treat it as persisted so
    // the local mirror remains a valid rollback source if that write fails.
    return true;
  });
  // Chain the next write onto this one regardless of outcome, so a failed
  // save doesn't wedge the queue.
  durablePersistTail = durablePersist.then(
    () => undefined,
    () => undefined,
  );
  const persisted = await durablePersist;
  if (persisted) {
    try {
      writeLocalEnvelope(envelope);
    } catch {
      // Best-effort mirror in Tauri; the durable store already committed and
      // remains the source Rust reads.
    }
  }
  return persisted;
}

// --- Remote (OFREP) last-known-good cache -----------------------------------

interface RemoteEnvelope {
  state: { remote: FeatureFlagRemote };
  updatedAt: number;
}

function normalizeRemote(value: unknown): FeatureFlagRemote {
  if (typeof value !== "object" || value === null) return {};
  const source = (value as { remote?: unknown }).remote ?? value;
  if (typeof source !== "object" || source === null) return {};
  const result: FeatureFlagRemote = {};
  for (const [key, raw] of Object.entries(source as Record<string, unknown>)) {
    if (typeof raw === "boolean" && isKnownFlagKey(key)) {
      result[key] = raw;
    }
  }
  return result;
}

function remoteEnvelopeFromUnknown(value: unknown): RemoteEnvelope | null {
  if (typeof value !== "object" || value === null) return null;
  const record = value as { state?: unknown; updatedAt?: unknown };
  if (record.state !== undefined) {
    return {
      state: { remote: normalizeRemote(record.state) },
      updatedAt: typeof record.updatedAt === "number" ? record.updatedAt : 0,
    };
  }
  return { state: { remote: normalizeRemote(value) }, updatedAt: 0 };
}

function readLocalRemoteEnvelope(): RemoteEnvelope | null {
  try {
    const raw = localStorage.getItem(FEATURE_FLAGS_REMOTE_LOCAL_STORAGE_KEY);
    return raw ? remoteEnvelopeFromUnknown(JSON.parse(raw)) : null;
  } catch {
    return null;
  }
}

async function readStoreRemoteEnvelope(): Promise<RemoteEnvelope | null> {
  try {
    const store = await getStore();
    if (!store) return null;
    return remoteEnvelopeFromUnknown(await store.get<unknown>(FEATURE_FLAGS_REMOTE_STORE_KEY));
  } catch {
    return null;
  }
}

/** Reads the cached last-known-good remote evaluations (fail-open source). */
export async function readRemoteFlags(): Promise<FeatureFlagRemote> {
  const [store, local] = await Promise.all([
    readStoreRemoteEnvelope(),
    Promise.resolve(readLocalRemoteEnvelope()),
  ]);
  const envelope =
    store && local ? (store.updatedAt >= local.updatedAt ? store : local) : (store ?? local);
  return envelope?.state.remote ?? {};
}

/**
 * Persists a fresh remote snapshot. Returns whether the durable write reached
 * disk (always `true` on the web path, where `localStorage` is the store the
 * caller reads back). Routed through the **same** `durablePersistTail` queue as
 * `persistOverrides` so a remote refresh's `set`+`save` can never interleave
 * with an override's — the plugin store flushes the whole file on `save()`, so
 * an unserialized remote save could prematurely persist an in-flight override
 * and break its rollback. On failure the previous durable cache stands
 * (fail-open); the caller only applies the new values to the UI once this
 * returns `true`, keeping the frontend consistent with what Rust reads.
 */
export async function persistRemoteFlags(
  remote: FeatureFlagRemote,
  updatedAt: number = Date.now(),
): Promise<boolean> {
  const envelope: RemoteEnvelope = { state: { remote }, updatedAt };
  const writeMirror = () => {
    try {
      localStorage.setItem(FEATURE_FLAGS_REMOTE_LOCAL_STORAGE_KEY, JSON.stringify(envelope));
    } catch {
      // Best-effort mirror.
    }
  };
  if (!isTauri()) {
    // No native store here — localStorage is the durable location.
    writeMirror();
    return true;
  }

  const task = durablePersistTail.then(async () => {
    const store = await getStore();
    if (!store) return false;
    await store.set(FEATURE_FLAGS_REMOTE_STORE_KEY, envelope);
    await store.save();
    return true;
  });
  durablePersistTail = task.then(
    () => undefined,
    () => undefined,
  );
  let persisted = false;
  try {
    persisted = await task;
  } catch {
    // Keep the previous durable cache; Rust and the next launch fall back to it.
    persisted = false;
  }
  // Mirror only after the durable write lands — otherwise a failed save would
  // leave a newer-timestamped localStorage entry that `readRemoteFlags` prefers
  // on the next launch, diverging from the file the Rust core reads.
  if (persisted) writeMirror();
  return persisted;
}
