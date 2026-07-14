import { beforeEach, describe, expect, it } from "vitest";
import { getInstallId } from "./installId";

beforeEach(() => {
  localStorage.clear();
});

describe("getInstallId", () => {
  it("is stable across calls and persisted", () => {
    const first = getInstallId();
    expect(first).toBeTruthy();
    expect(getInstallId()).toBe(first);
    expect(localStorage.getItem("charm:featureFlagsInstallId")).toBe(first);
  });

  it("generates a fresh id after storage is cleared", () => {
    const first = getInstallId();
    localStorage.clear();
    const second = getInstallId();
    expect(second).not.toBe(first);
  });

  it("reuses an already-persisted id", () => {
    localStorage.setItem("charm:featureFlagsInstallId", "preexisting-id");
    expect(getInstallId()).toBe("preexisting-id");
  });
});
