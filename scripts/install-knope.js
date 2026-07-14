#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import process from "node:process";
import { chmodSync, existsSync, mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { join, dirname, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { gunzipSync } from "node:zlib";
import { PrefixedLogger, createTextHelpers } from "./utils/console-style.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

const VERSION = "0.22.3";
const TARGETS = {
  "linux-x64": "x86_64-unknown-linux-musl",
  "linux-arm64": "aarch64-unknown-linux-musl",
  "darwin-x64": "x86_64-apple-darwin",
  "darwin-arm64": "aarch64-apple-darwin",
  "win32-x64": "x86_64-pc-windows-msvc",
};

// SHA-256 digests published by GitHub for the pinned v0.22.3 release assets.
// This script runs automatically during `pnpm install`, so executing a
// downloaded binary without authenticating the archive would turn a
// compromised release asset or download path into arbitrary code execution.
const ARCHIVE_SHA256 = {
  "x86_64-unknown-linux-musl": "67ef0bf50ad3f075413e796a8364e72025af26d3116edf6842bc24869fe0dbf7",
  "aarch64-unknown-linux-musl": "5ffbc14453a383f241c2ce8214f4c02769a3376f3c61a89552d42fd10a1bd41b",
  "x86_64-apple-darwin": "caeed621095069a8b7e07891dbd476d35bbb46efc29e89c68e3a2d76d4c8dc11",
  "aarch64-apple-darwin": "4fc9b920bf511928d6d9ac45ac52fcfcd779c290b1fc5eb75e9c8ca423df793d",
  "x86_64-pc-windows-msvc": "2ea29e6c9cd81f0f50c241ac26eb518b77d16202f87878d0aa3e6065f97526c0",
};

function parseKnopeVersion(output) {
  const version = output?.trim().replace(/^knope\s+/, "");
  return version || null;
}

function getKnopeVersion(command) {
  const result = spawnSync(command, ["--version"], { encoding: "utf8" });
  if (result.status !== 0) {
    return null;
  }
  return parseKnopeVersion(result.stdout);
}

function readNullTerminatedString(buffer) {
  const nulIndex = buffer.indexOf(0);
  const end = nulIndex === -1 ? buffer.length : nulIndex;
  return buffer.toString("utf8", 0, end);
}

function getTarBasename(entryName) {
  const segments = entryName.split("/").filter(Boolean);
  return segments.at(-1) ?? "";
}

function extractRegularFileFromTar(tarBuffer, expectedBasename) {
  let offset = 0;
  const regularEntries = [];

  while (offset + 512 <= tarBuffer.length) {
    const header = tarBuffer.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) {
      break;
    }

    const name = readNullTerminatedString(header.subarray(0, 100));
    const prefix = readNullTerminatedString(header.subarray(345, 500));
    const fullName = prefix ? `${prefix}/${name}` : name;
    const sizeOctal = readNullTerminatedString(header.subarray(124, 136)).trim();
    const size = sizeOctal ? Number.parseInt(sizeOctal, 8) : 0;
    const typeflag = header[156];
    const isRegular = typeflag === 0 || typeflag === 48;

    if (!Number.isFinite(size) || size < 0) {
      throw new Error(`Invalid tar entry size for ${fullName || "<unknown>"}`);
    }

    const dataStart = offset + 512;
    const dataEnd = dataStart + size;
    if (dataEnd > tarBuffer.length) {
      throw new Error("Corrupt tarball: entry exceeds archive size");
    }

    if (isRegular && fullName) {
      regularEntries.push(fullName);
      if (getTarBasename(fullName) === expectedBasename) {
        return Buffer.from(tarBuffer.subarray(dataStart, dataEnd));
      }
    }

    const alignedSize = Math.ceil(size / 512) * 512;
    offset = dataStart + alignedSize;
  }

  throw new Error(
    `Expected "${expectedBasename}" in tarball; found: ${regularEntries.join(", ") || "none"}`,
  );
}

function getSystemKnopePath() {
  const which = spawnSync(process.platform === "win32" ? "where" : "which", ["knope"], {
    encoding: "utf8",
  });
  if (which.status !== 0) {
    return null;
  }
  return (
    which.stdout
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find(Boolean) ?? null
  );
}

const toComparablePath = (value) => {
  const resolved = resolve(value);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
};

function isPathWithin(candidatePath, rootPath) {
  const candidate = toComparablePath(candidatePath);
  const root = toComparablePath(rootPath);
  return candidate === root || candidate.startsWith(`${root}${sep}`);
}

const logger = new PrefixedLogger("[postinstall:knope]");
const { dim, red, green } = createTextHelpers({ useColor: logger.useColor });

if (process.env.GITHUB_ACTIONS && process.env.CI) {
  logger.info(`${dim("Running in CI environment, skipping knope installation")}`);
  process.exit(0);
}

const target = TARGETS[`${process.platform}-${process.arch}`];
if (!target) {
  const supported = Object.keys(TARGETS).join(", ");
  logger.info(
    `${dim("Unsupported platform: ")}${red(`${process.platform}-${process.arch}`)}${dim(". Supported targets: ")}${supported}${dim(". Skipping knope install — everything else will still work; `pnpm run document-change`/`knope` won't be available locally.")}`,
  );
  process.exit(0);
}

const bin = join(
  __dirname,
  `../node_modules/.bin/knope${process.platform === "win32" ? ".exe" : ""}`,
);
const localBinDir = join(__dirname, "../node_modules/.bin");
mkdirSync(dirname(bin), { recursive: true });

if (existsSync(bin)) {
  const installed = getKnopeVersion(bin);
  if (installed === VERSION) {
    logger.info(`${dim("knope ")}${green(`v${VERSION}`)}${dim(" already installed")}`);
    process.exit(0);
  }
  logger.info(
    `${dim("Updating knope ")}${red(`v${installed ?? "unknown"}`)}${dim(" -> ")}${green(`v${VERSION}`)}`,
  );
}

const systemKnopePath = getSystemKnopePath();
if (systemKnopePath) {
  const resolvedPath = (() => {
    try {
      return realpathSync(systemKnopePath);
    } catch {
      return systemKnopePath;
    }
  })();

  if (!isPathWithin(resolvedPath, localBinDir)) {
    const installed = getKnopeVersion(systemKnopePath);
    if (installed === VERSION) {
      logger.info(
        `${dim("Using system knope ")}${green(`v${installed}`)}${dim(", skipping download")}`,
      );
      process.exit(0);
    }
    if (installed) {
      logger.info(
        `${dim("Found system knope ")}${red(`v${installed}`)}${dim("; installing pinned ")}${green(`v${VERSION}`)}${dim(". Consider updating your system knope.")}`,
      );
    }
  }
}

const url = `https://github.com/knope-dev/knope/releases/download/knope%2Fv${VERSION}/knope-${target}.tgz`;
logger.info(
  `${dim("Downloading knope ")}${green(`v${VERSION}`)}${dim(" for ")}${target}${dim("...")}`,
);
const response = await fetch(url);
if (!response.ok) {
  throw new Error(`Failed to download knope: ${response.status} ${response.statusText}`);
}
const gzipBytes = Buffer.from(await response.arrayBuffer());
const actualDigest = createHash("sha256").update(gzipBytes).digest("hex");
const expectedDigest = ARCHIVE_SHA256[target];
if (actualDigest !== expectedDigest) {
  throw new Error(
    `Knope archive checksum mismatch for ${target}: expected ${expectedDigest}, got ${actualDigest}`,
  );
}
const tarBytes = gunzipSync(gzipBytes);
const expectedBinaryName = process.platform === "win32" ? "knope.exe" : "knope";
const knopeBinary = extractRegularFileFromTar(tarBytes, expectedBinaryName);
writeFileSync(bin, knopeBinary);
chmodSync(bin, 0o755);
const installed = getKnopeVersion(bin);
if (installed !== VERSION) {
  throw new Error(
    `Installed knope version mismatch: expected ${VERSION}, got ${installed ?? "unknown"}`,
  );
}
logger.info(`${dim("Installed knope ")}${green(`v${installed}`)}`);
