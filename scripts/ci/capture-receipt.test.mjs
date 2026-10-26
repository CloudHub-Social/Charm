import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createReceipt, verifyReceipt } from "./capture-receipt.mjs";
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
