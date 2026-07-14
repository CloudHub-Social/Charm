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
  overridesCache = await readOverrides();
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
  overridesCache = { ...overridesCache, [key]: value };
  emit();
  await persistOverrides(overridesCache);
}

/** Clears a local override, reverting the flag to remote/default resolution. */
export async function clearFeatureFlagOverride(key: FeatureFlagKey): Promise<void> {
  const next = { ...overridesCache };
  delete next[key];
  overridesCache = next;
  emit();
  await persistOverrides(overridesCache);
}

/** Current overrides snapshot (for the Labs panel to render toggle state). */
export function getFeatureFlagOverrides(): FeatureFlagOverrides {
  return overridesCache;
}

export const featureFlagTestHooks = {
  reset() {
    overridesCache = {};
    listeners.clear();
  },
  setCache(overrides: FeatureFlagOverrides) {
    overridesCache = overrides;
    emit();
  },
};
