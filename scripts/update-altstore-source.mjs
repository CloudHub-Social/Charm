#!/usr/bin/env node

import { readFileSync, writeFileSync } from "node:fs";

const [
  templatePath,
  outputPath,
  version,
  buildVersion,
  sizeText,
  downloadURL,
  date,
  marketingVersion,
] = process.argv.slice(2);

if (
  !templatePath ||
  !outputPath ||
  !version ||
  !buildVersion ||
  !sizeText ||
  !downloadURL ||
  !date ||
  !marketingVersion
) {
  throw new Error(
    "usage: update-altstore-source.mjs <template> <output> <version> <build> <size> <download-url> <date> <marketing-version>",
  );
}
if (!/^\d+\.\d+\.\d+$/.test(version)) {
  throw new Error("AltStore version must match the three-component Apple short version");
}
if (!/^\d+$/.test(buildVersion) || BigInt(buildVersion) < 1n) {
  throw new Error("AltStore buildVersion must be a positive numeric Apple bundle version");
}
const size = Number(sizeText);
if (!Number.isSafeInteger(size) || size < 1) {
  throw new Error("AltStore IPA size must be a positive safe integer");
}
if (!URL.canParse(downloadURL) || Number.isNaN(Date.parse(date))) {
  throw new Error("AltStore download URL and release date must be valid ISO 8601 values");
}

const source = JSON.parse(readFileSync(templatePath, "utf8"));
const app = source.apps?.[0];
if (!app || app.bundleIdentifier !== "social.cloudhub.charm") {
  throw new Error("AltStore template must contain canonical Charm as apps[0]");
}
if (app.appPermissions?.entitlements?.length !== 0) {
  throw new Error("Personal Team sideload source must not advertise unsupported entitlements");
}

const entry = {
  version,
  buildVersion,
  marketingVersion,
  date,
  size,
  downloadURL,
  minOSVersion: "15.0",
  localizedDescription: `${marketingVersion}. Personal Team signing is required; killed-state remote push is unavailable.`,
};
const current = Array.isArray(app.versions) ? app.versions : [];
const remaining = current.filter((candidate) => candidate.buildVersion !== buildVersion);
app.versions = [entry, ...remaining].slice(0, 3);

writeFileSync(outputPath, `${JSON.stringify(source, null, 2)}\n`);
