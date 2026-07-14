import { useEffect, useSyncExternalStore } from "react";
import type { FeatureFlagKey } from "@bindings/FeatureFlagKey";
import { getInstallId } from "./installId";
import { fetchRemoteFlags, isRemoteConfigured } from "./ofrep";
import { resolveFlag, type FeatureFlagOverrides, type FeatureFlagRemote } from "./resolve";
import { reportFlagEvaluation } from "./sentry";
import { persistOverrides, persistRemoteFlags, readOverrides, readRemoteFlags } from "./store";

export type { FeatureFlagOverrides } from "./resolve";
export { FEATURE_FLAG_CATALOG, FEATURE_FLAG_KEYS } from "./catalog";
export type { FeatureFlagDefinition } from "./catalog";

/**
 * Module-level caches + subscription. Seeded once by
 * {@link initializeFeatureFlags} at startup; the Labs panel (Spec 34) mutates
 * the override cache via {@link setFeatureFlagOverride}, and the remote cache is
 * refreshed from OFREP. Before the caches are seeded, resolution falls back to
 * catalog defaults — so first paint never blocks on a store read or the network
 * (the no-flag-flicker contract).
 */
let overridesCache: FeatureFlagOverrides = {};
// Only updated after initialization or a persistence call confirms that its
// envelope reached durable state. Unlike the optimistic UI cache, this is safe
// to restore after a later overlapping mutation fails.
let persistedOverridesCache: FeatureFlagOverrides = {};
let remoteCache: FeatureFlagRemote = {};
let cacheMutationId = 0;
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

/**
 * Loads persisted overrides + the last-known-good remote cache, then starts the
 * OFREP refresh loop. Call once, early (main.tsx).
 */
export async function initializeFeatureFlags(): Promise<void> {
  const mutationId = cacheMutationId;
  const [persistedOverrides, cachedRemote] = await Promise.all([
    readOverrides(),
    readRemoteFlags(),
  ]);
  // Apply the cached remote only when (a) an endpoint is configured and (b) the
  // cache was computed for the *current* install id. A removed endpoint makes
  // the layer inert; a mismatched id means a different percentage-rollout cohort
  // (e.g. localStorage cleared → new install id while feature-flags.json
  // survived). In either case clear the durable cache — and `await` it — so the
  // Rust core (which reads the file regardless of JS config or id) is reconciled
  // before app boot reaches native-gated code, rather than racing a
  // fire-and-forget clear. (If that durable write itself fails, both sides
  // fall open to the last-known cache, as documented.)
  const hasCachedRemote = Object.keys(cachedRemote.remote).length > 0;
  if (isRemoteConfigured()) {
    // Only mint/read the install id when a remote endpoint exists — otherwise a
    // build that never makes an OFREP request would still get a durable
    // per-install identifier (see PRIVACY.md).
    const currentInstallId = getInstallId();
    if (cachedRemote.installId === currentInstallId) {
      remoteCache = cachedRemote.remote;
    } else {
      remoteCache = {};
      if (hasCachedRemote) await persistRemoteFlags({}, currentInstallId);
    }
  } else {
    remoteCache = {};
    if (hasCachedRemote) await persistRemoteFlags({});
  }
  if (mutationId === cacheMutationId) {
    overridesCache = persistedOverrides;
    persistedOverridesCache = persistedOverrides;
  }
  emit();
  startRemoteRefresh();
}

/**
 * Resolves a flag outside React (event handlers, non-component logic) and
 * reports the evaluation to Sentry. React components use {@link useFlag}.
 */
export function getFlag(key: FeatureFlagKey): boolean {
  const value = resolveFlag(key, overridesCache, remoteCache);
  reportFlagEvaluation(key, value);
  return value;
}

/** React hook: resolves a flag and re-renders when its override/remote changes. */
export function useFlag(key: FeatureFlagKey): boolean {
  const snapshot = () => resolveFlag(key, overridesCache, remoteCache);
  const value = useSyncExternalStore(subscribe, snapshot, snapshot);
  // Report from an effect, not during render, so evaluation tracking has no
  // render-time side effect and fires once per resolved value.
  useEffect(() => {
    reportFlagEvaluation(key, value);
  }, [key, value]);
  return value;
}

