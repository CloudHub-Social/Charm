const candidatePattern = /^release-candidate-(\d+\.\d+\.\d+)-([1-9]\d*)$/;

export function candidateIdentity(branch) {
  const match = candidatePattern.exec(branch);
  if (!match) throw new Error("Invalid release candidate branch.");
  return { version: match[1], runId: match[2] };
}

export function candidateBranch(version, runId) {
  const branch = `release-candidate-${version}-${runId}`;
  candidateIdentity(branch);
  return branch;
}

export function isReleaseBranch(branch) {
  return branch === "release" || branch.startsWith("release-candidate-");
}

function releasePull(context) {
  const pull = context.payload.pull_request;
  const repository = `${context.repo.owner}/${context.repo.repo}`;
  if (
    !pull?.merged ||
    pull.head.repo?.full_name !== repository ||
    pull.base.repo?.full_name !== repository ||
    pull.base.ref !== "main"
  ) {
    throw new Error("Only a merged, same-repository release PR into main is eligible.");
  }
  return pull;
}

// Discover the artifact with read-only credentials. A branch name, PR body or
// signed commit alone is not evidence that the preparation workflow produced it.
export async function candidateArtifact({ github, context }) {
  const pull = releasePull(context);
  if (pull.head.ref === "release") return null; // Existing PR541 contract.
  const { runId } = candidateIdentity(pull.head.ref);
  const artifacts = await github.paginate(github.rest.actions.listWorkflowRunArtifacts, {
    ...context.repo,
    run_id: runId,
    per_page: 100,
  });
  const matches = artifacts.filter((item) => item.name === `release-candidate-${runId}`);
  if (
    matches.length !== 1 ||
    matches[0].expired ||
    String(matches[0].workflow_run?.id) !== runId ||
    !Number.isSafeInteger(matches[0].id)
  ) {
    throw new Error("Release candidate receipt is missing, expired or ambiguous.");
  }
  return { artifactId: matches[0].id, runId };
}

// The receipt is downloaded by artifact ID from the run encoded in the branch.
// Validate the originating attempt: a later failed rerun must not invalidate a
// receipt from a successful attempt, and may not replace that immutable receipt.
export async function verifyCandidate({ github, context, receipt, mergeVersion }) {
  const pull = releasePull(context);
  if (pull.head.ref === "release") return; // Do not strand the legacy candidate.
  const { version, runId } = candidateIdentity(pull.head.ref);
  const repository = `${context.repo.owner}/${context.repo.repo}`;
  if (
    receipt?.schema !== 1 ||
    receipt.repository !== repository ||
    receipt.branch !== pull.head.ref ||
    receipt.version !== version ||
    receipt.sha !== pull.head.sha ||
    receipt.runId !== runId ||
    !Number.isSafeInteger(receipt.runAttempt) ||
    receipt.runAttempt < 1 ||
    mergeVersion !== version
  ) {
    throw new Error("Release candidate receipt does not match the merged PR and version.");
  }
  const workflow = (
    await github.rest.actions.getWorkflow({
      ...context.repo,
      workflow_id: "prepare-release.yml",
    })
  ).data;
  const run = (
    await github.rest.actions.getWorkflowRunAttempt({
      ...context.repo,
      run_id: runId,
      attempt_number: receipt.runAttempt,
    })
  ).data;
  if (
    String(run.id) !== runId ||
    run.run_attempt !== receipt.runAttempt ||
    run.workflow_id !== workflow.id ||
    run.path !== ".github/workflows/prepare-release.yml" ||
    run.event !== "push" ||
    run.head_branch !== "main" ||
    run.repository?.full_name !== repository ||
    run.head_repository?.full_name !== repository ||
    run.head_sha !== receipt.base ||
    run.status !== "completed" ||
    run.conclusion !== "success"
  ) {
    throw new Error("Receipt did not originate in a successful main preparation attempt.");
  }
  const commit = (await github.rest.repos.getCommit({ ...context.repo, ref: pull.head.sha })).data;
  if (
    !commit.commit.verification.verified ||
    commit.commit.tree.sha !== receipt.tree ||
    commit.parents.length !== 1 ||
    commit.parents[0].sha !== receipt.base
  ) {
    throw new Error("Candidate commit does not match its signed preparation receipt.");
  }
}
