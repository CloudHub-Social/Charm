import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { openMessageContextMenu, useMessageActionTouch } from "./messageActionSurface";

function setup(expanded = false) {
  const actions = { startLongPress: vi.fn(), cancelLongPress: vi.fn(), openMenu: vi.fn() };
  function Fixture() {
    const touch = useMessageActionTouch(() => actions);
    return (
      <div
        data-testid="message"
        {...touch}
        onContextMenu={(event) => openMessageContextMenu(event, actions)}
      >
        <span>Message text</span>
        <a href="#detail">Link</a>
        <button type="button">Media control</button>
        <div data-message-actions>
          <button type="button" aria-haspopup="menu" aria-expanded={expanded}>
            More actions
          </button>
        </div>
      </div>
    );
  }
  render(<Fixture />);
  return {
    row: screen.getByTestId("message"),
    trigger: screen.getByRole("button", { name: "More actions" }),
    text: screen.getByText("Message text"),
    actions,
  };
}

function touchStart(element: HTMLElement) {
  fireEvent.touchStart(element, { touches: [{ identifier: 1 }] });
}

function touchEnd(element: HTMLElement) {
  fireEvent.touchEnd(element, { touches: [] });
}

describe("message action surface", () => {
  it("reveals the native menu trigger on a text tap without making the message a control", () => {
    const { row, trigger, text, actions } = setup();
    touchStart(text);
    touchEnd(text);
    expect(trigger).toHaveFocus();
    expect(row).not.toHaveAttribute("tabindex");
    expect(row).not.toHaveAttribute("role");
    expect(actions.startLongPress).toHaveBeenCalledOnce();
    expect(actions.openMenu).not.toHaveBeenCalled();
  });

  it("does not reveal actions after scrolling or touch cancellation", () => {
    const { trigger, text } = setup();
    touchStart(text);
    fireEvent.touchMove(text);
    touchEnd(text);
    expect(trigger).not.toHaveFocus();
    touchStart(text);
    fireEvent.touchCancel(text);
    touchEnd(text);
    expect(trigger).not.toHaveFocus();
  });

  it("leaves embedded links and controls alone", () => {
    const { trigger, actions } = setup();
    for (const element of [screen.getByRole("link"), screen.getByText("Media control")]) {
      touchStart(element);
      touchEnd(element);
      fireEvent.contextMenu(element);
    }
    expect(trigger).not.toHaveFocus();
    expect(actions.startLongPress).not.toHaveBeenCalled();
    expect(actions.openMenu).not.toHaveBeenCalled();
  });

  it("does not treat a multi-touch gesture as a message tap", () => {
    const { trigger, text, actions } = setup();
    fireEvent.touchStart(text, { touches: [{ identifier: 1 }, { identifier: 2 }] });
    touchEnd(text);
    expect(trigger).not.toHaveFocus();
    expect(actions.startLongPress).not.toHaveBeenCalled();
  });

  it("preserves text selected during a gesture and its native context menu", () => {
    const { trigger, text, actions } = setup();
    touchStart(text);
    const selection = window.getSelection();
    const range = document.createRange();
    range.selectNodeContents(text);
    selection?.addRange(range);
    try {
      touchEnd(text);
      fireEvent.contextMenu(text);
      expect(trigger).not.toHaveFocus();
      expect(actions.openMenu).not.toHaveBeenCalled();
    } finally {
      selection?.removeAllRanges();
    }
  });

  it("does not steal focus back from a menu opened by long press", () => {
    const { trigger, text } = setup(true);
    const focusedControl = screen.getByRole("button", { name: "Media control" });
    focusedControl.focus();
    touchStart(text);
    touchEnd(text);
    expect(focusedControl).toHaveFocus();
    expect(trigger).not.toHaveFocus();
  });

  it("opens the message context menu without replacing a link context menu", () => {
    const { text, actions } = setup();
    fireEvent.contextMenu(text);
    expect(actions.openMenu).toHaveBeenCalledOnce();
    fireEvent.contextMenu(screen.getByRole("link"));
    expect(actions.openMenu).toHaveBeenCalledOnce();
  });
});
