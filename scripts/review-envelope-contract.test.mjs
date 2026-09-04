// CI-only contract for upstream JoeyTeng/codex-review-gate-action#6.
// The pinned Apache-2.0 fork changes only the exact disclosure allowlist.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  codexInlineParentReviewBodyHasClosedGrammar,
  collectCodexThreadEvidence,
  parseCodexReviewArtifact,
} from "../.review-gate-contract/src/core.mjs";

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
    /uses: BTCMedia\/codex-review-gate-action@3b7ee46126a75b05eaf537247254eea682ce5787/,
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
