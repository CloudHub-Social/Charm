import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const errors = [];
const requiredLicensingFiles = ["LICENSE", "NOTICE", "LICENSING.md", "THIRD_PARTY_NOTICES.md"];

function read(relativePath) {
  return readFileSync(path.join(repositoryRoot, relativePath), "utf8");
}

function stripPackagingComments(content, relativePath) {
  const withoutCommentLines = content.replace(/^\s*(?:#|\/\/|@?rem\b).*$/gim, "");
  if (!/\.[cm]?[jt]sx?$/i.test(relativePath)) return withoutCommentLines;

  const languageVariant = /x$/i.test(relativePath)
    ? ts.LanguageVariant.JSX
    : ts.LanguageVariant.Standard;
  const scanner = ts.createScanner(
    ts.ScriptTarget.Latest,
    false,
    languageVariant,
    withoutCommentLines,
  );
  let executableContent = "";

  for (let token = scanner.scan(); token !== ts.SyntaxKind.EndOfFileToken; token = scanner.scan()) {
    if (
      token !== ts.SyntaxKind.SingleLineCommentTrivia &&
      token !== ts.SyntaxKind.MultiLineCommentTrivia
    ) {
      executableContent += scanner.getTokenText();
    }
  }

  return executableContent;
}

function requirePackagedLicensingFiles(relativePath, destination) {
  const packagingLines = stripPackagingComments(read(relativePath), relativePath).split("\n");

  for (const requiredFile of requiredLicensingFiles) {
    const isPackaged = packagingLines.some(
      (line) =>
        /\b(?:copy|cp|install)\b/i.test(line) &&
        line.includes(requiredFile) &&
        line.includes(destination),
    );
    if (!isPackaged) {
      errors.push(`${relativePath} must package ${requiredFile} into ${destination}.`);
    }
  }
}

for (const requiredFile of requiredLicensingFiles) {
  if (!existsSync(path.join(repositoryRoot, requiredFile))) {
    errors.push(`Missing required licensing file: ${requiredFile}`);
  }
}

requirePackagedLicensingFiles(".github/actions/build-web-worker/action.yml", "dist/");
requirePackagedLicensingFiles("crates/charm-web-server/Dockerfile", "/usr/share/doc/charm/");

for (const manifestPath of ["package.json", "docs-site/package.json"]) {
  const manifest = JSON.parse(read(manifestPath));
  if (manifest.license !== "Apache-2.0") {
    errors.push(`${manifestPath} must declare license "Apache-2.0".`);
  }
}

for (const manifestPath of ["src-tauri/Cargo.toml", "crates/charm-web-server/Cargo.toml"]) {
  const packageSection = read(manifestPath).split(/^\[dependencies\]$/m, 1)[0];
  if (!/^license\s*=\s*"Apache-2\.0"\s*$/m.test(packageSection)) {
    errors.push(`${manifestPath} must declare license = "Apache-2.0" in [package].`);
  }
}

const tauriConfig = JSON.parse(read("src-tauri/tauri.conf.json"));
if (tauriConfig.bundle?.license !== "Apache-2.0") {
  errors.push('src-tauri/tauri.conf.json must declare bundle.license "Apache-2.0".');
}
if (tauriConfig.bundle?.licenseFile !== "../LICENSE") {
  errors.push('src-tauri/tauri.conf.json must package "../LICENSE" as bundle.licenseFile.');
}
for (const noticePath of ["../NOTICE", "../LICENSING.md", "../THIRD_PARTY_NOTICES.md"]) {
  if (!tauriConfig.bundle?.resources?.includes(noticePath)) {
    errors.push(`src-tauri/tauri.conf.json must package ${noticePath}.`);
  }
}
if (/sable[-_ ]?call/i.test(JSON.stringify(tauriConfig.bundle))) {
  errors.push("src-tauri/tauri.conf.json bundle configuration cannot reference Sable Call.");
}

const trackedFilesResult = spawnSync("git", ["ls-files", "-z"], {
  cwd: repositoryRoot,
  encoding: "utf8",
});
if (trackedFilesResult.status !== 0) {
  errors.push(`Unable to inspect tracked files: ${trackedFilesResult.stderr.trim()}`);
}

const trackedFiles =
  trackedFilesResult.status === 0 ? trackedFilesResult.stdout.split("\0").filter(Boolean) : [];
const dependencySections = [
  "dependencies",
  "devDependencies",
  "peerDependencies",
  "optionalDependencies",
];
const forbiddenSource = /SableClient\/SableCall|@sableclient\/sable-call/i;
const packagingInputPatterns = [
  /^\.github\/(?:actions|scripts|workflows)\//i,
  /^(?:scripts)\//i,
  /(?:^|\/)(?:package\.json|pnpm-lock\.yaml|Cargo\.toml|Cargo\.lock)$/,
  /^src-tauri\/tauri\.conf\.json$/,
  /(?:^|\/)(?:vite|rollup|astro)\.config\.[cm]?[jt]s$/i,
  /(?:^|\/)(?:build\.rs|Makefile|Justfile)$/i,
  /(?:^|\/)gradlew(?:\.bat)?$/i,
  /(?:^|\/)gradle\/wrapper\/gradle-wrapper\.properties$/i,
  /(?:^|\/)(?:(?:Dockerfile|Containerfile)(?:\.[^/]+)?|(?:docker-)?compose(?:\.[^/]+)?\.ya?ml|docker-bake\.(?:hcl|json))$/i,
  /^src-tauri\/gen\/apple\/(?:Podfile|project\.yml|.+\.xcodeproj\/project\.pbxproj)$/i,
  /^src-tauri\/gen\/android\/(?:(?:.+\/)?(?:build|settings)\.gradle(?:\.kts)?|gradle\.properties|buildSrc\/src\/.+\.(?:java|kt|kts))$/i,
];
const bundledAssetPatterns = [
  /(?:^|\/)(?:public|src\/assets|src-tauri\/resources|vendor|third[_-]party|embedded)\//i,
  /^src-tauri\/gen\/apple\/(?:assets|Assets\.xcassets)\//i,
  /^src-tauri\/gen\/android\/app\/src\/main\/(?:assets|res|resources)\//i,
];
const sableCallName = /sable[-_ ]?call/i;

for (const trackedFile of trackedFiles) {
  const isBundledAsset = bundledAssetPatterns.some((pattern) => pattern.test(trackedFile));
  if (isBundledAsset) {
    const containsForbiddenSource = forbiddenSource.test(read(trackedFile));
    if (sableCallName.test(trackedFile) || containsForbiddenSource) {
      errors.push(`Sable Call material cannot be stored in a packaged asset: ${trackedFile}`);
    }
  }

  if (trackedFile.endsWith("package.json")) {
    const manifest = JSON.parse(read(trackedFile));
    for (const section of dependencySections) {
      for (const [name, source] of Object.entries(manifest[section] ?? {})) {
        if (sableCallName.test(name) || forbiddenSource.test(String(source))) {
          errors.push(
            `Sable Call cannot be a bundled dependency: ${trackedFile} ${section}.${name}`,
          );
        }
      }
    }
  }

  const isPackagingInput = packagingInputPatterns.some((pattern) => pattern.test(trackedFile));
  if (trackedFile !== "scripts/check-license-boundaries.mjs" && isPackagingInput) {
    const packagingContent = read(trackedFile);
    const executablePackagingContent = stripPackagingComments(packagingContent, trackedFile);
    const referencesSableCall =
      forbiddenSource.test(executablePackagingContent) ||
      sableCallName.test(executablePackagingContent);
    if (referencesSableCall) {
      errors.push(`Packaging and build inputs cannot fetch Sable Call: ${trackedFile}`);
    }
  }
}

if (errors.length > 0) {
  for (const error of errors) console.error(`license-boundary: ${error}`);
  process.exit(1);
}

process.stdout.write("License files and external Sable Call boundary are intact.\n");
