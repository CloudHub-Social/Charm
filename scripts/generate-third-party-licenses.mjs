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
const licenseTermsFilename = /(?:^|\/)(?:licen[cs]e|copying)(?:$|[._-])|^(?:licen[cs]es?)\//i;
const entries = new Map();
const errors = [];
const mitLicenseText = `MIT License

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.`;
const iscLicenseTerms = `Permission to use, copy, modify, and/or distribute this software for any
purpose with or without fee is hereby granted, provided that the above
copyright notice and this permission notice appear in all copies.

THE SOFTWARE IS PROVIDED "AS IS" AND THE AUTHOR DISCLAIMS ALL WARRANTIES WITH
REGARD TO THIS SOFTWARE INCLUDING ALL IMPLIED WARRANTIES OF MERCHANTABILITY
AND FITNESS. IN NO EVENT SHALL THE AUTHOR BE LIABLE FOR ANY SPECIAL, DIRECT,
INDIRECT, OR CONSEQUENTIAL DAMAGES OR ANY DAMAGES WHATSOEVER RESULTING FROM
LOSS OF USE, DATA OR PROFITS, WHETHER IN AN ACTION OF CONTRACT, NEGLIGENCE OR
OTHER TORTIOUS ACTION, ARISING OUT OF OR IN CONNECTION WITH THE USE OR
PERFORMANCE OF THIS SOFTWARE.`;

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

function normalizedRepository(value) {
  if (!value) return "";
  const repository = typeof value === "string" ? value : value.url;
  return String(repository ?? "")
    .replace(/^git\+/, "")
    .replace(/^(?:git|https?|ssh):\/\//, "")
    .replace(/^git@github\.com:/, "github.com/")
    .replace(/^github\.com:/, "github.com/")
    .replace(/\.git$/, "")
    .replace(/\/$/, "")
    .toLowerCase();
}

function candidateLicenseFiles(packageRoot, explicitLicenseFile) {
  if (!existsSync(packageRoot) || !statSync(packageRoot).isDirectory()) return [];

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
  repository,
  packageRoot,
  licenseFile,
}) {
  const key = `${ecosystem}:${name}@${version}`;
  if (entries.has(key)) return;

  const files = candidateLicenseFiles(packageRoot, licenseFile);
  entries.set(key, {
    ecosystem,
    name,
    version,
    license: license || "UNKNOWN",
    authors: authors || "Not declared",
    homepage: homepage || "Not declared",
    repository: normalizedRepository(repository),
    files,
  });
}

function canonicalLicenseFiles(entry) {
  const attribution =
    entry.authors !== "Not declared" ? entry.authors : `${entry.name} contributors`;
  const declaredLicense = entry.license.replace(/[()]/g, "").trim();
  const licenseIds = declaredLicense.split(/\s+OR\s+/i).map((value) => value.trim());
  const files = [];

  for (const licenseId of licenseIds) {
    if (licenseId === "MIT") {
      files.push({
        name: "SPDX-MIT.txt",
        content: `Canonical SPDX text: https://spdx.org/licenses/MIT\nCopyright (c) ${attribution}\n\n${mitLicenseText}`,
      });
    } else if (licenseId === "ISC") {
      files.push({
        name: "SPDX-ISC.txt",
        content: `Canonical SPDX text: https://spdx.org/licenses/ISC\nCopyright (c) ${attribution}\n\n${iscLicenseTerms}`,
      });
    } else if (licenseId === "Apache-2.0") {
      files.push({
        name: "SPDX-Apache-2.0.txt",
        content: readFileSync(path.join(repositoryRoot, "LICENSE"), "utf8").trimEnd(),
      });
    } else if (licenseId === "MPL-2.0") {
      files.push({
        name: "SPDX-MPL-2.0.txt",
        content: `Canonical SPDX text: https://spdx.org/licenses/MPL-2.0\n\n${readFileSync(
          path.join(repositoryRoot, "scripts/license-texts/MPL-2.0.txt"),
          "utf8",
        ).trimEnd()}`,
      });
    } else if (licenseId === "LGPL-3.0-or-later") {
      files.push(
        {
          name: "GNU-GPL-3.0.txt",
          content: `Canonical GNU text: https://www.gnu.org/licenses/gpl-3.0.txt\n\n${readFileSync(
            path.join(repositoryRoot, "scripts/license-texts/GPL-3.0.txt"),
            "utf8",
          ).trimEnd()}`,
        },
        {
          name: "GNU-LGPL-3.0-or-later.txt",
          content: `Canonical GNU text: https://www.gnu.org/licenses/lgpl-3.0.txt\n\n${readFileSync(
            path.join(repositoryRoot, "scripts/license-texts/LGPL-3.0-or-later.txt"),
            "utf8",
          ).trimEnd()}`,
        },
      );
    } else {
      return [];
    }
  }

  return files;
}

function resolveMissingLicenseFiles() {
  const allEntries = [...entries.values()];

  for (const entry of allEntries) {
    if (entry.files.some(({ name }) => licenseTermsFilename.test(name))) continue;
    const repositoryDonor = entry.repository
      ? allEntries.find(
          (candidate) =>
            candidate !== entry &&
            candidate.repository === entry.repository &&
            candidate.license === entry.license &&
            candidate.files.some(({ name }) => licenseTermsFilename.test(name)),
        )
      : undefined;

    if (repositoryDonor) {
      entry.files.push(
        ...repositoryDonor.files
          .filter(({ name }) => licenseTermsFilename.test(name))
          .map(({ name, content }) => ({
            name: `repository-license-from-${repositoryDonor.name}/${name}`,
            content,
          })),
      );
      continue;
    }

    const canonicalFiles = canonicalLicenseFiles(entry);
    entry.files.push(...canonicalFiles);
    if (canonicalFiles.length === 0) {
      errors.push(
        `${entry.ecosystem} dependency ${entry.name}@${entry.version} has no package, repository, or supported canonical license text for ${entry.license}.`,
      );
    }
  }
}

function collectNpmLicenses() {
  const report = commandJson("pnpm", ["licenses", "list", "--json"], npmDirectory);

  for (const [reportedLicense, packages] of Object.entries(report)) {
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
          typeof manifest.license === "string"
            ? manifest.license
            : (packageRecord.license ?? reportedLicense);
        const licenseFile = /^SEE LICEN[CS]E IN (.+)$/i.exec(license ?? "")?.[1];

        addEntry({
          ecosystem: "npm",
          name: manifest.name ?? packageRecord.name,
          version: manifest.version ?? "unknown",
          license,
          authors,
          homepage: manifest.homepage ?? packageRecord.homepage,
          repository: manifest.repository,
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
      repository: packageRecord.repository,
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

resolveMissingLicenseFiles();

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
  "are included below. When a split package omits them, the generator uses a same-repository",
  "license file or supported canonical license text with package attribution. Charm does not",
  "relicense these works.",
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
