import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ComponentProps } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { makeRoomSummary } from "@/features/rooms/testFixtures";
import { SpaceChildrenSettings } from "./SpaceChildrenSettings";

const listManageableSpaceChildren = vi.fn();
const removeSpaceChild = vi.fn();
const addExistingSpaceChild = vi.fn();

vi.mock("@/lib/matrix", () => ({
  listManageableSpaceChildren: (...args: unknown[]) => listManageableSpaceChildren(...args),
  removeSpaceChild: (...args: unknown[]) => removeSpaceChild(...args),
  addExistingSpaceChild: (...args: unknown[]) => addExistingSpaceChild(...args),
}));

const child = {
  room_id: "!child:example.org",
  name: "Project",
  topic: "Planning",
  num_joined_members: 4,
  join_rule: "invite" as const,
  is_space: false,
};

function renderSettings(overrides: Partial<ComponentProps<typeof SpaceChildrenSettings>> = {}) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <SpaceChildrenSettings
        spaceId="!space:example.org"
        spaceName="Community"
        rooms={[]}
        canEdit
        {...overrides}
      />
    </QueryClientProvider>,
  );
}

describe("SpaceChildrenSettings", () => {
  beforeEach(() => {
    listManageableSpaceChildren.mockReset().mockResolvedValue([child]);
    removeSpaceChild.mockReset().mockResolvedValue(undefined);
    addExistingSpaceChild.mockReset().mockResolvedValue(undefined);
  });

  it("lists published children and refreshes after removing one", async () => {
    listManageableSpaceChildren.mockResolvedValueOnce([child]).mockResolvedValueOnce([]);
    const onChanged = vi.fn();
    renderSettings({ onChanged });

    expect(await screen.findByText("Project")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Remove Project from space" }));

    await waitFor(() =>
      expect(removeSpaceChild).toHaveBeenCalledWith("!space:example.org", "!child:example.org"),
    );
    await waitFor(() => expect(listManageableSpaceChildren).toHaveBeenCalledTimes(2));
    expect(onChanged).toHaveBeenCalledOnce();
    expect(await screen.findByText("This space has no published children.")).toBeInTheDocument();
  });

  it("keeps all mutation controls disabled without a fresh child-state permission", async () => {
    renderSettings({ canEdit: false });

    expect(await screen.findByText("Project")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Add existing" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Remove Project from space" })).toBeDisabled();
    expect(
      screen.getByText("You need a higher power level to change this space's children."),
    ).toBeInTheDocument();
  });

  it("adds a safe joined room while excluding the space, its ancestors, and current children", async () => {
    const safeRoom = makeRoomSummary({ room_id: "!safe:example.org", name: "Safe room" });
    renderSettings({
      rooms: [
        makeRoomSummary({
          room_id: "!space:example.org",
          name: "Community",
          is_space: true,
          parent_space_ids: ["!ancestor:example.org"],
        }),
        makeRoomSummary({ room_id: "!ancestor:example.org", name: "Ancestor", is_space: true }),
        makeRoomSummary({ room_id: child.room_id, name: child.name }),
        safeRoom,
      ],
    });

    await screen.findByText("Project");
    fireEvent.click(screen.getByRole("button", { name: "Add existing" }));

    expect(screen.queryByRole("button", { name: /Ancestor/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Project/ })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /Safe room/ }));

    await waitFor(() =>
      expect(addExistingSpaceChild).toHaveBeenCalledWith("!space:example.org", "!safe:example.org"),
    );
  });
});
