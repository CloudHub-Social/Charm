import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const script = fileURLToPath(new URL("./sync-android-version-code.mjs", import.meta.url));

async function fixture(t, versionCode) {
  const cwd = await mkdtemp(join(tmpdir(), "charm-android-version-"));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  await mkdir(join(cwd, "src-tauri"));
  await writeFile(join(cwd, "package.json"), JSON.stringify({ version: "0.1.4" }));
  const configPath = join(cwd, "src-tauri/tauri.conf.json");
  const config = { version: "0.1.4", bundle: { android: { versionCode, minSdkVersion: 24 } } };
  await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`);
  return { cwd, configPath, config };
}

function run(cwd, args, previousTag = "") {
  return spawnSync(process.execPath, [script, ...args], {
    cwd,
    encoding: "utf8",
    env: { ...process.env, PREVIOUS_RELEASE_TAG: previousTag },
  });
}

test("check rejects the stale 0.1.3 code after a 0.1.4 version bump without writing", async (t) => {
  const { cwd, configPath } = await fixture(t, 1004);
  const before = await readFile(configPath, "utf8");
  const result = run(cwd, ["--check"]);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Android versionCode 1004 does not match derived value 1005/);
  assert.equal(await readFile(configPath, "utf8"), before);
});

test("sync repairs the release code and preserves other Android settings", async (t) => {
  const { cwd, configPath, config } = await fixture(t, 1004);
  const result = run(cwd, ["0.1.4"]);
  assert.equal(result.status, 0, result.stderr);
  config.bundle.android.versionCode = 1005;
  assert.deepEqual(JSON.parse(await readFile(configPath, "utf8")), config);
  const check = run(cwd, ["--check"], "v0.1.3");
  assert.equal(check.status, 0, check.stderr);
});

test("check rejects a version older than the published release", async (t) => {
  const { cwd } = await fixture(t, 1005);
  const result = run(cwd, ["--check"], "v0.1.5");
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Android versionCode 1005 must exceed published v0.1.5 \(1006\)/);
});
