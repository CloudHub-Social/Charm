import { readFile, writeFile } from "node:fs/promises";

function deriveVersionCode(version) {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(version);

  if (!match) {
    throw new Error(`Cannot derive an Android version code from ${version}`);
  }

  const [, major, minor, patch] = match.map(Number);
  const versionCode = major * 1_000_000 + minor * 1_000 + patch + 1;

  if (!Number.isSafeInteger(versionCode) || versionCode > 2_100_000_000) {
    throw new Error(`Derived Android version code ${versionCode} is invalid`);
  }
  return versionCode;
}

const packageJson = JSON.parse(await readFile("package.json", "utf8"));
const versionCode = deriveVersionCode(packageJson.version);
const tauriConfigPath = "src-tauri/tauri.conf.json";
const tauriConfig = JSON.parse(await readFile(tauriConfigPath, "utf8"));

if (process.argv.includes("--check")) {
  if (tauriConfig.bundle.android.versionCode !== versionCode) {
    throw new Error(
      `Android versionCode ${tauriConfig.bundle.android.versionCode} does not match derived value ${versionCode}`,
    );
  }
  const previousTag = process.env.PREVIOUS_RELEASE_TAG;
  if (previousTag && previousTag !== `v${packageJson.version}`) {
    const previousVersionCode = deriveVersionCode(previousTag.replace(/^v/, ""));
    if (versionCode <= previousVersionCode) {
      throw new Error(
        `Android versionCode ${versionCode} must exceed published ${previousTag} (${previousVersionCode})`,
      );
    }
  }
  process.exit(0);
}

tauriConfig.bundle.android = {
  ...tauriConfig.bundle.android,
  versionCode,
};

await writeFile(tauriConfigPath, `${JSON.stringify(tauriConfig, null, 2)}\n`);
