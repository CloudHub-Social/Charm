import type { FeatureFlagKey } from "@bindings/FeatureFlagKey";

/**
 * Frontend view of one flag's compiled-in default and description.
 *
 * The Rust core (`src-tauri/src/feature_flags.rs`) is the authoritative
 * catalog; this record is keyed by the ts-rs-exported {@link FeatureFlagKey}
 * union, so a key that is missing here, or one that doesn't exist in Rust, is a
 * `tsc` error — the two lists can't silently drift.
 */
export interface FeatureFlagDefinition {
  /** Offline / not-yet-rolled-out value. Keep new flags `false` until ready. */
  default: boolean;
  /** Shown in the Labs panel (Spec 34). */
  description: string;
}

export const FEATURE_FLAG_CATALOG: Record<FeatureFlagKey, FeatureFlagDefinition> = {
  canary: {
    default: false,
    description:
      "Internal no-op flag used to exercise the feature-flag system. Not connected to any feature.",
  },
};

export const FEATURE_FLAG_KEYS = Object.keys(FEATURE_FLAG_CATALOG) as FeatureFlagKey[];
