import { createHash } from "node:crypto";
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
function inventory(dir) {
  const files = {};
  for (const entry of readdirSync(dir, { withFileTypes: true }).toSorted((a, b) =>
    a.name.localeCompare(b.name),
  )) {
    if (entry.name === "capture-receipt.json") continue;
    if (!entry.isFile() || !entry.name.endsWith(".png"))
      throw new Error("Unexpected capture entry");
    files[entry.name] = createHash("sha256")
      .update(readFileSync(path.join(dir, entry.name)))
      .digest("hex");
  }
  if (!Object.keys(files).length) throw new Error("Empty capture inventory");
  return files;
}
export function createReceipt(dir, identity) {
  writeFileSync(
    path.join(dir, "capture-receipt.json"),
    JSON.stringify({ ...identity, files: inventory(dir) }),
  );
}
export function verifyReceipt(dir, identity) {
  const receipt = JSON.parse(readFileSync(path.join(dir, "capture-receipt.json"), "utf8"));
  for (const [key, value] of Object.entries(identity))
    if (receipt[key] !== value) throw new Error(`Capture ${key} mismatch`);
  if (JSON.stringify(receipt.files) !== JSON.stringify(inventory(dir)))
    throw new Error("Capture inventory mismatch");
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [operation, dir, suite] = process.argv.slice(2);
  const identity = {
    repository: process.env.GITHUB_REPOSITORY,
    sha: process.env.GITHUB_SHA,
    run: process.env.GITHUB_RUN_ID,
    attempt: process.env.GITHUB_RUN_ATTEMPT,
    suite,
  };
  if (Object.values(identity).some((value) => !value)) throw new Error("Missing capture identity");
  if (operation === "create") createReceipt(dir, identity);
  else if (operation === "verify") verifyReceipt(dir, identity);
  else throw new Error("Unknown capture operation");
}
