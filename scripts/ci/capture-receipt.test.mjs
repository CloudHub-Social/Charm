import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { captureIdentity, createReceipt, verifyReceipt } from "./capture-receipt.mjs";
const identity = {
  repository: "CloudHub-Social/Charm",
  sha: "a".repeat(40),
  run: "123",
  attempt: "2",
  suite: "e2e",
};
test("same-run complete artifacts verify; identity and content drift reject", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "capture-"));
  try {
    assert.throws(() => createReceipt(dir, identity), /empty/i);
    writeFileSync(path.join(dir, "one.png"), "fixture");
    createReceipt(dir, identity);
    assert.doesNotThrow(() => verifyReceipt(dir, identity));
    for (const key of Object.keys(identity))
      assert.throws(() => verifyReceipt(dir, { ...identity, [key]: "other" }));
    writeFileSync(path.join(dir, "one.png"), "changed");
    assert.throws(() => verifyReceipt(dir, identity));
    writeFileSync(path.join(dir, "one.png"), "fixture");
    writeFileSync(path.join(dir, "extra.png"), "extra");
    assert.throws(() => verifyReceipt(dir, identity));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("partial reruns retain the successful producer attempt within the same run", () => {
  const env = {
    GITHUB_REPOSITORY: identity.repository,
    GITHUB_SHA: identity.sha,
    GITHUB_RUN_ID: identity.run,
    GITHUB_RUN_ATTEMPT: "3",
    CAPTURE_ATTEMPT: "2",
  };
  assert.deepEqual(captureIdentity(env, "e2e"), identity);
  for (const attempt of ["", "0", "4", "02", "other"])
    assert.throws(() => captureIdentity({ ...env, CAPTURE_ATTEMPT: attempt }, "e2e"));
  const { CAPTURE_ATTEMPT, ...producerEnv } = env;
  assert.equal(CAPTURE_ATTEMPT, "2");
  assert.equal(captureIdentity(producerEnv, "e2e").attempt, "3");
});