/** Sets a local override (Labs panel / dev tooling) and persists it. */
export async function setFeatureFlagOverride(key: FeatureFlagKey, value: boolean): Promise<void> {
  const mutationId = ++cacheMutationId;
  const next = { ...overridesCache, [key]: value };
  overridesCache = next;
  emit();
  try {
    if (await persistOverrides(next)) {
      persistedOverridesCache = next;
    }
  } catch (error) {
    if (mutationId === cacheMutationId) {
      overridesCache = persistedOverridesCache;
      emit();
    }
    throw error;
  }
}

/** Clears a local override, reverting the flag to remote/default resolution. */
export async function clearFeatureFlagOverride(key: FeatureFlagKey): Promise<void> {
  const mutationId = ++cacheMutationId;
  const next = { ...overridesCache };
  delete next[key];
  overridesCache = next;
  emit();
  try {
    if (await persistOverrides(next)) {
      persistedOverridesCache = next;
    }
  } catch (error) {
    if (mutationId === cacheMutationId) {
      overridesCache = persistedOverridesCache;
      emit();
    }
    throw error;
  }
}

/** Current overrides snapshot (for the Labs panel to render toggle state). */
export function getFeatureFlagOverrides(): FeatureFlagOverrides {
  return overridesCache;
}

/**
 * Reactive overrides for the Labs panel: re-renders when any override changes.
 * Unlike calling {@link useFlag} per row, this reports nothing to Sentry — the
 * panel is inspecting/editing flag state, not evaluating flags for gating.
 */
export function useFeatureFlagOverrides(): FeatureFlagOverrides {
  return useSyncExternalStore(subscribe, getFeatureFlagOverrides, getFeatureFlagOverrides);
}

// --- Remote (OFREP) refresh loop --------------------------------------------

const REMOTE_REFRESH_INTERVAL_MS = 5 * 60 * 1000;
let refreshStarted = false;
let refreshInFlight = false;

/**
 * Fetches the latest remote evaluations and applies them. Fail-open: on any
 * failure the previous cache stands, so a kill-switch/rollout only ever moves
 * forward from the last successful fetch. Guarded so overlapping ticks don't
 * race; the durable write is serialized (and rolled back on failure) with
 * override writes inside {@link persistRemoteFlags}.
 */
export async function refreshRemoteFlags(): Promise<void> {
  if (!isRemoteConfigured() || refreshInFlight) return;
  refreshInFlight = true;
  try {
    const result = await fetchRemoteFlags(getInstallId());
    if (result) {
      // Persist to the shared durable file first, then apply to the UI — so the
      // frontend never enables a rolled-out feature that the Rust core (which
      // reads only that file) hasn't seen yet. If the durable write fails, keep
      // the previous cache; the next tick retries.
      if (await persistRemoteFlags(result, getInstallId())) {
        remoteCache = result;
        emit();
      }
    }
  } finally {
    refreshInFlight = false;
  }
}

/**
 * Starts the refresh loop once: an immediate fetch, a poll interval, and
 * refreshes on network-reconnect and tab-visible so a kill-switch propagates to
 * a backgrounded/just-woke client promptly. No-op when no endpoint is
 * configured or outside a browser context.
 */
function startRemoteRefresh(): void {
  if (refreshStarted || !isRemoteConfigured() || typeof window === "undefined") return;
  refreshStarted = true;
  void refreshRemoteFlags();
  setInterval(() => void refreshRemoteFlags(), REMOTE_REFRESH_INTERVAL_MS);
  window.addEventListener("online", () => void refreshRemoteFlags());
  if (typeof document !== "undefined") {
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "visible") void refreshRemoteFlags();
    });
  }
}

export const featureFlagTestHooks = {
  reset() {
    overridesCache = {};
    persistedOverridesCache = {};
    remoteCache = {};
    cacheMutationId = 0;
    refreshStarted = false;
    refreshInFlight = false;
    listeners.clear();
  },
  setCache(overrides: FeatureFlagOverrides) {
    cacheMutationId += 1;
    overridesCache = overrides;
    persistedOverridesCache = overrides;
    emit();
  },
  setRemoteCache(remote: FeatureFlagRemote) {
    remoteCache = remote;
    emit();
  },
};
