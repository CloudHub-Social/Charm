import { spawnSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const includeNpm = args.includes("--npm");
const includeCargo = args.includes("--cargo");
const copyProjectLicenses = args.includes("--copy-project-licenses");
const outputFlag = args.indexOf("--output");
const npmDirectoryFlag = args.indexOf("--npm-directory");

if (
  (!includeNpm && !includeCargo) ||
  outputFlag === -1 ||
  !args[outputFlag + 1] ||
  (npmDirectoryFlag !== -1 && !args[npmDirectoryFlag + 1])
) {
  console.error(
    "Usage: node scripts/generate-third-party-licenses.mjs (--npm | --cargo)+ [--npm-directory <path>] [--copy-project-licenses] --output <path>",
  );
  process.exit(1);
}

const outputPath = path.resolve(repositoryRoot, args[outputFlag + 1]);
const npmDirectory = path.resolve(
  repositoryRoot,
  npmDirectoryFlag === -1 ? "." : args[npmDirectoryFlag + 1],
);
const licenseFilename =
  /^(?:licen[cs]e|copying|notice|copyright|authors?|contributors?|patents?)(?:$|[._-])/i;
const entries = new Map();
const errors = [];

function commandJson(command, commandArgs, cwd = repositoryRoot) {
  const executable = process.platform === "win32" && command === "pnpm" ? "pnpm.cmd" : command;
  const result = spawnSync(executable, commandArgs, {
    cwd,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });

  if (result.status !== 0) {
    const detail = (result.stderr || result.stdout || "unknown failure").trim();
    throw new Error(`${command} ${commandArgs.join(" ")} failed: ${detail}`);
  }

  return JSON.parse(result.stdout);
}

function normalizedPerson(value) {
  if (!value) return "";
  if (typeof value === "string") return value;
  return [value.name, value.email && `<${value.email}>`, value.url && `(${value.url})`]
    .filter(Boolean)
    .join(" ");
}

function candidateLicenseFiles(packageRoot, explicitLicenseFile) {
  const candidates = new Set();

  if (explicitLicenseFile) {
    const explicitPath = path.resolve(packageRoot, explicitLicenseFile);
    if (existsSync(explicitPath) && statSync(explicitPath).isFile()) candidates.add(explicitPath);
  }

  const nestedLicenseDirectories = readdirSync(packageRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && /^licen[cs]es?$/i.test(entry.name))
    .map((entry) => path.join(packageRoot, entry.name));

  for (const directory of [packageRoot, ...nestedLicenseDirectories]) {
    if (!existsSync(directory) || !statSync(directory).isDirectory()) continue;
    for (const directoryEntry of readdirSync(directory, { withFileTypes: true })) {
      if (directoryEntry.isFile() && licenseFilename.test(directoryEntry.name)) {
        candidates.add(path.join(directory, directoryEntry.name));
      }
    }
  }

  return [...candidates]
    .sort((left, right) => left.localeCompare(right))
    .map((filename) => ({
      name: path.relative(packageRoot, filename),
      content: readFileSync(filename, "utf8").trimEnd(),
    }));
}

function addEntry({
  ecosystem,
  name,
  version,
  license,
  authors,
  homepage,
  packageRoot,
  licenseFile,
}) {
  const key = `${ecosystem}:${name}@${version}`;
  if (entries.has(key)) return;

  const files = candidateLicenseFiles(packageRoot, licenseFile);
  if (files.length === 0) {
    errors.push(`${ecosystem} dependency ${name}@${version} has no packaged license text.`);
    return;
  }

  entries.set(key, {
    ecosystem,
    name,
    version,
    license: license || "UNKNOWN",
    authors: authors || "Not declared",
    homepage: homepage || "Not declared",
    files,
  });
}

function collectNpmLicenses() {
  const report = commandJson("pnpm", ["licenses", "list", "--json"], npmDirectory);

  for (const packages of Object.values(report)) {
    for (const packageRecord of packages) {
      let foundInstalledPath = false;
      for (const packageRoot of packageRecord.paths ?? []) {
        const manifestPath = path.join(packageRoot, "package.json");
        if (!existsSync(manifestPath)) continue;
        foundInstalledPath = true;

        const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
        const contributors = Array.isArray(manifest.contributors)
          ? manifest.contributors
          : manifest.contributors
            ? [manifest.contributors]
            : [];
        const authors = [
          normalizedPerson(manifest.author ?? packageRecord.author),
          ...contributors.map(normalizedPerson),
        ]
          .filter(Boolean)
          .join(", ");
        const license =
          typeof manifest.license === "string" ? manifest.license : packageRecord.license;
        const licenseFile = /^SEE LICEN[CS]E IN (.+)$/i.exec(license ?? "")?.[1];

        addEntry({
          ecosystem: "npm",
          name: manifest.name ?? packageRecord.name,
          version: manifest.version ?? "unknown",
          license,
          authors,
          homepage: manifest.homepage ?? packageRecord.homepage,
          packageRoot,
          licenseFile,
        });
      }

      if (!foundInstalledPath) {
        for (const version of packageRecord.versions ?? ["unknown"]) {
          errors.push(
            `npm dependency ${packageRecord.name}@${version} has no installed package path.`,
          );
        }
      }
    }
  }
}

function collectCargoLicenses() {
  const metadata = commandJson("cargo", ["metadata", "--locked", "--format-version=1"]);

  for (const packageRecord of metadata.packages) {
    if (!packageRecord.source) continue;
    const packageRoot = path.dirname(packageRecord.manifest_path);
    addEntry({
      ecosystem: "Cargo",
      name: packageRecord.name,
      version: packageRecord.version,
      license: packageRecord.license,
      authors: packageRecord.authors?.join(", "),
      homepage: packageRecord.homepage ?? packageRecord.repository,
      packageRoot,
      licenseFile: packageRecord.license_file,
    });
  }
}

try {
  if (includeNpm) collectNpmLicenses();
  if (includeCargo) collectCargoLicenses();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}

if (errors.length > 0) {
  for (const error of errors) console.error(`third-party-license: ${error}`);
  process.exit(1);
}

const sortedEntries = [...entries.values()].sort((left, right) =>
  [left.ecosystem, left.name, left.version]
    .join(":")
    .localeCompare([right.ecosystem, right.name, right.version].join(":")),
);
const sections = sortedEntries.map((entry) => {
  const heading = `${entry.ecosystem}: ${entry.name}@${entry.version}`;
  const files = entry.files.map(({ name, content }) => `--- ${name} ---\n${content}`).join("\n\n");
  return `${"=".repeat(80)}\n${heading}\nDeclared license: ${entry.license}\nAuthors: ${entry.authors}\nHomepage: ${entry.homepage}\n\n${files}`;
});
const output = [
  "CHARM THIRD-PARTY LICENSES AND NOTICES",
  "",
  "Generated deterministically from the installed pnpm dependency graph and/or",
  "Cargo.lock-resolved external crates. Package license, notice, copying, and copyright files",
  "are included below; Charm does not relicense these works.",
  "",
  ...sections,
  "",
].join("\n");

mkdirSync(path.dirname(outputPath), { recursive: true });
writeFileSync(outputPath, output, "utf8");
if (copyProjectLicenses) {
  for (const filename of ["LICENSE", "NOTICE", "LICENSING.md", "THIRD_PARTY_NOTICES.md"]) {
    copyFileSync(
      path.join(repositoryRoot, filename),
      path.join(path.dirname(outputPath), filename),
    );
  }
}
process.stdout.write(
  `Wrote ${sortedEntries.length} third-party license records to ${outputPath}.\n`,
);
