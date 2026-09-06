import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

const changesetDirectory = ".changeset";
const expectConsumed = process.argv.includes("--expect-consumed");
let entries = [];
try {
  entries = await readdir(changesetDirectory, { withFileTypes: true });
} catch (error) {
  if (error?.code !== "ENOENT") throw error;
}
const changesetFiles = entries
  .filter((entry) => entry.isFile() && entry.name.endsWith(".md") && entry.name !== "README.md")
  .map((entry) => entry.name)
  .toSorted((left, right) => left.localeCompare(right));

if (expectConsumed) {
  if (changesetFiles.length > 0) {
    throw new Error(
      `Knope left ${changesetFiles.length} changeset(s) unconsumed: ${changesetFiles.join(", ")}`,
    );
  }
  process.exit(0);
}

const invalidFiles = [];
for (const filename of changesetFiles) {
  const contents = await readFile(path.join(changesetDirectory, filename), "utf8");
  const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(contents)?.[1] ?? "";
  const packageLines = frontmatter
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  if (packageLines.length !== 1 || !/^default:\s*(major|minor|patch)$/.test(packageLines[0])) {
    invalidFiles.push(filename);
  }
}

if (invalidFiles.length > 0) {
  throw new Error(
    `Changesets must target Knope's default package with "default: major|minor|patch": ${invalidFiles.join(", ")}`,
  );
}
