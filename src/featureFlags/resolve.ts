import type { FeatureFlagKey } from "@bindings/FeatureFlagKey";
import { FEATURE_FLAG_CATALOG } from "./catalog";

export type FeatureFlagOverrides = Partial<Record<FeatureFlagKey, boolean>>;

/**
 * Pure flag resolution — the seam every consumer goes through. Precedence,
 * highest first:
 *   1. local override (dev/Labs escape hatch),
 *   2. static catalog default.
 *
 * The remote layer (GO Feature Flag via OFREP: kill-switch, staged rollout)
 * slots in *between* override and default in a later increment without changing
 * any call site — see `docs/FEATURE_FLAGS.md`.
 */
export function resolveFlag(key: FeatureFlagKey, overrides: FeatureFlagOverrides): boolean {
  const override = overrides[key];
  return typeof override === "boolean" ? override : FEATURE_FLAG_CATALOG[key].default;
}
