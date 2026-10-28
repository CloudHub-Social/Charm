import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { changedInputs } from "./changed-inputs.mjs";
import { selectJobs, selectIos, selectWeb } from "./selection.mjs";

const revision = "1".repeat(40);
const actualBase = "2".repeat(40);
const prHead = "3".repeat(40);
const staleBase = "4".repeat(40);
const input = {
  eventName: "pull_request",
  revision,
  event: { pull_request: { base: { sha: staleBase }, head: { sha: prHead } } },
};
function fixture({
  checkout = revision,
  parents = [actualBase, prHead],
  fail,
  diff = "src/Button.tsx\0",
} = {}) {
  const calls = [];
  const run = (args) => {
    calls.push(args);
    if (args[0] === fail) throw new Error("unavailable");
    if (args[0] === "rev-parse") return `${checkout}\n`;
    if (args[0] === "cat-file")
      return `tree ${"5".repeat(40)}\n${parents.map((p) => `parent ${p}\n`).join("")}\nmessage\nparent ignored-in-message\n`;
    if (args[0] === "diff") return diff;
    return "";
  };
  return { run, calls };
}
test("stale event base is replaced only by validated checkout merge parents", () => {
  const { run, calls } = fixture();
  const result = changedInputs(input, run);
  assert.equal(result.base, actualBase);
  assert.equal(result.fallback, false);
  assert.deepEqual(result.paths, ["src/Button.tsx"]);
  assert.deepEqual(calls.at(-1), [
    "diff",
    "--no-renames",
    "--name-only",
    "-z",
    actualBase,
    revision,
  ]);
  assert.ok(!calls.flat().includes(staleBase));
  assert.deepEqual(selectJobs(result.paths), {
    platform: false,
    integration: false,
    frontend: true,
    browser: true,
    companion_container: false,
  });
  assert.equal(selectIos(result.paths), false);
  assert.equal(selectWeb(result.paths), true);
});
test("missing, wrong or extra merge parents and checkout mismatch select ALL", () => {
  for (const options of [
    { parents: [] },
    { parents: [actualBase] },
    { parents: [actualBase, staleBase] },
    { parents: [actualBase, prHead, staleBase] },
    { parents: ["invalid", prHead] },
    { parents: [prHead, prHead] },
    { checkout: prHead },
  ]) {
    const { run, calls } = fixture(options);
    const result = changedInputs(input, run);
    assert.equal(result.paths, null);
    assert.equal(result.fallback, true);
    assert.ok(Object.values(selectJobs(result.paths)).every(Boolean));
    assert.equal(selectIos(result.paths), true);
    assert.equal(selectWeb(result.paths), true);
    assert.ok(!calls.some(([op]) => op === "diff"));
  }
});
test("fetch, object retrieval, checkout and diff errors fail closed", () => {
  for (const fail of ["fetch", "cat-file", "rev-parse", "diff"]) {
    const result = changedInputs(input, fixture({ fail }).run);
    assert.equal(result.paths, null, fail);
    assert.equal(result.fallback, true, fail);
  }
});
test("missing event head, invalid revision, incomplete diff and invalid paths fail closed", () => {
  for (const candidate of [
    { ...input, event: {} },
    { ...input, event: { pull_request: { head: { sha: "0".repeat(40) } } } },
    { ...input, revision: "invalid" },
  ])
    assert.equal(changedInputs(candidate, fixture().run).fallback, true);
  for (const diff of ["src/A.ts", "src/A.ts\nother\0", "../src/A.ts\0", "/src/A.ts\0", "\0"]) {
    assert.equal(changedInputs(input, fixture({ diff }).run).fallback, true);
  }
});
test("push and merge-group preserve their event comparison bases", () => {
  for (const eventName of ["push", "merge_group"]) {
    const { run, calls } = fixture();
    const result = changedInputs(
      { eventName, revision, event: { before: staleBase, merge_group: { base_sha: staleBase } } },
      run,
    );
    assert.equal(result.base, staleBase);
    assert.equal(result.fallback, false);
    assert.ok(!calls.some(([op]) => op === "cat-file"));
    assert.deepEqual(calls[1], ["fetch", "--no-tags", "--depth=1", "--quiet", "origin", staleBase]);
  }
  for (const eventName of ["schedule", "workflow_dispatch", "push", "merge_group"]) {
    assert.equal(changedInputs({ eventName, revision, event: {} }, fixture().run).fallback, true);
  }
});
test("empty diffs skip known lanes; native, unknown and renamed/deleted paths retain coverage", () => {
  assert.deepEqual(changedInputs(input, fixture({ diff: "" }).run).paths, []);
  for (const path of ["src-tauri/src/lib.rs", "scripts/ci/changed-inputs.mjs", "new-input.toml"]) {
    assert.equal(selectJobs([path]).platform, true);
    assert.equal(selectIos([path]), true);
  }
  for (const paths of [["src/Old.tsx", "docs/New.tsx"], ["src/Deleted.tsx"]]) {
    assert.equal(selectJobs(paths).browser, true);
    assert.equal(selectWeb(paths), true);
  }
});
test("real shallow Git checkout exposes both raw parents and preserves rename/deletion witnesses", () => {
  const dir = mkdtempSync(join(tmpdir(), "charm-selection-"));
  try {
    const origin = join(dir, "origin");
    const checkout = join(dir, "checkout");
    mkdirSync(origin);
    const git = (cwd, args) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: "pipe" });
    git(origin, ["init", "-b", "main"]);
    git(origin, ["config", "user.name", "CI fixture"]);
    git(origin, ["config", "user.email", "ci@example.invalid"]);
    const commit = (message) => {
      git(origin, ["add", "."]);
      git(origin, ["-c", "commit.gpgsign=false", "commit", "-m", message]);
      return git(origin, ["rev-parse", "HEAD"]).trim();
    };
    mkdirSync(join(origin, "src"));
    writeFileSync(join(origin, "src/Old.tsx"), "old\n");
    writeFileSync(join(origin, "src/Deleted.tsx"), "deleted\n");
    const stale = commit("initial");
    git(origin, ["checkout", "-b", "pr"]);
    mkdirSync(join(origin, "docs"));
    git(origin, ["mv", "src/Old.tsx", "docs/New.tsx"]);
    git(origin, ["rm", "src/Deleted.tsx"]);
    const head = commit("frontend rename and delete");
    git(origin, ["checkout", "main"]);
    mkdirSync(join(origin, "crates"));
    writeFileSync(join(origin, "crates/backend.rs"), "backend unrelated\n");
    const base = commit("base advanced");
    git(origin, ["-c", "commit.gpgsign=false", "merge", "--no-ff", "pr", "-m", "synthetic merge"]);
    const merge = git(origin, ["rev-parse", "HEAD"]).trim();
    git(dir, ["clone", "--depth=1", `file://${origin}`, checkout]);
    const result = changedInputs(
      {
        eventName: "pull_request",
        revision: merge,
        event: { pull_request: { base: { sha: stale }, head: { sha: head } } },
      },
      (args) => git(checkout, args),
    );
    assert.equal(result.fallback, false);
    assert.equal(result.base, base);
    assert.deepEqual(result.parents, [base, head]);
    assert.deepEqual(result.paths, ["docs/New.tsx", "src/Deleted.tsx", "src/Old.tsx"]);
    assert.equal(selectJobs(result.paths).platform, false);
    assert.equal(selectJobs(result.paths).browser, true);
    assert.equal(selectIos(result.paths), false);
    git(checkout, ["fetch", "--no-tags", "--depth=1", "origin", stale]);
    const eventPath = join(dir, "event.json");
    const outputPath = join(dir, "output.txt");
    const cli = (lane, eventName, event) => {
      writeFileSync(eventPath, JSON.stringify(event));
      writeFileSync(outputPath, "");
      const receipt = JSON.parse(
        execFileSync(
          process.execPath,
          [fileURLToPath(new URL("./selection.mjs", import.meta.url)), ...lane],
          {
            cwd: checkout,
            encoding: "utf8",
            env: {
              ...process.env,
              GITHUB_EVENT_NAME: eventName,
              GITHUB_EVENT_PATH: eventPath,
              GITHUB_OUTPUT: outputPath,
              GITHUB_SHA: merge,
            },
          },
        ),
      );
      return { receipt, output: readFileSync(outputPath, "utf8") };
    };
    const event = { pull_request: { base: { sha: stale }, head: { sha: head } } };
    assert.equal(cli(["ios"], "pull_request", event).output, "ios=false\n");
    assert.equal(cli(["web"], "pull_request", event).output, "web=true\n");
    assert.equal(cli([], "pull_request", event).receipt.selected.platform, false);
    for (const eventName of ["push", "merge_group", "workflow_dispatch"]) {
      assert.equal(
        cli(["ios"], eventName, { before: base, merge_group: { base_sha: base } }).output,
        "ios=true\n",
      );
    }
    const missing = cli([], "pull_request", {});
    assert.equal(missing.receipt.fallback, true);
    assert.ok(Object.values(missing.receipt.selected).every(Boolean));
    const oldPaths = git(checkout, ["diff", "--no-renames", "--name-only", "-z", stale, merge])
      .split("\0")
      .filter(Boolean);
    assert.ok(oldPaths.includes("crates/backend.rs"));
    assert.equal(selectJobs(oldPaths).platform, true);
    console.log(
      JSON.stringify({
        witness: "stale-base",
        before: selectJobs(oldPaths),
        after: selectJobs(result.paths),
        iosBefore: selectIos(oldPaths),
        iosAfter: selectIos(result.paths),
      }),
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
