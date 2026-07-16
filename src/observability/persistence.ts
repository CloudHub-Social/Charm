import {
  DEFAULT_OBSERVABILITY_SETTINGS,
  normalizeObservabilitySettings,
  type ObservabilitySettings,
} from "./settings";
import { isTauri } from "@/lib/platform";

export const OBSERVABILITY_LOCAL_STORAGE_KEY = "charm:observability";
export const OBSERVABILITY_STORE_FILENAME = "observability.json";
export const OBSERVABILITY_STORE_KEY = "observability";

interface PersistedEnvelope {
  state: ObservabilitySettings;
  updatedAt: number;
}

let persistMutationId = 0;
let durablePersistTail = Promise.resolve();

/**
 * `sessionStorage` key backing {@link nextConsentSyncSequence}'s counter —
 * exported only for that function's own use, not a public API.
 */
const CONSENT_SYNC_SEQUENCE_STORAGE_KEY = "charm:consentSyncSequence";

/**
 * Assigned at send time to every `update_observability_log_consent`/
 * `update_observability_sentry_consent` IPC call, so the Rust side can tell
 * which of two overlapping calls is actually newer regardless of which one
 * happens to arrive first. Tauri gives no ordering guarantee between two
 * independent `invoke`s — an eager opt-out racing a still-in-flight earlier
 * opt-in could otherwise have the *older* call land second and silently
 * undo the newer one (Codex review on #289, P1). Shared across both consent
 * kinds (log and sentry) rather than one counter each — they don't need to
 * interleave meaningfully against each other, but a single always-
 * increasing source is simpler than keeping two in sync with no benefit.
 *
 * Backed by `sessionStorage`, not a plain module-scoped variable (Codex
 * review on #289, P1 follow-up to the first fix): the Rust process can
 * outlive a webview reload (the Tauri window navigating/reloading without
 * the native process restarting), which would reset a plain in-memory
 * counter back to `0` while Rust's `RUNTIME_*_CONSENT` watermark keeps
 * whatever it was before the reload — the first post-reload call would then
 * look "stale" and get silently ignored. An earlier version of this used
 * `Date.now()` instead, reasoning that wall-clock time only moves forward —
 * true in the common case, but wrong if the system clock is corrected
 * backward (NTP, manual change) between issuing a sequence and the next
 * reload, which would reproduce the exact same staleness bug via a
 * different path. `sessionStorage` sidesteps wall-clock entirely: it
 * persists across a reload/navigation within the same tab/window (matching
 * "must survive webview reload") and is cleared when that tab/window
 * actually closes (matching Rust's own watermark reset on process restart —
 * the two resets stay aligned since both are tied to the same underlying
 * app-lifetime boundary, not to independent clocks).
 */
let inMemoryConsentSyncSequenceFallback = 0;
function nextConsentSyncSequence(): number {
  try {
    const current = Number(sessionStorage.getItem(CONSENT_SYNC_SEQUENCE_STORAGE_KEY) ?? "0");
    const next = current + 1;
    sessionStorage.setItem(CONSENT_SYNC_SEQUENCE_STORAGE_KEY, String(next));
    return next;
  } catch {
    // sessionStorage can throw (private-browsing/storage-restricted
    // contexts) — same defensive posture as readLocalEnvelope/
    // writeLocalEnvelope above. Falls back to a plain in-memory counter,
    // which reintroduces the reload-reset gap this function exists to
    // close, but only in the already-degraded case where sessionStorage
    // itself isn't available — strictly increasing within this module
    // instance's lifetime is still better than nothing.
    inMemoryConsentSyncSequenceFallback += 1;
    return inMemoryConsentSyncSequenceFallback;
  }
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
  // The plugin's `load()` waits on a Tauri IPC callback that never arrives
  // outside the native shell — it doesn't reject, it hangs forever. Guard
  // with isTauri() the same way syncRustLogConsent does, or every web build
  // deadlocks on the top-level `await bootstrapSentry()` in main.tsx before
  // React ever mounts.
  if (!isTauri()) {
    return null;
  }
  const { load } = await import("@tauri-apps/plugin-store");
  return load(OBSERVABILITY_STORE_FILENAME, { autoSave: false, defaults: {} });
}

