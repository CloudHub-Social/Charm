import { useEffect, useSyncExternalStore } from "react";
import type { FeatureFlagKey } from "@bindings/FeatureFlagKey";
import { isTauri } from "@/lib/platform";
import { getInstallId } from "./installId";
import { fetchRemoteFlags, isRemoteConfigured } from "./ofrep";
import { resolveFlag, type FeatureFlagOverrides, type FeatureFlagRemote } from "./resolve";
import { reportFlagEvaluation } from "./sentry";
import { persistOverrides, persistRemoteFlags, readOverrides, readRemoteFlags } from "./store";
import { FEATURE_FLAG_KEYS } from "./catalog";

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
let initialized = false;
let cacheMutationId = 0;
let messageSearchReconciliationPending = false;
let messageSearchMutationQueue: Promise<void> = Promise.resolve();
const persistedFlagVersions: Partial<Record<FeatureFlagKey, number>> = {};
const listeners = new Set<() => void>();

function serializeMessageSearchMutation(mutation: () => Promise<void>): Promise<void> {
  const run = async (): Promise<void> => {
    // A prior disable may have persisted successfully but failed before Rust
    // could create its own durable purge marker. Retry while the authoritative
    // flag is still disabled; never let the next mutation persist a re-enable
    // first and erase the only remaining cleanup intent.
    if (messageSearchReconciliationPending) {
      const { invoke } = await import("@/lib/matrixTransport");
      await invoke("reconcile_message_search_flag");
      messageSearchReconciliationPending = false;
    }
    await mutation();
  };
  const pending = messageSearchMutationQueue.then(run, run);
  messageSearchMutationQueue = pending.catch(() => undefined);
  return pending;
}

