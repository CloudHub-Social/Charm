import type { FeatureFlagKey } from "@bindings/FeatureFlagKey";
import { FEATURE_FLAG_KEYS } from "./catalog";
import type { FeatureFlagRemote } from "./resolve";
import { isTauri } from "@/lib/platform";

/**
 * OFREP (OpenFeature Remote Evaluation Protocol) client for Charm's GO Feature
 * Flag relay proxy. Deliberately a thin fetch over the protocol rather than the
 * full OpenFeature SDK: OFREP is a plain REST call, staying protocol-native
 * keeps the vendor-neutral swappability without a heavy runtime dependency, and
 * it's trivially testable against a mock. The endpoint comes from
 * `VITE_CHARM_OFREP_URL`; when unset the whole remote layer is inert and flags
 * resolve from local overrides + catalog defaults only.
 */
const OFREP_TIMEOUT_MS = 5000;
const KNOWN_KEYS = new Set<string>(FEATURE_FLAG_KEYS);

function ofrepBaseUrl(): string | undefined {
  const url = import.meta.env.VITE_CHARM_OFREP_URL;
  return url ? url.replace(/\/+$/, "") : undefined;
}

/** Whether a remote endpoint is configured for this build. */
export function isRemoteConfigured(): boolean {
  return ofrepBaseUrl() !== undefined;
}

interface OfrepFlag {
  key?: string;
  value?: unknown;
  reason?: string;
  errorCode?: string;
}
interface OfrepBulkResponse {
  flags?: OfrepFlag[];
}

/**
 * Keeps only boolean values for known catalog keys that evaluated without an
 * error. Sentry evaluation tracking (and the catalog) are boolean-only by
 * design, so a non-boolean or unknown key is dropped rather than trusted.
 */
export function parseRemoteFlags(body: OfrepBulkResponse): FeatureFlagRemote {
  const remote: FeatureFlagRemote = {};
  for (const flag of body.flags ?? []) {
    if (
      flag &&
      !flag.errorCode &&
      typeof flag.key === "string" &&
      typeof flag.value === "boolean" &&
      KNOWN_KEYS.has(flag.key)
    ) {
      remote[flag.key as FeatureFlagKey] = flag.value;
    }
  }
  return remote;
}

/**
 * Bulk-evaluates all flags for this install via OFREP. Returns the parsed
 * remote map, or `null` on any failure (endpoint unset, network error,
 * timeout, non-2xx) — the caller keeps its last-known-good cache and flags
 * fail open to it, then to catalog defaults. The `targetingKey` is the
 * anonymized per-install ID (see `installId.ts`), which GO Feature Flag hashes
 * for percentage cohorting; no other context is sent.
 */
export async function fetchRemoteFlags(targetingKey: string): Promise<FeatureFlagRemote | null> {
  const base = ofrepBaseUrl();
  if (!base) return null;
  const url = `${base}/ofrep/v1/evaluate/flags`;
  try {
    const body = isTauri()
      ? await evaluateViaIpc(url, targetingKey)
      : await evaluateViaHttp(url, targetingKey);
    return body ? parseRemoteFlags(body) : null;
  } catch {
    return null;
  }
}

/**
 * Desktop/mobile: the webview CSP (`connect-src 'self' ipc: http://ipc.localhost`)
 * blocks a direct `fetch()` to the external proxy, so route through the Rust
 * core's `fetch_remote_flags` command (reqwest, not CSP-constrained), mirroring
 * the Sentry envelope transport.
 */
async function evaluateViaIpc(
  url: string,
  targetingKey: string,
): Promise<OfrepBulkResponse | null> {
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<OfrepBulkResponse>("fetch_remote_flags", { endpoint: url, targetingKey });
}

/** Web build: direct fetch (no restrictive CSP), with a timeout. */
async function evaluateViaHttp(
  url: string,
  targetingKey: string,
): Promise<OfrepBulkResponse | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), OFREP_TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ context: { targetingKey } }),
      signal: controller.signal,
    });
    if (!response.ok) return null;
    return (await response.json()) as OfrepBulkResponse;
  } finally {
    clearTimeout(timer);
  }
}
