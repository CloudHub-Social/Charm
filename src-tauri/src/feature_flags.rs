//! Runtime feature flags (Spec 35).
//!
//! The Rust core is the **authoritative** source of the flag catalog: every
//! flag key, its compiled-in default, and its description live here, and the
//! key set is exported to the frontend as a string-literal union via ts-rs
//! (`FeatureFlagKey` → `src/bindings/FeatureFlagKey.ts`) so JS call sites can't
//! typo a key or drift from this list.
//!
//! Resolution is layered, highest precedence first:
//!   1. **local override** — a per-key boolean persisted by the frontend (the
//!      Labs panel, Spec 34) into `feature-flags.json`, read here directly off
//!      disk the same way [`crate::observability_enabled_from_store`] reads the
//!      observability consent file;
//!   2. **static default** — the flag's [`FeatureFlagKey::default_value`].
//!
//! A third layer — remote rollout control via a GO Feature Flag OFREP endpoint
//! (kill-switch, staged/percentage rollout) — is the next increment and slots
//! in *between* override and default without changing any call site: callers
//! only ever go through [`flag`] / [`evaluate`]. See `docs/FEATURE_FLAGS.md`.
//!
//! Evaluations are reported to Sentry's Feature Flag Context so a captured
//! error shows which flags were active for the user who hit it. The installed
//! `sentry` crate (0.48.x) has no native feature-flag API, so
//! [`record_evaluation`] maintains the context by hand to the documented wire
//! shape (`contexts.flags.values = [{ flag, result }]`).

use std::collections::BTreeMap;
use std::path::Path;
use std::sync::Mutex;

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use ts_rs::TS;

/// Store file the frontend persists overrides into (sibling of
/// `observability.json`), and the top-level key inside it. The envelope shape
/// matches `src/observability/persistence.ts`: `{ <KEY>: { state, updatedAt } }`.
const FEATURE_FLAGS_STORE_FILENAME: &str = "feature-flags.json";
const FEATURE_FLAGS_STORE_KEY: &str = "featureFlags";

/// Most recent unique evaluations retained on the Sentry scope, matching the
/// Feature Flag Context protocol's cap.
const MAX_TRACKED_EVALUATIONS: usize = 100;

// Define the enum and its exhaustive catalog slice from one variant list. This
// makes it impossible to add a key without also including it in `ALL`.
macro_rules! define_feature_flag_keys {
    (
        $(#[$enum_meta:meta])*
        pub enum FeatureFlagKey {
            $( $(#[$variant_meta:meta])* $variant:ident ),+ $(,)?
        }
    ) => {
        $(#[$enum_meta])*
        #[derive(
            Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize, TS,
        )]
        #[ts(export, export_to = "../src/bindings/")]
        #[serde(rename_all = "snake_case")]
        pub enum FeatureFlagKey {
            $(
                $(#[$variant_meta])*
                $variant,
            )+
        }

        impl FeatureFlagKey {
            pub const ALL: &'static [FeatureFlagKey] = &[$(FeatureFlagKey::$variant),+];
        }
    };
}

define_feature_flag_keys!(
    /// Stable, authoritative flag keys. Serialized `snake_case` — the serialized
    /// string is the wire/store key and must never change once shipped (renaming a
    /// variant silently orphans any persisted override / remote-config entry).
    ///
    /// Exported to the frontend as a union type; a JS catalog missing or misspelling
    /// a key fails `tsc`.
    pub enum FeatureFlagKey {
        /// Internal no-op canary so the flag machinery is exercised before any real
        /// Day-2 feature key exists. Not wired to any behavior. Delete this variant
        /// (and its catalog/override/remote entries) once the first real flag lands.
        Canary,
    }
);

impl FeatureFlagKey {
    /// The compiled-in default — also the offline / not-yet-rolled-out value.
    /// Keep new flags `false` until their feature is ready to ship.
    pub const fn default_value(self) -> bool {
        match self {
            FeatureFlagKey::Canary => false,
        }
    }

    /// Human-readable description, shown in the Labs panel (Spec 34).
    pub const fn description(self) -> &'static str {
        match self {
            FeatureFlagKey::Canary => {
                "Internal no-op flag used to exercise the feature-flag system. \
                 Not connected to any feature."
            }
        }
    }

    /// Which spec / feature this flag gates — for traceability and so a stale
    /// flag is easy to trace back and retire.
    pub const fn owner(self) -> &'static str {
        match self {
            FeatureFlagKey::Canary => "Spec 35 (feature-flag plumbing)",
        }
    }

    /// The stable serialized string key. Must match the `serde` rename above —
    /// asserted by [`serialized_key_matches_wire_string`].
    pub const fn as_wire_key(self) -> &'static str {
        match self {
            FeatureFlagKey::Canary => "canary",
        }
    }
}

/// Catalog metadata for one flag, exported to the frontend so the Labs panel
/// can render the list without a second source of truth.
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../src/bindings/")]
#[serde(rename_all = "camelCase")]
pub struct FeatureFlagCatalogEntry {
    pub key: FeatureFlagKey,
    pub default: bool,
    pub description: String,
    pub owner: String,
}

