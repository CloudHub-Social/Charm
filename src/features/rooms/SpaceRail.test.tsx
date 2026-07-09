import { fireEvent, render, screen } from "@testing-library/react";
import type { ComponentProps } from "react";
import { createStore, Provider } from "jotai";
import { describe, expect, it, vi } from "vitest";
import { badgeAtom } from "@/features/shell/badgeAtom";
import { SpaceRail } from "./SpaceRail";
import { makeRoomSummary } from "./testFixtures";

function renderRail(overrides: Partial<ComponentProps<typeof SpaceRail>> = {}) {
  const store = createStore();
  store.set(badgeAtom, {
    total_unread: 2,
    total_highlight: 0,
    spaces: {
      "!space:localhost": { total_unread: 1, total_highlight: 3 },
      "!child-space:localhost": { total_unread: 1, total_highlight: 0 },
    },
  });
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
    expect(screen.getByRole("button", { name: "Direct messages, 1 unread" })).toBeInTheDocument();
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

  it("wires Home, DM, and create/join actions", () => {
    const props = renderRail({ activeMode: "dms" });

    fireEvent.click(screen.getByRole("button", { name: "Home, 2 unread" }));
    fireEvent.click(screen.getByRole("button", { name: "Direct messages, 1 unread" }));
    fireEvent.click(screen.getByRole("button", { name: "Create or join space" }));

    expect(props.onSelectHome).toHaveBeenCalledOnce();
    expect(props.onSelectDms).toHaveBeenCalledOnce();
    expect(props.onCreateJoin).toHaveBeenCalledOnce();
  });
});
