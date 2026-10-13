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
import {
  candidateArtifact,
  candidateBranch,
  candidateIdentity,
  verifyCandidate,
} from "../.github/scripts/release-candidate.mjs";

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
  const repository = "fixture/repository";
  const context = { repo: { owner: "fixture", repo: "repository" }, sha: "base", runId: 42 };
  const branch = candidateBranch("0.1.4", context.runId);
  const candidate = {
    version: "0.1.4",
    tree: "tree",
    fileChanges: { additions: [], deletions: [] },
  };
  const calls = [];
  const refs = new Map(
    options.refs ?? (options.existingRef ? [["release", options.existingRef]] : []),
  );
  const pulls =
    options.pulls ??
    (options.existingPR
      ? [
          {
            number: 541,
            state: "open",
            head: { ref: "release", repo: { full_name: repository }, sha: "owner-head" },
            base: { ref: "main", repo: { full_name: repository } },
          },
        ]
      : []);
  const missing = () => Object.assign(new Error("Not found"), { status: 404 });
  const github = {
    rest: {
      pulls: {
        list: async () => ({ data: pulls }),
        get: async ({ pull_number }) => ({
          data: pulls.find((pull) => pull.number === pull_number),
        }),
        create: async (input) => {
          calls.push(["pull", input]);
          pulls.push({
            number: 1,
            state: "open",
            head: { ref: input.head, repo: { full_name: repository } },
          });
          return { data: { number: 1, html_url: "https://example.invalid/pull/1" } };
        },
      },
      git: {
        listMatchingRefs: async () => ({
          data: [...refs].map(([name, sha]) => ({ ref: `refs/heads/${name}`, object: { sha } })),
        }),
        getRef: async ({ ref }) => {
          if (options.readError) throw Object.assign(new Error("Denied"), { status: 403 });
          if (ref === "heads/main") return { data: { object: { sha: options.main ?? "base" } } };
          const sha = refs.get(ref.replace(/^heads\//, ""));
          if (!sha) throw missing();
          return { data: { object: { sha } } };
        },
        createRef: async (input) => {
          calls.push(["ref", input]);
          const name = input.ref.replace(/^refs\/heads\//, "");
          if (options.refRace || refs.has(name)) throw new Error("Ref already exists");
          refs.set(name, input.sha);
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
    paginate: async (method, input) => {
      if (options.readError) throw Object.assign(new Error("Denied"), { status: 403 });
      return (await method(input)).data;
    },
    graphql: async (_, input) => {
      calls.push(["commit", input]);
      if (options.commitError) throw new Error("Commit unavailable");
      assert.equal(input.input.expectedHeadOid, refs.get(branch));
      refs.set(branch, options.refMoved ? "other" : "signed");
      return { createCommitOnBranch: { commit: { oid: "signed" } } };
    },
  };
  return { github, context, candidate, calls, refs, pulls, runAttempt: 1 };
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
    await assert.rejects(publishRelease(input), /Partial release ref/);
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
  assert.match(input.calls[2][1].body, /Required checks and release readiness remain pending/);
  assert.deepEqual(result.receipt, {
    schema: 1,
    repository: "fixture/repository",
    branch: "release-candidate-0.1.4-42",
    version: "0.1.4",
    base: "base",
    sha: "signed",
    tree: "tree",
    runId: "42",
    runAttempt: 1,
  });
  const before = input.calls.length;
  await assert.rejects(publishRelease(input), /Existing open/);
  assert.equal(input.calls.length, before);
});

test("a label API failure preserves the verified candidate receipt and warns", async () => {
  const input = fixture();
  const warnings = [];
  input.warn = (message) => warnings.push(message);
  input.github.rest.issues.addLabels = async () => {
    throw new Error("Label API unavailable");
  };
  const result = await publishRelease(input);
  assert.equal(result.sha, "signed");
  assert.equal(result.receipt.sha, result.sha);
  assert.equal(result.receipt.tree, "tree");
  assert.equal(result.receipt.runAttempt, 1);
  assert.equal(input.refs.get(result.receipt.branch), "signed");
  assert.equal(input.pulls.length, 1);
  assert.deepEqual(warnings, ["Could not label release PR #1; reconcile its internal label."]);
  // A warning does not authorize duplicating or overwriting the preserved PR.
  await assert.rejects(publishRelease(input), /Existing open/);
});

function mergedPull(branch = "release", sha = "previous") {
  return {
    number: 541,
    state: "closed",
    merged: true,
    head: { ref: branch, sha, repo: { full_name: "fixture/repository" } },
    base: { ref: "main", repo: { full_name: "fixture/repository" } },
  };
}

test("successive candidates retain unchanged merged legacy and unique refs", async () => {
  const oldBranch = "release-candidate-0.1.3-41";
  const input = fixture({
    refs: [
      ["release", "previous"],
      [oldBranch, "older"],
    ],
    pulls: [mergedPull(), mergedPull(oldBranch, "older")].map((pull, i) => ({
      ...pull,
      number: i + 1,
    })),
  });
  await publishRelease(input);
  assert.equal(input.refs.get("release"), "previous");
  assert.equal(input.refs.get(oldBranch), "older");
  assert.equal(input.refs.get("release-candidate-0.1.4-42"), "signed");
  assert.deepEqual(
    input.calls.map(([name]) => name),
    ["ref", "commit", "pull", "labels"],
  );
});

for (const change of [
  { merged: false },
  { state: "open" },
  { head: { ref: "release", sha: "advanced", repo: { full_name: "fixture/repository" } } },
  { base: { ref: "other", repo: { full_name: "fixture/repository" } } },
]) {
  test(`preserves an unmerged or advanced historical candidate: ${JSON.stringify(change)}`, async () => {
    const input = fixture({
      refs: [["release", "previous"]],
      pulls: [{ ...mergedPull(), ...change }],
    });
    await assert.rejects(publishRelease(input));
    assert.deepEqual(input.calls, []);
    assert.equal(input.refs.get("release"), "previous");
  });
}

test("a PR opened after discovery cannot cause deletion of its historical branch", async () => {
  const input = fixture({ refs: [["release", "previous"]], pulls: [mergedPull()] });
  const getRef = input.github.rest.git.getRef;
  input.github.rest.git.getRef = async (args) => {
    if (args.ref === "heads/main")
      input.pulls.push({ ...mergedPull(), number: 542, state: "open", merged: false });
    return getRef(args);
  };
  await publishRelease(input);
  assert.equal(input.refs.get("release"), "previous");
  assert.equal(input.pulls.find((pull) => pull.number === 542).state, "open");
});

test("a paginated open candidate prevents preparation even when older refs are merged", async () => {
  const input = fixture({ refs: [["release", "previous"]], pulls: [mergedPull()] });
  const paginate = input.github.paginate;
  input.github.paginate = async (method, args) => {
    const rows = await paginate(method, args);
    return method === input.github.rest.pulls.list
      ? [...rows, { ...mergedPull("release-candidate-0.1.4-43"), number: 999, state: "open" }]
      : rows;
  };
  await assert.rejects(publishRelease(input), /Existing open/);
  assert.deepEqual(input.calls, []);
});

test("a renamed PR head discovered after listing does not qualify the old ref", async () => {
  const input = fixture({ refs: [["release", "previous"]], pulls: [mergedPull()] });
  input.github.rest.pulls.get = async () => ({ data: mergedPull("renamed") });
  await assert.rejects(publishRelease(input), /Unmerged or advanced/);
  assert.deepEqual(input.calls, []);
});

function provenanceFixture() {
  const repository = "fixture/repository";
  const branch = "release-candidate-0.1.4-42";
  const context = {
    repo: { owner: "fixture", repo: "repository" },
    payload: { pull_request: mergedPull(branch, "signed") },
  };
  const receipt = {
    schema: 1,
    repository,
    branch,
    version: "0.1.4",
    base: "base",
    sha: "signed",
    tree: "tree",
    runId: "42",
    runAttempt: 1,
  };
  const run = {
    id: 42,
    run_attempt: 1,
    workflow_id: 7,
    path: ".github/workflows/prepare-release.yml",
    event: "push",
    head_branch: "main",
    head_sha: "base",
    status: "completed",
    conclusion: "success",
    repository: { full_name: repository },
    head_repository: { full_name: repository },
  };
  const artifacts = [
    { id: 77, name: "release-candidate-42", expired: false, workflow_run: { id: 42 } },
  ];
  const commit = {
    commit: { verification: { verified: true }, tree: { sha: "tree" } },
    parents: [{ sha: "base" }],
  };
  const github = {
    rest: {
      actions: {
        listWorkflowRunArtifacts: async ({ run_id }) => {
          assert.equal(run_id, "42");
          return { data: artifacts };
        },
        getWorkflow: async ({ workflow_id }) => {
          assert.equal(workflow_id, "prepare-release.yml");
          return { data: { id: 7 } };
        },
        getWorkflowRunAttempt: async ({ run_id, attempt_number }) => {
          assert.equal(run_id, "42");
          assert.equal(attempt_number, receipt.runAttempt);
          return { data: run };
        },
      },
      repos: {
        getCommit: async ({ ref }) => {
          assert.equal(ref, "signed");
          return { data: commit };
        },
      },
    },
    paginate: async (method, args) => (await method(args)).data,
  };
  return { github, context, receipt, run, artifacts, commit, mergeVersion: "0.1.4" };
}

test("a trusted exact receipt qualifies the original successful attempt, independent of later reruns", async () => {
  const input = provenanceFixture();
  assert.deepEqual(await candidateArtifact(input), { artifactId: 77, runId: "42" });
  // There is deliberately no latest-run endpoint in the fixture. The original
  // attempt's receipt remains authoritative after a later rerun fails closed.
  await verifyCandidate(input);
});

test("a trusted main attempt accepts GitHub's ref-qualified workflow path", async () => {
  const input = provenanceFixture();
  input.run.path = ".github/workflows/prepare-release.yml@main";
  await verifyCandidate(input);
  input.run.workflow_id = 8;
  await assert.rejects(verifyCandidate(input));
});

for (const change of [
  { sha: "forged" },
  { tree: "other" },
  { version: "0.1.5" },
  { base: "other" },
  { branch: "release-candidate-0.1.4-43" },
  { runId: "43" },
  { runAttempt: 2 },
  { runAttempt: 0 },
  { repository: "fork/repository" },
  { schema: 2 },
]) {
  test(`rejects a forged or mismatched preparation receipt: ${JSON.stringify(change)}`, async () => {
    const input = provenanceFixture();
    Object.assign(input.receipt, change);
    await assert.rejects(verifyCandidate(input));
  });
}

for (const change of [
  { conclusion: "failure" },
  { status: "in_progress" },
  { event: "workflow_dispatch" },
  { path: ".github/workflows/other.yml" },
  { path: ".github/workflows/prepare-release.yml@feature" },
  { path: ".github/workflows/prepare-release.yml@main-other" },
  { path: ".github/workflows/other.yml@main" },
  { workflow_id: 8 },
  { head_branch: "feature" },
  { head_sha: "other" },
  { head_repository: { full_name: "fork/repository" } },
]) {
  test(`rejects an unrelated or unsuccessful preparation attempt: ${JSON.stringify(change)}`, async () => {
    const input = provenanceFixture();
    Object.assign(input.run, change);
    await assert.rejects(verifyCandidate(input));
  });
}

for (const state of ["missing", "expired", "ambiguous", "wrong-run"]) {
  test(`rejects ${state} artifact evidence`, async () => {
    const input = provenanceFixture();
    if (state === "missing") input.artifacts.length = 0;
    if (state === "expired") input.artifacts[0].expired = true;
    if (state === "ambiguous") input.artifacts.push({ ...input.artifacts[0], id: 78 });
    if (state === "wrong-run") input.artifacts[0].workflow_run.id = 43;
    await assert.rejects(candidateArtifact(input));
  });
}

function legacyFixture() {
  const input = provenanceFixture();
  input.context.repo = { owner: "CloudHub-Social", repo: "Charm" };
  input.context.payload.pull_request = mergedPull(
    "release",
    "17cc3908c89e10c167c4fa5f4c8cf69aa4491f89",
  );
  input.context.payload.pull_request.head.repo.full_name = "CloudHub-Social/Charm";
  input.context.payload.pull_request.base.repo.full_name = "CloudHub-Social/Charm";
  return input;
}

test("only the exact reviewed legacy PR541 candidate remains eligible", async () => {
  const input = legacyFixture();
  assert.equal(await candidateArtifact(input), null);
  await verifyCandidate(input);
});

for (const state of [
  "future-pr",
  "changed-head",
  "other-repository",
  "fork",
  "unmerged",
  "wrong-base",
]) {
  test(`legacy compatibility rejects ${state}`, async () => {
    const input = legacyFixture();
    const pull = input.context.payload.pull_request;
    if (state === "future-pr") pull.number = 600;
    if (state === "changed-head") pull.head.sha = "replacement";
    if (state === "other-repository") {
      input.context.repo = { owner: "other", repo: "repository" };
      pull.head.repo.full_name = pull.base.repo.full_name = "other/repository";
    }
    if (state === "fork") pull.head.repo.full_name = "fork/repository";
    if (state === "unmerged") pull.merged = false;
    if (state === "wrong-base") pull.base.ref = "other";
    await assert.rejects(candidateArtifact(input));
    await assert.rejects(verifyCandidate(input));
  });
}

test("the exact legacy candidate cannot publish a different merged version", async () => {
  const input = legacyFixture();
  input.mergeVersion = "0.1.5";
  await assert.rejects(verifyCandidate(input));
});

test("malformed candidate names, forks and mismatched merge versions never qualify", async () => {
  for (const branch of ["release-candidate-fake", "release/0.1.4", "release-candidate-0.1.4-0"]) {
    assert.throws(() => candidateIdentity(branch));
  }
  const input = provenanceFixture();
  input.mergeVersion = "0.1.5";
  await assert.rejects(verifyCandidate(input));
  input.mergeVersion = "0.1.4";
  input.context.payload.pull_request.head.repo.full_name = "fork/repository";
  await assert.rejects(verifyCandidate(input));
});

test("unsigned or changed-parent candidates cannot use an otherwise matching receipt", async () => {
  const input = provenanceFixture();
  input.commit.commit.verification.verified = false;
  await assert.rejects(verifyCandidate(input));
  input.commit.commit.verification.verified = true;
  input.commit.parents[0].sha = "other";
  await assert.rejects(verifyCandidate(input));
});
