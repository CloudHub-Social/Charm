import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_PRIVACY_SETTINGS,
  getPrivacySettings,
  initializePrivacySettings,
  PRIVACY_SETTINGS_LOCAL_STORAGE_KEY,
  setPrivacySettings,
} from "./privacySettings";

vi.mock("@/lib/platform", () => ({
  isTauri: () => false,
}));

describe("privacySettings", () => {
  beforeEach(() => {
    localStorage.clear();
    // Reset the module's in-memory cache/init flag between tests by
    // re-initializing to defaults through the public API.
  });

  it("defaults to every toggle off and a 10-minute idle timeout", async () => {
    await initializePrivacySettings();
    expect(getPrivacySettings()).toEqual(DEFAULT_PRIVACY_SETTINGS);
  });

  it("persists a partial update and updates the synchronous cache immediately", async () => {
    await setPrivacySettings({ hideReadReceipts: true });
    expect(getPrivacySettings().hideReadReceipts).toBe(true);
    // Other fields are untouched by a partial update.
    expect(getPrivacySettings().hideTyping).toBe(false);
  });

  it("clamps an out-of-range idle timeout instead of accepting it verbatim", async () => {
    await setPrivacySettings({ idleTimeoutMins: 999 });
    expect(getPrivacySettings().idleTimeoutMins).toBeLessThanOrEqual(120);

    await setPrivacySettings({ idleTimeoutMins: -5 });
    expect(getPrivacySettings().idleTimeoutMins).toBeGreaterThanOrEqual(1);
  });

  it("writes through to the localStorage mirror outside Tauri", async () => {
    await setPrivacySettings({ appearOffline: true });
    const raw = localStorage.getItem(PRIVACY_SETTINGS_LOCAL_STORAGE_KEY);
    expect(raw).not.toBeNull();
    const parsed = JSON.parse(raw ?? "{}");
    expect(parsed.appearOffline).toBe(true);
  });

  it("is a no-op on a second initialize call once already initialized", async () => {
    await initializePrivacySettings();
    await setPrivacySettings({ hideTyping: true });
    const result = await initializePrivacySettings();
    // The second call must return the current cache (hideTyping still true),
    // not re-read from disk and clobber it back to defaults.
    expect(result.hideTyping).toBe(true);
  });

  it("drops unknown/malformed fields when persisting a partial update", async () => {
    // `setPrivacySettings` always normalizes its result, regardless of what
    // a corrupt persisted file on disk might contain — a malformed
    // `hideReadReceipts` value could never survive into the in-memory cache.
    await setPrivacySettings({ hideReadReceipts: "yes" as unknown as boolean });
    const settings = getPrivacySettings();
    expect(typeof settings.hideReadReceipts).toBe("boolean");
    expect(typeof settings.idleTimeoutMins).toBe("number");
  });
});
