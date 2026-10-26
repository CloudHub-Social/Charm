import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
const quality = readFileSync(
  new URL("../../.github/workflows/quality-checks.yml", import.meta.url),
  "utf8",
);
const snapshots = readFileSync(
  new URL("../../.github/workflows/sentry-snapshots.yml", import.meta.url),
  "utf8",
);
test("required quality contexts keep their names", () => {
  for (const name of [
    "Frontend (lint, format, typecheck, test, build)",
    "Storybook (build + axe a11y)",
    "E2E (message actions, against the dev server)",
    "Rust CI (required)",
  ])
    assert.ok(quality.includes(`name: ${name}`), name);
});
test("visual consumer requires both successful producers and exact receipts", () => {
  assert.match(quality, /needs\.storybook-a11y\.result == 'success'/);
  assert.match(quality, /needs\.e2e\.result == 'success'/);
  assert.match(snapshots, /capture-receipt\.mjs verify \.artifacts\/sentry-snapshots storybook/);
  assert.match(snapshots, /capture-receipt\.mjs verify \.artifacts\/sentry-e2e-snapshots e2e/);
  assert.doesNotMatch(snapshots, /^  pull_request:/m);
  assert.match(snapshots, /^  push:\n    branches: \[main\]/m);
  assert.match(snapshots, /^  workflow_dispatch:/m);
});
