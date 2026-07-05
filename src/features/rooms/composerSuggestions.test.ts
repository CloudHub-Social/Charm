import { describe, expect, it } from "vitest";
import {
  filterEmoji,
  filterRoomMembers,
  filterRooms,
  filterSlashCommands,
} from "./composerSuggestions";
import { resolveInlineShortcodes } from "./emojiShortcodes";
import { parseSlashCommand, unescapeLiteralSlash } from "./slashCommands";

describe("filterSlashCommands", () => {
  it("matches by name prefix", () => {
    expect(filterSlashCommands("k").map((c) => c.name)).toEqual(["kick"]);
  });

  it("returns all commands for an empty query", () => {
    expect(filterSlashCommands("").length).toBe(5);
  });

  it("returns nothing for an unknown prefix", () => {
    expect(filterSlashCommands("zzz")).toEqual([]);
  });
});

describe("filterEmoji", () => {
  it("matches by shortcode prefix", () => {
    const results = filterEmoji("smi");
    expect(results.map((r) => r.shortcode)).toContain("smile");
  });

  it("is case-insensitive", () => {
    expect(filterEmoji("SMI").length).toBeGreaterThan(0);
  });
});

describe("resolveInlineShortcodes", () => {
  it("resolves a known shortcode to its glyph", () => {
    expect(resolveInlineShortcodes("hey :smile:")).toBe("hey 😄");
  });

  it("leaves unknown shortcodes untouched", () => {
    expect(resolveInlineShortcodes("hey :not_an_emoji:")).toBe("hey :not_an_emoji:");
  });
});

describe("filterRoomMembers", () => {
  const members = [
    { userId: "@alice:example.org", displayName: "Alice" },
    { userId: "@bob:example.org", displayName: "Bob" },
  ];

  it("matches by display name", () => {
    expect(filterRoomMembers("ali", members).map((m) => m.userId)).toEqual(["@alice:example.org"]);
  });

  it("matches by user id", () => {
    expect(filterRoomMembers("bob", members).map((m) => m.userId)).toEqual(["@bob:example.org"]);
  });

  it("returns everyone for an empty query", () => {
    expect(filterRoomMembers("", members).length).toBe(2);
  });
});

describe("filterRooms", () => {
  const rooms = [
    { roomId: "!a:example.org", name: "General", alias: "#general:example.org" },
    { roomId: "!b:example.org", name: "Random", alias: "#random:example.org" },
  ];

  it("matches by alias", () => {
    expect(filterRooms("gen", rooms).map((r) => r.roomId)).toEqual(["!a:example.org"]);
  });

  it("matches by name", () => {
    expect(filterRooms("Random", rooms).map((r) => r.roomId)).toEqual(["!b:example.org"]);
  });
});

describe("parseSlashCommand", () => {
  it("parses a known command with args", () => {
    expect(parseSlashCommand("/kick @bob:example.org spamming")).toEqual({
      command: "kick",
      args: ["@bob:example.org", "spamming"],
    });
  });

  it("parses /me with no args as an empty args list", () => {
    expect(parseSlashCommand("/me")).toEqual({ command: "me", args: [] });
  });

  it("returns null for an unknown /x command (passthrough)", () => {
    expect(parseSlashCommand("/nonexistent thing")).toBeNull();
  });

  it("returns null for a message not starting with /", () => {
    expect(parseSlashCommand("hello /me")).toBeNull();
  });

  it("treats a leading // as an escaped literal, not a command", () => {
    expect(parseSlashCommand("//usr/bin/env")).toBeNull();
  });
});

describe("unescapeLiteralSlash", () => {
  it("collapses a leading // to a single /", () => {
    expect(unescapeLiteralSlash("//usr/bin/env")).toBe("/usr/bin/env");
  });

  it("leaves other text untouched", () => {
    expect(unescapeLiteralSlash("hello")).toBe("hello");
  });
});
