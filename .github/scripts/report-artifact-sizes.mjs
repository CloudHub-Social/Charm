#!/usr/bin/env node
import { readdir, stat, writeFile } from "node:fs/promises";
import { dirname, relative, resolve } from "node:path";
import { mkdirSync } from "node:fs";

const title = process.env.SIZE_REPORT_TITLE ?? "Artifact sizes";
const output = process.env.SIZE_REPORT_OUTPUT ?? ".artifacts/artifact-sizes.md";
const maxFiles = Number.parseInt(process.env.SIZE_REPORT_MAX_FILES ?? "100", 10);
const roots = (process.env.SIZE_REPORT_PATHS ?? "")
  .split(/\r?\n/)
  .map((value) => value.trim())
  .filter(Boolean);

if (roots.length === 0) {
  throw new Error("SIZE_REPORT_PATHS must contain at least one path");
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

async function collectFiles(path) {
  let details;
  try {
    details = await stat(path);
  } catch (error) {
    if (error?.code === "ENOENT") {
      return [];
    }
    throw error;
  }

  if (details.isFile()) {
    return [{ path, bytes: details.size }];
  }

  if (!details.isDirectory()) {
    return [];
  }

  const children = await readdir(path);
  const nested = await Promise.all(children.map((child) => collectFiles(resolve(path, child))));
  return nested.flat();
}

const cwd = process.cwd();
const files = (await Promise.all(roots.map((root) => collectFiles(resolve(root)))))
  .flat()
  .toSorted((a, b) => b.bytes - a.bytes || a.path.localeCompare(b.path));

const total = files.reduce((sum, file) => sum + file.bytes, 0);
const lines = [
  `### ${title}`,
  "",
  `Total: **${humanBytes(total)}** (${byteFormatter.format(total)} bytes)`,
  "",
];

if (files.length === 0) {
  lines.push("_No files were found in the configured paths._", "");
} else {
  lines.push("| File | Size | Bytes |", "| --- | ---: | ---: |");
  for (const file of files.slice(0, maxFiles)) {
    const path = relative(cwd, file.path);
    lines.push(`| \`${path}\` | ${humanBytes(file.bytes)} | ${byteFormatter.format(file.bytes)} |`);
  }
  if (files.length > maxFiles) {
    lines.push(`| _${files.length - maxFiles} smaller files omitted_ | | |`);
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
