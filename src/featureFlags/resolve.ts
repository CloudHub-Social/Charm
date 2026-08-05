import type { FeatureFlagKey } from "@bindings/FeatureFlagKey";
import { FEATURE_FLAG_CATALOG } from "./catalog";

export type FeatureFlagOverrides = Partial<Record<FeatureFlagKey, boolean>>;
/** Last-known-good remote (GO Feature Flag / OFREP) evaluations, cached on disk. */
export type FeatureFlagRemote = Partial<Record<FeatureFlagKey, boolean>>;

/**
 * Pure flag resolution — the seam every consumer goes through. Precedence,
 * highest first:
 *   1. **local override** — dev/Labs escape hatch, always wins;
 *   2. **remote** — GO Feature Flag via OFREP (kill-switch, staged/percentage
 *      rollout), from the last-known-good cached response;
 *   3. **static catalog default** — the offline / not-yet-rolled-out backstop.
 *
 * Fail-open lives at the edges: when the remote layer has no value for a key
 * (endpoint unset, unreachable, or the flag absent from the response), that key
 * falls through to its catalog default.
 */
export function resolveFlag(
  key: FeatureFlagKey,
  overrides: FeatureFlagOverrides,
  remote: FeatureFlagRemote = {},
): boolean {
  const override = overrides[key];
  if (typeof override === "boolean") return override;
  const remoteValue = remote[key];
  if (typeof remoteValue === "boolean") return remoteValue;
  return FEATURE_FLAG_CATALOG[key].default;
}
