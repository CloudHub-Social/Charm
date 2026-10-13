import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const base = process.argv[2];
if (!base) throw new Error("A fetched base revision is required for release validation.");
const previous = JSON.parse(execFileSync("git", ["show", `${base}:package.json`]).toString());
const current = JSON.parse(readFileSync("package.json", "utf8"));

// The merge queue tests the combined tree. A later main changeset must block
// a preserved version bump rather than being shipped with stale release notes.
if (current.version !== previous.version || process.env.CHARM_RELEASE_CANDIDATE === "true") {
  execFileSync(
    process.execPath,
    [
      fileURLToPath(new URL("validate-changeset-packages.mjs", import.meta.url)),
      "--expect-consumed",
    ],
    { stdio: "inherit" },
  );
}
