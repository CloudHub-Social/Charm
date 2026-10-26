import assert from "node:assert/strict";
import test from "node:test";
import { selectJobs } from "./selection.mjs";

test("unknown and unavailable inputs select every lane", () => {
  for (const paths of [
    null,
    ["new-build-input.toml"],
    ["src/file.ts\nunknown"],
    ["scripts/new-generator.mjs"],
  ]) {
    assert.ok(Object.values(selectJobs(paths)).every(Boolean));
  }
});
test("docs-only changes leave always-running audit and policy jobs to their owners", () => {
  assert.ok(
    Object.values(selectJobs(["docs-site/src/content/docs/contributing/example.md"])).every(
      (v) => !v,
    ),
  );
});
test("frontend-only changes keep browsers without native compilation", () => {
  const jobs = selectJobs(["src/components/Button.tsx"]);
  assert.equal(jobs.frontend, true);
  assert.equal(jobs.browser, true);
  assert.equal(jobs.platform, false);
});
test("lint configuration needs frontend gate but not browser execution", () => {
  const jobs = selectJobs(["oxlint.config.ts"]);
  assert.equal(jobs.frontend, true);
  assert.equal(jobs.browser, false);
});
test("bindings, feature flags and gallery changes retain browser witnesses", () => {
  for (const path of [
    "src-tauri/src/bindings/example.ts",
    "src-tauri/src/feature_flags.rs",
    "docs-site/src/data/feature-gallery.json",
    "docs-site/public/features/a.png",
  ]) {
    assert.equal(selectJobs([path]).browser, true, path);
  }
});
test("workspace dependencies and CI implementation require full qualification", () => {
  for (const path of [
    "Cargo.lock",
    "pnpm-lock.yaml",
    ".github/workflows/quality-checks.yml",
    "scripts/ci/selection.mjs",
  ]) {
    assert.ok(Object.values(selectJobs([path])).every(Boolean), path);
  }
});
test("rename/delete witnesses are combined, not replaced by the destination", () => {
  const jobs = selectJobs(["src/Foo.tsx", "docs/Foo.tsx"]);
  assert.equal(jobs.browser, true);
});
test("Synapse inputs retain both integration lanes", () => {
  assert.equal(selectJobs(["dev/synapse/configure-homeserver.sh"]).integration, true);
});
