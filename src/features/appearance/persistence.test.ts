import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_APPEARANCE, type AppearanceState } from "./atoms";
import {
  LOCAL_STORAGE_KEY,
  mergeAppearance,
  persistAppearance,
  pickNewerEnvelope,
  readLocalMirror,
  readPersistedAppearance,
  writeLocalMirror,
  type PersistedEnvelope,
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
  it("round-trips through localStorage as a { state, updatedAt } envelope", () => {
    const state: AppearanceState = {
      theme: "light",
      fontSize: "lg",
      density: "compact",
      reducedMotion: "on",
      messageLayout: "discord",
      jumboEmojiSize: "lg",
      showUnreadCounts: false,
      autoplayGifs: true,
      stripExifOnUpload: true,
    };
    writeLocalMirror(state, 1000);
    expect(JSON.parse(localStorage.getItem(LOCAL_STORAGE_KEY)!)).toEqual({
      state,
      updatedAt: 1000,
    });
    expect(readLocalMirror()).toEqual({ state, updatedAt: 1000 });
  });

  it("returns null when nothing is stored", () => {
    expect(readLocalMirror()).toBeNull();
  });

  it("returns null on corrupt JSON rather than throwing", () => {
    localStorage.setItem(LOCAL_STORAGE_KEY, "{not json");
    expect(readLocalMirror()).toBeNull();
  });

  it("treats a pre-envelope bare AppearanceState as updatedAt: 0", () => {
    // A mirror written by a build that predates the { state, updatedAt }
    // envelope — must not throw, and must always lose a version compare
    // against any properly-versioned value (see pickNewerEnvelope).
    const bareState: AppearanceState = { ...DEFAULT_APPEARANCE, theme: "midnight" };
    localStorage.setItem(LOCAL_STORAGE_KEY, JSON.stringify(bareState));
    expect(readLocalMirror()).toEqual({ state: bareState, updatedAt: 0 });
  });
});

describe("readPersistedAppearance", () => {
  it("returns the store's envelope when the plugin is available", async () => {
    storeGet.mockResolvedValue({ state: { theme: "midnight" }, updatedAt: 500 });
    await expect(readPersistedAppearance()).resolves.toEqual({
      state: { theme: "midnight" },
      updatedAt: 500,
    });
  });

  it("returns null when the store has no value yet", async () => {
    storeGet.mockResolvedValue(undefined);
    await expect(readPersistedAppearance()).resolves.toBeNull();
  });

  it("returns null when the plugin throws (e.g. no Tauri host)", async () => {
    load.mockRejectedValue(new Error("no host"));
    await expect(readPersistedAppearance()).resolves.toBeNull();
  });

  it("treats a pre-envelope bare AppearanceState from the store as updatedAt: 0", () => {
    const bareState = { theme: "light" };
    storeGet.mockResolvedValue(bareState);
    return expect(readPersistedAppearance()).resolves.toEqual({
      state: bareState,
      updatedAt: 0,
    });
  });
});

describe("persistAppearance", () => {
  it("writes through to both the store and the localStorage mirror with the given timestamp", async () => {
    const state: AppearanceState = { ...DEFAULT_APPEARANCE, theme: "midnight" };
    await persistAppearance(state, 12345);
    expect(storeSet).toHaveBeenCalledWith("appearance", { state, updatedAt: 12345 });
    expect(readLocalMirror()).toEqual({ state, updatedAt: 12345 });
  });

  it("defaults updatedAt to Date.now() when not given", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(999);
    const state: AppearanceState = { ...DEFAULT_APPEARANCE, theme: "light" };
    await persistAppearance(state);
    expect(readLocalMirror()).toEqual({ state, updatedAt: 999 });
    vi.useRealTimers();
  });

  it("still writes the localStorage mirror when the store plugin fails", async () => {
    load.mockRejectedValue(new Error("no host"));
    const state: AppearanceState = { ...DEFAULT_APPEARANCE, density: "compact" };
    await persistAppearance(state, 42);
    expect(readLocalMirror()).toEqual({ state, updatedAt: 42 });
  });
});

