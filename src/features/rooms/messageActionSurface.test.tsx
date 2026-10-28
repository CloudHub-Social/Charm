import { createPortal } from "react-dom";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { useMessageActionTouch } from "./messageActionSurface";

function setup(expanded = false) {
  const actions = { startLongPress: vi.fn(), cancelLongPress: vi.fn(), openMenu: vi.fn() };
  function Fixture() {
    const touch = useMessageActionTouch(() => actions);
    return (
      <div data-testid="message" {...touch}>
        <span>Message text</span>
        <details>
          <summary>
            <span>Disclosure toggle</span>
          </summary>
          Collapsed content
        </details>
        {createPortal(<div>Portalled image surface</div>, document.body)}
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
      fireEvent.pointerDown(element, { button: 2, pointerType: "mouse" });
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
    const selection = window.getSelection();
    selection?.removeAllRanges();
    touchStart(text);
    const range = document.createRange();
    range.selectNodeContents(text);
    selection?.addRange(range);
    try {
      expect(selection?.toString()).toBe("Message text");
      expect(actions.startLongPress).toHaveBeenCalledOnce();
      touchEnd(text);
      fireEvent.contextMenu(text);
      expect(trigger).not.toHaveFocus();
      expect(actions.openMenu).not.toHaveBeenCalled();
    } finally {
      selection?.removeAllRanges();
    }
  });

  it.each([
    { button: 2, ctrlKey: false },
    { button: 0, ctrlKey: true },
  ])("opens actions for secondary-click selection ($button, $ctrlKey)", (pointer) => {
    const { text, actions } = setup();
    const selection = window.getSelection()!;
    selection.removeAllRanges();
    fireEvent.pointerDown(text, { ...pointer, pointerType: "mouse" });
    const range = document.createRange();
    range.setStart(text.firstChild!, 0);
    range.setEnd(text.firstChild!, 7);
    selection.addRange(range);
    try {
      expect(selection.toString()).toBe("Message");
      expect(fireEvent.contextMenu(text, pointer)).toBe(false);
      expect(actions.openMenu).toHaveBeenCalledOnce();
      expect(selection.toString()).toBe("Message");
    } finally {
      selection.removeAllRanges();
    }
  });

  it.each(["secondary", "keyboard"])("opens actions with outside selection via %s", (entry) => {
    const { text, actions } = setup();
    const otherMessage = document.createElement("div");
    otherMessage.textContent = "Another selected message";
    document.body.append(otherMessage);
    const selection = window.getSelection()!;
    selection.removeAllRanges();
    const range = document.createRange();
    range.selectNodeContents(otherMessage);
    selection.addRange(range);
    try {
      if (entry === "secondary") {
        fireEvent.pointerDown(text, { button: 2, pointerType: "mouse" });
      } else {
        fireEvent.keyDown(text, { key: "ContextMenu" });
      }
      expect(fireEvent.contextMenu(text, { button: 2 })).toBe(false);
      expect(actions.openMenu).toHaveBeenCalledOnce();
      expect(selection.toString()).toBe("Another selected message");
    } finally {
      selection.removeAllRanges();
      otherMessage.remove();
    }
  });

  it("preserves a deliberate selection spanning the clicked message and another node", () => {
    const { text, actions } = setup();
    const otherMessage = document.createElement("div");
    otherMessage.textContent = "Another message";
    document.body.append(otherMessage);
    const selection = window.getSelection()!;
    selection.removeAllRanges();
    const range = document.createRange();
    range.setStart(text.firstChild!, 3);
    range.setEnd(otherMessage.firstChild!, 7);
    selection.addRange(range);
    const selectedText = selection.toString();
    try {
      expect(selectedText).toContain("sage text");
      fireEvent.pointerDown(text, { button: 2, pointerType: "mouse" });
      expect(fireEvent.contextMenu(text, { button: 2 })).toBe(true);
      expect(actions.openMenu).not.toHaveBeenCalled();
      expect(selection.toString()).toBe(selectedText);
    } finally {
      selection.removeAllRanges();
      otherMessage.remove();
    }
  });

  it("preserves a deliberate selection made before secondary pointer down", () => {
    const { text, actions } = setup();
    const selection = window.getSelection()!;
    selection.removeAllRanges();
    const range = document.createRange();
    range.selectNodeContents(text);
    selection.addRange(range);
    try {
      fireEvent.pointerDown(text, { button: 2, pointerType: "mouse" });
      expect(fireEvent.contextMenu(text, { button: 2 })).toBe(true);
      expect(actions.openMenu).not.toHaveBeenCalled();
      expect(selection.toString()).toBe("Message text");
    } finally {
      selection.removeAllRanges();
    }
  });

  it("does not reuse a secondary-click snapshot for a keyboard context request", () => {
    const { text, actions } = setup();
    const selection = window.getSelection()!;
    selection.removeAllRanges();
    fireEvent.pointerDown(text, { button: 2, pointerType: "mouse" });
    const range = document.createRange();
    range.selectNodeContents(text);
    selection.addRange(range);
    try {
      fireEvent.keyDown(text, { key: "ContextMenu" });
      expect(fireEvent.contextMenu(text, { button: 2 })).toBe(true);
      expect(actions.openMenu).not.toHaveBeenCalled();
    } finally {
      selection.removeAllRanges();
    }
  });

  it("preserves text selected by a touch gesture before its context menu", () => {
    const { text, actions } = setup();
    const selection = window.getSelection()!;
    selection.removeAllRanges();
    fireEvent.pointerDown(text, { button: 0, pointerType: "touch" });
    const range = document.createRange();
    range.selectNodeContents(text);
    selection.addRange(range);
    try {
      expect(fireEvent.contextMenu(text, { button: 2 })).toBe(true);
      expect(actions.openMenu).not.toHaveBeenCalled();
      expect(selection.toString()).toBe("Message text");
    } finally {
      selection.removeAllRanges();
    }
  });

  it("discards selection state from a cancelled secondary pointer", () => {
    const { text, actions } = setup();
    const selection = window.getSelection()!;
    selection.removeAllRanges();
    fireEvent.pointerDown(text, { button: 2, pointerType: "mouse" });
    fireEvent.pointerCancel(text, { pointerType: "mouse" });
    const range = document.createRange();
    range.selectNodeContents(text);
    selection.addRange(range);
    try {
      expect(fireEvent.contextMenu(text, { button: 2 })).toBe(true);
      expect(actions.openMenu).not.toHaveBeenCalled();
    } finally {
      selection.removeAllRanges();
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
  it("preserves native disclosure taps and context menus", () => {
    const { trigger, actions } = setup();
    const summary = screen.getByText("Disclosure toggle");
    touchStart(summary);
    expect(fireEvent.touchEnd(summary, { touches: [] })).toBe(true);
    fireEvent.pointerDown(summary, { button: 2, pointerType: "mouse" });
    expect(fireEvent.contextMenu(summary)).toBe(true);
    expect(trigger).not.toHaveFocus();
    expect(actions.startLongPress).not.toHaveBeenCalled();
    expect(actions.openMenu).not.toHaveBeenCalled();
  });

  it("does not consume touch or context events bubbling from a React portal", () => {
    const { row, trigger, actions } = setup();
    const target = screen.getByText("Portalled image surface");
    expect(row).not.toContainElement(target);
    touchStart(target);
    expect(fireEvent.touchEnd(target, { touches: [] })).toBe(true);
    fireEvent.pointerDown(target, { button: 2, pointerType: "mouse" });
    expect(fireEvent.contextMenu(target)).toBe(true);
    expect(trigger).not.toHaveFocus();
    expect(actions.startLongPress).not.toHaveBeenCalled();
    expect(actions.openMenu).not.toHaveBeenCalled();
  });
});
