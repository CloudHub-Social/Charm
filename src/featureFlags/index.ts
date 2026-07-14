import { useEffect, useSyncExternalStore } from "react";
import type { FeatureFlagKey } from "@bindings/FeatureFlagKey";
import { resolveFlag, type FeatureFlagOverrides } from "./resolve";
import { reportFlagEvaluation } from "./sentry";
import { persistOverrides, readOverrides } from "./store";

export type { FeatureFlagOverrides } from "./resolve";
export { FEATURE_FLAG_CATALOG, FEATURE_FLAG_KEYS } from "./catalog";
export type { FeatureFlagDefinition } from "./catalog";

/**
 * Module-level override cache + subscription. Seeded once by
 * {@link initializeFeatureFlags} at startup; the Labs panel (Spec 34) mutates
 * it via {@link setFeatureFlagOverride}. Before the cache is seeded, resolution
 * falls back to catalog defaults — so first paint never blocks on a store read
 * (the no-flag-flicker contract).
 */
let overridesCache: FeatureFlagOverrides = {};
// Only updated after initialization or a persistence call confirms that its
// envelope reached durable state. Unlike the optimistic UI cache, this is safe
// to restore after a later overlapping mutation fails.
let persistedOverridesCache: FeatureFlagOverrides = {};
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

/** Loads persisted overrides into the cache. Call once, early (main.tsx). */
export async function initializeFeatureFlags(): Promise<void> {
  const mutationId = cacheMutationId;
  const persistedOverrides = await readOverrides();
  if (mutationId !== cacheMutationId) return;
  overridesCache = persistedOverrides;
  persistedOverridesCache = persistedOverrides;
  emit();
}

/**
 * Resolves a flag outside React (event handlers, non-component logic) and
 * reports the evaluation to Sentry. React components use {@link useFlag}.
 */
export function getFlag(key: FeatureFlagKey): boolean {
  const value = resolveFlag(key, overridesCache);
  reportFlagEvaluation(key, value);
  return value;
}

/** React hook: resolves a flag and re-renders when its override changes. */
export function useFlag(key: FeatureFlagKey): boolean {
  const snapshot = () => resolveFlag(key, overridesCache);
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

export const featureFlagTestHooks = {
  reset() {
    overridesCache = {};
    persistedOverridesCache = {};
    cacheMutationId = 0;
    listeners.clear();
  },
  setCache(overrides: FeatureFlagOverrides) {
    cacheMutationId += 1;
    overridesCache = overrides;
    persistedOverridesCache = overrides;
    emit();
  },
};
