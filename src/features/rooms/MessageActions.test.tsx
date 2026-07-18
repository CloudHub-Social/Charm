import { createRef } from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MessageActions, type MessageActionsHandle } from "./MessageActions";

const mockUseFlag = vi.hoisted(() => vi.fn(() => true));
vi.mock("@/featureFlags", () => ({ useFlag: () => mockUseFlag() }));

function renderActions(overrides: Partial<Parameters<typeof MessageActions>[0]> = {}) {
  const onReply = vi.fn();
  const onReact = vi.fn();
  const onEdit = vi.fn();
  const onDelete = vi.fn();
  const onCopy = vi.fn();
  const onCopyLink = vi.fn();
  const onResend = vi.fn();
  const onDiscard = vi.fn();

  render(
    <MessageActions
      isOwn={false}
      canRedact={false}
      onReply={onReply}
      onReact={onReact}
      onEdit={onEdit}
      onDelete={onDelete}
      onCopy={onCopy}
      onCopyLink={onCopyLink}
      onResend={onResend}
      onDiscard={onDiscard}
      {...overrides}
    />,
  );

  return { onReply, onReact, onEdit, onDelete, onCopy, onCopyLink, onResend, onDiscard };
}

/** Radix's DropdownMenu opens on pointerdown, not click, in jsdom. */
function openMenu() {
  fireEvent.pointerDown(screen.getByRole("button", { name: "More actions" }), {
    button: 0,
    ctrlKey: false,
    pointerType: "mouse",
  });
}

