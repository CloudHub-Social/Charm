---
title: Maintaining the feature gallery
description: How snapshots, the feature manifest, CI validation, and automated refresh pull requests fit together.
---

The public [feature gallery](../) is a curated view over Charm's Playwright
visual regression suite. Every public image captures a complete application
state after a real interaction against the deterministic mock backend.

Storybook remains useful for component-level regression and accessibility
coverage, but its isolated fixtures are intentionally not eligible for the
public feature gallery.

## Sources of truth

- `src-tauri/src/feature_flags.rs` owns feature-flag keys and metadata.
- `docs-site/src/data/feature-gallery.json` chooses the public features and
  their snapshot sources, and links each journey to its governing product
  specs.
- `e2e/support/sentrySnapshot.ts` captures named Playwright states.
- `scripts/sync-feature-docs.mjs` validates flag coverage and copies only the
  curated images into `docs-site/public/features/`.

The internal `canary` flag is explicitly excluded. Every other flag must have a
gallery entry, even while it defaults off.

## Updating a screenshot

1. Push the UI change and let **Sentry Snapshots** finish.
2. Download that run's `sentry-e2e-snapshots-*` artifact into
   `.artifacts/sentry-e2e-snapshots/`.
3. Run `pnpm docs:features:sync`.
4. Review the changed PNGs, then commit them with the feature change.
5. Run `pnpm docs:features:check` and `pnpm --dir docs-site build`.

The check uses a 100-pixel visual tolerance (about 0.011% of a 1280×720
capture). That absorbs Chromium's occasional SVG-edge antialiasing noise while
still failing any visible layout or content drift.

CI also uploads a `feature-docs-candidate-*` artifact containing only the
curated images, so contributors do not need to sort through the complete
snapshot set.

## Automated refresh pull requests

After a successful main-branch snapshot run, the feature-doc refresh workflow
rebuilds the curated image set. When it detects drift, it uploads the candidate
artifact and can open a docs-only pull request.

To enable pull-request creation, add a repository secret named
`FEATURE_DOCS_TOKEN` containing a fine-grained token with **Contents: read and
write** and **Pull requests: read and write** for this repository. Without that
secret, validation and candidate artifacts still run, but CI records that the
refresh PR was skipped.

The token is deliberately separate from Sentry credentials and is never passed
to the screenshot jobs.

## Related documentation

- [Feature flags](/contributing/feature-flags/) defines the rollout contract
  for preview entries.
- [Sentry observability](/operations/sentry/) describes the complete snapshot
  suite and its upload boundary.
- [CI / release tiers](/contributing/ci-tiers/) explains which checks gate pull
  requests and which run on trusted branches.
- [Documentation workflow](/contributing/documentation/) covers cross-linking
  specs, features, and operator guides without duplicating their source of
  truth.
