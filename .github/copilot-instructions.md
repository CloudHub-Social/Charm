# Copilot instructions for Charm

Charm 2.0 is a Matrix client: a React + TypeScript frontend over a Rust
(matrix-rust-sdk) core, bridged by typed Tauri IPC. See `CLAUDE.md` and
`AGENTS.md` for the full agent guidance; this file is the Copilot-facing summary
of the rules most likely to be missed.

## Branch & PR

- All PRs target `main` (or a `release/*` backport branch).
- Run the quality gate before opening a PR: `pnpm lint`, `pnpm fmt:check`,
  `pnpm typecheck`, `pnpm test:coverage`, `pnpm knip`, `pnpm build`, plus
  `cargo fmt --check`, `cargo clippy -D warnings`, `cargo test` for Rust changes.

## Feature flags (required for new features)

New user-facing features must ship **behind a feature flag** that defaults off,
so they can be dark-launched, rolled out in stages, and killed without a client
release. See `docs/FEATURE_FLAGS.md`.

- Add the key to the Rust catalog (`src-tauri/src/feature_flags.rs`) **and**
  `src/featureFlags/catalog.ts` (the key is a ts-rs-exported union — a mismatch
  is a compile error), defaulting `false`.
- Gate the feature on `useFlag()` (React), `getFlag()` (other JS), or
  `feature_flags::flag()` (Rust).
- Retire the flag once the feature is fully rolled out.
- The "PR checklist gate" CI check enforces this. Bug fixes/refactors mark the
  feature-flag checklist line `N/A: <reason>`; docs/internal/chore PRs apply the
  `internal` label to skip the gate.

## IPC types

Rust structs shared across IPC are generated to `src-tauri/src/bindings/` by
ts-rs and imported via the `@bindings/*` alias. Don't hand-write or edit a
binding file — change the Rust struct and regenerate (`cargo test --lib`).

## Observability

Add Sentry breadcrumbs/logging/metrics for new error paths, IPC calls, and user
actions, and Playwright e2e coverage (`e2e/*.spec.ts`) for user-facing changes.
Both are enforced by the same PR checklist gate. See `SENTRY.md`.

## Documentation

Repository docs and feature specs under `docs-site/src/content/docs/` are the
source of truth. Update the linked spec in the same PR when behavior, scope,
acceptance criteria, dependencies, or implementation status changes. Do not add
private workspace paths or Obsidian wikilinks to published docs.
