import { render, screen } from "@testing-library/react";
import { createStore, Provider } from "jotai";
import { describe, expect, it, vi } from "vitest";
import type { GroupDmAvatarMember } from "@/lib/matrix";
import { presenceAtomFamily } from "@/features/presence/presenceAtoms";
import { GroupDmAvatar, aggregateGroupPresence } from "./GroupDmAvatar";

vi.mock("@/features/profile/useResolvedAvatarSrc", () => ({
  useResolvedAvatarSrc: () => undefined,
}));

vi.mock("@/lib/matrix", () => ({
  getPresence: vi.fn().mockResolvedValue(null),
}));

const MEMBERS: GroupDmAvatarMember[] = [
  { user_id: "@alice:example.org", display_name: "Alice", avatar_url: null },
  { user_id: "@bob:example.org", display_name: "Bob", avatar_url: null },
  { user_id: "@carol:example.org", display_name: "Carol", avatar_url: null },
  { user_id: "@dave:example.org", display_name: "Dave", avatar_url: null },
];

function renderAvatar(showPresenceRing: boolean) {
  const store = createStore();
  store.set(presenceAtomFamily(MEMBERS[0].user_id), {
    user_id: MEMBERS[0].user_id,
    presence: "online",
    status_msg: null,
    last_active_ago_ms: null,
  });
  return render(
    <Provider store={store}>
      <GroupDmAvatar members={MEMBERS} showPresenceRing={showPresenceRing} />
    </Provider>,
  );
}

describe("aggregateGroupPresence", () => {
  it("selects the most available state and keeps dnd above unavailable", () => {
    expect(aggregateGroupPresence(["offline", "unavailable", "dnd"])).toBe("dnd");
    expect(aggregateGroupPresence(["dnd", "online"])).toBe("online");
    expect(aggregateGroupPresence([])).toBeNull();
  });
});

describe("GroupDmAvatar", () => {
  it("caps the composite at three faces while aggregating all heroes", () => {
    const { container } = renderAvatar(true);
    expect(container.querySelectorAll("[data-slot='avatar'] [data-slot='avatar']")).toHaveLength(3);
    expect(screen.getByText("Online group presence")).toBeInTheDocument();
  });

  it("uses an accessible corner dot when the ring preference is off", () => {
    renderAvatar(false);
    expect(screen.getByText("Online")).toBeInTheDocument();
    expect(screen.queryByText("Online group presence")).not.toBeInTheDocument();
  });
});
