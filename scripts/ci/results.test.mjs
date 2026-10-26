import assert from "node:assert/strict";
import test from "node:test";
import { assertResults } from "./results.mjs";
const selected = { platform: "true", integration: "false", companion_container: "false" };
const needs = {
  changes: { result: "success", outputs: selected },
  rust: { result: "success" },
  "rust-audit": { result: "success" },
  "rust-integration": { result: "skipped" },
  "rust-integration-qr": { result: "skipped" },
  "companion-container": { result: "skipped" },
};
test("successful selected jobs and intentional skips pass", () =>
  assert.doesNotThrow(() => assertResults(needs)));
for (const result of ["skipped", "cancelled", "failure", undefined]) {
  test(`selected Rust result ${result} fails closed`, () =>
    assert.throws(() => assertResults({ ...needs, rust: { result } })));
}
test("missing selector cannot authorize a skip", () =>
  assert.throws(() => assertResults({ ...needs, changes: { result: "success", outputs: {} } })));
test("failed unselected job is still a failure", () =>
  assert.throws(() => assertResults({ ...needs, "rust-integration": { result: "failure" } })));
test("audit must succeed regardless of selection", () =>
  assert.throws(() => assertResults({ ...needs, "rust-audit": { result: "skipped" } })));
