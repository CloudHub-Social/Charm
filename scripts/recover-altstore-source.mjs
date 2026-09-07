#!/usr/bin/env node

import { readdirSync, readFileSync, writeFileSync } from "node:fs";

const [templatePath, metadataDirectory, releaseAssetsPath, outputPath, downloadBaseURL, date] =
  process.argv.slice(2);

if (
  !templatePath ||
  !metadataDirectory ||
  !releaseAssetsPath ||
  !outputPath ||
  !downloadBaseURL ||
  !date
) {
  throw new Error(
    "usage: recover-altstore-source.mjs <template> <metadata-dir> <release-assets-json> <output> <download-base-url> <date>",
  );
}
if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(date) || Number.isNaN(Date.parse(date))) {
  throw new Error("AltStore recovery date must be a UTC ISO 8601 timestamp");
}
const parsedBaseURL = new URL(downloadBaseURL);
if (parsedBaseURL.protocol !== "https:") {
  throw new Error("AltStore recovery download base URL must use HTTPS");
}

const source = JSON.parse(readFileSync(templatePath, "utf8"));
const app = source.apps?.[0];
if (!app || app.bundleIdentifier !== "social.cloudhub.charm") {
  throw new Error("AltStore template must contain canonical Charm as apps[0]");
}
const releaseAssets = JSON.parse(readFileSync(releaseAssetsPath, "utf8")).assets;
if (!Array.isArray(releaseAssets)) {
  throw new Error("GitHub release asset input must contain an assets array");
}
const assets = new Map(releaseAssets.map(({ name, size }) => [name, size]));
const entries = [];
for (const filename of readdirSync(metadataDirectory)) {
  if (!filename.endsWith(".ipa.build-metadata.txt")) continue;
  const fields = Object.fromEntries(
    readFileSync(`${metadataDirectory}/${filename}`, "utf8")
      .trim()
      .split("\n")
      .map((line) => line.split("=", 2)),
  );
  const asset = fields.asset;
  if (
    !asset ||
    !/^\d+\.\d+\.\d+$/.test(fields.version ?? "") ||
    !/^\d+$/.test(fields.build ?? "") ||
    !assets.has(asset) ||
    ![`${asset}.sha256`, `${asset}.spdx.json`, `${asset}.build-metadata.txt`].every((name) =>
      assets.has(name),
    )
  ) {
    continue;
  }
  entries.push({
    version: fields.version,
    buildVersion: fields.build,
    marketingVersion: `Charm ${fields.version} nightly.${fields.build} (recovered)`,
    date,
    size: assets.get(asset),
    downloadURL: new URL(asset, `${downloadBaseURL}/`).toString(),
    minOSVersion: "15.0",
    localizedDescription:
      "Recovered Personal Team build. Signing is required; killed-state remote push is unavailable.",
  });
}
app.versions = entries
  .sort((left, right) => {
    const leftBuild = BigInt(left.buildVersion);
    const rightBuild = BigInt(right.buildVersion);
    return leftBuild === rightBuild ? 0 : leftBuild > rightBuild ? -1 : 1;
  })
  .slice(0, 3);
writeFileSync(outputPath, `${JSON.stringify(source, null, 2)}\n`);
