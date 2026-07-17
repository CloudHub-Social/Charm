import { fireEvent, render, screen } from "@testing-library/react";
import type { ComponentProps } from "react";
import { createStore, Provider } from "jotai";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { badgeAtom } from "@/features/shell/badgeAtom";
import type * as MatrixLib from "@/lib/matrix";
import type { BadgeState } from "@/lib/matrix";
import { SpaceRail } from "./SpaceRail";
import { makeRoomSummary } from "./testFixtures";

const removeSpaceChild = vi.fn().mockResolvedValue(undefined);
const setSpaceChildSuggested = vi.fn().mockResolvedValue(undefined);
const addExistingSpaceChild = vi.fn().mockResolvedValue(undefined);
const leaveRoom = vi.fn().mockResolvedValue(undefined);
const inviteMember = vi.fn().mockResolvedValue(undefined);

vi.mock("@/lib/matrix", async (importOriginal) => ({
  ...(await importOriginal<typeof MatrixLib>()),
  removeSpaceChild: (...args: unknown[]) => removeSpaceChild(...args),
  setSpaceChildSuggested: (...args: unknown[]) => setSpaceChildSuggested(...args),
  addExistingSpaceChild: (...args: unknown[]) => addExistingSpaceChild(...args),
  leaveRoom: (...args: unknown[]) => leaveRoom(...args),
  inviteMember: (...args: unknown[]) => inviteMember(...args),
}));

type RenderRailOptions = Partial<ComponentProps<typeof SpaceRail>> & {
  badgeState?: BadgeState;
};

function renderRail({ badgeState, ...overrides }: RenderRailOptions = {}) {
  const store = createStore();
  store.set(
    badgeAtom,
    badgeState ?? {
      total_unread: 2,
      total_highlight: 0,
      spaces: {
        "!space:localhost": { total_unread: 1, total_highlight: 3 },
        "!child-space:localhost": { total_unread: 1, total_highlight: 0 },
      },
    },
  );
  const props = {
    rooms: [
      makeRoomSummary({ room_id: "!space:localhost", name: "Team", is_space: true }),
      makeRoomSummary({
        room_id: "!child-space:localhost",
        name: "Product",
        is_space: true,
        parent_space_ids: ["!space:localhost"],
      }),
      makeRoomSummary({
        room_id: "!orphaned-child-space:localhost",
        name: "Loose child",
        is_space: true,
        parent_space_ids: ["!missing-space:localhost"],
      }),
      makeRoomSummary({
        room_id: "!dm:localhost",
        name: "Alice",
        is_direct: true,
        has_unread: true,
        unread_count: 1,
      }),
    ],
    activeMode: "home" as const,
    activeSpaceId: null,
    showAllRooms: false,
    onSelectHome: vi.fn(),
    onSelectDms: vi.fn(),
    onSelectSpace: vi.fn(),
    onCreateJoin: vi.fn(),
    ...overrides,
  };
  render(
    <Provider store={store}>
      <SpaceRail {...props} />
    </Provider>,
  );
  return props;
}

