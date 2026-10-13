import { execFileSync } from "node:child_process";

function git(...args) {
  return execFileSync("git", args);
}

export async function assertNoRelease({ github, context }) {
  const repo = context.repo;
  const pulls = await github.rest.pulls.list({
    ...repo,
    head: `${repo.owner}:release`,
    state: "open",
  });
  if (pulls.data.length) {
    throw new Error(
      `Release PR #${pulls.data[0].number} already exists; preserve its head and body.`,
    );
  }
  let ref;
  try {
    ref = await github.rest.git.getRef({ ...repo, ref: "heads/release" });
  } catch (error) {
    if (error.status !== 404) throw error;
  }
  if (ref) {
    throw new Error(
      `Release ref ${ref.data.object.sha} already exists; operator review is required.`,
    );
  }
}

export function stagedRelease(base, runGit = git) {
  if (runGit("rev-parse", "HEAD").toString().trim() !== base) {
    throw new Error("Release preparation changed HEAD instead of staging the candidate.");
  }
  if (runGit("diff", "--name-only").toString().trim()) {
    throw new Error("Release candidate has unstaged changes.");
  }
  const entries = runGit("diff", "--cached", "--no-renames", "--name-status", "-z", base)
    .toString()
    .split("\0");
  entries.pop();
  const fileChanges = { additions: [], deletions: [] };
  for (let i = 0; i < entries.length; i += 2) {
    const [status, path] = entries.slice(i, i + 2);
    if (status === "D") fileChanges.deletions.push({ path });
    else if (status === "A" || status === "M") {
      fileChanges.additions.push({ path, contents: runGit("show", `:${path}`).toString("base64") });
    } else throw new Error(`Unsupported release change: ${status}`);
  }
  if (!fileChanges.additions.length) throw new Error("Release candidate is empty.");
  const version = JSON.parse(runGit("show", ":package.json").toString()).version;
  if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error("Expected a stable release version.");
  return { fileChanges, version, tree: runGit("write-tree").toString().trim() };
}

// Initial publication only. Existing release branches, including partial runs,
// require explicit operator reconciliation; this never force-pushes or deletes.
export async function publishRelease({ github, context, candidate = stagedRelease(context.sha) }) {
  const repo = context.repo;
  const base = context.sha;
  await assertNoRelease({ github, context });
  const main = await github.rest.git.getRef({ ...repo, ref: "heads/main" });
  if (main.data.object.sha !== base)
    throw new Error("Main advanced; regenerate from its new head.");
  try {
    await github.rest.git.createRef({ ...repo, ref: "refs/heads/release", sha: base });
    const result = await github.graphql(
      `mutation($input: CreateCommitOnBranchInput!) {
        createCommitOnBranch(input: $input) { commit { oid } }
      }`,
      {
        input: {
          branch: { repositoryNameWithOwner: `${repo.owner}/${repo.repo}`, branchName: "release" },
          expectedHeadOid: base,
          message: { headline: `chore: prepare release ${candidate.version}` },
          fileChanges: candidate.fileChanges,
        },
      },
    );
    const sha = result.createCommitOnBranch.commit.oid;
    const commit = (await github.rest.repos.getCommit({ ...repo, ref: sha })).data;
    const ref = (await github.rest.git.getRef({ ...repo, ref: "heads/release" })).data;
    if (
      !commit.commit.verification.verified ||
      commit.commit.tree.sha !== candidate.tree ||
      commit.parents.length !== 1 ||
      commit.parents[0].sha !== base ||
      ref.object.sha !== sha
    ) {
      throw new Error(
        "Published commit does not match the signed candidate, parent, tree and ref.",
      );
    }
    const pull = await github.rest.pulls.create({
      ...repo,
      head: "release",
      base: "main",
      title: `chore: prepare release ${candidate.version}`,
      draft: true,
      body: `> [!IMPORTANT]\n> Merging this PR will create a new release.\n\nPrepares ${candidate.version}; see CHANGELOG.md for release notes.\n\nGenerated from ${base}. Required checks, release readiness and owner provenance attestation remain pending.`,
    });
    await github.rest.issues.addLabels({
      ...repo,
      issue_number: pull.data.number,
      labels: ["internal"],
    });
    return { sha, url: pull.data.html_url };
  } catch (error) {
    throw new Error(
      "Release ref may contain a partial publication; preserve it for operator review.",
      {
        cause: error,
      },
    );
  }
}
