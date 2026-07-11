// Unit tests for scripts/compute-build-id.mjs's pure computeBuildId() logic
// (Spec 24). Run with `node --test scripts/compute-build-id.test.mjs` — this
// is a plain Node script (like the other scripts/*.mjs files in this repo),
// not part of the src/ vitest suite, so it isn't picked up by
// `pnpm test:coverage`'s include glob or its coverage floor.
import test from "node:test";
import assert from "node:assert/strict";
import { computeBuildId, describeCaughtError } from "./compute-build-id.mjs";

test("ordinary commit: {version}+{short_sha}", () => {
  const id = computeBuildId({ version: "0.4.2", sha: "a1b2c3d4e5f6" });
  assert.equal(id, "0.4.2+a1b2c3d");
});

test("PR preview: {version}+pr{number}.{short_sha}", () => {
  const id = computeBuildId({
    version: "0.4.2",
    sha: "a1b2c3d4e5f6",
    kind: "pr",
    prNumber: 187,
  });
  assert.equal(id, "0.4.2+pr187.a1b2c3d");
});

test("nightly build: {version}+nightly.{short_sha}", () => {
  const id = computeBuildId({ version: "0.4.2", sha: "a1b2c3d4e5f6", kind: "nightly" });
  assert.equal(id, "0.4.2+nightly.a1b2c3d");
});

test("short sha is truncated to 7 characters even from a full 40-char SHA", () => {
  const id = computeBuildId({
    version: "1.0.0",
    sha: "0123456789abcdef0123456789abcdef01234567",
  });
  assert.equal(id, "1.0.0+0123456");
});

test("throws when version is missing", () => {
  assert.throws(() => computeBuildId({ sha: "a1b2c3d" }), /version is required/);
});

test("throws when sha is missing", () => {
  assert.throws(() => computeBuildId({ version: "0.4.2" }), /sha is required/);
});

test("throws when sha is shorter than the short-sha length", () => {
  assert.throws(() => computeBuildId({ version: "0.4.2", sha: "a1b2" }), /shorter than/);
});

test("throws for a pr build without a PR number", () => {
  assert.throws(
    () => computeBuildId({ version: "0.4.2", sha: "a1b2c3d4e5f6", kind: "pr" }),
    /prNumber is required/,
  );
});

test("throws for an unknown build kind", () => {
  assert.throws(
    () => computeBuildId({ version: "0.4.2", sha: "a1b2c3d4e5f6", kind: "bogus" }),
    /unknown kind/,
  );
});

test("pr number accepts a numeric string (as GitHub Actions env vars are always strings)", () => {
  const id = computeBuildId({
    version: "0.4.2",
    sha: "a1b2c3d4e5f6",
    kind: "pr",
    prNumber: "187",
  });
  assert.equal(id, "0.4.2+pr187.a1b2c3d");
});

test("describeCaughtError returns the message for an Error instance", () => {
  assert.equal(describeCaughtError(new Error("boom")), "boom");
});

test("describeCaughtError stringifies a non-Error thrown value", () => {
  assert.equal(describeCaughtError("just a string"), "just a string");
  assert.equal(describeCaughtError({ code: "EBADF" }), '{"code":"EBADF"}');
});

test("describeCaughtError falls back to String() for values JSON.stringify can't handle", () => {
  const circular = {};
  circular.self = circular;
  assert.equal(describeCaughtError(circular), "[object Object]");
});
