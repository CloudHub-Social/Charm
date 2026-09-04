import { Editor } from "@tiptap/core";
import { describe, expect, it } from "vitest";
import { guardedStarterKit } from "./guardedStarterKit";

describe("staged formatting rules", () => {
  it.each([
    ["strike", "Mod-Shift-x"],
    ["codeBlock", "Mod-Alt-c"],
  ])("checks the current flag for every %s shortcut", (format, shortcut) => {
    let enabled = false;
    const editor = new Editor({
      extensions: [guardedStarterKit(() => enabled)],
      content: "<p>text</p>",
    });
    try {
      editor.commands.selectAll();
      editor.commands.keyboardShortcut(shortcut);
      expect(editor.isActive(format)).toBe(false);
      enabled = true;
      editor.commands.keyboardShortcut(shortcut);
      expect(editor.isActive(format)).toBe(true);
      editor.commands.clearNodes();
      editor.commands.unsetAllMarks();
      enabled = false;
      editor.commands.keyboardShortcut(shortcut);
      expect(editor.isActive(format)).toBe(false);
    } finally {
      editor.destroy();
    }
  });
});
