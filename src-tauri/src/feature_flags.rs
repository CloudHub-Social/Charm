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
//!   2. **remote** — GO Feature Flag (OFREP) rollout control (kill-switch,
//!      staged/percentage rollout). The frontend's refresh loop is the single
//!      fetcher; it writes the last-known-good evaluations into the same
//!      `feature-flags.json` (under a separate key), so the Rust core reads
//!      remote state without its own HTTP client and both sides stay consistent;
//!   3. **static default** — the flag's [`FeatureFlagKey::default_value`], the
//!      offline / not-yet-rolled-out backstop.
//!
//! Callers only ever go through [`flag`] / [`evaluate`]. See `docs/FEATURE_FLAGS.md`.
//!
//! Evaluations are reported to Sentry's Feature Flag Context so a captured
//! error shows which flags were active for the user who hit it. The installed
//! `sentry` crate (0.48.x) has no native feature-flag API, so
//! [`record_evaluation`] maintains the context by hand to the documented wire
//! shape (`contexts.flags.values = [{ flag, result }]`).

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use ts_rs::TS;

/// Store file the frontend persists overrides into (sibling of
/// `observability.json`), and the top-level key inside it. The envelope shape
/// matches `src/observability/persistence.ts`: `{ <KEY>: { state, updatedAt } }`.
const FEATURE_FLAGS_STORE_FILENAME: &str = "feature-flags.json";
const FEATURE_FLAGS_STORE_KEY: &str = "featureFlags";
/// Remote (OFREP) last-known-good cache, written by the frontend refresh loop
/// into the same file. A separate top-level key so remote refreshes and
/// override writes never clobber each other.
const FEATURE_FLAGS_REMOTE_STORE_KEY: &str = "featureFlagsRemote";

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
        /// Spec 56 room-invite inbox, actions, deep-link handling, and native
        /// invite notifications.
        RoomInvites,
        /// Spec 58 rich-message enhancements: linkification, syntax highlighting,
        /// tables, Matrix pills, room mentions, math, and jumbo emoji.
        RichMessageRendering,
        /// Spec 52 mobile chat redesign: compact room header and composer,
        /// in-header back navigation, and detail-view bottom-nav suppression.
        MobileChatRedesign,
        /// Spec 30 Focus mode / Do Not Disturb: the Settings panel toggle and
        /// tray-menu preset durations that suppress notification dispatch.
        FocusMode,
        /// Spec 29 link previews: unfurled title/description/thumbnail card
        /// under a message containing a URL, fetched via the homeserver's
        /// `/preview_url` endpoint.
        LinkPreviews,
        /// Spec 32 room alias management: publish/unpublish an alias, set
        /// the canonical alias, and add alternative aliases from room
        /// settings.
        RoomAliasManagement,
        /// Spec 54 room-list filtering: switch Home, DMs, and space room
        /// lists between all joined rooms and rooms needing attention.
        RoomListUnreadFilter,
        /// Spec 37 message-action parity. The first slice adds a canonical
        /// matrix.to permalink action for server-backed timeline events.
        MessageActionParity,
        /// Spec 42 media-send polish: progressive attachment-send UX such as
        /// a visible file drag-and-drop target.
        MediaSendPolish,
        /// Spec 54 room-list last-message preview: a compact sender + text
        /// snippet rendered under the room name in each row.
        RoomListMessagePreview,
        /// Spec 63 sidebar and space management: pin/unpin and reorder rail
        /// entries, and the per-space context menu (Invite, Add Existing,
        /// Mark/Unmark Suggested, Remove, Leave).
        SpaceRailManagement,
        /// Day-2 Spec 12: personal, private message bookmarks and the global
        /// Saved Messages view.
        Bookmarks,
    }
);

impl FeatureFlagKey {
    /// The compiled-in default — also the offline / not-yet-rolled-out value.
    /// Keep new flags `false` until their feature is ready to ship.
    pub const fn default_value(self) -> bool {
        match self {
            FeatureFlagKey::Canary => false,
            FeatureFlagKey::RoomInvites => false,
            FeatureFlagKey::RichMessageRendering => false,
            FeatureFlagKey::MobileChatRedesign => false,
            FeatureFlagKey::FocusMode => false,
            FeatureFlagKey::LinkPreviews => false,
            FeatureFlagKey::RoomAliasManagement => false,
            FeatureFlagKey::RoomListUnreadFilter => false,
            FeatureFlagKey::MessageActionParity => false,
            FeatureFlagKey::MediaSendPolish => false,
            FeatureFlagKey::RoomListMessagePreview => false,
            FeatureFlagKey::SpaceRailManagement => false,
            FeatureFlagKey::Bookmarks => false,
        }
    }

