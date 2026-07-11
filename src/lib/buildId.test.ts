import { afterEach, describe, expect, it, vi } from "vitest";
import packageJson from "../../package.json";
import { formatBuildIdForDisplay, getBuildId } from "./buildId";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("getBuildId", () => {
  it("returns VITE_BUILD_ID when set", () => {
    vi.stubEnv("VITE_BUILD_ID", "0.4.2+a1b2c3d");
    expect(getBuildId()).toBe("0.4.2+a1b2c3d");
  });

  it("falls back to the package version when VITE_BUILD_ID is unset", () => {
    vi.stubEnv("VITE_BUILD_ID", "");
    expect(getBuildId()).toBe(packageJson.version);
  });
});

describe("formatBuildIdForDisplay", () => {
  it("formats an ordinary build as {version} (sha-{sha})", () => {
    expect(formatBuildIdForDisplay("0.4.2+a1b2c3d")).toBe("0.4.2 (sha-a1b2c3d)");
  });

  it("formats a PR preview build as {version}-pr{n} (sha-{sha})", () => {
    expect(formatBuildIdForDisplay("0.4.2+pr187.a1b2c3d")).toBe("0.4.2-pr187 (sha-a1b2c3d)");
  });

  it("formats a nightly build as {version}-nightly (sha-{sha})", () => {
    expect(formatBuildIdForDisplay("0.4.2+nightly.a1b2c3d")).toBe("0.4.2-nightly (sha-a1b2c3d)");
  });

  it("appends -dev to a bare version with no +sha suffix (local/dev fallback)", () => {
    expect(formatBuildIdForDisplay("0.4.2")).toBe("0.4.2-dev");
  });

  it("falls back to appending -dev for a malformed id it can't parse", () => {
    expect(formatBuildIdForDisplay("not-a-build-id+???")).toBe("not-a-build-id+???-dev");
  });
});
