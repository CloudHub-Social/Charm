import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

import {
  assertNoRelease,
  publishRelease,
  stagedRelease,
} from "../.github/scripts/publish-release.mjs";

const root = new URL("..", import.meta.url).pathname;

test("real Knope stages the derived Android code without committing or publishing", () => {
  const directory = mkdtempSync(join(tmpdir(), "charm-release-preparation-"));
  const git = (...args) => execFileSync("git", args, { cwd: directory });
  try {
    for (const path of [
      "knope.toml",
      "package.json",
      "Cargo.lock",
      "src-tauri/Cargo.toml",
      "src-tauri/Cargo.lock",
      "src-tauri/tauri.conf.json",
      "src-tauri/gen/apple/project.yml",
      "src-tauri/gen/apple/charm_iOS/Info.plist",
      "scripts/sync-android-version-code.mjs",
      "scripts/validate-changeset-packages.mjs",
      "CHANGELOG.md",
    ]) {
      mkdirSync(dirname(join(directory, path)), { recursive: true });
      cpSync(join(root, path), join(directory, path));
    }
    mkdirSync(join(directory, ".changeset"));
    writeFileSync(
      join(directory, ".changeset/regression.md"),
      "---\ndefault: patch\n---\n\nFixture release.\n",
    );
    git("init", "--initial-branch=main");
    git("config", "user.name", "Release fixture");
    git("config", "user.email", "release-fixture@example.invalid");
    git("config", "commit.gpgsign", "false");
    git("add", ".");
    git("commit", "-m", "fixture");
    const base = git("rev-parse", "HEAD").toString().trim();
    const previous = JSON.parse(readFileSync(join(directory, "package.json"))).version;
    const checkCandidate = () =>
      execFileSync(process.execPath, [join(root, "scripts/check-release-candidate.mjs"), base], {
        cwd: directory,
        env: { ...process.env, CHARM_RELEASE_CANDIDATE: "false" },
        stdio: "pipe",
      });
    // Ordinary changesets on the unchanged main version remain valid.
    checkCandidate();
    execFileSync("knope", ["prepare-release"], {
      cwd: directory,
      env: { ...process.env, GITHUB_TOKEN: "", GH_TOKEN: "" },
      stdio: "pipe",
    });
    const candidate = stagedRelease(base, git);
    const [major, minor, patch] = previous.split(".").map(Number);
    assert.equal(candidate.version, `${major}.${minor}.${patch + 1}`);
    const stagedConfig = JSON.parse(git("show", ":src-tauri/tauri.conf.json").toString());
    assert.equal(
      stagedConfig.bundle.android.versionCode,
      major * 1_000_000 + minor * 1_000 + patch + 2,
    );
    assert.deepEqual(candidate.fileChanges.deletions, [{ path: ".changeset/regression.md" }]);
    assert.equal(git("remote").toString(), "");
    checkCandidate();
    // Model a merge-queue tree that combines the preserved release with a
    // later main changeset. It must fail before that code can be tagged.
    mkdirSync(join(directory, ".changeset"), { recursive: true });
    writeFileSync(
      join(directory, ".changeset/later.md"),
      "---\ndefault: patch\n---\n\nLater change.\n",
    );
    assert.throws(checkCandidate, /unconsumed/);
    writeFileSync(join(directory, "CHANGELOG.md"), "unstaged change\n");
    assert.throws(() => stagedRelease(base, git), /unstaged changes/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

function fixture(options = {}) {
  const context = { repo: { owner: "fixture", repo: "repository" }, sha: "base" };
  const candidate = {
    version: "0.1.4",
    tree: "tree",
    fileChanges: { additions: [], deletions: [] },
  };
  const calls = [];
  let release = options.existingRef;
  const missing = () => Object.assign(new Error("Not found"), { status: 404 });
  const github = {
    rest: {
      pulls: {
        list: async () => ({ data: options.existingPR ? [{ number: 541 }] : [] }),
        create: async (input) => {
          calls.push(["pull", input]);
          return { data: { number: 1, html_url: "https://example.invalid/pull/1" } };
        },
      },
      git: {
        getRef: async ({ ref }) => {
          if (options.readError) throw Object.assign(new Error("Denied"), { status: 403 });
          if (ref === "heads/main") return { data: { object: { sha: options.main ?? "base" } } };
          if (!release) throw missing();
          return { data: { object: { sha: release } } };
        },
        createRef: async (input) => {
          calls.push(["ref", input]);
          if (options.refRace) throw new Error("Ref already exists");
          release = input.sha;
        },
      },
      repos: {
        getCommit: async () => ({
          data: {
            commit: {
              verification: { verified: !options.unsigned },
              tree: { sha: options.tree ?? "tree" },
            },
            parents: [{ sha: options.parent ?? "base" }],
          },
        }),
      },
      issues: { addLabels: async (input) => calls.push(["labels", input]) },
    },
    graphql: async (_, input) => {
      calls.push(["commit", input]);
      if (options.commitError) throw new Error("Commit unavailable");
      release = options.refMoved ? "other" : "signed";
      return { createCommitOnBranch: { commit: { oid: "signed" } } };
    },
  };
  return { github, context, candidate, calls };
}

for (const options of [{ existingPR: true }, { existingRef: "owner-head" }, { readError: true }]) {
  test(`preserves existing release work and fails closed on unreadable state: ${JSON.stringify(options)}`, async () => {
    const input = fixture(options);
    await assert.rejects(assertNoRelease(input));
    await assert.rejects(publishRelease(input));
    assert.deepEqual(input.calls, []);
  });
}

test("refuses publication after main advances", async () => {
  const input = fixture({ main: "new-main" });
  await assert.rejects(publishRelease(input), /Main advanced/);
  assert.deepEqual(input.calls, []);
});

test("a racing release-ref creation never reaches a commit or PR", async () => {
  const input = fixture({ refRace: true });
  await assert.rejects(publishRelease(input), /partial publication/);
  assert.deepEqual(
    input.calls.map(([name]) => name),
    ["ref"],
  );
});

for (const options of [
  { unsigned: true },
  { tree: "different" },
  { parent: "different" },
  { refMoved: true },
  { commitError: true },
]) {
  test(`retains partial publication without opening a PR: ${JSON.stringify(options)}`, async () => {
    const input = fixture(options);
    await assert.rejects(publishRelease(input), /partial publication/);
    assert.deepEqual(
      input.calls.map(([name]) => name),
      ["ref", "commit"],
    );
    await assert.rejects(publishRelease(input), /already exists/);
    assert.equal(input.calls.length, 2);
  });
}

test("creates a draft only after matching signed content and uses an atomic expected parent", async () => {
  const input = fixture();
  const result = await publishRelease(input);
  assert.equal(result.sha, "signed");
  assert.deepEqual(
    input.calls.map(([name]) => name),
    ["ref", "commit", "pull", "labels"],
  );
  assert.equal(input.calls[1][1].input.expectedHeadOid, "base");
  assert.equal(input.calls[2][1].draft, true);
  assert.match(input.calls[2][1].body, /owner provenance attestation remain pending/);
});