    /// Human-readable description, shown in the Labs panel (Spec 34).
    pub const fn description(self) -> &'static str {
        match self {
            FeatureFlagKey::Canary => {
                "Internal no-op flag used to exercise the feature-flag system. \
                 Not connected to any feature."
            }
            FeatureFlagKey::RoomInvites => {
                "Pending room invitations, accept/decline actions, deep-link handling, and invite notifications."
            }
            FeatureFlagKey::RichMessageRendering => {
                "Render enhanced Matrix message content including code, tables, pills, math, and jumbo emoji."
            }
            FeatureFlagKey::MobileChatRedesign => {
                "Use the compact mobile-first room header, composer, and chat navigation."
            }
            FeatureFlagKey::FocusMode => {
                "Focus mode / Do Not Disturb: suppress notifications for a preset duration or indefinitely, from Settings or the tray menu."
            }
            FeatureFlagKey::LinkPreviews => {
                "Show an unfurled title/description/thumbnail card under messages containing a URL."
            }
            FeatureFlagKey::RoomAliasManagement => {
                "Manage room aliases and the canonical alias from room settings."
            }
            FeatureFlagKey::RoomListUnreadFilter => {
                "Filter Home, direct-message, and space room lists to rooms needing attention."
            }
            FeatureFlagKey::MessageActionParity => {
                "Add the next set of message actions, beginning with copying a canonical message permalink."
            }
            FeatureFlagKey::MediaSendPolish => {
                "Improve attachment sending with a visible file drag-and-drop target and later media-send controls."
            }
            FeatureFlagKey::RoomListMessagePreview => {
                "Show a compact last-message preview with sender label under each room-list row."
            }
            FeatureFlagKey::SpaceRailManagement => {
                "Pin/unpin and reorder the space rail, and manage a space from its right-click context menu (Invite, Add Existing, Mark/Unmark Suggested, Remove, Leave)."
            }
            FeatureFlagKey::Bookmarks => {
                "Bookmark a message from its action menu and browse saved messages from a global Settings panel."
            }
        }
    }

    /// Which spec / feature this flag gates — for traceability and so a stale
    /// flag is easy to trace back and retire.
    pub const fn owner(self) -> &'static str {
        match self {
            FeatureFlagKey::Canary => "Spec 35 (feature-flag plumbing)",
            FeatureFlagKey::RoomInvites => "Spec 56 (room invites surface)",
            FeatureFlagKey::RichMessageRendering => "Spec 58 (rich message content rendering)",
            FeatureFlagKey::MobileChatRedesign => "Spec 52 (mobile chat UX)",
            FeatureFlagKey::FocusMode => "Spec 30 (focus mode / do-not-disturb)",
            FeatureFlagKey::LinkPreviews => "Spec 29 (link previews)",
            FeatureFlagKey::RoomAliasManagement => "Spec 32 (room alias management)",
            FeatureFlagKey::RoomListUnreadFilter => "Spec 54 (room-list enrichment and filtering)",
            FeatureFlagKey::MessageActionParity => "Spec 37 (message action parity)",
            FeatureFlagKey::MediaSendPolish => "Spec 42 (media send polish)",
            FeatureFlagKey::RoomListMessagePreview => {
                "Spec 54 (room-list enrichment and filtering)"
            }
            FeatureFlagKey::SpaceRailManagement => "Spec 63 (sidebar and space management)",
            FeatureFlagKey::Bookmarks => "Day-2 Spec 12 (bookmarks and saved messages)",
        }
    }

    /// The stable serialized string key. Must match the `serde` rename above —
    /// asserted by [`serialized_key_matches_wire_string`].
    pub const fn as_wire_key(self) -> &'static str {
        match self {
            FeatureFlagKey::Canary => "canary",
            FeatureFlagKey::RoomInvites => "room_invites",
            FeatureFlagKey::RichMessageRendering => "rich_message_rendering",
            FeatureFlagKey::MobileChatRedesign => "mobile_chat_redesign",
            FeatureFlagKey::FocusMode => "focus_mode",
            FeatureFlagKey::LinkPreviews => "link_previews",
            FeatureFlagKey::RoomAliasManagement => "room_alias_management",
            FeatureFlagKey::RoomListUnreadFilter => "room_list_unread_filter",
            FeatureFlagKey::MessageActionParity => "message_action_parity",
            FeatureFlagKey::MediaSendPolish => "media_send_polish",
            FeatureFlagKey::RoomListMessagePreview => "room_list_message_preview",
            FeatureFlagKey::SpaceRailManagement => "space_rail_management",
            FeatureFlagKey::Bookmarks => "bookmarks",
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
    read_state(app_data_dir).0
}

