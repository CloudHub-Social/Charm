import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ReactionChip } from "./ReactionChip";

const reaction = { key: "👍", count: 3, reacted_by_me: true };
const touch = { touches: [{ identifier: 1, clientX: 20, clientY: 20 }] };

describe("ReactionChip", () => {
  afterEach(() => vi.useRealTimers());

  it("toggles a short tap but never the compatibility click after a hold", () => {
    vi.useFakeTimers();
    const toggle = vi.fn();
    const details = vi.fn();
    render(<ReactionChip reaction={reaction} onToggle={toggle} onViewDetails={details} />);
    const chip = screen.getByRole("button");
    fireEvent.touchStart(chip, touch);
    act(() => vi.advanceTimersByTime(100));
    fireEvent.touchEnd(chip);
    fireEvent.click(chip);
    expect(toggle).toHaveBeenCalledOnce();
    expect(details).not.toHaveBeenCalled();

    fireEvent.touchStart(chip, touch);
    act(() => vi.advanceTimersByTime(600));
    expect(details).toHaveBeenCalledWith(chip);
    fireEvent.touchEnd(chip);
    fireEvent.click(chip);
    expect(toggle).toHaveBeenCalledOnce();

    fireEvent.pointerDown(chip, { pointerType: "mouse", button: 0 });
    fireEvent.click(chip);
    expect(toggle).toHaveBeenCalledTimes(2);
  });

  it.each(["touchMove", "touchCancel"] as const)("cancels a hold on %s", (event) => {
    vi.useFakeTimers();
    const details = vi.fn();
    const toggle = vi.fn();
    render(<ReactionChip reaction={reaction} onToggle={toggle} onViewDetails={details} />);
    const chip = screen.getByRole("button");
    fireEvent.touchStart(chip, touch);
    fireEvent[event](chip);
    act(() => vi.advanceTimersByTime(1000));
    fireEvent.click(chip);
    expect(details).not.toHaveBeenCalled();
    expect(toggle).not.toHaveBeenCalled();
  });

  it("cancels a hold when unmounted or disabled mid-gesture", () => {
    vi.useFakeTimers();
    const details = vi.fn();
    const props = { reaction, onToggle: vi.fn(), onViewDetails: details };
    const { rerender, unmount } = render(<ReactionChip {...props} />);
    fireEvent.touchStart(screen.getByRole("button"), touch);
    rerender(<ReactionChip {...props} disabled />);
    act(() => vi.advanceTimersByTime(1000));
    expect(details).not.toHaveBeenCalled();
    rerender(<ReactionChip {...props} />);
    fireEvent.touchStart(screen.getByRole("button"), touch);
    unmount();
    act(() => vi.advanceTimersByTime(1000));
    expect(details).not.toHaveBeenCalled();
  });

  it("isolates hold/context gestures from the message row", () => {
    vi.useFakeTimers();
    const rowTouch = vi.fn();
    const rowContext = vi.fn();
    const details = vi.fn();
    const toggle = vi.fn();
    render(
      <div onTouchStart={rowTouch} onContextMenu={rowContext}>
        <ReactionChip reaction={reaction} onToggle={toggle} onViewDetails={details} />
      </div>,
    );
    const chip = screen.getByRole("button");
    fireEvent.touchStart(chip, touch);
    fireEvent.contextMenu(chip);
    act(() => vi.advanceTimersByTime(1000));
    expect(rowTouch).not.toHaveBeenCalled();
    expect(rowContext).not.toHaveBeenCalled();
    expect(details).toHaveBeenCalledOnce();
    fireEvent.click(chip);
    expect(toggle).not.toHaveBeenCalled();
  });

  it.each([{ key: "F10", shiftKey: true }, { key: "ContextMenu" }])(
    "opens details with $key without toggling",
    (keys) => {
      const details = vi.fn();
      const toggle = vi.fn();
      render(<ReactionChip reaction={reaction} onToggle={toggle} onViewDetails={details} />);
      const chip = screen.getByRole("button");
      fireEvent.keyDown(chip, keys);
      expect(details).toHaveBeenCalledWith(chip);
      expect(toggle).not.toHaveBeenCalled();
      expect(chip).toHaveAttribute("aria-pressed", "true");
      expect(chip).toHaveAccessibleDescription(/Shift\+F10/);
    },
  );

  it("does not start a hold for a multitouch gesture or when details are off", () => {
    vi.useFakeTimers();
    const details = vi.fn();
    const { rerender } = render(
      <ReactionChip reaction={reaction} onToggle={vi.fn()} onViewDetails={details} />,
    );
    fireEvent.touchStart(screen.getByRole("button"), {
      touches: [...touch.touches, ...touch.touches],
    });
    act(() => vi.advanceTimersByTime(1000));
    expect(details).not.toHaveBeenCalled();
    rerender(<ReactionChip reaction={reaction} onToggle={vi.fn()} />);
    fireEvent.touchStart(screen.getByRole("button"), touch);
    act(() => vi.advanceTimersByTime(1000));
    expect(details).not.toHaveBeenCalled();
    expect(screen.getByRole("button")).not.toHaveAttribute("aria-describedby");
  });
});