describe("pickNewerEnvelope", () => {
  const older: PersistedEnvelope = { state: { theme: "dark" }, updatedAt: 100 };
  const newer: PersistedEnvelope = { state: { theme: "light" }, updatedAt: 200 };

  it("prefers the store when it is newer", () => {
    expect(pickNewerEnvelope(newer, older)).toEqual(newer.state);
  });

  it("prefers localStorage when it is newer — the race this fixes", () => {
    // The scenario from the bug report: the user changes a setting, the
    // synchronous localStorage write lands, then the app quits before the
    // async tauri-plugin-store write resolves. On next launch the store
    // still holds the OLDER value but is non-null — reconciliation must not
    // let it unconditionally win.
    expect(pickNewerEnvelope(older, newer)).toEqual(newer.state);
  });

  it("prefers the store on an exact tie", () => {
    const tie: PersistedEnvelope = { state: { theme: "midnight" }, updatedAt: 100 };
    expect(pickNewerEnvelope(older, tie)).toEqual(older.state);
  });

  it("falls back to whichever one is non-null", () => {
    expect(pickNewerEnvelope(newer, null)).toEqual(newer.state);
    expect(pickNewerEnvelope(null, older)).toEqual(older.state);
  });

  it("returns null when both are null", () => {
    expect(pickNewerEnvelope(null, null)).toBeNull();
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
      messageLayout: "irc",
      jumboEmojiSize: "md",
      showUnreadCounts: true,
      autoplayGifs: false,
      stripExifOnUpload: false,
    };
    expect(mergeAppearance(full)).toEqual(full);
  });

  it("falls back to the default for an invalid theme rather than propagating it", () => {
    // Simulates corrupted-but-parseable JSON (e.g. hand-edited localStorage
    // or a store file written by an incompatible build) — `theme` is a
    // string, just not one of the supported values.
    const corrupted = { theme: "banana" } as unknown as Partial<AppearanceState>;
    expect(mergeAppearance(corrupted)).toEqual(DEFAULT_APPEARANCE);
  });

  it("falls back to the default for an invalid fontSize/density/reducedMotion", () => {
    const corrupted = {
      fontSize: "huge",
      density: "spacious",
      reducedMotion: "maybe",
    } as unknown as Partial<AppearanceState>;
    expect(mergeAppearance(corrupted)).toEqual(DEFAULT_APPEARANCE);
  });

  it("falls back to the default for an invalid messageLayout", () => {
    const corrupted = { messageLayout: "compact" } as unknown as Partial<AppearanceState>;
    expect(mergeAppearance(corrupted)).toEqual(DEFAULT_APPEARANCE);
  });

  it("accepts each valid messageLayout value", () => {
    expect(mergeAppearance({ messageLayout: "discord" })).toEqual({
      ...DEFAULT_APPEARANCE,
      messageLayout: "discord",
    });
    expect(mergeAppearance({ messageLayout: "irc" })).toEqual({
      ...DEFAULT_APPEARANCE,
      messageLayout: "irc",
    });
  });

  it("falls back to the default when a field is a non-string type", () => {
    const corrupted = { theme: 42, density: null } as unknown as Partial<AppearanceState>;
    expect(mergeAppearance(corrupted)).toEqual(
      expect.objectContaining({
        theme: DEFAULT_APPEARANCE.theme,
        density: DEFAULT_APPEARANCE.density,
      }),
    );
  });

  it("accepts only a boolean unread-count preference", () => {
    expect(mergeAppearance({ showUnreadCounts: true })).toEqual({
      ...DEFAULT_APPEARANCE,
      showUnreadCounts: true,
    });
    expect(
      mergeAppearance({ showUnreadCounts: "yes" } as unknown as Partial<AppearanceState>),
    ).toEqual(DEFAULT_APPEARANCE);
  });

  it("validates each field independently — a valid theme survives an invalid density", () => {
    const partiallyCorrupted = {
      theme: "light",
      density: "spacious",
    } as unknown as Partial<AppearanceState>;
    expect(mergeAppearance(partiallyCorrupted)).toEqual({
      ...DEFAULT_APPEARANCE,
      theme: "light",
    });
  });
});
