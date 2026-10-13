import { execFileSync } from "node:child_process";
import { candidateBranch, candidateIdentity, isReleaseBranch } from "./release-candidate.mjs";

function git(...args) {
  return execFileSync("git", args);
}

export async function assertNoRelease({ github, context }) {
  const repo = context.repo;
  const repository = `${repo.owner}/${repo.repo}`;
  const pulls = await github.paginate(github.rest.pulls.list, {
    ...repo,
    state: "all",
    per_page: 100,
  });
  const related = pulls.filter(
    (pull) =>
      isReleaseBranch(pull.head.ref) &&
      (!pull.head.repo || pull.head.repo.full_name === repository),
  );
  if (related.some((pull) => !pull.head.repo || pull.state === "open")) {
    throw new Error("Existing open or ambiguous release PR; preserve its head and body.");
  }
  const refs = await github.paginate(github.rest.git.listMatchingRefs, {
    ...repo,
    ref: "heads/release",
    per_page: 100,
  });
  for (const ref of refs) {
    const branch = ref.ref.replace(/^refs\/heads\//, "");
    if (!isReleaseBranch(branch)) continue;
    if (branch !== "release") candidateIdentity(branch);
    const latest = related
      .filter((pull) => pull.head.ref === branch)
      .sort((a, b) => b.number - a.number)[0];
    if (!latest) throw new Error("Partial release ref requires operator reconciliation.");
    const pull = (await github.rest.pulls.get({ ...repo, pull_number: latest.number })).data;
    if (
      !pull.merged ||
      pull.state !== "closed" ||
      pull.head.repo?.full_name !== repository ||
      pull.head.ref !== branch ||
      pull.base.repo?.full_name !== repository ||
      pull.base.ref !== "main" ||
      pull.head.sha !== ref.object.sha
    ) {
      throw new Error("Unmerged or advanced release ref requires operator reconciliation.");
    }
    // Conclusively merged and unchanged: leave the old ref intact. Unique new
    // refs avoid deleting a branch if another actor opens a PR after this read.
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

// Create-only publication. Existing work is never deleted or overwritten;
// partial runs and collisions require explicit operator reconciliation.
export async function publishRelease({
  github,
  context,
  candidate = stagedRelease(context.sha),
  runAttempt = Number(process.env.GITHUB_RUN_ATTEMPT),
  warn = console.warn,
}) {
  const repo = context.repo;
  const base = context.sha;
  const runId = String(context.runId);
  if (!Number.isSafeInteger(runAttempt) || runAttempt < 1) {
    throw new Error("A valid workflow run attempt is required.");
  }
  const branch = candidateBranch(candidate.version, runId);
  await assertNoRelease({ github, context });
  const main = await github.rest.git.getRef({ ...repo, ref: "heads/main" });
  if (main.data.object.sha !== base)
    throw new Error("Main advanced; regenerate from its new head.");
  try {
    await github.rest.git.createRef({ ...repo, ref: `refs/heads/${branch}`, sha: base });
    const result = await github.graphql(
      `mutation($input: CreateCommitOnBranchInput!) {
        createCommitOnBranch(input: $input) { commit { oid } }
      }`,
      {
        input: {
          branch: { repositoryNameWithOwner: `${repo.owner}/${repo.repo}`, branchName: branch },
          expectedHeadOid: base,
          message: { headline: `chore: prepare release ${candidate.version}` },
          fileChanges: candidate.fileChanges,
        },
      },
    );
    const sha = result.createCommitOnBranch.commit.oid;
    const commit = (await github.rest.repos.getCommit({ ...repo, ref: sha })).data;
    const ref = (await github.rest.git.getRef({ ...repo, ref: `heads/${branch}` })).data;
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
      head: branch,
      base: "main",
      title: `chore: prepare release ${candidate.version}`,
      draft: true,
      body: `> [!IMPORTANT]\n> Merging this PR will create a new release.\n\nPrepares ${candidate.version}; see CHANGELOG.md for release notes.\n\nGenerated from ${base}. Required checks, release readiness and owner provenance attestation remain pending.`,
    });
    try {
      await github.rest.issues.addLabels({
        ...repo,
        issue_number: pull.data.number,
        labels: ["internal"],
      });
    } catch {
      // Metadata is repairable without changing candidate identity. Do not lose
      // the verified receipt merely because labeling is temporarily unavailable.
      warn(`Could not label release PR #${pull.data.number}; reconcile its internal label.`);
    }
    return {
      sha,
      url: pull.data.html_url,
      receipt: {
        schema: 1,
        repository: `${repo.owner}/${repo.repo}`,
        branch,
        version: candidate.version,
        base,
        sha,
        tree: candidate.tree,
        runId,
        runAttempt,
      },
    };
  } catch (error) {
    throw new Error(
      "Release ref may contain a partial publication; preserve it for operator review.",
      {
        cause: error,
      },
    );
  }
}