type FlagState = (BTreeMap<String, bool>, BTreeMap<String, bool>);

/// Cache for [`read_state`], keyed by the store file's path plus a hash of
/// its raw contents — not path+mtime+size (Codex review on #286, P2,
/// round 2). Metadata alone is an unreliable change signal: on a filesystem
/// with coarse mtime granularity, a remote refresh that rewrites the file
/// within the same mtime tick and happens to keep the same byte length (e.g.
/// flipping one flag off while another flips on) would leave this cache
/// serving the pre-rewrite state — silently ignoring a Labs/remote
/// kill-switch change — until some later write finally produces a different
/// mtime or size. Hashing the content directly makes the cache key exactly
/// as precise as the data it guards, at the cost of a read (but not a
/// re-parse) on every call; that read is the cheap part `flag()`/`evaluate()`
/// being hot needed to avoid, not the syscall itself.
static STATE_CACHE: Mutex<Option<(PathBuf, u64, FlagState)>> = Mutex::new(None);

/// Reads both the local overrides and the remote (OFREP) cache from the file in
/// a single parse. Tolerant of a missing/corrupt file (returns empties) and of
/// both the plugin-store envelope and bare `{ state }` / `{ overrides }` shapes,
/// so a format tweak on the JS side can't hard-fail Rust evaluation.
pub fn read_state(app_data_dir: &Path) -> FlagState {
    let path = app_data_dir.join(FEATURE_FLAGS_STORE_FILENAME);
    let Ok(raw) = std::fs::read_to_string(&path) else {
        return (BTreeMap::new(), BTreeMap::new());
    };
    let hash = content_hash(&raw);

    if let Ok(cache) = STATE_CACHE.lock() {
        if let Some((cached_path, cached_hash, state)) = cache.as_ref() {
            if *cached_path == path && *cached_hash == hash {
                return state.clone();
            }
        }
    }

    let state = parse_state(&raw);
    if let Ok(mut cache) = STATE_CACHE.lock() {
        *cache = Some((path, hash, state.clone()));
    }
    state
}

fn content_hash(raw: &str) -> u64 {
    use std::hash::{Hash, Hasher};
    let mut hasher = std::collections::hash_map::DefaultHasher::new();
    raw.hash(&mut hasher);
    hasher.finish()
}

fn parse_state(raw: &str) -> FlagState {
    let Ok(value) = serde_json::from_str::<Value>(raw) else {
        return (BTreeMap::new(), BTreeMap::new());
    };
    (
        flag_map_from_value(&value, FEATURE_FLAGS_STORE_KEY, "overrides"),
        flag_map_from_value(&value, FEATURE_FLAGS_REMOTE_STORE_KEY, "remote"),
    )
}

/// Extracts a `{ key: bool }` map from `<store_key>.state.<inner>` (or the bare
/// `state.<inner>` / `<store_key>.<inner>` fallbacks), keeping only booleans.
fn flag_map_from_value(value: &Value, store_key: &str, inner: &str) -> BTreeMap<String, bool> {
    let state = value
        .get(store_key)
        .and_then(|envelope| envelope.get("state"))
        .or_else(|| value.get("state"))
        .or_else(|| value.get(store_key));

    let Some(map) = state
        .and_then(|state| state.get(inner))
        .and_then(Value::as_object)
    else {
        return BTreeMap::new();
    };

    map.iter()
        .filter_map(|(key, value)| value.as_bool().map(|value| (key.clone(), value)))
        .collect()
}

/// Resolves a flag from the file, via [`read_state`]'s mtime-keyed cache — a
/// Labs override or remote refresh still takes effect on the next call (no
/// restart or manual invalidation needed) since it rewrites the file's mtime.
pub fn evaluate(app_data_dir: &Path, key: FeatureFlagKey) -> bool {
    let (overrides, remote) = read_state(app_data_dir);
    resolve(key, &overrides, &remote)
}

