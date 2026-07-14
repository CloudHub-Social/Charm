---
title: Documentation workflow
description: Source-of-truth rules for product docs, specs, operational guides, and generated feature evidence.
---

Charm's durable product and engineering documentation lives in this repository
and is published from `docs-site/`. This keeps decisions beside the code they
govern and lets pull-request checks validate the exact content that will reach
the public site.

## What belongs here

- Product vision, roadmap, architecture, and durable decisions.
- Day-1 and Day-2 feature specs, including acceptance criteria and status.
- Contributor workflows, CI/release behavior, and feature-flag conventions.
- Operational guides for Cloudflare, Sentry, and the Rust companion service.
- CI-managed feature journeys, screenshots, and metadata.

Personal timelines, meeting notes, task capture, and exploratory material can
remain in a private notebook. Those notes may link to repository docs, but they
are not the implementation source of truth.

## Updating a feature

When a pull request changes documented behavior:

1. Update the relevant spec's scope, acceptance criteria, or status in the same
   pull request.
2. Update contributor or operations guides when commands, secrets, ownership,
   deployment topology, or failure modes change.
3. Add or update a deterministic feature journey when the user-visible flow
   changes materially.
4. Cross-link the feature evidence, governing spec, adjacent implementation
   guide, and operator runbook where those relationships are real.
5. Run the content check, production build, and generated graph check locally.

The feature gallery is not a Storybook component catalog. It captures complete
user journeys with deterministic state. See [Maintaining the feature
gallery](/features/maintaining/) for its CI contract.

## Content rules

- Use normal Markdown links; Obsidian wikilinks are not supported.
- Never commit personal filesystem paths, private-note locations, credentials,
  or owner-only dashboard URLs.
- Prefer links to repository files, issues, pull requests, Matrix spec sections,
  and public operational documentation.
- Give feature cards direct links to their governing specs. Add a short
  `Related documentation` section when a spec depends on or materially extends
  another spec, contributor guide, or runbook.
- Do not add links merely to increase the graph count. Every edge should answer
  why a reader of one page should continue to the other.
- Keep frontmatter titles descriptive and statuses explicit.
- Treat an implementation/spec mismatch as documentation debt to fix in the
  same change, not a future vault-sync task.

The original Day-1 and Day-2 corpus was imported from the private planning
workspace at source revision `9758ff331eb9b100d2791e37e6e6b7008a2ec5a7` on
2026-07-14. Git history now records all subsequent edits.
