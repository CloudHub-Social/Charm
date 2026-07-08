#!/usr/bin/env node
import { readdir, stat, writeFile } from "node:fs/promises";
import { dirname, relative, resolve } from "node:path";
import { mkdirSync } from "node:fs";

const title = process.env.SIZE_REPORT_TITLE ?? "Artifact sizes";
const output = process.env.SIZE_REPORT_OUTPUT ?? ".artifacts/artifact-sizes.md";
const maxFilesRaw = process.env.SIZE_REPORT_MAX_FILES ?? "100";
const maxFiles = Number.parseInt(maxFilesRaw, 10);
const roots = (process.env.SIZE_REPORT_PATHS ?? "")
  .split(/\r?\n/)
  .map((value) => value.trim())
  .filter(Boolean);

if (roots.length === 0) {
  throw new Error("SIZE_REPORT_PATHS must contain at least one path");
}
if (!Number.isSafeInteger(maxFiles) || String(maxFiles) !== maxFilesRaw || maxFiles <= 0) {
  throw new Error("SIZE_REPORT_MAX_FILES must be a positive integer");
}

const byteFormatter = new Intl.NumberFormat("en-US");

function humanBytes(bytes) {
  const units = ["B", "KiB", "MiB", "GiB"];
  let value = bytes;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }
  return `${value.toFixed(unitIndex === 0 ? 0 : 2)} ${units[unitIndex]}`;
}

function compareFiles(left, right) {
  return right.bytes - left.bytes || left.path.localeCompare(right.path);
}

function recordFile(topFiles, file) {
  topFiles.push(file);
  topFiles.sort(compareFiles);
  if (topFiles.length > maxFiles) {
    topFiles.pop();
  }
}

async function collectFiles(path, seenFiles, topFiles) {
  let details;
  try {
    details = await stat(path);
  } catch (error) {
    if (error?.code === "ENOENT") {
      return { bytes: 0, count: 0 };
    }
    throw error;
  }

  if (details.isFile()) {
    if (seenFiles.has(path)) {
      return { bytes: 0, count: 0 };
    }
    seenFiles.add(path);
    recordFile(topFiles, { path, bytes: details.size });
    return { bytes: details.size, count: 1 };
  }

  if (!details.isDirectory()) {
    return { bytes: 0, count: 0 };
  }

  const children = await readdir(path);
  let bytes = 0;
  let count = 0;
  for (const child of children) {
    const nested = await collectFiles(resolve(path, child), seenFiles, topFiles);
    bytes += nested.bytes;
    count += nested.count;
  }
  return { bytes, count };
}

const cwd = process.cwd();
const seenFiles = new Set();
const topFiles = [];
let total = 0;
let fileCount = 0;
for (const root of roots) {
  const nested = await collectFiles(resolve(root), seenFiles, topFiles);
  total += nested.bytes;
  fileCount += nested.count;
}

const lines = [
  `### ${title}`,
  "",
  `Total: **${humanBytes(total)}** (${byteFormatter.format(total)} bytes)`,
  "",
];

if (fileCount === 0) {
  lines.push("_No files were found in the configured paths._", "");
} else {
  lines.push("| File | Size | Bytes |", "| --- | ---: | ---: |");
  for (const file of topFiles) {
    const path = relative(cwd, file.path);
    lines.push(`| \`${path}\` | ${humanBytes(file.bytes)} | ${byteFormatter.format(file.bytes)} |`);
  }
  if (fileCount > maxFiles) {
    lines.push(`| _${fileCount - maxFiles} smaller files omitted_ | | |`);
  }
  lines.push("");
}

mkdirSync(dirname(output), { recursive: true });
await writeFile(output, `${lines.join("\n")}\n`);

if (process.env.GITHUB_STEP_SUMMARY) {
  await writeFile(process.env.GITHUB_STEP_SUMMARY, `${lines.join("\n")}\n`, {
    flag: "a",
  });
}
