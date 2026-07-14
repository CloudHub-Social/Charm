import type { FeatureFlagKey } from "@bindings/FeatureFlagKey";
import type { FeatureFlagCatalogEntry } from "@bindings/FeatureFlagCatalogEntry";
import catalogEntriesJson from "@bindings/featureFlagCatalog.json";

/**
 * Frontend view of one flag's compiled-in default and description.
 *
 * The Rust core (`src-tauri/src/feature_flags.rs`) is the authoritative
 * catalog; the generated JSON below is checked byte-for-value against that
 * catalog by Rust tests, while the ts-rs types keep frontend consumers typed.
 */
export type FeatureFlagDefinition = Omit<FeatureFlagCatalogEntry, "key">;

// Generated from Rust's authoritative catalog and guarded by a Rust parity
// test, so frontend defaults and metadata cannot drift from native evaluation.
const catalogEntries = catalogEntriesJson as FeatureFlagCatalogEntry[];
export const FEATURE_FLAG_CATALOG = Object.fromEntries(
  catalogEntries.map(({ key, ...definition }) => [key, definition]),
) as Record<FeatureFlagKey, FeatureFlagDefinition>;

export const FEATURE_FLAG_KEYS = catalogEntries.map(({ key }) => key);
