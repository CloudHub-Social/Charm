# Feature flags

Charm gates runtime behavior behind feature flags so Day-2 features can ship
disabled, roll out in stages, and be turned off without a client release. This
document is the contributor guide; the design rationale lives in the vault spec
(Charm 2.0 Spec 35).

## Architecture at a glance

- **The Rust core is the authoritative catalog.** Every flag key, its
  compiled-in default, and its description live in
  [`src-tauri/src/feature_flags.rs`](../src-tauri/src/feature_flags.rs). The key
  set is exported to the frontend as a `FeatureFlagKey` string-literal union via
  ts-rs (`src/bindings/FeatureFlagKey.ts`), so a JS catalog that misspells or
  omits a key fails `tsc`.
- **Resolution is layered**, highest precedence first:
  1. **local override** — a per-key boolean the Labs panel / dev tooling
     persists into `feature-flags.json`;
  2. **static default** — the flag's catalog default (also the offline value).
- Both the frontend (`src/featureFlags/`) and the Rust core read the same
  override file and the same defaults, so a flag reads identically on both sides
  of the IPC boundary for the same install.

> **Next increment (not yet shipped): the remote layer.** A GO Feature Flag
> (OFREP) endpoint slots in _between_ override and default to provide the
> production **kill-switch** and **staged/percentage rollout**. It is deployed
> as a relay-proxy container on DO App Platform reading a config published from
> a PR-reviewed `charm-flags` repo to DO Spaces, with a break-glass path for
> emergency kills. Consumers already go through the stable seam
> (`useFlag()` / `flag()`), so adding it changes no call site. Until it lands,
> flags are controlled by catalog defaults + local overrides only, i.e. a flip
> requires a client release. See Spec 35 for the full design and runbook.

## Adding a flag

1. **Rust** — add a variant to `FeatureFlagKey` in `feature_flags.rs` and fill
   in every `match` arm (`default_value`, `description`, `owner`, `as_wire_key`)
   and the `ALL` list. Default to `false` until the feature is ready to ship.
   Run `cargo test --lib feature_flags` to regenerate the ts-rs binding.
2. **Frontend** — add the same key to `FEATURE_FLAG_CATALOG` in
   [`src/featureFlags/catalog.ts`](../src/featureFlags/catalog.ts) with its
   `default` and `description`. Because the record is typed by the exported
   union, a missing/extra/misspelled key is a compile error.
3. **Gate the feature** on the flag:
   - React: `const enabled = useFlag("your_flag");`
   - Other JS: `if (getFlag("your_flag")) { … }`
   - Rust: `if feature_flags::flag(&app_data_dir, FeatureFlagKey::YourFlag) { … }`
     (use `flag`, not `evaluate`, so the evaluation is reported to Sentry).

The `wire_key` (the serialized `snake_case` string) is the stable identifier
used in the override store and, later, the remote config — **never rename it
once shipped**, or persisted overrides/remote entries silently orphan.

## Overriding a flag locally

Overrides are the developer/tester escape hatch and win over everything else.
They're written via `setFeatureFlagOverride(key, value)` /
`clearFeatureFlagOverride(key)` from `src/featureFlags`, persisted to
`feature-flags.json` (and a `localStorage` mirror for web/dev builds). The Labs
settings panel (Spec 34) is the user-facing surface for these; until it ships,
set them programmatically or by editing the store file.

## Retiring a flag

When a feature is fully shipped and the flag is no longer a kill-switch, delete
it in the PR that declares the feature stable: remove the `FeatureFlagKey`
variant + its `match` arms + `ALL` entry (Rust), the `catalog.ts` entry, and all
call sites. Leaving flags around accumulates dead config. Each Day-2 spec's
acceptance criteria should include retiring its flag.

## Sentry evaluation tracking

Flag evaluations are reported to Sentry's Feature Flag Context so a captured
error shows which flags were active:

- **JS** uses `Sentry.featureFlagsIntegration()` (added in
  `src/observability/instrument.ts`); `reportFlagEvaluation` buffers each
  evaluation via the integration. Reporting only happens when the integration is
  present, which is only when Sentry consent (`sentryEnabled`, Spec 21) is on.
- **Rust** hand-maintains the `flags` context on the Sentry scope
  (`record_evaluation` in `feature_flags.rs`), since the installed `sentry`
  crate has no native feature-flag API.

**Caveat:** Sentry's evaluation tracking captures **boolean** flags only. The
catalog is boolean by design; a non-boolean flag would evaluate correctly but
not appear in Sentry's flag context.

## Privacy

Flag keys and values are app-internal config identifiers — never user or room
identity. Nothing about flag _state_ is sent to Sentry beyond the boolean, and
it flows through the same scrubbers as all other Sentry data (Spec 21).

Once the remote layer ships, the client will send an **anonymized per-install
ID** to Charm's own flag proxy as the rollout targeting key. That ID is random,
non-reversible, and **never** the Matrix ID / email / display name. This
disclosure will also appear in `PRIVACY.md` when that layer lands.
