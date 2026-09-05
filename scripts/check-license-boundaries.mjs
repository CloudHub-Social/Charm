import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { LanguageVariant, SyntaxKind } from "typescript/unstable/ast";
import { createScanner } from "typescript/unstable/ast/scanner";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const checkerRelativePath = path.relative(repositoryRoot, fileURLToPath(import.meta.url));
const errors = [];
const requiredLicensingFiles = ["LICENSE", "NOTICE", "LICENSING.md", "THIRD_PARTY_NOTICES.md"];
const canonicalLicenseFiles = [
  "scripts/license-texts/MPL-2.0.txt",
  "scripts/license-texts/GPL-3.0.txt",
  "scripts/license-texts/LGPL-3.0-or-later.txt",
];
const generatedThirdPartyLicenses = "THIRD_PARTY_LICENSES.txt";

function read(relativePath) {
  return readFileSync(path.join(repositoryRoot, relativePath), "utf8");
}

function stripPackagingComments(content, relativePath) {
  if (!/\.[cm]?[jt]sx?$/i.test(relativePath)) {
    return content.replace(/^\s*(?:#|\/\/|@?rem\b).*$/gim, "");
  }

  const languageVariant = /x$/i.test(relativePath) ? LanguageVariant.JSX : LanguageVariant.Standard;
  const scanner = createScanner(true, languageVariant, content);
  const executableTokens = [];

  for (let token = scanner.scan(); token !== SyntaxKind.EndOfFile; token = scanner.scan()) {
    executableTokens.push(scanner.getTokenText());
  }

  return executableTokens.join("");
}

function requirePackagedFiles(relativePath, destination, requiredFiles) {
  const packagingLines = stripPackagingComments(read(relativePath), relativePath).split("\n");

  for (const requiredFile of requiredFiles) {
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
for (const canonicalLicenseFile of canonicalLicenseFiles) {
  if (!existsSync(path.join(repositoryRoot, canonicalLicenseFile))) {
    errors.push(`Missing canonical dependency license text: ${canonicalLicenseFile}`);
  }
}

requirePackagedFiles(
  ".github/actions/build-web-worker/action.yml",
  "dist/",
  requiredLicensingFiles,
);
requirePackagedFiles("crates/charm-web-server/Dockerfile", "/usr/share/doc/charm/", [
  ...requiredLicensingFiles,
  generatedThirdPartyLicenses,
]);

for (const manifestPath of ["package.json", "docs-site/package.json"]) {
  const manifest = JSON.parse(read(manifestPath));
  if (manifest.license !== "Apache-2.0") {
    errors.push(`${manifestPath} must declare license "Apache-2.0".`);
  }
}

const rootManifest = JSON.parse(read("package.json"));
const requiredScripts = {
  build: "tsc && vite build && pnpm license:bundle:npm",
  "build:web": "tsc && vite build --mode web && pnpm license:bundle:npm",
  "build:tauri": "tsc && vite build && pnpm license:bundle:tauri",
  "license:bundle:npm":
    "node scripts/generate-third-party-licenses.mjs --npm --copy-project-licenses --output dist/THIRD_PARTY_LICENSES.txt",
  "license:bundle:tauri":
    "node scripts/generate-third-party-licenses.mjs --npm --cargo --copy-project-licenses --output dist/THIRD_PARTY_LICENSES.txt",
};
for (const [scriptName, expectedCommand] of Object.entries(requiredScripts)) {
  if (rootManifest.scripts?.[scriptName] !== expectedCommand) {
    errors.push(`package.json scripts.${scriptName} must generate the expected license bundle.`);
  }
}

const docsManifest = JSON.parse(read("docs-site/package.json"));
const requiredDocsScripts = {
  build: "astro build && node scripts/generate-site-graph-loader.mjs && pnpm license:bundle:npm",
  "license:bundle:npm":
    "node ../scripts/generate-third-party-licenses.mjs --npm --npm-directory docs-site --copy-project-licenses --output docs-site/dist/THIRD_PARTY_LICENSES.txt",
};
for (const [scriptName, expectedCommand] of Object.entries(requiredDocsScripts)) {
  if (docsManifest.scripts?.[scriptName] !== expectedCommand) {
    errors.push(
      `docs-site/package.json scripts.${scriptName} must generate the expected license bundle.`,
    );
  }
}

for (const manifestPath of ["src-tauri/Cargo.toml", "crates/charm-web-server/Cargo.toml"]) {
  const packageSection = read(manifestPath).split(/^\[dependencies\]$/m, 1)[0];
  if (!/^license\s*=\s*"Apache-2\.0"\s*$/m.test(packageSection)) {
    errors.push(`${manifestPath} must declare license = "Apache-2.0" in [package].`);
  }
}

const tauriConfig = JSON.parse(read("src-tauri/tauri.conf.json"));
if (tauriConfig.build?.beforeBuildCommand !== "pnpm build:tauri") {
  errors.push("src-tauri/tauri.conf.json must generate npm and Cargo licenses before bundling.");
}
if (tauriConfig.build?.frontendDist !== "../dist") {
  errors.push("src-tauri/tauri.conf.json must bundle the generated dist license inventory.");
}
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

const serverDockerfile = stripPackagingComments(
  read("crates/charm-web-server/Dockerfile"),
  "crates/charm-web-server/Dockerfile",
);
if (!serverDockerfile.includes("COPY LICENSE ./LICENSE")) {
  errors.push("The companion-server builder must provide LICENSE to the license generator.");
}

const androidBuild = stripPackagingComments(
  read("src-tauri/gen/android/app/build.gradle.kts"),
  "src-tauri/gen/android/app/build.gradle.kts",
);
if (!androidBuild.includes('id("com.mikepenz.aboutlibraries.plugin.android") version "13.2.1"')) {
  errors.push("Android builds must generate native dependency license metadata.");
}
if (!androidBuild.includes("requireLicense = true") || !androidBuild.includes("StrictMode.FAIL")) {
  errors.push("Android dependency license generation must fail closed.");
}
if (!serverDockerfile.includes("COPY scripts/license-texts ./scripts/license-texts")) {
  errors.push("The companion-server builder must provide canonical dependency license texts.");
}
if (
  !serverDockerfile.includes(
    "node scripts/generate-third-party-licenses.mjs --cargo --output /tmp/THIRD_PARTY_LICENSES.txt",
  )
) {
  errors.push("The companion-server image must generate its locked Cargo license bundle.");
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
  /(?:^|\/)pnpm-workspace\.yaml$/,
  /^\.do\/.+\.ya?ml$/i,
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
const narrativeDocument = /\.mdx?$/i;
const sourceArchiveText =
  /(?:^|\/)(?:Dockerfile|Containerfile|Makefile|Justfile|Podfile|gradlew)$|\.(?:[cm]?[jt]sx?|rs|py|sh|bash|zsh|fish|ps1|bat|cmd|jsonc?|ya?ml|toml|xml|html?|css|scss|sass|less|svg|astro|vue|svelte|hbs|njk|liquid|graphql|gql|sql|proto|gradle|kts?|java|swift|plist|pbxproj|xcconfig|properties|conf|config|env|lock|txt|snap|fixture)$/i;
const opaqueArchiveArtifact =
  /\.(?:wasm|zip|tar|tgz|gz|7z|rar|jar|aar|apk|aab|dylib|so|dll|exe|bin)$/i;
const auditedOpaqueArtifacts = new Map([
  [
    "src-tauri/gen/android/gradle/wrapper/gradle-wrapper.jar",
    "e996d452d2645e70c01c11143ca2d3742734a28da2bf61f25c82bdc288c9e637",
  ],
]);

for (const trackedFile of trackedFiles) {
  if (opaqueArchiveArtifact.test(trackedFile)) {
    const expectedHash = auditedOpaqueArtifacts.get(trackedFile);
    if (!expectedHash) {
      errors.push(`Opaque source-archive artifact requires explicit audit: ${trackedFile}`);
    } else {
      const actualHash = createHash("sha256")
        .update(readFileSync(path.join(repositoryRoot, trackedFile)))
        .digest("hex");
      if (actualHash !== expectedHash) {
        errors.push(`Audited opaque artifact changed without review: ${trackedFile}`);
      }
    }
  }

  const isNarrativeDocument = narrativeDocument.test(trackedFile);
  const archiveContainsForbiddenSource =
    trackedFile !== checkerRelativePath &&
    !isNarrativeDocument &&
    sourceArchiveText.test(trackedFile) &&
    forbiddenSource.test(read(trackedFile));
  if (
    trackedFile !== checkerRelativePath &&
    !isNarrativeDocument &&
    (sableCallName.test(trackedFile) || archiveContainsForbiddenSource)
  ) {
    errors.push(`Sable Call material cannot be included in source archives: ${trackedFile}`);
  }

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
  if (trackedFile !== checkerRelativePath && isPackagingInput) {
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
