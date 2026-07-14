---
title: Feature flags
description: Charm's feature-flag system for staged rollout and kill-switches.
---

:::note
This page mirrors [`docs/FEATURE_FLAGS.md`](https://github.com/CloudHub-Social/Charm/blob/main/docs/FEATURE_FLAGS.md)
in the repository, which is the canonical, most up-to-date copy.
:::

Charm gates runtime behavior behind feature flags so Day-2 features can ship
disabled, roll out in stages, and be turned off without a client release.

## Architecture at a glance

- **The Rust core is the authoritative catalog.** Every flag key, its
  compiled-in default, and its description live in
  [`src-tauri/src/feature_flags.rs`](https://github.com/CloudHub-Social/Charm/blob/main/src-tauri/src/feature_flags.rs).
  The key set is exported to the frontend as a `FeatureFlagKey` string-literal
  union via ts-rs (`src/bindings/FeatureFlagKey.ts`), so a JS catalog that
  misspells or omits a key fails `tsc`.
- The same key must also be added to `src/featureFlags/catalog.ts` on the
  frontend, defaulting to `false`.
- Gate the feature on `useFlag()` (React), `getFlag()` (other JS), or
  `feature_flags::flag()` (Rust) — use `flag`, not `evaluate`, so the
  evaluation reports to Sentry's Feature Flag Context.
- Retire the flag (key + catalog entries + call sites) once the feature is
  fully rolled out and stable.

## PR checklist gate

A `New feature` PR must check the feature-flag box in the PR template; a bug
fix/refactor marks it `N/A: <reason>`; a docs/internal/chore PR applies the
`internal` label to skip the gate.

The remote rollout layer (GO Feature Flag / OFREP for kill-switch and staged
rollout) is a follow-up increment — until it lands, flags are controlled by
catalog defaults plus local overrides.

For the full how-to, see
[`docs/FEATURE_FLAGS.md`](https://github.com/CloudHub-Social/Charm/blob/main/docs/FEATURE_FLAGS.md)
in the repository.