describe("SpaceRail", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it("renders Home, DMs, top-level spaces, and the create/join entry", () => {
    renderRail();

    expect(screen.getByRole("navigation", { name: "Spaces" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Home" })).toHaveAttribute("aria-current", "page");
    expect(
      screen.getByRole("button", { name: "Direct messages, 1 unread, 1 mentions" }),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Team, 1 unread, 3 mentions" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Loose child" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Create or join space" })).toBeInTheDocument();
  });

  it("scopes the Home badge to rooms visible in Home mode", () => {
    renderRail({
      rooms: [
        makeRoomSummary({
          room_id: "!home:localhost",
          name: "Home room",
          has_unread: true,
          unread_count: 2,
        }),
        makeRoomSummary({
          room_id: "!dm:localhost",
          name: "Alice",
          is_direct: true,
          has_unread: true,
          unread_count: 3,
        }),
        makeRoomSummary({ room_id: "!space:localhost", name: "Team", is_space: true }),
        makeRoomSummary({
          room_id: "!child:localhost",
          name: "Team chat",
          has_unread: true,
          unread_count: 4,
          parent_space_ids: ["!space:localhost"],
        }),
      ],
    });

    expect(screen.getByRole("button", { name: "Home, 1 unread, 2 mentions" })).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Direct messages, 1 unread, 3 mentions" }),
    ).toBeInTheDocument();
  });

  it("includes non-DM space children in the Home badge when Show all rooms is enabled", () => {
    renderRail({
      showAllRooms: true,
      rooms: [
        makeRoomSummary({
          room_id: "!home:localhost",
          name: "Home room",
          has_unread: true,
          unread_count: 2,
        }),
        makeRoomSummary({ room_id: "!space:localhost", name: "Team", is_space: true }),
        makeRoomSummary({
          room_id: "!child:localhost",
          name: "Team chat",
          has_unread: true,
          unread_count: 4,
          parent_space_ids: ["!space:localhost"],
        }),
        makeRoomSummary({
          room_id: "!dm:localhost",
          name: "Alice",
          is_direct: true,
          has_unread: true,
          unread_count: 3,
        }),
      ],
    });

    expect(screen.getByRole("button", { name: "Home, 2 unread, 6 mentions" })).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Direct messages, 1 unread, 3 mentions" }),
    ).toBeInTheDocument();
  });

  it("expands child spaces as a collapsible folder and selects them", () => {
    const props = renderRail();

    fireEvent.click(screen.getByRole("button", { name: "Expand Team" }));
    fireEvent.click(screen.getByRole("button", { name: "Product, 1 unread" }));

    expect(props.onSelectSpace).toHaveBeenCalledWith("!child-space:localhost");
  });

  it("opens the parent folder when a child space is active", () => {
    renderRail({ activeMode: "space", activeSpaceId: "!child-space:localhost" });

    expect(screen.getByRole("button", { name: "Product, 1 unread" })).toHaveAttribute(
      "aria-current",
      "page",
    );
    expect(screen.getByRole("button", { name: "Collapse Team" })).toBeInTheDocument();
  });

  it("opens ancestor folders when a nested space is active", () => {
    renderRail({
      activeMode: "space",
      activeSpaceId: "!grandchild-space:localhost",
      rooms: [
        makeRoomSummary({ room_id: "!space:localhost", name: "Team", is_space: true }),
        makeRoomSummary({
          room_id: "!child-space:localhost",
          name: "Product",
          is_space: true,
          parent_space_ids: ["!space:localhost"],
        }),
        makeRoomSummary({
          room_id: "!grandchild-space:localhost",
          name: "Platform",
          is_space: true,
          parent_space_ids: ["!child-space:localhost"],
        }),
      ],
    });

    expect(screen.getByRole("button", { name: "Collapse Team" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Collapse Product" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Platform" })).toHaveAttribute(
      "aria-current",
      "page",
    );
  });

  it("guards active-space ancestor expansion against cyclic parent links", () => {
    renderRail({
      activeMode: "space",
      activeSpaceId: "!space-a:localhost",
      rooms: [
        makeRoomSummary({
          room_id: "!space-a:localhost",
          name: "Space A",
          is_space: true,
          parent_space_ids: ["!space-b:localhost"],
        }),
        makeRoomSummary({
          room_id: "!space-b:localhost",
          name: "Space B",
          is_space: true,
          parent_space_ids: ["!space-a:localhost"],
        }),
      ],
    });

    expect(screen.getByRole("navigation", { name: "Spaces" })).toBeInTheDocument();
  });

  it("guards recursive folder rendering against reachable cyclic child links", () => {
    renderRail({
      activeMode: "space",
      activeSpaceId: "!space-b:localhost",
      rooms: [
        makeRoomSummary({
          room_id: "!root:localhost",
          name: "Root",
          is_space: true,
        }),
        makeRoomSummary({
          room_id: "!space-a:localhost",
          name: "Space A",
          is_space: true,
          parent_space_ids: ["!root:localhost", "!space-b:localhost"],
        }),
        makeRoomSummary({
          room_id: "!space-b:localhost",
          name: "Space B",
          is_space: true,
          parent_space_ids: ["!space-a:localhost"],
        }),
      ],
    });

    expect(screen.getByRole("button", { name: "Collapse Root" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Collapse Space A" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Space B" })).toHaveAttribute("aria-current", "page");
  });

  it("surfaces rootless cyclic spaces as rail entries", () => {
    renderRail({
      rooms: [
        makeRoomSummary({
          room_id: "!space-a:localhost",
          name: "Space A",
          is_space: true,
          parent_space_ids: ["!space-b:localhost"],
        }),
        makeRoomSummary({
          room_id: "!space-b:localhost",
          name: "Space B",
          is_space: true,
          parent_space_ids: ["!space-a:localhost"],
        }),
      ],
    });

    expect(screen.getByRole("button", { name: "Space A" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Space B" })).toBeInTheDocument();
  });

  it("subtracts hidden direct-room badge counts from parent spaces", () => {
    renderRail({
      badgeState: {
        total_unread: 0,
        total_highlight: 0,
        spaces: {
          "!space:localhost": { total_unread: 1, total_highlight: 2 },
        },
      },
      rooms: [
        makeRoomSummary({ room_id: "!space:localhost", name: "Team", is_space: true }),
        makeRoomSummary({
          room_id: "!dm:localhost",
          name: "Alice",
          is_direct: true,
          has_unread: true,
          unread_count: 2,
          parent_space_ids: ["!space:localhost"],
        }),
      ],
    });

    expect(screen.getByRole("button", { name: "Team" })).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Direct messages, 1 unread, 2 mentions" }),
    ).toBeInTheDocument();
  });

  it("wires Home, DM, and create/join actions", () => {
    const props = renderRail({ activeMode: "dms" });

    fireEvent.click(screen.getByRole("button", { name: "Home" }));
    fireEvent.click(screen.getByRole("button", { name: "Direct messages, 1 unread, 1 mentions" }));
    fireEvent.click(screen.getByRole("button", { name: "Create or join space" }));

    expect(props.onSelectHome).toHaveBeenCalledOnce();
    expect(props.onSelectDms).toHaveBeenCalledOnce();
    expect(props.onCreateJoin).toHaveBeenCalledOnce();
  });

  it("opens a context menu on a top-level space with Open lobby, Invite, and Pin actions", () => {
    const props = renderRail();

    fireEvent.contextMenu(screen.getByRole("button", { name: "Team, 1 unread, 3 mentions" }));

    expect(screen.getByRole("menuitem", { name: /Open lobby/ })).toBeInTheDocument();
    expect(screen.getByRole("menuitem", { name: /Invite/ })).toBeInTheDocument();
    expect(screen.getByRole("menuitem", { name: /Unpin from sidebar/ })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("menuitem", { name: /Open lobby/ }));
    expect(props.onSelectSpace).toHaveBeenCalledWith("!space:localhost");
  });

  it("does not offer pin/reorder actions on a nested (non-top-level) space", () => {
    renderRail();

    fireEvent.click(screen.getByRole("button", { name: "Expand Team" }));
    fireEvent.contextMenu(screen.getByRole("button", { name: /^Product/ }));

    expect(screen.queryByRole("menuitem", { name: /Pin to sidebar/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("menuitem", { name: /Unpin from sidebar/ })).not.toBeInTheDocument();
  });

  it("unpins a top-level space from the rail via its context menu, keeping it visible below a divider", () => {
    renderRail();

    fireEvent.contextMenu(screen.getByRole("button", { name: "Team, 1 unread, 3 mentions" }));
    fireEvent.click(screen.getByRole("menuitem", { name: /Unpin from sidebar/ }));

    fireEvent.contextMenu(screen.getByRole("button", { name: "Team, 1 unread, 3 mentions" }));
    expect(screen.getByRole("menuitem", { name: /Pin to sidebar/ })).toBeInTheDocument();
  });

  it("reorders pinned top-level spaces via Move up/Move down", () => {
    renderRail({
      rooms: [
        makeRoomSummary({ room_id: "!space-a:localhost", name: "Alpha", is_space: true }),
        makeRoomSummary({ room_id: "!space-b:localhost", name: "Beta", is_space: true }),
      ],
    });

    const spaceButtons = () => screen.getAllByRole("button", { name: /^(Alpha|Beta)$/ });
    expect(spaceButtons().map((button) => button.getAttribute("aria-label"))).toEqual([
      "Alpha",
      "Beta",
    ]);

    fireEvent.contextMenu(screen.getByRole("button", { name: "Beta" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Move up" }));

    expect(spaceButtons().map((button) => button.getAttribute("aria-label"))).toEqual([
      "Beta",
      "Alpha",
    ]);
  });

  it("opens the Invite dialog for a space from its context menu", () => {
    renderRail();

    fireEvent.contextMenu(screen.getByRole("button", { name: "Team, 1 unread, 3 mentions" }));
    fireEvent.click(screen.getByRole("menuitem", { name: /Invite/ }));

    expect(screen.getByRole("dialog", { name: "Invite to Team" })).toBeInTheDocument();
  });

  it("opens a Leave confirmation dialog rather than leaving immediately", async () => {
    renderRail();

    fireEvent.contextMenu(screen.getByRole("button", { name: "Team, 1 unread, 3 mentions" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Leave" }));

    expect(screen.getByRole("dialog", { name: "Leave Team?" })).toBeInTheDocument();
    expect(leaveRoom).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Leave" }));
    expect(leaveRoom).toHaveBeenCalledWith("!space:localhost");
    await screen.findByRole("navigation", { name: "Spaces" });
  });

  it("opens the Add Existing dialog for a space from its context menu", () => {
    renderRail();

    fireEvent.contextMenu(screen.getByRole("button", { name: "Team, 1 unread, 3 mentions" }));
    fireEvent.click(screen.getByRole("menuitem", { name: /Add existing/ }));

    expect(
      screen.getByRole("dialog", { name: "Add existing room or space to Team" }),
    ).toBeInTheDocument();
  });

  it("offers Remove and Set/Unset Suggested only on a space with a parent", () => {
    renderRail();

    fireEvent.contextMenu(screen.getByRole("button", { name: "Team, 1 unread, 3 mentions" }));
    expect(screen.queryByRole("menuitem", { name: /Remove from space/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("menuitem", { name: /Mark as suggested/ })).not.toBeInTheDocument();
    fireEvent.keyDown(screen.getByRole("menu"), { key: "Escape" });

    fireEvent.click(screen.getByRole("button", { name: "Expand Team" }));
    fireEvent.contextMenu(screen.getByRole("button", { name: /^Product/ }));

    fireEvent.click(screen.getByRole("menuitem", { name: "Remove from space" }));
    expect(removeSpaceChild).toHaveBeenCalledWith("!space:localhost", "!child-space:localhost");

    fireEvent.contextMenu(screen.getByRole("button", { name: /^Product/ }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Mark as suggested" }));
    expect(setSpaceChildSuggested).toHaveBeenCalledWith(
      "!space:localhost",
      "!child-space:localhost",
      true,
    );

    fireEvent.contextMenu(screen.getByRole("button", { name: /^Product/ }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Unmark as suggested" }));
    expect(setSpaceChildSuggested).toHaveBeenCalledWith(
      "!space:localhost",
      "!child-space:localhost",
      false,
    );
  });
});