async function syncRustLogConsent(logsEnabled: boolean): Promise<void> {
  if (!isTauri()) {
    return;
  }
  const sequence = nextConsentSyncSequence();
  try {
    const { invoke } = await import("@tauri-apps/api/core");
    await invoke("update_observability_log_consent", { logsEnabled, sequence });
  } catch (error) {
    console.warn("Failed to sync Rust observability log consent", error);
    // Rust reads the persisted store on the next app start if same-session IPC is unavailable.
  }
}

/**
 * Rust's counterpart to `syncRustLogConsent`, but for the primary
 * `sentryEnabled` opt-in rather than the stricter `logsEnabled` sub-toggle —
 * kept as its own call (not folded into `syncRustLogConsent`) because the
 * two are independent settings and the backend gates different things on
 * each (`observability_trace::traced`'s performance transactions on this
 * one; native log events on the other). See `RUNTIME_SENTRY_CONSENT`'s doc
 * comment in `src-tauri/src/lib.rs`.
 */
async function syncRustSentryConsent(sentryEnabled: boolean): Promise<void> {
  if (!isTauri()) {
    return;
  }
  const sequence = nextConsentSyncSequence();
  try {
    const { invoke } = await import("@tauri-apps/api/core");
    await invoke("update_observability_sentry_consent", { sentryEnabled, sequence });
  } catch (error) {
    console.warn("Failed to sync Rust observability Sentry consent", error);
    // Rust reads the persisted store on the next app start if same-session IPC is unavailable.
  }
}

async function readStoreEnvelope(): Promise<PersistedEnvelope | null> {
  try {
    const store = await getStore();
    if (!store) return null;
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
  const mutationId = ++persistMutationId;
  const envelope: PersistedEnvelope = {
    state: normalizeObservabilitySettings(settings),
    updatedAt,
  };
  writeLocalEnvelope(envelope);
  // Concurrent, not sequential (Codex review on #289): these are two
  // independent Tauri commands with no ordering dependency between them, so
  // awaiting the log-consent IPC first would let a delayed or hung
  // update_observability_log_consent call block the primary Sentry
  // revocation behind it — the opposite of "eager" for the one that gates
  // whether login/sync/timeline performance transactions keep starting.
  await Promise.all([
    !envelope.state.sentryEnabled ? syncRustSentryConsent(false) : Promise.resolve(),
    !envelope.state.logsEnabled ? syncRustLogConsent(false) : Promise.resolve(),
  ]);
  let persisted = false;
  try {
    const durablePersist = durablePersistTail.then(async () => {
      if (mutationId !== persistMutationId) {
        return false;
      }
      const store = await getStore();
      if (!store || mutationId !== persistMutationId) {
        return false;
      }
      await store.set(OBSERVABILITY_STORE_KEY, envelope);
      if (mutationId !== persistMutationId) {
        return false;
      }
      await store.save();
      return mutationId === persistMutationId;
    });
    durablePersistTail = durablePersist.then(
      () => undefined,
      () => undefined,
    );
    persisted = await durablePersist;
  } catch (error) {
    if (isTauri()) {
      console.warn("Failed to persist observability settings to the Tauri store", error);
    }
    // The local mirror already landed; plain-browser tests and dev previews use it.
  }
  if (persisted && mutationId === persistMutationId) {
    await Promise.all([
      envelope.state.sentryEnabled ? syncRustSentryConsent(true) : Promise.resolve(),
      envelope.state.logsEnabled ? syncRustLogConsent(true) : Promise.resolve(),
    ]);
  }
}
