import { readFile, writeFile } from "node:fs/promises";

const packageJson = JSON.parse(await readFile("package.json", "utf8"));
const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(packageJson.version);

if (!match) {
  throw new Error(`Cannot derive an Android version code from ${packageJson.version}`);
}

const [, major, minor, patch] = match.map(Number);
const versionCode = major * 1_000_000 + minor * 1_000 + patch + 1;

if (!Number.isSafeInteger(versionCode) || versionCode > 2_100_000_000) {
  throw new Error(`Derived Android version code ${versionCode} is invalid`);
}

const tauriConfigPath = "src-tauri/tauri.conf.json";
const tauriConfig = JSON.parse(await readFile(tauriConfigPath, "utf8"));
tauriConfig.bundle.android = {
  ...tauriConfig.bundle.android,
  versionCode,
};

await writeFile(tauriConfigPath, `${JSON.stringify(tauriConfig, null, 2)}\n`);
