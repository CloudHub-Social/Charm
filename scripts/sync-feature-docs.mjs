import { access, copyFile, mkdir, readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const mode = args.includes("--write") ? "write" : args.includes("--check") ? "check" : "validate";

function option(name, fallback) {
  const index = args.indexOf(name);
  return index === -1 ? fallback : path.resolve(repoRoot, args[index + 1]);
}

const manifestPath = option(
  "--manifest",
  path.join(repoRoot, "docs-site/src/data/feature-gallery.json"),
);
const targetDir = option("--target-dir", path.join(repoRoot, "docs-site/public/features"));
const snapshotRoot = option(
  "--e2e-dir",
  process.env.FEATURE_DOC_E2E_DIR
    ? path.resolve(repoRoot, process.env.FEATURE_DOC_E2E_DIR)
    : path.join(repoRoot, ".artifacts/sentry-e2e-snapshots"),
);
const flagCatalogPath = path.join(repoRoot, "src-tauri/src/bindings/featureFlagCatalog.json");

const errors = [];
const noteError = (message) => errors.push(message);
const exists = async (filePath) =>
  access(filePath)
    .then(() => true)
    .catch(() => false);

const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
const flagCatalog = JSON.parse(await readFile(flagCatalogPath, "utf8"));

if (manifest.schemaVersion !== 1) noteError("feature gallery schemaVersion must be 1");
if (!Array.isArray(manifest.features) || manifest.features.length === 0) {
  noteError("feature gallery must contain at least one feature");
}

const excludedFlags = new Set(manifest.excludedFlags ?? []);
const knownFlags = new Set(flagCatalog.map(({ key }) => key));
const documentedFlags = new Set();
const slugs = new Set();
const targets = new Set();

for (const feature of manifest.features ?? []) {
  if (!feature.slug || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(feature.slug)) {
    noteError(`invalid feature slug: ${JSON.stringify(feature.slug)}`);
    continue;
  }
  if (slugs.has(feature.slug)) noteError(`duplicate feature slug: ${feature.slug}`);
  slugs.add(feature.slug);

  for (const field of ["title", "summary", "status", "spec"]) {
    if (typeof feature[field] !== "string" || feature[field].trim() === "") {
      noteError(`${feature.slug}: ${field} must be a non-empty string`);
    }
  }
  if (!new Set(["stable", "preview"]).has(feature.status)) {
    noteError(`${feature.slug}: status must be stable or preview`);
  }
  if (feature.flag) {
    if (!knownFlags.has(feature.flag)) noteError(`${feature.slug}: unknown flag ${feature.flag}`);
    documentedFlags.add(feature.flag);
  }

  const snapshot = feature.snapshot;
  if (!snapshot || snapshot.suite !== "e2e") {
    noteError(`${feature.slug}: public feature documentation must use an e2e snapshot`);
    continue;
  }
  if (!snapshot.name || !/^[a-z0-9]+(?:[a-z0-9-]*[a-z0-9])?$/.test(snapshot.name)) {
    noteError(`${feature.slug}: invalid snapshot name ${JSON.stringify(snapshot.name)}`);
    continue;
  }
  if (!snapshot.alt || !snapshot.caption) {
    noteError(`${feature.slug}: snapshot alt and caption are required`);
  }

  const target = path.join(targetDir, `${feature.slug}.png`);
  targets.add(`${feature.slug}.png`);

  if (mode === "validate") {
    if (!(await exists(target))) noteError(`${feature.slug}: missing committed image ${target}`);
    continue;
  }

  const source = path.join(snapshotRoot, `${snapshot.name}.png`);
  if (!(await exists(source))) {
    noteError(`${feature.slug}: missing e2e snapshot ${source}`);
    continue;
  }

  if (mode === "write") {
    await mkdir(targetDir, { recursive: true });
    await copyFile(source, target);
    process.stdout.write(`updated ${path.relative(repoRoot, target)} from e2e/${snapshot.name}\n`);
    continue;
  }

  if (!(await exists(target))) {
    noteError(`${feature.slug}: missing committed image ${target}`);
    continue;
  }
  // Pixel-level drift is checked by e2e/feature-docs-current.spec.ts. Keeping
  // source/target discovery here lets this dependency-free script remain the
  // single validator and sync entry point without making transient SVG
  // antialiasing a byte-for-byte failure.
}

for (const { key } of flagCatalog) {
  if (!excludedFlags.has(key) && !documentedFlags.has(key)) {
    noteError(`feature flag ${key} has no public feature-gallery entry`);
  }
}
for (const key of excludedFlags) {
  if (!knownFlags.has(key)) noteError(`excluded flag ${key} is not in the Rust catalog`);
}

if (await exists(targetDir)) {
  const committedPngs = (await readdir(targetDir)).filter((name) => name.endsWith(".png"));
  for (const name of committedPngs) {
    if (!targets.has(name)) noteError(`orphaned feature image: ${path.join(targetDir, name)}`);
  }
}

if (errors.length > 0) {
  for (const error of errors) {
    console.error(
      process.env.GITHUB_ACTIONS ? `::error title=Feature docs::${error}` : `- ${error}`,
    );
  }
  process.exitCode = 1;
} else {
  process.stdout.write(
    `${mode === "check" ? "checked" : mode === "write" ? "synced" : "validated"} ${manifest.features.length} feature entries and ${documentedFlags.size} public feature flags\n`,
  );
}
