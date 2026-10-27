import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import {
  focusMessageActions,
  handleMessageActionKey,
  openMessageContextMenu,
} from "./messageActionSurface";

function setup() {
  const actions = { startLongPress: vi.fn(), cancelLongPress: vi.fn(), openMenu: vi.fn() };
  render(
    <div
      role="group"
      aria-label="Message"
      tabIndex={0}
      onClick={focusMessageActions}
      onKeyDown={(event) => handleMessageActionKey(event, actions)}
      onContextMenu={(event) => openMessageContextMenu(event, actions)}
    >
      <span>Message text</span>
      <a href="#detail">Link</a>
      <button type="button">Media control</button>
    </div>,
  );
  return { row: screen.getByRole("group"), actions };
}

describe("message action surface", () => {
  it("reveals actions on a text tap but leaves embedded controls alone", () => {
    const { row } = setup();
    fireEvent.click(screen.getByText("Message text"));
    expect(row).toHaveFocus();
    row.blur();
    fireEvent.click(screen.getByRole("button"));
    expect(row).not.toHaveFocus();
  });

  it("preserves text selection", () => {
    const { row } = setup();
    const selection = window.getSelection();
    const range = document.createRange();
    range.selectNodeContents(screen.getByText("Message text"));
    selection?.addRange(range);
    try {
      fireEvent.click(screen.getByText("Message text"));
      expect(row).not.toHaveFocus();
    } finally {
      selection?.removeAllRanges();
    }
  });

  it("opens the row context menu without replacing a link context menu", () => {
    const { actions } = setup();
    fireEvent.contextMenu(screen.getByText("Message text"));
    expect(actions.openMenu).toHaveBeenCalledOnce();
    fireEvent.contextMenu(screen.getByRole("link"));
    expect(actions.openMenu).toHaveBeenCalledOnce();
  });

  it("supports keyboard context menus and Escape without capturing child keys", () => {
    const { row, actions } = setup();
    row.focus();
    fireEvent.keyDown(row, { key: "F10", shiftKey: true });
    fireEvent.keyDown(row, { key: "ContextMenu" });
    expect(actions.openMenu).toHaveBeenCalledTimes(2);
    fireEvent.keyDown(screen.getByRole("button"), { key: "ContextMenu" });
    expect(actions.openMenu).toHaveBeenCalledTimes(2);
    fireEvent.keyDown(row, { key: "ArrowDown" });
    expect(row).toHaveFocus();
    fireEvent.keyDown(row, { key: "Escape" });
    expect(row).not.toHaveFocus();
  });
});
