import { describe, expect, it } from "vitest";
import { resolveEnterKeyAction } from "./composerKeybinding";

describe("resolveEnterKeyAction", () => {
  it("sends on Enter when the menu is closed", () => {
    expect(resolveEnterKeyAction(false, false)).toBe("send");
  });

  it("inserts a newline on Shift+Enter when the menu is closed", () => {
    expect(resolveEnterKeyAction(true, false)).toBe("newline");
  });

  it("selects the highlighted menu item on Enter when the menu is open", () => {
    expect(resolveEnterKeyAction(false, true)).toBe("select-menu-item");
  });

  it("still inserts a newline on Shift+Enter even when the menu is open", () => {
    expect(resolveEnterKeyAction(true, true)).toBe("newline");
  });
});