describe("MessageActions", () => {
  beforeEach(() => {
    mockUseFlag.mockReturnValue(true);
  });

  it("shows Reply and Copy for a message that isn't own and can't be redacted", async () => {
    renderActions({ isOwn: false, canRedact: false });
    openMenu();

    expect(await screen.findByText("Reply")).toBeInTheDocument();
    expect(screen.getByText("Copy")).toBeInTheDocument();
    expect(screen.queryByText("Edit")).not.toBeInTheDocument();
    expect(screen.queryByText("Delete")).not.toBeInTheDocument();
  });

  it("shows Edit only when isOwn is true", async () => {
    renderActions({ isOwn: true, canRedact: false });
    openMenu();

    expect(await screen.findByText("Edit")).toBeInTheDocument();
  });

  it("shows Delete only when canRedact is true", async () => {
    renderActions({ isOwn: false, canRedact: true });
    openMenu();

    expect(await screen.findByText("Delete")).toBeInTheDocument();
  });

  it("shows both Edit and Delete for an own message the user can redact", async () => {
    renderActions({ isOwn: true, canRedact: true });
    openMenu();

    expect(await screen.findByText("Edit")).toBeInTheDocument();
    expect(screen.getByText("Delete")).toBeInTheDocument();
  });

  it("shows no bookmark item when onBookmark/onUnbookmark are both omitted", async () => {
    renderActions();
    openMenu();

    expect(await screen.findByText("Reply")).toBeInTheDocument();
    expect(screen.queryByText("Bookmark")).not.toBeInTheDocument();
    expect(screen.queryByText("Remove bookmark")).not.toBeInTheDocument();
  });

  it("shows Bookmark (not Remove bookmark) when isBookmarked is false", async () => {
    const onBookmark = vi.fn();
    renderActions({ onBookmark, isBookmarked: false });
    openMenu();

    expect(await screen.findByText("Bookmark")).toBeInTheDocument();
    expect(screen.queryByText("Remove bookmark")).not.toBeInTheDocument();
  });

  it("shows Remove bookmark (not Bookmark) when isBookmarked is true", async () => {
    const onUnbookmark = vi.fn();
    renderActions({ onUnbookmark, isBookmarked: true });
    openMenu();

    expect(await screen.findByText("Remove bookmark")).toBeInTheDocument();
    expect(screen.queryByText("Bookmark")).not.toBeInTheDocument();
  });

  it("calls onBookmark when Bookmark is selected", async () => {
    const onBookmark = vi.fn();
    renderActions({ onBookmark, isBookmarked: false });
    openMenu();
    fireEvent.click(await screen.findByText("Bookmark"));

    expect(onBookmark).toHaveBeenCalledOnce();
  });

  it("calls onUnbookmark when Remove bookmark is selected", async () => {
    const onUnbookmark = vi.fn();
    renderActions({ onUnbookmark, isBookmarked: true });
    openMenu();
    fireEvent.click(await screen.findByText("Remove bookmark"));

    expect(onUnbookmark).toHaveBeenCalledOnce();
  });

  it("calls onReply when Reply is selected", async () => {
    const { onReply } = renderActions();
    openMenu();
    fireEvent.click(await screen.findByText("Reply"));

    expect(onReply).toHaveBeenCalledOnce();
  });

  it("calls onDelete when Delete is selected", async () => {
    const { onDelete } = renderActions({ canRedact: true });
    openMenu();
    fireEvent.click(await screen.findByText("Delete"));

    expect(onDelete).toHaveBeenCalledOnce();
  });

  it("calls onCopyLink when Copy link is selected", async () => {
    const { onCopyLink } = renderActions();
    openMenu();
    fireEvent.click(await screen.findByText("Copy link"));

    expect(onCopyLink).toHaveBeenCalledOnce();
  });

  it("hides Copy link when message-action parity is disabled", async () => {
    mockUseFlag.mockReturnValue(false);
    renderActions();
    openMenu();

    expect(await screen.findByText("Reply")).toBeInTheDocument();
    expect(screen.queryByText("Copy link")).not.toBeInTheDocument();
  });

  it("has 44x44px hit targets for the trigger buttons", () => {
    renderActions();
    const moreButton = screen.getByRole("button", { name: "More actions" });
    const reactButton = screen.getByRole("button", { name: "React" });

    expect(moreButton.className).toContain("size-11");
    expect(reactButton.className).toContain("size-11");
  });

  it("disables relation actions (Reply/React/Edit/Delete) for a still-pending message", async () => {
    renderActions({ isOwn: true, canRedact: true, disableRelationActions: true });
    openMenu();

    expect(screen.getByRole("button", { name: "React" })).toBeDisabled();
    const reply = (await screen.findByText("Reply")).closest('[role="menuitem"]');
    const edit = screen.getByText("Edit").closest('[role="menuitem"]');
    const del = screen.getByText("Delete").closest('[role="menuitem"]');
    const copy = screen.getByText("Copy").closest('[role="menuitem"]');
    const copyLink = screen.getByText("Copy link").closest('[role="menuitem"]');

    expect(reply).toHaveAttribute("data-disabled");
    expect(edit).toHaveAttribute("data-disabled");
    expect(del).toHaveAttribute("data-disabled");
    // Copy only needs the already-known body text, so it stays enabled even
    // on a pending message.
    expect(copy).not.toHaveAttribute("data-disabled");
    expect(copyLink).toHaveAttribute("data-disabled");
  });

  it("disables Edit, Copy, Reply, and React for an undecrypted message, but not Delete", async () => {
    renderActions({ isOwn: true, canRedact: true, isUndecrypted: true });
    openMenu();

    expect(screen.getByRole("button", { name: "React" })).toBeDisabled();
    const reply = (await screen.findByText("Reply")).closest('[role="menuitem"]');
    const edit = screen.getByText("Edit").closest('[role="menuitem"]');
    const copy = screen.getByText("Copy").closest('[role="menuitem"]');
    const copyLink = screen.getByText("Copy link").closest('[role="menuitem"]');
    const del = screen.getByText("Delete").closest('[role="menuitem"]');

    expect(reply).toHaveAttribute("data-disabled");
    expect(edit).toHaveAttribute("data-disabled");
    expect(copy).toHaveAttribute("data-disabled");
    expect(copyLink).toHaveAttribute("data-disabled");
    // Redacting doesn't need the plaintext, so Delete stays available even
    // though the message never decrypted.
    expect(del).not.toHaveAttribute("data-disabled");
  });

  it("does not call onCopy when Copy is selected for an undecrypted message", async () => {
    const { onCopy } = renderActions({ isUndecrypted: true });
    openMenu();
    fireEvent.click(await screen.findByText("Copy"));

    expect(onCopy).not.toHaveBeenCalled();
  });

  it("does not show Resend or Discard for a normal (non-failed) message", async () => {
    renderActions({ isOwn: true, canRedact: true, isError: false });
    openMenu();

    expect(await screen.findByText("Reply")).toBeInTheDocument();
    expect(screen.queryByText("Resend")).not.toBeInTheDocument();
    expect(screen.queryByText("Discard")).not.toBeInTheDocument();
  });

  it("shows Resend and Discard, and hides Delete, for a failed send", async () => {
    renderActions({ isOwn: true, canRedact: true, isError: true, disableRelationActions: true });
    openMenu();

    expect(await screen.findByText("Resend")).toBeInTheDocument();
    expect(screen.getByText("Discard")).toBeInTheDocument();
    expect(screen.queryByText("Delete")).not.toBeInTheDocument();
  });

  it("hides Resend and Discard when message-action parity is disabled, even for a failed send", async () => {
    mockUseFlag.mockReturnValue(false);
    renderActions({ isOwn: true, canRedact: true, isError: true });
    openMenu();

    expect(await screen.findByText("Reply")).toBeInTheDocument();
    expect(screen.queryByText("Resend")).not.toBeInTheDocument();
    expect(screen.queryByText("Discard")).not.toBeInTheDocument();
  });

  it("calls onResend when Resend is selected", async () => {
    const { onResend } = renderActions({ isError: true });
    openMenu();
    fireEvent.click(await screen.findByText("Resend"));

    expect(onResend).toHaveBeenCalledOnce();
  });

  it("calls onDiscard when Discard is selected", async () => {
    const { onDiscard } = renderActions({ isError: true });
    openMenu();
    fireEvent.click(await screen.findByText("Discard"));

    expect(onDiscard).toHaveBeenCalledOnce();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("does not open the menu on a quick tap, even when a parent row forwards the same long-press gesture", () => {
    // Mirrors ChatShell's actual wiring: a parent element (there, the whole
    // message row) also calls the same imperative startLongPress/
    // cancelLongPress via the ref, for touch discoverability. Without
    // stopPropagation in MessageActions' own touch handlers, a touch here
    // bubbles to the parent's handler too — overwriting the timer ref with a
    // *second* timer before the first is ever cleared, so releasing quickly
    // only clears the second one and the first still fires the menu open
    // after the long-press delay elapses.
    const ref = createRef<MessageActionsHandle>();
    const outerStartLongPress = vi.fn(() => ref.current?.startLongPress());
    const outerCancelLongPress = vi.fn(() => ref.current?.cancelLongPress());
    render(
      <div data-testid="row" onTouchStart={outerStartLongPress} onTouchEnd={outerCancelLongPress}>
        <MessageActions
          ref={ref}
          isOwn={false}
          canRedact={false}
          onReply={vi.fn()}
          onReact={vi.fn()}
          onEdit={vi.fn()}
          onDelete={vi.fn()}
          onCopy={vi.fn()}
          onCopyLink={vi.fn()}
        />
      </div>,
    );

    const reactButton = screen.getByRole("button", { name: "React" });
    fireEvent.touchStart(reactButton, { bubbles: true });
    fireEvent.touchEnd(reactButton, { bubbles: true });

    // The bug this guards against: without stopPropagation, the touch
    // bubbles to the row's own handler, which calls the *same* imperative
    // startLongPress/cancelLongPress a second time, overwriting (and thus
    // orphaning, uncleared) MessageActions' own first timer.
    expect(outerStartLongPress).not.toHaveBeenCalled();
    expect(outerCancelLongPress).not.toHaveBeenCalled();

    vi.useFakeTimers();
    fireEvent.touchStart(reactButton, { bubbles: true });
    fireEvent.touchEnd(reactButton, { bubbles: true });
    vi.advanceTimersByTime(500);

    expect(screen.queryByText("Reply")).not.toBeInTheDocument();
  });

  // --- Spec day-2/04: message pinning ---

  it("doesn't show Pin when canPin is false", async () => {
    renderActions({ canPin: false, isPinned: false });
    openMenu();

    expect(await screen.findByText("Reply")).toBeInTheDocument();
    expect(screen.queryByText("Pin")).not.toBeInTheDocument();
    expect(screen.queryByText("Unpin")).not.toBeInTheDocument();
  });

  it("shows Pin when canPin is true and the message isn't pinned", async () => {
    renderActions({ canPin: true, isPinned: false, onPin: vi.fn(), onUnpin: vi.fn() });
    openMenu();

    expect(await screen.findByText("Pin")).toBeInTheDocument();
    expect(screen.queryByText("Unpin")).not.toBeInTheDocument();
  });

  it("shows Unpin instead of Pin when the message is already pinned", async () => {
    renderActions({ canPin: true, isPinned: true, onPin: vi.fn(), onUnpin: vi.fn() });
    openMenu();

    expect(await screen.findByText("Unpin")).toBeInTheDocument();
    expect(screen.queryByText("Pin")).not.toBeInTheDocument();
  });

  it("calls onPin when Pin is selected", async () => {
    const onPin = vi.fn();
    renderActions({ canPin: true, isPinned: false, onPin, onUnpin: vi.fn() });
    openMenu();

    fireEvent.click(await screen.findByText("Pin"));
    expect(onPin).toHaveBeenCalledTimes(1);
  });

  it("calls onUnpin when Unpin is selected", async () => {
    const onUnpin = vi.fn();
    renderActions({ canPin: true, isPinned: true, onPin: vi.fn(), onUnpin });
    openMenu();

    fireEvent.click(await screen.findByText("Unpin"));
    expect(onUnpin).toHaveBeenCalledTimes(1);
  });

  it("hides Pin/Unpin for a failed send (isError), matching Delete's own gating", async () => {
    renderActions({ canPin: true, isPinned: false, onPin: vi.fn(), isError: true });
    openMenu();

    expect(screen.queryByText("Pin")).not.toBeInTheDocument();
    expect(screen.queryByText("Unpin")).not.toBeInTheDocument();
  });

  it("disables Pin (not yet pinned) when undecrypted", async () => {
    renderActions({ canPin: true, isPinned: false, onPin: vi.fn(), isUndecrypted: true });
    openMenu();

    expect(await screen.findByText("Pin")).toHaveAttribute("aria-disabled", "true");
  });

  it("keeps Unpin enabled for an already-pinned message even when undecrypted", async () => {
    // Review fix regression test: `unpin_event` only needs the event ID, not
    // decrypted content, and is the only way to remove a stuck pin — an
    // encrypted room can have an already-pinned message go undecrypted after
    // a key gap or restore, and gating Unpin the same way Pin/reply/react
    // are would leave it permanently unremovable.
    const onUnpin = vi.fn();
    renderActions({ canPin: true, isPinned: true, onPin: vi.fn(), onUnpin, isUndecrypted: true });
    openMenu();

    const unpinItem = await screen.findByText("Unpin");
    expect(unpinItem).not.toHaveAttribute("aria-disabled", "true");
    fireEvent.click(unpinItem);
    expect(onUnpin).toHaveBeenCalledTimes(1);
  });
});
