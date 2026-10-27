# Charm CI Cleanup Implementation Plan

> **For agentic workers:** Use superpowers:executing-plans to implement this plan. Hosted CI is the verification authority; do not run local validation on Evie's Mac.

**Goal:** Remove repeated browser work and native setup drift while making changed-path qualification fail closed.

**Architecture:** Quality owns PR browser execution and publishes exact-revision screenshot receipts. Sentry consumes those same-run artifacts; standalone main/manual capture preserves the existing baseline and refresh workflow. A dependency-free selector and strict result accounting retain every required check name.

**Tech Stack:** GitHub Actions, Node built-ins, existing pnpm/Rust/Playwright tools.

**Spec:** Owner-approved coordinated CI cleanup; canonical contributing/ci-tiers.md. Baseline: quality 40401788799, snapshots 40401788645, iOS 40401788779.

## Global Constraints

No local build/test/lint/browser verification. No assertions, tests, coverage floors, security scans, review gates or release safeguards removed. No new credentials, permissions, services or spending. Production merge/deployment remain held. Keep required context names and existing main-only cache writes. Preserve PR591's separate dependency/accessibility results.

## Review Focus

- Unknown, deleted/renamed, shared configuration and failed-diff inputs select all relevant jobs.
- Selected jobs that are skipped/missing cannot pass the aggregate.
- Artifact SHA, run, attempt, suite and content mismatch must reject reuse.
- Fork/Dependabot PRs keep quality coverage without secret upload; main baselines retain their existing workflow lineage.
- Screenshot capture must retain all browser assertions and gallery tolerances; native service isolation remains intact.

### Task 1: Selection and result contracts

- [ ] Add scripts/ci/selection.test.mjs and results.test.mjs for the above cases.
- [ ] Extract current patterns into selection.mjs; retain existing scope, widen unknown inputs, distinguish browser work from tooling-only inputs.
- [ ] Wire detector and strict selected-job accounting in quality-checks.yml; run new contracts in the unconditional frontend gate.
- [ ] Verify through hosted Node contract tests and required workflows.

### Task 2: One PR browser capture

- [ ] Add artifact receipt contract tests and create/verify implementation.
- [ ] Capture and upload from existing required Storybook/E2E jobs; retain names and assertions.
- [ ] Make Sentry workflow callable for same-run consumption, retaining main/manual fallback and existing trusted upload boundaries.
- [ ] Verify actual artifacts, gallery and upload disposition in hosted CI.

### Task 3: Native setup and documentation

- [ ] Reuse a small Linux setup action without changing packages; keep existing services isolated.
- [ ] Apply the existing read-only PR/main-write compiler-cache wrapper consistently to the existing web recovery Cargo commands, preserving commands/assertions.
- [ ] Update canonical CI tier docs and legacy guidance; retain iOS simulator/smoke/archive proof and all release workflows.
- [ ] Independent review, signed draft publication, hosted validation and actual runtime comparison. No merge/deployment.

## Execution record

Plan approved for immediate coordinated execution by owner. Local red/green execution is prohibited; tests are written before implementation, but no local failure evidence is claimed. No redundant full hosted runs solely to manufacture a red-phase receipt. Existing historical timing receipts are baseline observations, not claimed speedup results.
