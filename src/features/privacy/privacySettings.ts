import { useSyncExternalStore } from "react";
import type { Store } from "@tauri-apps/plugin-store";
import { isTauri } from "@/lib/platform";

/**
 * Global (not per-room) privacy toggles (Spec 40): whether to send read
 * receipts and typing indicators, whether to appear offline regardless of
 * activity, and the auto-idle/away timeout. Persisted per-install, mirroring
 * the feature-flag override store (`src/featureFlags/store.ts`) but much
 * simpler — these are plain user preferences with a single writer, no
 * remote/rollout layer and no Rust-side reader, so a lightweight
 * store-plus-localStorage-mirror is enough.
 */
export interface PrivacySettings {
  /** When `true`, read receipts are sent as `m.read.private` instead of the
   * broadcast `m.read` — which, per Matrix reciprocity, also means the
   * client stops seeing other users' receipts. */
  hideReadReceipts: boolean;
  /** When `true`, the composer never emits `m.typing` notifications. */
  hideTyping: boolean;
  /** When `true`, presence is forced to `offline` regardless of activity. */
  appearOffline: boolean;
  /** When `true`, presence automatically drops to `unavailable` after
   * `idleTimeoutMins` of inactivity, and returns to `online` on activity
   * (unless `appearOffline` is set). */
  autoIdleEnabled: boolean;
  /** Minutes of inactivity before auto-idle kicks in. */
  idleTimeoutMins: number;
}

export const DEFAULT_PRIVACY_SETTINGS: PrivacySettings = {
  hideReadReceipts: false,
  hideTyping: false,
  appearOffline: false,
  autoIdleEnabled: false,
  idleTimeoutMins: 10,
};

export const MIN_IDLE_TIMEOUT_MINS = 1;
export const MAX_IDLE_TIMEOUT_MINS = 120;

export const PRIVACY_SETTINGS_STORE_FILENAME = "privacy-settings.json";
export const PRIVACY_SETTINGS_STORE_KEY = "privacySettings";
export const PRIVACY_SETTINGS_LOCAL_STORAGE_KEY = "charm:privacySettings";

function clampIdleTimeout(mins: number): number {
  if (!Number.isFinite(mins)) return DEFAULT_PRIVACY_SETTINGS.idleTimeoutMins;
  return Math.min(MAX_IDLE_TIMEOUT_MINS, Math.max(MIN_IDLE_TIMEOUT_MINS, Math.round(mins)));
}

/** Drops unknown fields and coerces to the expected shape, so a malformed or
 * partial persisted file can never produce a nonsensical setting. */
function normalize(value: unknown): PrivacySettings {
  if (typeof value !== "object" || value === null) return { ...DEFAULT_PRIVACY_SETTINGS };
  const source = value as Partial<PrivacySettings>;
  return {
    hideReadReceipts:
      typeof source.hideReadReceipts === "boolean"
        ? source.hideReadReceipts
        : DEFAULT_PRIVACY_SETTINGS.hideReadReceipts,
    hideTyping:
      typeof source.hideTyping === "boolean"
        ? source.hideTyping
        : DEFAULT_PRIVACY_SETTINGS.hideTyping,
    appearOffline:
      typeof source.appearOffline === "boolean"
        ? source.appearOffline
        : DEFAULT_PRIVACY_SETTINGS.appearOffline,
    autoIdleEnabled:
      typeof source.autoIdleEnabled === "boolean"
        ? source.autoIdleEnabled
        : DEFAULT_PRIVACY_SETTINGS.autoIdleEnabled,
    idleTimeoutMins:
      typeof source.idleTimeoutMins === "number"
        ? clampIdleTimeout(source.idleTimeoutMins)
        : DEFAULT_PRIVACY_SETTINGS.idleTimeoutMins,
  };
}

let cache: PrivacySettings = { ...DEFAULT_PRIVACY_SETTINGS };
let initialized = false;
const listeners = new Set<() => void>();

function emit(): void {
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function readLocal(): PrivacySettings | null {
  try {
    const raw = localStorage.getItem(PRIVACY_SETTINGS_LOCAL_STORAGE_KEY);
    return raw ? normalize(JSON.parse(raw)) : null;
  } catch {
    return null;
  }
}

function writeLocal(settings: PrivacySettings): void {
  try {
    localStorage.setItem(PRIVACY_SETTINGS_LOCAL_STORAGE_KEY, JSON.stringify(settings));
  } catch {
    // Best-effort mirror.
  }
}

let storePromise: Promise<Store> | undefined;

async function getStore() {
  if (!isTauri()) return null;
  storePromise ??= import("@tauri-apps/plugin-store")
    .then(({ load }) => load(PRIVACY_SETTINGS_STORE_FILENAME, { autoSave: false, defaults: {} }))
    .catch((error) => {
      storePromise = undefined;
      throw error;
    });
  return storePromise;
}

/** Reads the persisted settings once at startup (or lazily, on first access)
 * and seeds the in-memory cache other modules read synchronously. Safe to
 * call more than once — later calls are no-ops once initialized. */
export async function initializePrivacySettings(): Promise<PrivacySettings> {
  if (initialized) return cache;
  try {
    const store = await getStore();
    const stored = store ? await store.get<unknown>(PRIVACY_SETTINGS_STORE_KEY) : null;
    cache = stored ? normalize(stored) : (readLocal() ?? { ...DEFAULT_PRIVACY_SETTINGS });
  } catch {
    cache = readLocal() ?? { ...DEFAULT_PRIVACY_SETTINGS };
  }
  initialized = true;
  emit();
  return cache;
}

/** Synchronous read of the current in-memory settings — safe to call from
 * non-React code (e.g. `useChatTyping`, `mark_room_read` call sites) once
 * {@link initializePrivacySettings} has run; falls back to defaults before
 * then, matching the feature-flag catalog's no-flicker-before-init contract. */
export function getPrivacySettings(): PrivacySettings {
  return cache;
}

/** Persists a partial update, updating the in-memory cache immediately
 * (optimistic — mirrors `setFeatureFlagOverride`) and writing through to the
 * durable store in the background. */
export async function setPrivacySettings(partial: Partial<PrivacySettings>): Promise<void> {
  const next = normalize({ ...cache, ...partial });
  cache = next;
  initialized = true;
  emit();
  writeLocal(next);
  try {
    const store = await getStore();
    if (!store) return;
    await store.set(PRIVACY_SETTINGS_STORE_KEY, next);
    await store.save();
  } catch {
    // Best-effort durable write — the local mirror above still reflects the
    // user's choice for this session, and the next successful write reconciles.
  }
}

/** React hook exposing the live privacy settings, re-rendering on any change
 * made anywhere in the app (Settings panel, idle timer, etc). */
export function usePrivacySettings(): PrivacySettings {
  return useSyncExternalStore(
    subscribe,
    () => cache,
    () => cache,
  );
}
