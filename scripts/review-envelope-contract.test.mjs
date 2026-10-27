// CI-only contracts for the pinned review action and exact Codex receipt envelope.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
// This checkout is supplied by the contract workflow, not a repository module.
// Fail rather than skipping tests if the runtime dependency is unavailable.
assert.ok(
  process.env.REVIEW_GATE_ROOT,
  "REVIEW_GATE_ROOT must identify the pinned action checkout",
);
const {
  codexInlineParentReviewBodyHasClosedGrammar,
  collectCodexThreadEvidence,
  parseCodexReviewArtifact,
  parseCodexIssueCommentArtifact,
  isCodexCompletionComment,
} = await import(pathToFileURL(resolve(process.env.REVIEW_GATE_ROOT, "src/core.mjs")).href);

const sha = "941a6bb7db01484f8df66a683b78f510d8f74861";
const user = { login: "chatgpt-codex-connector[bot]", type: "Bot" };
const disclosure = (modern) =>
  [
    "<details> <summary>ℹ️ About Codex in GitHub</summary>",
    "<br/>",
    modern
      ? "[Your team has set up Codex to review pull requests in this repo](https://chatgpt.com/codex/cloud/settings/general). Reviews are triggered when you"
      : "Codex has been enabled to automatically review pull requests in this repo. Reviews are triggered when you",
    "- Open a pull request for review",
    "- Mark a draft as ready",
    '- Comment "@codex review".',
    "If Codex has suggestions, it will comment; otherwise it will react with 👍.",
    modern
      ? 'Codex can also answer questions or update the PR. Try commenting "@codex address that feedback".'
      : 'When you [sign up for Codex through ChatGPT](https://openai.com/codex), Codex can also answer questions or update the PR, like "@codex address that feedback".',
    "</details>",
  ].join("\n");
const review = (modern = true) => ({
  id: 123,
  user,
  state: "COMMENTED",
  commit_id: sha,
  submitted_at: "2026-09-04T10:00:00Z",
  body: `### 💡 Codex Review\n\nHere are some automated review suggestions for this pull request.\n\n**Reviewed commit:** \`${sha.slice(0, 10)}\`\n\n${disclosure(modern)}`,
});

test("the production action pin matches the tested fork", async () => {
  const workflow = await readFile(
    new URL("../.github/workflows/codex-review-gate.yml", import.meta.url),
    "utf8",
  );
  assert.match(
    workflow,
    /uses: BTCMedia\/codex-review-gate-action@c3701c29489550dd61c4cea6de906aee92a21b36/,
  );
});

test("both exact disclosure variants are recognized, never clean approval", () => {
  for (const modern of [false, true]) {
    const value = review(modern);
    assert.equal(codexInlineParentReviewBodyHasClosedGrammar(value), true);
    assert.notEqual(
      parseCodexReviewArtifact(value, { owner: "CloudHub-Social", repo: "Charm" })?.kind,
      "clean",
    );
  }
});

test("altered text, mismatched commits and wrong review states fail closed", () => {
  const value = review();
  for (const changed of [
    { ...value, body: value.body + "\nEverything approved" },
    { ...value, body: value.body.replace("chatgpt.com", "example.com") },
    { ...value, commit_id: "a".repeat(40) },
    { ...value, commit_id: sha.slice(0, 10) },
    { ...value, state: "APPROVED" },
  ])
    assert.equal(codexInlineParentReviewBodyHasClosedGrammar(changed), false);
});

test("an envelope without loaded children provides no inline-parent evidence", () => {
  const evidence = collectCodexThreadEvidence([], [review()], [], undefined, sha);
  assert.deepEqual(evidence.validatedCodexInlineParentReviewIds, []);
});

const comment = {
  id: 456,
  node_id: "PRRC_contract",
  user,
  pull_request_review_id: 123,
  original_commit_id: sha,
  path: "src/example.ts",
  line: 1,
};
const thread = {
  id: "PRRT_contract",
  isResolved: false,
  path: "src/example.ts",
  line: 1,
  comments: {
    nodes: [{ id: comment.node_id, databaseId: comment.id, fullDatabaseId: String(comment.id) }],
  },
};

test("unresolved historical inline findings still block", () => {
  const evidence = collectCodexThreadEvidence(
    [comment],
    [review()],
    [thread],
    undefined,
    "b".repeat(40),
  );
  assert.equal(evidence.count, 1);
  assert.deepEqual(evidence.errors, []);
  assert.deepEqual(evidence.transientErrors, []);
});

test("missing children and forged authors cannot validate a parent", () => {
  const missing = collectCodexThreadEvidence([], [review()], [thread], undefined, sha);
  assert.ok(missing.transientErrors.length > 0);
  const forged = collectCodexThreadEvidence(
    [comment],
    [{ ...review(), user: { ...user, type: "User" } }],
    [thread],
    undefined,
    sha,
  );
  assert.ok(forged.errors.length > 0);
  assert.deepEqual(forged.validatedCodexInlineParentReviewIds, []);
});

const receipt = "<!-- codex-review-receipt:v1 -->";
const cleanComment = (prefix = receipt) => ({
  id: 789,
  node_id: "IC_contract",
  user,
  performed_via_github_app: { slug: "chatgpt-codex-connector" },
  created_at: "2026-10-26T23:46:44Z",
  updated_at: "2026-10-26T23:46:44Z",
  body: `${prefix}\n\nCodex Review: Didn't find any major issues. :+1:\n\n**Reviewed commit:** \`${sha.slice(0, 10)}\`\n\n${disclosure(false)}`,
});

test("exact receipt-prefixed clean comments are selected and retain commit identity", () => {
  const value = cleanComment();
  assert.equal(isCodexCompletionComment(value), true);
  const result = parseCodexIssueCommentArtifact(value);
  assert.equal(result.kind, "clean");
  assert.equal(result.commitRef, sha.slice(0, 10));
  assert.equal(
    codexInlineParentReviewBodyHasClosedGrammar({
      ...review(),
      body: `${receipt}\n\n${review().body}`,
    }),
    true,
  );
});

test("receipt envelopes do not relax author, application or closed-content boundaries", () => {
  const value = cleanComment();
  for (const changed of [
    cleanComment("<!-- codex-review-receipt:v2 -->"),
    cleanComment(`${receipt} extra`),
    cleanComment(`${receipt}\n${receipt}`),
    { ...value, user: { ...user, type: "User" } },
    { ...value, performed_via_github_app: { slug: "other" } },
    { ...value, body: value.body + "\n[P1] An unresolved finding" },
    { ...value, body: value.body.replace(sha.slice(0, 10), "not-a-commit") },
  ])
    assert.notEqual(parseCodexIssueCommentArtifact(changed)?.kind, "clean");
});
