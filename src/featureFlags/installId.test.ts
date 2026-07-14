import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

beforeEach(() => {
  localStorage.clear();
  vi.resetModules(); // reset the module-level session fallback id between tests
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("getInstallId", () => {
  it("is stable across calls and persisted", async () => {
    const { getInstallId } = await import("./installId");
    const first = getInstallId();
    expect(first).toBeTruthy();
    expect(getInstallId()).toBe(first);
    expect(localStorage.getItem("charm:featureFlagsInstallId")).toBe(first);
  });

  it("generates a fresh id after storage is cleared", async () => {
    const { getInstallId } = await import("./installId");
    const first = getInstallId();
    localStorage.clear();
    const second = getInstallId();
    expect(second).not.toBe(first);
  });

  it("reuses an already-persisted id", async () => {
    localStorage.setItem("charm:featureFlagsInstallId", "preexisting-id");
    const { getInstallId } = await import("./installId");
    expect(getInstallId()).toBe("preexisting-id");
  });

  it("stays stable within a session when storage is blocked", async () => {
    const { getInstallId } = await import("./installId");
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("storage blocked");
    });
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("storage blocked");
    });
    const first = getInstallId();
    // Without the session cache, each call would regenerate and rebucket.
    expect(getInstallId()).toBe(first);
    expect(getInstallId()).toBe(first);
  });
});
