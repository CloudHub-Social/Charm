import { afterEach, describe, expect, it, vi } from "vitest";
import packageJson from "../../package.json";
import { getBuildId } from "./buildId";

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
