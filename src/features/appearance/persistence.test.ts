import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_APPEARANCE, type AppearanceState } from "./atoms";
import {
  LOCAL_STORAGE_KEY,
  mergeAppearance,
  persistAppearance,
  readLocalMirror,
  readPersistedAppearance,
  writeLocalMirror,
} from "./persistence";

const storeGet = vi.fn();
const storeSet = vi.fn();
const load = vi.fn();

vi.mock("@tauri-apps/plugin-store", () => ({
  load: (...args: unknown[]) => load(...args),
}));

beforeEach(() => {
  localStorage.clear();
  storeGet.mockReset();
  storeSet.mockReset();
  load.mockReset().mockResolvedValue({ get: storeGet, set: storeSet });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("local mirror", () => {
  it("round-trips through localStorage", () => {
    const state: AppearanceState = {
      theme: "light",
      fontSize: "lg",
      density: "compact",
      reducedMotion: "on",
    };
    writeLocalMirror(state);
    expect(JSON.parse(localStorage.getItem(LOCAL_STORAGE_KEY)!)).toEqual(state);
    expect(readLocalMirror()).toEqual(state);
  });

  it("returns null when nothing is stored", () => {
    expect(readLocalMirror()).toBeNull();
  });

  it("returns null on corrupt JSON rather than throwing", () => {
    localStorage.setItem(LOCAL_STORAGE_KEY, "{not json");
    expect(readLocalMirror()).toBeNull();
  });
});

describe("readPersistedAppearance", () => {
  it("returns the store's value when the plugin is available", async () => {
    storeGet.mockResolvedValue({ theme: "midnight" });
    await expect(readPersistedAppearance()).resolves.toEqual({ theme: "midnight" });
  });

  it("returns null when the store has no value yet", async () => {
    storeGet.mockResolvedValue(undefined);
    await expect(readPersistedAppearance()).resolves.toBeNull();
  });

  it("returns null when the plugin throws (e.g. no Tauri host)", async () => {
    load.mockRejectedValue(new Error("no host"));
    await expect(readPersistedAppearance()).resolves.toBeNull();
  });
});

describe("persistAppearance", () => {
  it("writes through to both the store and the localStorage mirror", async () => {
    const state: AppearanceState = { ...DEFAULT_APPEARANCE, theme: "midnight" };
    await persistAppearance(state);
    expect(storeSet).toHaveBeenCalledWith("appearance", state);
    expect(readLocalMirror()).toEqual(state);
  });

  it("still writes the localStorage mirror when the store plugin fails", async () => {
    load.mockRejectedValue(new Error("no host"));
    const state: AppearanceState = { ...DEFAULT_APPEARANCE, density: "compact" };
    await persistAppearance(state);
    expect(readLocalMirror()).toEqual(state);
  });
});

describe("mergeAppearance", () => {
  it("returns defaults for null input", () => {
    expect(mergeAppearance(null)).toEqual(DEFAULT_APPEARANCE);
  });

  it("fills in missing keys from defaults", () => {
    expect(mergeAppearance({ theme: "light" })).toEqual({ ...DEFAULT_APPEARANCE, theme: "light" });
  });

  it("passes through a fully-specified partial", () => {
    const full: AppearanceState = {
      theme: "midnight",
      fontSize: "xl",
      density: "compact",
      reducedMotion: "off",
    };
    expect(mergeAppearance(full)).toEqual(full);
  });
});