impl From<FeatureFlagKey> for FeatureFlagCatalogEntry {
    fn from(key: FeatureFlagKey) -> Self {
        FeatureFlagCatalogEntry {
            key,
            default: key.default_value(),
            description: key.description().to_string(),
            owner: key.owner().to_string(),
        }
    }
}

/// The full catalog, in stable order.
pub fn catalog() -> Vec<FeatureFlagCatalogEntry> {
    FeatureFlagKey::ALL
        .iter()
        .copied()
        .map(FeatureFlagCatalogEntry::from)
        .collect()
}

/// Reads persisted local overrides off disk. Mirrors
/// [`crate::observability_enabled_from_store`]: tolerant of a missing/corrupt
/// file (returns empty) and of both the plugin-store envelope
/// (`{ featureFlags: { state: { overrides } } }`) and a bare `{ state }` /
/// `{ overrides }` shape, so a format tweak on the JS side can't hard-fail Rust
/// evaluation.
pub fn read_overrides(app_data_dir: &Path) -> BTreeMap<String, bool> {
    let Ok(raw) = std::fs::read_to_string(app_data_dir.join(FEATURE_FLAGS_STORE_FILENAME)) else {
        return BTreeMap::new();
    };
    let Ok(value) = serde_json::from_str::<Value>(&raw) else {
        return BTreeMap::new();
    };
    overrides_from_value(&value)
}

fn overrides_from_value(value: &Value) -> BTreeMap<String, bool> {
    let state = value
        .get(FEATURE_FLAGS_STORE_KEY)
        .and_then(|envelope| envelope.get("state"))
        .or_else(|| value.get("state"))
        .or_else(|| value.get(FEATURE_FLAGS_STORE_KEY));

    let Some(overrides) = state
        .and_then(|state| state.get("overrides"))
        .and_then(Value::as_object)
    else {
        return BTreeMap::new();
    };

    overrides
        .iter()
        .filter_map(|(key, value)| value.as_bool().map(|value| (key.clone(), value)))
        .collect()
}

/// Resolves a flag: local override wins, else the static default. Reads the
/// override file fresh each call — flags are checked at branch points, not in
/// hot loops, and reading fresh means a Labs-panel override takes effect without
/// a restart or a cache-invalidation dance.
pub fn evaluate(app_data_dir: &Path, key: FeatureFlagKey) -> bool {
    resolve(key, &read_overrides(app_data_dir))
}

/// Pure resolution, separated from disk I/O so precedence is unit-testable.
pub fn resolve(key: FeatureFlagKey, overrides: &BTreeMap<String, bool>) -> bool {
    overrides
        .get(key.as_wire_key())
        .copied()
        .unwrap_or_else(|| key.default_value())
}

/// Resolves a flag *and* records the evaluation to Sentry's Feature Flag
/// Context. Gate Day-2 feature code paths on this rather than [`evaluate`] so
/// the flag state shows up on any error captured afterward.
pub fn flag(app_data_dir: &Path, key: FeatureFlagKey) -> bool {
    let value = evaluate(app_data_dir, key);
    record_evaluation(key.as_wire_key(), value);
    value
}

/// Process-global buffer of the most recent unique flag evaluations, kept in
/// sync onto the Sentry scope. Insertion-ordered; a re-evaluation of the same
/// flag updates its value in place (and moves it to most-recent) rather than
/// adding a duplicate, and the buffer is capped at [`MAX_TRACKED_EVALUATIONS`].
static TRACKED_EVALUATIONS: Mutex<Vec<(String, bool)>> = Mutex::new(Vec::new());

/// Records one evaluation into [`TRACKED_EVALUATIONS`] and pushes the whole set
/// onto the current Sentry scope as the `flags` context. No-op-safe when Sentry
/// is uninitialized (`configure_scope` is cheap and discards on the noop hub).
fn record_evaluation(flag: &str, result: bool) {
    let values = {
        let mut tracked = match TRACKED_EVALUATIONS.lock() {
            Ok(tracked) => tracked,
            // A poisoned lock (a panic mid-update) must not take down a flag
            // check — flag tracking is diagnostics, not correctness.
            Err(poisoned) => poisoned.into_inner(),
        };
        update_tracked(&mut tracked, flag, result);
        flags_context_values(&tracked)
    };

    // `sentry::protocol::Context::Other` wants a `BTreeMap`, not a
    // `serde_json::Map` — build it directly.
    let mut context: BTreeMap<String, Value> = BTreeMap::new();
    context.insert("values".to_string(), Value::Array(values));
    sentry::configure_scope(|scope| {
        scope.set_context("flags", sentry::protocol::Context::Other(context.clone()));
    });
}

/// Applies one evaluation to the tracked buffer: de-dupes by flag name (latest
/// value + most-recent position wins) and bounds the buffer.
fn update_tracked(tracked: &mut Vec<(String, bool)>, flag: &str, result: bool) {
    if let Some(pos) = tracked.iter().position(|(name, _)| name == flag) {
        tracked.remove(pos);
    }
    tracked.push((flag.to_string(), result));
    if tracked.len() > MAX_TRACKED_EVALUATIONS {
        let overflow = tracked.len() - MAX_TRACKED_EVALUATIONS;
        tracked.drain(0..overflow);
    }
}

