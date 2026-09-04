import { Editor } from "@tiptap/core";
import { describe, expect, it } from "vitest";
import { guardedStarterKit } from "./guardedStarterKit";

describe("staged formatting rules", () => {
  it.each([
    ["strike", { key: "s", ctrlKey: true, shiftKey: true }],
    ["codeBlock", { key: "c", ctrlKey: true, altKey: true }],
  ])("checks the current flag for every %s shortcut", (format, shortcut) => {
    let enabled = false;
    const editor = new Editor({
      extensions: [guardedStarterKit(() => enabled)],
      content: "<p>text</p>",
    });
    try {
      editor.commands.selectAll();
      editor.view.dom.dispatchEvent(
        new KeyboardEvent("keydown", { ...shortcut, bubbles: true, cancelable: true }),
      );
      expect(editor.isActive(format)).toBe(false);
      enabled = true;
      editor.view.dom.dispatchEvent(
        new KeyboardEvent("keydown", { ...shortcut, bubbles: true, cancelable: true }),
      );
      expect(editor.isActive(format)).toBe(true);
      editor.commands.clearNodes();
      editor.commands.unsetAllMarks();
      enabled = false;
      editor.view.dom.dispatchEvent(
        new KeyboardEvent("keydown", { ...shortcut, bubbles: true, cancelable: true }),
      );
      expect(editor.isActive(format)).toBe(false);
    } finally {
      editor.destroy();
    }
  });
});
