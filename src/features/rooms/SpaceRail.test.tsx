import { fireEvent, render, screen } from "@testing-library/react";
import type { ComponentProps } from "react";
import { createStore, Provider } from "jotai";
import { describe, expect, it, vi } from "vitest";
import { badgeAtom } from "@/features/shell/badgeAtom";
import type { BadgeState } from "@/lib/matrix";
import { SpaceRail } from "./SpaceRail";
import { makeRoomSummary } from "./testFixtures";

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
  it("renders Home, DMs, top-level spaces, and the create/join entry", () => {
    renderRail();

    expect(screen.getByRole("navigation", { name: "Spaces" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Home, 2 unread" })).toHaveAttribute(
      "aria-current",
      "page",
    );
    expect(
      screen.getByRole("button", { name: "Direct messages, 1 unread, 1 mentions" }),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Team, 1 unread, 3 mentions" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Loose child" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Create or join space" })).toBeInTheDocument();
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

    fireEvent.click(screen.getByRole("button", { name: "Home, 2 unread" }));
    fireEvent.click(screen.getByRole("button", { name: "Direct messages, 1 unread, 1 mentions" }));
    fireEvent.click(screen.getByRole("button", { name: "Create or join space" }));

    expect(props.onSelectHome).toHaveBeenCalledOnce();
    expect(props.onSelectDms).toHaveBeenCalledOnce();
    expect(props.onCreateJoin).toHaveBeenCalledOnce();
  });
});