/// Serializes the tracked buffer to the Feature Flag Context wire shape:
/// `[{ "flag": <name>, "result": <bool> }]`.
fn flags_context_values(tracked: &[(String, bool)]) -> Vec<Value> {
    tracked
        .iter()
        .map(|(flag, result)| {
            let mut entry = Map::new();
            entry.insert("flag".to_string(), Value::String(flag.clone()));
            entry.insert("result".to_string(), Value::Bool(*result));
            Value::Object(entry)
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn overrides(pairs: &[(&str, bool)]) -> BTreeMap<String, bool> {
        pairs
            .iter()
            .map(|(key, value)| ((*key).to_string(), *value))
            .collect()
    }

    #[test]
    fn resolve_falls_back_to_default_without_override() {
        assert!(!resolve(FeatureFlagKey::Canary, &BTreeMap::new()));
    }

    #[test]
    fn override_wins_over_default() {
        let on = overrides(&[("canary", true)]);
        assert!(resolve(FeatureFlagKey::Canary, &on));
        let off = overrides(&[("canary", false)]);
        assert!(!resolve(FeatureFlagKey::Canary, &off));
    }

    #[test]
    fn catalog_entries_have_complete_metadata() {
        for entry in catalog() {
            assert_eq!(entry.default, entry.key.default_value());
            assert!(!entry.description.is_empty());
            assert!(!entry.owner.is_empty());
        }
    }

    #[test]
    fn generated_frontend_catalog_matches_rust_catalog() {
        let generated: Value =
            serde_json::from_str(include_str!("bindings/featureFlagCatalog.json"))
                .expect("generated frontend feature flag catalog must be valid JSON");
        assert_eq!(
            generated,
            serde_json::to_value(catalog()).expect("Rust feature flag catalog must serialize")
        );
    }

    #[test]
    fn serialized_key_matches_wire_string() {
        for &key in FeatureFlagKey::ALL {
            let serialized = serde_json::to_string(&key).unwrap();
            assert_eq!(serialized, format!("\"{}\"", key.as_wire_key()));
        }
    }

    #[test]
    fn parses_plugin_store_envelope() {
        let value = serde_json::json!({
            "featureFlags": { "state": { "overrides": { "canary": true } }, "updatedAt": 1 }
        });
        assert_eq!(overrides_from_value(&value).get("canary"), Some(&true));
    }

    #[test]
    fn parses_bare_state_and_overrides_shapes() {
        let bare_state = serde_json::json!({ "state": { "overrides": { "canary": true } } });
        assert_eq!(overrides_from_value(&bare_state).get("canary"), Some(&true));
        let bare = serde_json::json!({ "featureFlags": { "overrides": { "canary": false } } });
        assert_eq!(overrides_from_value(&bare).get("canary"), Some(&false));
    }

    #[test]
    fn tolerates_missing_and_malformed() {
        assert!(overrides_from_value(&serde_json::json!({})).is_empty());
        assert!(overrides_from_value(&serde_json::json!("nonsense")).is_empty());
        let non_bool = serde_json::json!({ "state": { "overrides": { "canary": "yes" } } });
        assert!(overrides_from_value(&non_bool).is_empty());
    }

    #[test]
    fn evaluate_reads_override_file() {
        let dir = std::env::temp_dir().join(format!("charm-flags-test-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(
            dir.join(FEATURE_FLAGS_STORE_FILENAME),
            r#"{"featureFlags":{"state":{"overrides":{"canary":true}},"updatedAt":1}}"#,
        )
        .unwrap();
        assert!(evaluate(&dir, FeatureFlagKey::Canary));
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn evaluate_defaults_when_file_absent() {
        let dir = std::env::temp_dir().join("charm-flags-test-does-not-exist-xyz");
        std::fs::remove_dir_all(&dir).ok();
        assert!(!evaluate(&dir, FeatureFlagKey::Canary));
    }

    #[test]
    fn tracked_evaluations_dedupe_and_bound() {
        let mut tracked = Vec::new();
        update_tracked(&mut tracked, "canary", false);
        update_tracked(&mut tracked, "canary", true);
        assert_eq!(tracked, vec![("canary".to_string(), true)]);

        for i in 0..(MAX_TRACKED_EVALUATIONS + 10) {
            update_tracked(&mut tracked, &format!("flag_{i}"), true);
        }
        assert_eq!(tracked.len(), MAX_TRACKED_EVALUATIONS);
        // Oldest ("canary", then the first flags) evicted; newest retained.
        assert_eq!(
            tracked.last().unwrap().0,
            format!("flag_{}", MAX_TRACKED_EVALUATIONS + 9)
        );
        assert!(!tracked.iter().any(|(name, _)| name == "canary"));
    }

    #[test]
    fn flags_context_values_shape() {
        let values = flags_context_values(&[("canary".to_string(), true)]);
        assert_eq!(
            values,
            vec![serde_json::json!({ "flag": "canary", "result": true })]
        );
    }
}
