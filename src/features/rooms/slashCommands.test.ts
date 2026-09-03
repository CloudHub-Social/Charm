import { describe, expect, it } from "vitest";
import { parseSlashCommand } from "./slashCommands";
import { filterSlashCommands } from "./composerSuggestions";

describe("staged message-style commands", () => {
  it("stages notice parsing and suggestions without converting it to plain text", () => {
    expect(parseSlashCommand("/notice hello")).toBeNull();
    expect(filterSlashCommands("notice")).toEqual([]);
    expect(parseSlashCommand("/notice hello", true)).toEqual({
      command: "notice",
      args: ["hello"],
    });
    expect(filterSlashCommands("notice", true).map((spec) => spec.name)).toEqual(["notice"]);
  });
  it.each(["unban", "nick", "ignore", "unignore"])(
    "stages /%s parsing and suggestions",
    (command) => {
      expect(parseSlashCommand(`/${command} @alice:example.org`)).toBeNull();
      expect(filterSlashCommands(command)).toEqual([]);
      expect(parseSlashCommand(`/${command} @alice:example.org`, true)).toEqual({
        command,
        args: ["@alice:example.org"],
        action: true,
      });
      expect(filterSlashCommands(command, true).map((spec) => spec.name)).toContain(command);
    },
  );
  it.each(["plain", "shrug", "tableflip"])(
    "keeps /%s literal and out of suggestions while disabled",
    (name) => {
      expect(parseSlashCommand(`/${name} hello`)).toBeNull();
      expect(filterSlashCommands(name)).toEqual([]);
      expect(filterSlashCommands(name, true).map((spec) => spec.name)).toEqual([name]);
    },
  );

  it("preserves internal whitespace for explicit plain messages", () => {
    expect(parseSlashCommand("/plain hello  world\nnext line", true)).toEqual({
      command: "plain",
      args: ["hello", "world", "next", "line"],
      text: "hello  world\nnext line",
    });
    expect(parseSlashCommand("//plain hello", true)).toBeNull();
  });
});
