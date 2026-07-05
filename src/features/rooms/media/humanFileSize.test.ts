import { describe, expect, it } from "vitest";
import { humanFileSize } from "./humanFileSize";

describe("humanFileSize", () => {
  it("returns an empty string for null/undefined", () => {
    expect(humanFileSize(null)).toBe("");
    expect(humanFileSize(undefined)).toBe("");
  });

  it("formats bytes under 1024 as B", () => {
    expect(humanFileSize(512)).toBe("512 B");
  });

  it("formats kilobytes", () => {
    expect(humanFileSize(2048)).toBe("2 KB");
  });

  it("formats megabytes with one decimal under 10", () => {
    expect(humanFileSize(1_500_000)).toBe("1.4 MB");
  });

  it("formats gigabytes", () => {
    expect(humanFileSize(5 * 1024 * 1024 * 1024)).toBe("5 GB");
  });
});
