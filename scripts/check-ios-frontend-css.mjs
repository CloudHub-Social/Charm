import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";

const mode = process.argv[2];
const evidence = ".artifacts/ios/frontend-css.json";
// Assemble the candidate at runtime so this tracked script cannot itself make
// Tailwind emit it. Only the generated file under Cargo's target/ contains it.
const probeValue = "987654321";

if (mode === "prepare") {
  await mkdir("target", { recursive: true });
  const utility = "z-[" + probeValue + "]";
  await writeFile("target/ios-tailwind-probe.html", `<div class="${utility}"></div>\n`);
} else {
  assert.ok(mode === "record" || mode === "compare", "Expected prepare, record or compare");
  const files = (await readdir("dist/assets")).filter((file) => file.endsWith(".css")).sort();
  assert.ok(files.length > 0, "Frontend CSS assets are missing");
  const hashes = {};
  for (const file of files) {
    const contents = await readFile(`dist/assets/${file}`);
    assert.ok(
      !new RegExp(`z-index:\\s*${probeValue}(?:;|})`).test(contents.toString()),
      "Tailwind scanned generated Cargo output",
    );
    hashes[file] = createHash("sha256").update(contents).digest("hex");
  }
  if (mode === "record") {
    await mkdir(".artifacts/ios", { recursive: true });
    await writeFile(evidence, JSON.stringify(hashes, null, 2) + "\n");
  } else {
    assert.deepEqual(
      hashes,
      JSON.parse(await readFile(evidence, "utf8")),
      "Frontend CSS changed after the native simulator build",
    );
  }
  process.stdout.write(
    `iOS frontend CSS ${mode}: ${files.length} assets; generated probe absent\n`,
  );
}
