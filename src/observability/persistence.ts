import {
  DEFAULT_OBSERVABILITY_SETTINGS,
  normalizeObservabilitySettings,
  type ObservabilitySettings,
} from "./settings";

export const OBSERVABILITY_LOCAL_STORAGE_KEY = "charm:observability";
export const OBSERVABILITY_STORE_FILENAME = "observability.json";
export const OBSERVABILITY_STORE_KEY = "observability";

interface PersistedEnvelope {
  state: ObservabilitySettings;
  updatedAt: number;
}

function isPersistedEnvelope(value: unknown): value is PersistedEnvelope {
  return (
    typeof value === "object" &&
    value !== null &&
    "state" in value &&
    "updatedAt" in value &&
    typeof (value as { updatedAt: unknown }).updatedAt === "number"
  );
}

function envelopeFromUnknown(value: unknown): PersistedEnvelope | null {
  if (isPersistedEnvelope(value)) {
    return { state: normalizeObservabilitySettings(value.state), updatedAt: value.updatedAt };
  }
  if (typeof value === "object" && value !== null) {
    return { state: normalizeObservabilitySettings(value), updatedAt: 0 };
  }
  return null;
}

function readLocalEnvelope(): PersistedEnvelope | null {
  try {
    const raw = localStorage.getItem(OBSERVABILITY_LOCAL_STORAGE_KEY);
    return raw ? envelopeFromUnknown(JSON.parse(raw)) : null;
  } catch {
    return null;
  }
}

function writeLocalEnvelope(envelope: PersistedEnvelope): void {
  try {
    localStorage.setItem(OBSERVABILITY_LOCAL_STORAGE_KEY, JSON.stringify(envelope));
  } catch {
    // Best-effort mirror; the Tauri store remains the durable location.
  }
}

async function getStore() {
  const { load } = await import("@tauri-apps/plugin-store");
  return load(OBSERVABILITY_STORE_FILENAME, { autoSave: true, defaults: {} });
}

async function readStoreEnvelope(): Promise<PersistedEnvelope | null> {
  try {
    const store = await getStore();
    return envelopeFromUnknown(await store.get<unknown>(OBSERVABILITY_STORE_KEY));
  } catch {
    return null;
  }
}

export async function readObservabilitySettings(): Promise<ObservabilitySettings> {
  const [store, local] = await Promise.all([
    readStoreEnvelope(),
    Promise.resolve(readLocalEnvelope()),
  ]);
  const envelope =
    store && local ? (store.updatedAt >= local.updatedAt ? store : local) : (store ?? local);
  return envelope?.state ?? DEFAULT_OBSERVABILITY_SETTINGS;
}

export async function persistObservabilitySettings(
  settings: ObservabilitySettings,
  updatedAt: number = Date.now(),
): Promise<void> {
  const envelope: PersistedEnvelope = {
    state: normalizeObservabilitySettings(settings),
    updatedAt,
  };
  writeLocalEnvelope(envelope);
  try {
    const store = await getStore();
    await store.set(OBSERVABILITY_STORE_KEY, envelope);
    await store.save();
  } catch {
    // The local mirror already landed; plain-browser tests and dev previews use it.
  }
}
