import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useMessageActionPosition } from "./useMessageActionPosition";

let rowTop = 300;
let rowHeight = 30;
let toolbarHeight = 52;
let viewportHeight = 400;
let resizeCallbacks: ResizeObserverCallback[] = [];

function Surface() {
  const ref = useMessageActionPosition();
  return (
    <div ref={ref} data-message-actions data-testid="toolbar">
      <button type="button">More actions</button>
    </div>
  );
}

function Fixture() {
  return (
    <div data-virtuoso-scroller data-testid="scroller">
      <div id="message-test" data-testid="row">
        <Surface />
      </div>
    </div>
  );
}

beforeEach(() => {
  rowTop = 300;
  rowHeight = 30;
  toolbarHeight = 52;
  viewportHeight = 400;
  resizeCallbacks = [];
  vi.stubGlobal(
    "ResizeObserver",
    class {
      constructor(callback: ResizeObserverCallback) {
        resizeCallbacks.push(callback);
      }
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (
    this: HTMLElement,
  ) {
    if (this.hasAttribute("data-virtuoso-scroller"))
      return new DOMRect(0, 100, 800, viewportHeight);
    if (this.id === "message-test") return new DOMRect(0, rowTop, 800, rowHeight);
    return new DOMRect(400, rowTop, 300, toolbarHeight);
  });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("message action positioning", () => {
  it("keeps the toolbar above a fully visible message", () => {
    render(<Fixture />);
    expect(screen.getByTestId("toolbar")).toHaveStyle({ top: "-52px", bottom: "auto" });
  });

  it("places actions below a short row at the top edge", () => {
    rowTop = 100;
    render(<Fixture />);
    expect(screen.getByTestId("toolbar")).toHaveStyle({ top: "30px" });
  });

  it("keeps actions in the visible part of a tall message", () => {
    rowTop = -100;
    rowHeight = 900;
    render(<Fixture />);
    expect(screen.getByTestId("toolbar")).toHaveStyle({ top: "204px" });
  });

  it("updates an active toolbar while scrolling and stops after pointer exit", () => {
    render(<Fixture />);
    const row = screen.getByTestId("row");
    const toolbar = screen.getByTestId("toolbar");
    fireEvent.pointerEnter(row);
    rowTop = 100;
    fireEvent.scroll(screen.getByTestId("scroller"));
    expect(toolbar).toHaveStyle({ top: "30px" });
    fireEvent.pointerLeave(row);
    rowTop = 300;
    fireEvent.scroll(screen.getByTestId("scroller"));
    expect(toolbar).toHaveStyle({ top: "30px" });
    fireEvent.pointerDown(row);
    expect(toolbar).toHaveStyle({ top: "-52px" });
    fireEvent.pointerCancel(row);
  });

  it("repositions focused controls after resize and ignores events after unmount", async () => {
    const { unmount } = render(<Fixture />);
    const toolbar = screen.getByTestId("toolbar");
    act(() => screen.getByRole("button").focus());
    toolbarHeight = 64;
    act(() => resizeCallbacks.at(-1)!([], {} as ResizeObserver));
    expect(toolbar).toHaveStyle({ top: "-64px" });
    rowTop = 100;
    fireEvent.resize(window);
    expect(toolbar).toHaveStyle({ top: "30px" });
    fireEvent.focusOut(screen.getByRole("button"));
    unmount();
    await act(async () => {
      await Promise.resolve();
    });
    rowTop = 350;
    fireEvent.resize(window);
    expect(toolbar.style.top).toBe("30px");
  });

  it("tracks an open portal even when focus leaves the row", async () => {
    render(<Fixture />);
    const button = screen.getByRole("button");
    const toolbar = screen.getByTestId("toolbar");
    await act(async () => {
      button.setAttribute("data-state", "open");
    });
    rowTop = 100;
    fireEvent.scroll(screen.getByTestId("scroller"));
    expect(toolbar).toHaveStyle({ top: "30px" });
    await act(async () => {
      button.setAttribute("data-state", "closed");
    });
    rowTop = 300;
    fireEvent.scroll(screen.getByTestId("scroller"));
    expect(toolbar).toHaveStyle({ top: "30px" });
  });

  it("does not pin controls from a completely offscreen message", () => {
    rowTop = -100;
    render(<Fixture />);
    expect(screen.getByTestId("toolbar")).toHaveStyle({ top: "-52px" });
  });

  it("bounds the toolbar height in a small visual viewport", () => {
    const viewport = Object.assign(new EventTarget(), { offsetTop: 100, height: 45 });
    vi.stubGlobal("visualViewport", viewport);
    rowTop = 100;
    rowHeight = 200;
    render(<Fixture />);
    const toolbar = screen.getByTestId("toolbar");
    expect(toolbar).toHaveStyle({ top: "4px", maxHeight: "37px", overflowY: "auto" });
    fireEvent.pointerEnter(screen.getByTestId("row"));
    viewport.height = 90;
    act(() => viewport.dispatchEvent(new Event("resize")));
    expect(toolbar).toHaveStyle({ maxHeight: "82px" });
    act(() => viewport.dispatchEvent(new Event("scroll")));
  });

  it("leaves standalone and unmeasurable surfaces to their CSS fallback", () => {
    const first = render(<Surface />);
    expect(screen.getByTestId("toolbar").style.top).toBe("");
    first.unmount();
    viewportHeight = 0;
    render(<Fixture />);
    expect(screen.getByTestId("toolbar").style.top).toBe("");
  });
});
