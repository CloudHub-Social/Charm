import { fireEvent, render, screen, within } from "@testing-library/react";
import { createRef } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { makeRoomSummary } from "./testFixtures";
import { QuickSwitcherDialog } from "./QuickSwitcherDialog";
import { readQuickSwitcherRecents, recordQuickSwitcherRecent } from "./quickSwitcherRecents";

const rooms = [
  makeRoomSummary({ room_id: "!general:example.org", name: "General" }),
  makeRoomSummary({
    room_id: "!design:example.org",
    name: "Design Studio",
    parent_space_ids: ["!work:example.org"],
  }),
  makeRoomSummary({
    room_id: "!alice:example.org",
    name: "Alice",
    is_direct: true,
    dm_peer_user_id: "@alice:example.org",
  }),
  makeRoomSummary({ room_id: "!work:example.org", name: "Work", is_space: true }),
];

describe("QuickSwitcherDialog", () => {
  beforeEach(() => localStorage.clear());

  it("orders recents first, then spaces, DMs, and rooms", () => {
    recordQuickSwitcherRecent("@me:example.org", "!design:example.org");
    renderDialog();

    const options = screen.getAllByRole("option");
    ["Design Studio", "Work", "Alice", "General"].forEach((name, index) => {
      expect(within(options[index]).getByText(name, { exact: true })).toBeInTheDocument();
    });
  });

  it("preserves saved recents until the initial room snapshot has loaded", () => {
    recordQuickSwitcherRecent("@me:example.org", "!design:example.org");

    renderDialog({ rooms: [], roomsLoaded: false });

    expect(readQuickSwitcherRecents("@me:example.org")).toEqual(["!design:example.org"]);
  });

  it("uses Fuse.js across names, DM peers, and parent-space context", () => {
    renderDialog();
    const input = screen.getByRole("combobox", {
      name: "Search rooms, direct messages, and spaces",
    });

    fireEvent.change(input, { target: { value: "dsgn stdio" } });
    expect(screen.getAllByRole("option")).toHaveLength(1);
    expect(screen.getByRole("option", { name: /Design Studio/ })).toBeInTheDocument();

    fireEvent.change(input, { target: { value: "@alice" } });
    expect(screen.getByRole("option", { name: /Alice/ })).toBeInTheDocument();

    fireEvent.change(input, { target: { value: "Work" } });
    expect(screen.getByRole("option", { name: /Design Studio/ })).toBeInTheDocument();
  });

  it("shows an empty state and ignores navigation when no rooms match", () => {
    const onSelectRoom = vi.fn();
    renderDialog({ onSelectRoom });
    const input = screen.getByRole("combobox", {
      name: "Search rooms, direct messages, and spaces",
    });

    fireEvent.change(input, { target: { value: "definitely-not-a-room" } });
    fireEvent.keyDown(input, { key: "ArrowDown" });
    fireEvent.keyDown(input, { key: "Enter" });

    expect(screen.getByText("No rooms found.")).toBeInTheDocument();
    expect(screen.getByText("0 results available.")).toBeInTheDocument();
    expect(input).not.toHaveAttribute("aria-activedescendant");
    expect(onSelectRoom).not.toHaveBeenCalled();
  });

  it("navigates with the keyboard and records only the chosen joined room", () => {
    const onSelectRoom = vi.fn();
    const onOpenChange = vi.fn();
    renderDialog({ onSelectRoom, onOpenChange });
    const input = screen.getByRole("combobox", {
      name: "Search rooms, direct messages, and spaces",
    });

    fireEvent.change(input, { target: { value: "alice" } });
    fireEvent.keyDown(input, { key: "Enter" });

    expect(onSelectRoom).toHaveBeenCalledWith(
      expect.objectContaining({ room_id: "!alice:example.org" }),
    );
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("keeps the active keyboard result scrolled into view", () => {
    renderDialog();
    const input = screen.getByRole("combobox", {
      name: "Search rooms, direct messages, and spaces",
    });
    const options = screen.getAllByRole("option");
    const scrollIntoView = vi.fn();
    options.at(-1)!.scrollIntoView = scrollIntoView;

    fireEvent.keyDown(input, { key: "End" });

    expect(options.at(-1)).toHaveAttribute("aria-selected", "true");
    expect(scrollIntoView).toHaveBeenCalledWith({ block: "nearest" });
  });
});

function renderDialog(overrides: Partial<React.ComponentProps<typeof QuickSwitcherDialog>> = {}) {
  const returnFocusRef = createRef<HTMLElement>();
  return render(
    <QuickSwitcherDialog
      open
      onOpenChange={() => {}}
      rooms={rooms}
      roomsLoaded
      currentUserId="@me:example.org"
      onSelectRoom={() => {}}
      returnFocusRef={returnFocusRef}
      {...overrides}
    />,
  );
}