function emit(): void {
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function recordPersistedOverrides(next: FeatureFlagOverrides): void {
  const keys = new Set<FeatureFlagKey>([
    ...(Object.keys(persistedOverridesCache) as FeatureFlagKey[]),
    ...(Object.keys(next) as FeatureFlagKey[]),
  ]);
  for (const changedKey of keys) {
    if (persistedOverridesCache[changedKey] !== next[changedKey]) {
      persistedFlagVersions[changedKey] = (persistedFlagVersions[changedKey] ?? 0) + 1;
    }
  }
  persistedOverridesCache = next;
}

async function reconcileMessageSearchTransition(
  wasEnabled: boolean,
  isEnabled: boolean,
): Promise<void> {
  if (isEnabled) {
    messageSearchReconciliationPending = false;
    return;
  }
  if (!wasEnabled && !messageSearchReconciliationPending) return;
  if (!isTauri()) {
    messageSearchReconciliationPending = false;
    return;
  }

  // Keep the retry marker set until the bounded native purge succeeds. This
  // lets a later OFREP refresh or Labs mutation retry a transient filesystem
  // failure even though the durable flag already resolves disabled.
  messageSearchReconciliationPending = true;
  const { invoke } = await import("@/lib/matrixTransport");
  await invoke("reconcile_message_search_flag");
  messageSearchReconciliationPending = false;
}

/**
 * Loads persisted overrides + the last-known-good remote cache, then starts the
 * OFREP refresh loop. Call once, early (main.tsx).
 */
export function initializeFeatureFlags(): Promise<void> {
  // Enqueue synchronously, before the first store read yields, so a Labs or
  // OFREP re-enable requested during startup cannot overtake stale-cache
  // cleanup and its native destructive reconciliation.
  const mutationId = cacheMutationId;
  return serializeMessageSearchMutation(() => initializeFeatureFlagsInner(mutationId));
}

async function initializeFeatureFlagsInner(mutationId: number): Promise<void> {
  const [persistedOverrides, cachedRemote] = await Promise.all([
    readOverrides(),
    readRemoteFlags(),
  ]);
  const searchWasEnabled = resolveFlag(
    "encrypted_local_message_search",
    persistedOverrides,
    cachedRemote.remote,
  );
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
  // Clears the stale/mismatched durable cache, keeping the JS cache consistent
  // with the file the Rust core reads: only drop to `{}` if the durable clear
  // actually succeeded — otherwise the file still holds the old value, so JS
  // must keep showing it too (both fall open to the last-known cache, in sync,
  // until a later clear/refresh lands).
  const clearStaleCache = async (installId?: string): Promise<FeatureFlagRemote> => {
    if (!hasCachedRemote) return {};
    return (await persistRemoteFlags({}, installId)) ? {} : cachedRemote.remote;
  };
  if (isRemoteConfigured()) {
    // Only mint/read the install id when a remote endpoint exists — otherwise a
    // build that never makes an OFREP request would still get a durable
    // per-install identifier (see PRIVACY.md).
    const currentInstallId = getInstallId();
    // A cache with no recorded install id (e.g. written by an intermediate build
    // before this field existed) is accepted rather than treated as a different
    // cohort — only a *different* recorded id means a mismatched cohort.
    const matchesCohort =
      cachedRemote.installId === undefined || cachedRemote.installId === currentInstallId;
    remoteCache = matchesCohort ? cachedRemote.remote : await clearStaleCache(currentInstallId);
  } else {
    remoteCache = await clearStaleCache();
  }
  if (mutationId === cacheMutationId) {
    overridesCache = persistedOverrides;
    persistedOverridesCache = persistedOverrides;
  }
  emit();
  // Native startup reads the durable flag file before this asynchronous JS
  // initialization. If initialization just removed a stale remote `true`,
  // reconcile that durable enabled-to-disabled transition now; otherwise the
  // startup purge may already have been skipped. A failed purge leaves the
  // shared retry marker set for the next persisted flag mutation.
  try {
    await reconcileMessageSearchTransition(
      searchWasEnabled,
      resolveFlag("encrypted_local_message_search", persistedOverridesCache, remoteCache),
    );
  } catch {
    // The helper retains its pending retry marker. Keep the rest of feature
    // flag initialization alive so the refresh loop or a later Labs mutation
    // can retry, without exposing renderer-visible filesystem details.
    console.error("Message search initialization reconciliation failed");
  }
  startRemoteRefresh();
  initialized = true;
  emit();
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

/**
 * Increments after this key's local override reaches durable storage. Native
 * consumers whose Rust side reads the on-disk envelope can react to this
 * signal without racing the optimistic JS update.
 */
export function useFeatureFlagPersistenceVersion(key: FeatureFlagKey): number {
  const snapshot = () => persistedFlagVersions[key] ?? 0;
  return useSyncExternalStore(subscribe, snapshot, snapshot);
}

/** True once persisted/remote cached flag state has been reconciled. */
export function useFeatureFlagsInitialized(): boolean {
  const snapshot = () => initialized;
  return useSyncExternalStore(subscribe, snapshot, snapshot);
}

/** Sets a local override (Labs panel / dev tooling) and persists it. */
export function setFeatureFlagOverride(key: FeatureFlagKey, value: boolean): Promise<void> {
  if (key === "encrypted_local_message_search") {
    return serializeMessageSearchMutation(() => setFeatureFlagOverrideInner(key, value));
  }
  return setFeatureFlagOverrideInner(key, value);
}

async function setFeatureFlagOverrideInner(key: FeatureFlagKey, value: boolean): Promise<void> {
  const mutationId = ++cacheMutationId;
  const searchWasEnabled = resolveFlag(
    "encrypted_local_message_search",
    persistedOverridesCache,
    remoteCache,
  );
  const next = { ...overridesCache, [key]: value };
  overridesCache = next;
  emit();
  try {
    if (await persistOverrides(next)) {
      recordPersistedOverrides(next);
      emit();
      await reconcileMessageSearchTransition(
        searchWasEnabled,
        resolveFlag("encrypted_local_message_search", persistedOverridesCache, remoteCache),
      );
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
export function clearFeatureFlagOverride(key: FeatureFlagKey): Promise<void> {
  if (key === "encrypted_local_message_search") {
    return serializeMessageSearchMutation(() => clearFeatureFlagOverrideInner(key));
  }
  return clearFeatureFlagOverrideInner(key);
}

async function clearFeatureFlagOverrideInner(key: FeatureFlagKey): Promise<void> {
  const mutationId = ++cacheMutationId;
  const searchWasEnabled = resolveFlag(
    "encrypted_local_message_search",
    persistedOverridesCache,
    remoteCache,
  );
  const next = { ...overridesCache };
  delete next[key];
  overridesCache = next;
  emit();
  try {
    if (await persistOverrides(next)) {
      recordPersistedOverrides(next);
      emit();
      await reconcileMessageSearchTransition(
        searchWasEnabled,
        resolveFlag("encrypted_local_message_search", persistedOverridesCache, remoteCache),
      );
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
      await serializeMessageSearchMutation(async () => {
        const changedKeys = FEATURE_FLAG_KEYS.filter(
          (key) =>
            resolveFlag(key, overridesCache, remoteCache) !==
            resolveFlag(key, overridesCache, result),
        );
        // Persist to the shared durable file first, then apply to the UI — so
        // the frontend never enables a rolled-out feature that the Rust core
        // hasn't seen yet. The search mutation queue also prevents a remote
        // re-enable from overtaking an earlier destructive Labs transition.
        if (await persistRemoteFlags(result, getInstallId())) {
          const searchWasEnabled = resolveFlag(
            "encrypted_local_message_search",
            overridesCache,
            remoteCache,
          );
          const searchIsEnabled = resolveFlag(
            "encrypted_local_message_search",
            overridesCache,
            result,
          );
          remoteCache = result;
          for (const key of changedKeys) {
            persistedFlagVersions[key] = (persistedFlagVersions[key] ?? 0) + 1;
          }
          emit();
          // The durable file is now authoritative for Rust and the UI is
          // already disabled. Reconcile the sensitive derived store before
          // this refresh completes so a trusted runtime kill switch does not
          // retain data until restart. The web companion has no local index.
          await reconcileMessageSearchTransition(searchWasEnabled, searchIsEnabled);
        }
      });
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
    initialized = false;
    cacheMutationId = 0;
    messageSearchReconciliationPending = false;
    refreshStarted = false;
    refreshInFlight = false;
    listeners.clear();
  },
  setCache(overrides: FeatureFlagOverrides) {
    cacheMutationId += 1;
    overridesCache = overrides;
    persistedOverridesCache = overrides;
    initialized = true;
    emit();
  },
  setRemoteCache(remote: FeatureFlagRemote) {
    remoteCache = remote;
    emit();
  },
};
