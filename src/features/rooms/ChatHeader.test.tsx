import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { makeRoomSummary } from "./testFixtures";
import { ChatHeader } from "./ChatHeader";

function renderHeader(overrides: Partial<React.ComponentProps<typeof ChatHeader>> = {}) {
  const props: React.ComponentProps<typeof ChatHeader> = {
    room: makeRoomSummary({ name: "General" }),
    mobile: false,
    presence: null,
    membersDrawerOpen: false,
    onToggleMembers: vi.fn(),
    messagePinningEnabled: true,
    pinnedMessagesDrawerOpen: false,
    pinnedMessageCount: 2,
    onTogglePinnedMessages: vi.fn(),
    onOpenRoomSettings: vi.fn(),
    jumpToDateEnabled: true,
    onJumpToDate: vi.fn(),
    ...overrides,
  };

  render(<ChatHeader {...props} />);
  return props;
}

describe("ChatHeader", () => {
  it("renders the desktop room controls and pin count", () => {
    const props = renderHeader();

    expect(screen.getByText("General")).toBeVisible();
    expect(screen.getByText("2")).toBeVisible();

    fireEvent.click(screen.getByRole("button", { name: "Show members" }));
    fireEvent.click(screen.getByRole("button", { name: "Show pinned messages" }));
    fireEvent.click(screen.getByRole("button", { name: "Room settings" }));
    fireEvent.click(screen.getByRole("button", { name: "Jump to date" }));

    expect(props.onToggleMembers).toHaveBeenCalledOnce();
    expect(props.onTogglePinnedMessages).toHaveBeenCalledOnce();
    expect(props.onOpenRoomSettings).toHaveBeenCalledOnce();
    expect(props.onJumpToDate).toHaveBeenCalledOnce();
  });

  it("keeps all pinning affordances dark while the feature is disabled", () => {
    renderHeader({ messagePinningEnabled: false, pinnedMessageCount: 3 });

    expect(screen.queryByRole("button", { name: /pinned messages/i })).not.toBeInTheDocument();
    expect(screen.queryByText("3")).not.toBeInTheDocument();
  });

  it("keeps jump-to-date dark while its feature flag is disabled", () => {
    renderHeader({ jumpToDateEnabled: false });

    expect(screen.queryByRole("button", { name: "Jump to date" })).not.toBeInTheDocument();
  });

  it("renders mobile navigation and delegates room-menu actions", async () => {
    const onBack = vi.fn();
    const props = renderHeader({
      mobile: true,
      onBack,
      membersDrawerOpen: true,
      pinnedMessagesDrawerOpen: true,
    });

    fireEvent.click(screen.getByRole("button", { name: "Back to chats" }));
    expect(onBack).toHaveBeenCalledOnce();

    fireEvent.pointerDown(screen.getByRole("button", { name: "Room actions" }), {
      button: 0,
      ctrlKey: false,
      pointerType: "mouse",
    });

    fireEvent.click(await screen.findByRole("menuitem", { name: "Hide members" }));
    expect(props.onToggleMembers).toHaveBeenCalledOnce();

    fireEvent.pointerDown(screen.getByRole("button", { name: "Room actions" }), {
      button: 0,
      ctrlKey: false,
      pointerType: "mouse",
    });
    fireEvent.click(await screen.findByRole("menuitem", { name: "Hide pinned messages (2)" }));
    expect(props.onTogglePinnedMessages).toHaveBeenCalledOnce();

    fireEvent.pointerDown(screen.getByRole("button", { name: "Room actions" }), {
      button: 0,
      ctrlKey: false,
      pointerType: "mouse",
    });
    fireEvent.click(await screen.findByRole("menuitem", { name: "Jump to date" }));
    expect(props.onJumpToDate).toHaveBeenCalledOnce();

    fireEvent.pointerDown(screen.getByRole("button", { name: "Room actions" }), {
      button: 0,
      ctrlKey: false,
      pointerType: "mouse",
    });
    fireEvent.click(await screen.findByRole("menuitem", { name: "Room settings" }));
    expect(props.onOpenRoomSettings).toHaveBeenCalledOnce();
  });
});