/// Pure resolution, separated from disk I/O so precedence is unit-testable:
/// local override wins, then the remote (OFREP) value, then the static default.
pub fn resolve(
    key: FeatureFlagKey,
    overrides: &BTreeMap<String, bool>,
    remote: &BTreeMap<String, bool>,
) -> bool {
    if let Some(&value) = overrides.get(key.as_wire_key()) {
        return value;
    }
    if let Some(&value) = remote.get(key.as_wire_key()) {
        return value;
    }
    key.default_value()
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
    fn resolve_falls_back_to_default_without_override_or_remote() {
        assert!(!resolve(
            FeatureFlagKey::Canary,
            &BTreeMap::new(),
            &BTreeMap::new()
        ));
    }

    #[test]
    fn override_wins_over_default() {
        let on = overrides(&[("canary", true)]);
        assert!(resolve(FeatureFlagKey::Canary, &on, &BTreeMap::new()));
        let off = overrides(&[("canary", false)]);
        assert!(!resolve(FeatureFlagKey::Canary, &off, &BTreeMap::new()));
    }

    #[test]
    fn remote_used_when_no_override() {
        let remote = overrides(&[("canary", true)]);
        assert!(resolve(FeatureFlagKey::Canary, &BTreeMap::new(), &remote));
    }

    #[test]
    fn override_beats_remote() {
        // Override off must win even when remote says on (the tester escape hatch).
        let override_off = overrides(&[("canary", false)]);
        let remote_on = overrides(&[("canary", true)]);
        assert!(!resolve(FeatureFlagKey::Canary, &override_off, &remote_on));
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
        assert_eq!(
            flag_map_from_value(&value, FEATURE_FLAGS_STORE_KEY, "overrides").get("canary"),
            Some(&true)
        );
    }

    #[test]
    fn parses_bare_state_and_overrides_shapes() {
        let bare_state = serde_json::json!({ "state": { "overrides": { "canary": true } } });
        assert_eq!(
            flag_map_from_value(&bare_state, FEATURE_FLAGS_STORE_KEY, "overrides").get("canary"),
            Some(&true)
        );
        let bare = serde_json::json!({ "featureFlags": { "overrides": { "canary": false } } });
        assert_eq!(
            flag_map_from_value(&bare, FEATURE_FLAGS_STORE_KEY, "overrides").get("canary"),
            Some(&false)
        );
    }

    #[test]
    fn tolerates_missing_and_malformed() {
        assert!(
            flag_map_from_value(&serde_json::json!({}), FEATURE_FLAGS_STORE_KEY, "overrides")
                .is_empty()
        );
        assert!(flag_map_from_value(
            &serde_json::json!("nonsense"),
            FEATURE_FLAGS_STORE_KEY,
            "overrides"
        )
        .is_empty());
        let non_bool = serde_json::json!({ "state": { "overrides": { "canary": "yes" } } });
        assert!(flag_map_from_value(&non_bool, FEATURE_FLAGS_STORE_KEY, "overrides").is_empty());
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
    fn read_state_parses_overrides_and_remote() {
        let value = serde_json::json!({
            "featureFlags": { "state": { "overrides": { "canary": false } }, "updatedAt": 2 },
            "featureFlagsRemote": { "state": { "remote": { "canary": true } }, "updatedAt": 1 },
        });
        assert_eq!(
            flag_map_from_value(&value, FEATURE_FLAGS_STORE_KEY, "overrides").get("canary"),
            Some(&false)
        );
        assert_eq!(
            flag_map_from_value(&value, FEATURE_FLAGS_REMOTE_STORE_KEY, "remote").get("canary"),
            Some(&true)
        );
    }

    #[test]
    fn evaluate_uses_remote_then_override_from_file() {
        let dir =
            std::env::temp_dir().join(format!("charm-flags-remote-test-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        // Remote turns canary on; no override → evaluates true.
        std::fs::write(
            dir.join(FEATURE_FLAGS_STORE_FILENAME),
            r#"{"featureFlagsRemote":{"state":{"remote":{"canary":true}},"updatedAt":1}}"#,
        )
        .unwrap();
        assert!(evaluate(&dir, FeatureFlagKey::Canary));
        // Override off wins over remote on.
        std::fs::write(
            dir.join(FEATURE_FLAGS_STORE_FILENAME),
            r#"{"featureFlags":{"state":{"overrides":{"canary":false}}},"featureFlagsRemote":{"state":{"remote":{"canary":true}}}}"#,
        )
        .unwrap();
        assert!(!evaluate(&dir, FeatureFlagKey::Canary));
        std::fs::remove_dir_all(&dir).ok();
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
