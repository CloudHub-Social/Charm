import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { changedInputs } from "./changed-inputs.mjs";
import { selectJobs, selectIos, selectWeb } from "./selection.mjs";

// Immutable provider witness from Quality 40699404196. Run only in hosted CI.
const revision = "6f0be9efae8fff1c7711e95e781de8afa8fa7ba0";
const eventBase = "e08884843c387c34559c0a1f6a1d30d6cadd3bd1";
const actualBase = "aeb2626b8cb1dc5a7e73c0b96109b53892943643";
const head = "1c80cef2d6fd6186b0dafa041509a80d8035e3b2";
const dir = mkdtempSync(join(tmpdir(), "charm-stale-base-replay-"));
const run = (command, args, cwd) =>
  execFileSync(command, args, { cwd, encoding: "utf8", stdio: "pipe" });
try {
  run("git", ["init", dir]);
  const git = (args) => run("git", args, dir);
  git(["remote", "add", "origin", "https://github.com/CloudHub-Social/Charm.git"]);
  git(["fetch", "--no-tags", "--depth=2", "origin", revision]);
  git(["checkout", "--detach", revision]);
  const after = changedInputs(
    {
      eventName: "pull_request",
      revision,
      event: { pull_request: { base: { sha: eventBase }, head: { sha: head } } },
    },
    git,
  );
  assert.equal(after.fallback, false);
  assert.equal(after.base, actualBase);
  assert.deepEqual(after.parents, [actualBase, head]);
  git(["fetch", "--no-tags", "--depth=1", "origin", eventBase]);
  const beforePaths = git(["diff", "--no-renames", "--name-only", "-z", eventBase, revision])
    .split("\0")
    .filter(Boolean);
  const before = selectJobs(beforePaths);
  const selected = selectJobs(after.paths);
  assert.ok(Object.values(before).every(Boolean));
  assert.deepEqual(selected, {
    platform: false,
    integration: false,
    frontend: true,
    browser: true,
    companion_container: false,
  });
  assert.equal(selectIos(beforePaths), true);
  assert.equal(selectIos(after.paths), false);
  const jobs = JSON.parse(
    run("gh", ["api", "repos/CloudHub-Social/Charm/actions/runs/40699404196/jobs?per_page=100"]),
  ).jobs;
  const avoidedNames = [
    "Rust (fmt, clippy, lib test)",
    "Rust (verification, alias-resolution, discovery/registration, SSO, persistence)",
    "Rust (QR login / MAS)",
    "Companion API container build",
  ];
  const historicalJobs = avoidedNames.map((name) => {
    const job = jobs.find((item) => item.name === name);
    assert.equal(job?.conclusion, "success", name);
    return {
      id: job.id,
      name,
      seconds: (Date.parse(job.completed_at) - Date.parse(job.started_at)) / 1000,
    };
  });
  const receipt = {
    revision,
    eventBase,
    actualBase,
    head,
    before,
    after: selected,
    iosBefore: selectIos(beforePaths),
    iosAfter: selectIos(after.paths),
    webBefore: selectWeb(beforePaths),
    webAfter: selectWeb(after.paths),
    unrelatedPaths: beforePaths.filter((path) => !after.paths.includes(path)),
    historicalJobs,
    historicalAvoidableRunnerSeconds: historicalJobs.reduce((sum, job) => sum + job.seconds, 0),
    measurement:
      "same-tree selector replay; historical job durations, not a new runtime speedup benchmark or billing savings",
  };
  process.stdout.write(`${JSON.stringify(receipt, null, 2)}\n`);
} finally {
  rmSync(dir, { recursive: true, force: true });
}
