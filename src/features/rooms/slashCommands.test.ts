import { describe, expect, it } from "vitest";
import { parseSlashCommand } from "./slashCommands";
import { filterSlashCommands } from "./composerSuggestions";

describe("staged message-style commands", () => {
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
