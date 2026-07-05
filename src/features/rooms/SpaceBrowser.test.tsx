import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { SpaceBrowser } from "./SpaceBrowser";
import { makeRoomSummary } from "./testFixtures";
import type { SpaceChild } from "@/lib/matrix";

const listSpaceChildren = vi.fn();
const joinRoom = vi.fn().mockResolvedValue(undefined);
const knockRoom = vi.fn().mockResolvedValue(undefined);

vi.mock("@/lib/matrix", () => ({
  listSpaceChildren: (...args: unknown[]) => listSpaceChildren(...args),
  joinRoom: (...args: unknown[]) => joinRoom(...args),
  knockRoom: (...args: unknown[]) => knockRoom(...args),
}));

const space = makeRoomSummary({ room_id: "!space:localhost", is_space: true, name: "Team" });

function publicChild(): SpaceChild {
  return {
    room_id: "!public:localhost",
    name: "General",
    topic: "Chit-chat",
    num_joined_members: 5,
    join_rule: "public",
    is_space: false,
  };
}

function knockChild(): SpaceChild {
  return {
    room_id: "!knock:localhost",
    name: "Private-ish",
    topic: null,
    num_joined_members: 2,
    join_rule: "knock",
    is_space: false,
  };
}

describe("SpaceBrowser", () => {
  it("renders nothing when no space is selected", () => {
    render(<SpaceBrowser space={null} onOpenChange={() => {}} />);
    expect(screen.queryByText("Browse and join rooms in this space.")).not.toBeInTheDocument();
  });

  it("fetches and lists a space's children", async () => {
    listSpaceChildren.mockResolvedValue([publicChild()]);
    render(<SpaceBrowser space={space} onOpenChange={() => {}} />);

    expect(listSpaceChildren).toHaveBeenCalledWith("!space:localhost");
    expect(await screen.findByText("General")).toBeInTheDocument();
    expect(screen.getByText("Chit-chat")).toBeInTheDocument();
  });

  it("shows an empty state when the space has no children", async () => {
    listSpaceChildren.mockResolvedValue([]);
    render(<SpaceBrowser space={space} onOpenChange={() => {}} />);
    expect(await screen.findByText("No rooms in this space.")).toBeInTheDocument();
  });

  it("joins a public child room via joinRoom", async () => {
    listSpaceChildren.mockResolvedValue([publicChild()]);
    render(<SpaceBrowser space={space} onOpenChange={() => {}} />);

    fireEvent.click(await screen.findByRole("button", { name: "Join" }));
    expect(joinRoom).toHaveBeenCalledWith("!public:localhost");
  });

  it("offers a Request to join button for a knock child room, wired to knockRoom", async () => {
    listSpaceChildren.mockResolvedValue([knockChild()]);
    render(<SpaceBrowser space={space} onOpenChange={() => {}} />);

    fireEvent.click(await screen.findByRole("button", { name: "Request to join" }));
    expect(knockRoom).toHaveBeenCalledWith("!knock:localhost");
  });

  it("surfaces an error if fetching children fails", async () => {
    listSpaceChildren.mockRejectedValue(new Error("network down"));
    render(<SpaceBrowser space={space} onOpenChange={() => {}} />);
    expect(await screen.findByText("Error: network down")).toBeInTheDocument();
  });
});
