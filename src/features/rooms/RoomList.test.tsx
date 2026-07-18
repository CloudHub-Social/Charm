import type { ComponentProps, ReactElement } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { createStore, Provider } from "jotai";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { badgeAtom } from "@/features/shell/badgeAtom";
import { RoomList } from "./RoomList";
import type { RoomListMode } from "./SpaceRail";
import { makeRoomSummary } from "./testFixtures";

const featureFlagMocks = vi.hoisted(() => ({
  roomListUnreadFilter: false,
  roomListMessagePreview: false,
  spaceRailManagement: false,
}));

vi.mock("@/featureFlags", () => ({
  useFlag: (key: string) => {
    if (key === "room_list_unread_filter") return featureFlagMocks.roomListUnreadFilter;
    if (key === "room_list_message_preview") return featureFlagMocks.roomListMessagePreview;
    if (key === "space_rail_management") return featureFlagMocks.spaceRailManagement;
    return false;
  },
}));

// Radix's Tooltip.Content measures itself via ResizeObserver, which jsdom
// doesn't implement — stub it so the tooltip-hover test below can render the
// portal content without crashing. Scoped to this file's beforeAll/afterAll
// (not a module-level vi.stubGlobal) so the stub can't leak into other test
// files sharing this Vitest worker.
class StubResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}
beforeAll(() => {
  vi.stubGlobal("ResizeObserver", StubResizeObserver);
});
afterAll(() => {
  vi.unstubAllGlobals();
});

// RoomList's header now fetches the signed-in user's own profile via
// `useOwnProfile` (TanStack Query), which needs a `QueryClientProvider`
// ancestor — a fresh, retry-disabled client per render, same as
// `useMediaSource.test.tsx`. Also wrap in a jotai `Provider` with a fresh
// `store` so tests can preload `badgeAtom` without leaking state between
// cases (same pattern as `useBadgeListener.test.ts`).
function renderRoomList(ui: ReactElement, store = createStore()) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <Provider store={store}>
      <QueryClientProvider client={client}>{ui}</QueryClientProvider>
    </Provider>,
  );
}

// RoomList wires context-menu actions and drag-reorder straight to Tauri IPC
// — mock lib/matrix so this test exercises sectioning/rendering only.
const setRoomFavourite = vi.fn().mockResolvedValue(undefined);
const setRoomLowPriority = vi.fn().mockResolvedValue(undefined);
const setRoomMuted = vi.fn().mockResolvedValue(undefined);
const setRoomMarkedUnread = vi.fn().mockResolvedValue(undefined);
const setRoomManualOrder = vi.fn().mockResolvedValue(undefined);
const markRoomRead = vi.fn().mockResolvedValue(undefined);
const listSpaceHierarchy = vi.fn().mockResolvedValue([]);
const removeSpaceChild = vi.fn().mockResolvedValue(undefined);
const joinRoom = vi.fn().mockResolvedValue(undefined);
const knockRoom = vi.fn().mockResolvedValue(undefined);
// Never resolves — these tests don't care about the header profile chip
// (see useOwnProfile.test.tsx for that), just that rendering it doesn't blow up.
const getOwnProfile = vi.fn().mockReturnValue(new Promise(() => {}));
const onSelfProfileUpdate = vi.fn().mockResolvedValue(() => {});
// Spec 30: RoomList's header renders a Do Not Disturb indicator via
// `useFocusMode`, which calls these — never resolving here is fine, the
// indicator only cares whether `focus_mode` is flagged on (the feature-flag
// mock above keeps every flag except the Spec 54 test flag off).
const getDndState = vi.fn().mockReturnValue(new Promise(() => {}));
const setDndState = vi.fn().mockResolvedValue({ enabled: false, until: null });
const onDndChanged = vi.fn().mockResolvedValue(() => {});
const onTypingUpdate = vi.fn().mockResolvedValue(() => {});

vi.mock("@/lib/matrix", () => ({
  setRoomFavourite: (...args: unknown[]) => setRoomFavourite(...args),
  setRoomLowPriority: (...args: unknown[]) => setRoomLowPriority(...args),
  setRoomMuted: (...args: unknown[]) => setRoomMuted(...args),
  setRoomMarkedUnread: (...args: unknown[]) => setRoomMarkedUnread(...args),
  setRoomManualOrder: (...args: unknown[]) => setRoomManualOrder(...args),
  markRoomRead: (...args: unknown[]) => markRoomRead(...args),
  listSpaceHierarchy: (...args: unknown[]) => listSpaceHierarchy(...args),
  removeSpaceChild: (...args: unknown[]) => removeSpaceChild(...args),
  joinRoom: (...args: unknown[]) => joinRoom(...args),
  knockRoom: (...args: unknown[]) => knockRoom(...args),
  getOwnProfile: () => getOwnProfile(),
  onSelfProfileUpdate: (...args: unknown[]) => onSelfProfileUpdate(...args),
  getDndState: () => getDndState(),
  setDndState: (...args: unknown[]) => setDndState(...args),
  onDndChanged: (...args: unknown[]) => onDndChanged(...args),
  onTypingUpdate: (...args: unknown[]) => onTypingUpdate(...args),
}));

// @use-gesture/react's useDrag attaches real pointer-event listeners; none of
// these tests exercise the drag interaction itself (see roomSections.test.ts
// for the reorder math), so bind() only needs to return an empty prop object.
vi.mock("@use-gesture/react", () => ({
  useDrag: (_handler: unknown, options?: { enabled?: boolean }) => () => ({
    "data-reorder-enabled": String(options?.enabled ?? true),
  }),
}));

function roomListProps(overrides: Partial<ComponentProps<typeof RoomList>> = {}) {
  return {
    rooms: [],
    activeRoomId: null,
    onSelectRoom: () => {},
    onSelectSpace: () => {},
    mode: "home" as const,
    selectedSpace: null,
    showAllRooms: false,
    onShowAllRoomsChange: () => {},
    ...overrides,
  };
}

function hierarchyChild(roomId: string, name: string, isSpace = false) {
  return {
    room_id: roomId,
    name,
    topic: null,
    num_joined_members: 2,
    join_rule: "invite" as const,
    is_space: isSpace,
  };
}

afterEach(() => {
  vi.clearAllMocks();
  vi.unstubAllEnvs();
  localStorage.clear();
  featureFlagMocks.roomListUnreadFilter = false;
  featureFlagMocks.roomListMessagePreview = false;
  featureFlagMocks.spaceRailManagement = false;
});

describe("RoomList", () => {
  it("shows room skeletons while the initial room list is loading", () => {
    renderRoomList(<RoomList {...roomListProps({ loading: true })} />);
    expect(screen.getByRole("status", { name: "Loading rooms" })).toBeInTheDocument();
    expect(screen.queryByText("No rooms yet")).not.toBeInTheDocument();
  });

  it("shows the empty state when there are no rooms", () => {
    renderRoomList(<RoomList {...roomListProps()} />);
    expect(screen.getByText("No rooms yet")).toBeInTheDocument();
  });

  it("labels unresolved space mode as space instead of Home", () => {
    renderRoomList(<RoomList {...roomListProps({ mode: "space", selectedSpace: null })} />);

    expect(screen.getByRole("heading", { name: "Space" })).toBeInTheDocument();
    expect(screen.getByText("Select a space.")).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Home" })).not.toBeInTheDocument();
  });

  it("renders section headers with per-section counts", () => {
    const fav = makeRoomSummary({
      room_id: "!fav:localhost",
      name: "Fav room",
      is_favourite: true,
    });
    const plain = makeRoomSummary({ room_id: "!plain:localhost", name: "Plain room" });
    renderRoomList(<RoomList {...roomListProps({ rooms: [fav, plain] })} />);

    expect(screen.getByText("Favourites")).toBeInTheDocument();
    expect(screen.getByText("Fav room")).toBeInTheDocument();
    expect(screen.getByText("Plain room")).toBeInTheDocument();
    // "Low priority" section has zero rooms and should not render at all.
    expect(screen.queryByText("Low priority")).not.toBeInTheDocument();
  });

  it("keeps Home scoped to orphan rooms by default", () => {
    const space = makeRoomSummary({ room_id: "!space:localhost", is_space: true, name: "Team" });
    const child = makeRoomSummary({
      room_id: "!child:localhost",
      name: "Team chat",
      parent_space_ids: ["!space:localhost"],
    });
    const orphan = makeRoomSummary({ room_id: "!orphan:localhost", name: "Orphan" });
    renderRoomList(<RoomList {...roomListProps({ rooms: [space, child, orphan] })} />);

    expect(screen.getByText("Orphan")).toBeInTheDocument();
    expect(screen.queryByText("Team chat")).not.toBeInTheDocument();
  });

  it("keeps Home room rows reorderable when DMs exist outside the Home scope", () => {
    const room = makeRoomSummary({ room_id: "!room:localhost", name: "Room" });
    const dm = makeRoomSummary({ room_id: "!dm:localhost", name: "Alice", is_direct: true });
    renderRoomList(<RoomList {...roomListProps({ rooms: [room, dm] })} />);

    expect(screen.getByText("Room")).toBeInTheDocument();
    expect(screen.queryByText("Alice")).not.toBeInTheDocument();
    expect(screen.getByText("Room").closest("button")).toHaveAttribute(
      "data-reorder-enabled",
      "true",
    );
  });

  it("keeps Home room rows reorderable when grouped space rooms are outside the Home scope", () => {
    const space = makeRoomSummary({ room_id: "!space:localhost", is_space: true, name: "Team" });
    const child = makeRoomSummary({
      room_id: "!child:localhost",
      name: "Team chat",
      parent_space_ids: ["!space:localhost"],
    });
    const orphan = makeRoomSummary({ room_id: "!orphan:localhost", name: "Orphan" });
    renderRoomList(<RoomList {...roomListProps({ rooms: [space, child, orphan] })} />);

    expect(screen.queryByText("Team chat")).not.toBeInTheDocument();
    expect(screen.getByText("Orphan").closest("button")).toHaveAttribute(
      "data-reorder-enabled",
      "true",
    );
  });

  it("calls onSelectRoom when a room is clicked", () => {
    const onSelectRoom = vi.fn();
    const room = makeRoomSummary({ name: "general" });
    renderRoomList(<RoomList {...roomListProps({ rooms: [room], onSelectRoom })} />);
    screen.getByText("general").click();
    expect(onSelectRoom).toHaveBeenCalledWith(room.room_id);
  });

  it("renders pending invites separately and wires accept and decline", async () => {
    const onAcceptInvite = vi.fn().mockResolvedValue(undefined);
    const onDeclineInvite = vi.fn().mockResolvedValue(undefined);
    const invite = makeRoomSummary({
      room_id: "!invite:localhost",
      name: "Project room",
      membership: "invite",
      inviter_user_id: "@alice:localhost",
      inviter_display_name: "Alice",
    });
    renderRoomList(
      <RoomList
        {...roomListProps({ rooms: [invite] })}
        onAcceptInvite={onAcceptInvite}
        onDeclineInvite={onDeclineInvite}
      />,
    );

    expect(screen.getByText("Invites")).toBeInTheDocument();
    expect(screen.getByText("Alice invited you")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Accept" }));
    await waitFor(() => expect(onAcceptInvite).toHaveBeenCalledWith(invite.room_id));
    fireEvent.click(screen.getByRole("button", { name: "Decline" }));
    await waitFor(() => expect(onDeclineInvite).toHaveBeenCalledWith(invite.room_id));
  });

  it("does not include pending invites in room search results", () => {
    const invite = makeRoomSummary({
      room_id: "!invite:localhost",
      name: "Secret invited room",
      membership: "invite",
    });
    renderRoomList(<RoomList {...roomListProps({ rooms: [invite] })} />);

    fireEvent.change(screen.getByRole("searchbox", { name: "Search rooms" }), {
      target: { value: "Secret" },
    });

    expect(screen.getByText("No matching rooms")).toBeInTheDocument();
  });

  it("wires the context menu's favourite/mute/mark actions to their IPC calls", async () => {
    const room = makeRoomSummary({ name: "general" });
    renderRoomList(<RoomList {...roomListProps({ rooms: [room] })} />);

    fireEvent.contextMenu(screen.getByText("general"));
    fireEvent.click(await screen.findByText("Add to Favourites"));
    expect(setRoomFavourite).toHaveBeenCalledWith(room.room_id, true);

    fireEvent.contextMenu(screen.getByText("general"));
    fireEvent.click(await screen.findByText("Move to Low priority"));
    expect(setRoomLowPriority).toHaveBeenCalledWith(room.room_id, true);

    fireEvent.contextMenu(screen.getByText("general"));
    fireEvent.click(await screen.findByText("Mute"));
    expect(setRoomMuted).toHaveBeenCalledWith(room.room_id, true);

    fireEvent.contextMenu(screen.getByText("general"));
    fireEvent.click(await screen.findByText("Mark as read"));
    expect(markRoomRead).toHaveBeenCalledWith(room.room_id);

    fireEvent.contextMenu(screen.getByText("general"));
    fireEvent.click(await screen.findByText("Mark as unread"));
    expect(setRoomMarkedUnread).toHaveBeenCalledWith(room.room_id, true);
  }, 10_000);

  it("hides the mute action in web builds while the companion lacks notification prefs", async () => {
    vi.stubEnv("VITE_CHARM_BUILD_TARGET", "web");
    const room = makeRoomSummary({ name: "general" });
    renderRoomList(<RoomList {...roomListProps({ rooms: [room] })} />);

    fireEvent.contextMenu(screen.getByText("general"));

    expect(await screen.findByText("Add to Favourites")).toBeInTheDocument();
    expect(screen.queryByText("Mute")).not.toBeInTheDocument();
  });

  it("shows no badge when badgeAtom is null or total_unread is zero", () => {
    renderRoomList(<RoomList {...roomListProps()} />);
    expect(screen.queryByLabelText(/unread rooms/)).not.toBeInTheDocument();
  });

  it("shows the total_unread count in the header badge", () => {
    const store = createStore();
    store.set(badgeAtom, { total_unread: 3, total_highlight: 0, spaces: {} });
    renderRoomList(<RoomList {...roomListProps()} />, store);
    expect(screen.getByLabelText("3 unread rooms")).toHaveTextContent("3");
  });

  it("prefers the mention count when total_highlight is nonzero", () => {
    const store = createStore();
    store.set(badgeAtom, { total_unread: 5, total_highlight: 2, spaces: {} });
    renderRoomList(<RoomList {...roomListProps()} />, store);
    expect(screen.getByLabelText("5 unread rooms, 2 mentions")).toHaveTextContent("2");
  });

  it("shows a tooltip with the same text as the badge's aria-label on hover", async () => {
    const store = createStore();
    store.set(badgeAtom, { total_unread: 5, total_highlight: 2, spaces: {} });
    renderRoomList(<RoomList {...roomListProps()} />, store);

    const badge = screen.getByLabelText("5 unread rooms, 2 mentions");
    fireEvent.pointerOver(badge, { pointerType: "mouse" });
    fireEvent.pointerEnter(badge, { pointerType: "mouse" });
    fireEvent.pointerMove(badge, { pointerType: "mouse" });

    const tooltip = await screen.findByRole("tooltip");
    expect(tooltip).toHaveTextContent(badge.getAttribute("aria-label") ?? "");
  });

  it("renders recursive space hierarchy with indentation and inline join actions", async () => {
    const space = makeRoomSummary({ room_id: "!space:localhost", is_space: true, name: "Team" });
    const joinedChild = makeRoomSummary({
      room_id: "!child:localhost",
      name: "Team chat",
      parent_space_ids: ["!space:localhost"],
    });
    listSpaceHierarchy.mockResolvedValue([
      {
        child: {
          room_id: "!child:localhost",
          name: "Team chat",
          topic: null,
          num_joined_members: 4,
          join_rule: "invite",
          is_space: false,
        },
        children: [
          {
            child: {
              room_id: "!public:localhost",
              name: "Public room",
              topic: "Open discussion",
              num_joined_members: 8,
              join_rule: "public",
              is_space: false,
            },
            children: [],
          },
        ],
      },
    ]);
    renderRoomList(
      <RoomList
        {...roomListProps({
          rooms: [space, joinedChild],
          mode: "space",
          selectedSpace: space,
        })}
      />,
    );

    expect(listSpaceHierarchy).toHaveBeenCalledWith("!space:localhost");
    expect(await screen.findByText("Team chat")).toBeInTheDocument();
    expect(await screen.findByText("Public room")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Join" }));
    expect(joinRoom).toHaveBeenCalledWith("!public:localhost");
  });

  it("wires Remove from space for a joined room row inside a space's lobby", async () => {
    featureFlagMocks.spaceRailManagement = true;
    const space = makeRoomSummary({ room_id: "!space:localhost", is_space: true, name: "Team" });
    const joinedChild = makeRoomSummary({
      room_id: "!child:localhost",
      name: "Team chat",
      parent_space_ids: ["!space:localhost"],
    });
    listSpaceHierarchy.mockResolvedValue([
      {
        child: {
          room_id: "!child:localhost",
          name: "Team chat",
          topic: null,
          num_joined_members: 4,
          join_rule: "invite",
          is_space: false,
        },
        children: [],
      },
    ]);
    renderRoomList(
      <RoomList
        {...roomListProps({ rooms: [space, joinedChild], mode: "space", selectedSpace: space })}
      />,
    );

    fireEvent.contextMenu(await screen.findByText("Team chat"));
    fireEvent.click(await screen.findByText("Remove from space"));

    expect(removeSpaceChild).toHaveBeenCalledWith("!space:localhost", "!child:localhost");
  });

  it("refetches the space hierarchy after a successful Remove from space, so the row disappears immediately", async () => {
    featureFlagMocks.spaceRailManagement = true;
    const space = makeRoomSummary({ room_id: "!space:localhost", is_space: true, name: "Team" });
    const joinedChild = makeRoomSummary({
      room_id: "!child:localhost",
      name: "Team chat",
      parent_space_ids: ["!space:localhost"],
    });
    const hierarchyWithChild = [
      {
        child: {
          room_id: "!child:localhost",
          name: "Team chat",
          topic: null,
          num_joined_members: 4,
          join_rule: "invite" as const,
          is_space: false,
        },
        children: [],
      },
    ];
    listSpaceHierarchy.mockResolvedValueOnce(hierarchyWithChild).mockResolvedValueOnce([]);
    renderRoomList(
      <RoomList
        {...roomListProps({ rooms: [space, joinedChild], mode: "space", selectedSpace: space })}
      />,
    );

    fireEvent.contextMenu(await screen.findByText("Team chat"));
    fireEvent.click(await screen.findByText("Remove from space"));

    await waitFor(() => expect(listSpaceHierarchy).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(screen.queryByText("Team chat")).not.toBeInTheDocument());
  });

  it("surfaces an error instead of failing silently when Remove from space is rejected", async () => {
    featureFlagMocks.spaceRailManagement = true;
    removeSpaceChild.mockRejectedValueOnce(new Error("insufficient power level"));
    const space = makeRoomSummary({ room_id: "!space:localhost", is_space: true, name: "Team" });
    const joinedChild = makeRoomSummary({
      room_id: "!child:localhost",
      name: "Team chat",
      parent_space_ids: ["!space:localhost"],
    });
    listSpaceHierarchy.mockResolvedValue([
      {
        child: {
          room_id: "!child:localhost",
          name: "Team chat",
          topic: null,
          num_joined_members: 4,
          join_rule: "invite",
          is_space: false,
        },
        children: [],
      },
    ]);
    renderRoomList(
      <RoomList
        {...roomListProps({ rooms: [space, joinedChild], mode: "space", selectedSpace: space })}
      />,
    );

    fireEvent.contextMenu(await screen.findByText("Team chat"));
    fireEvent.click(await screen.findByText("Remove from space"));

    expect(await screen.findByRole("alert")).toHaveTextContent("insufficient power level");
  });

  it("clears a Remove-from-space error when the user leaves that space's context", async () => {
    // A Remove failure is specific to the space it happened in — it
    // shouldn't keep rendering as a banner once the user navigates to
    // Home, DMs, or a different space (Codex review, #290).
    featureFlagMocks.spaceRailManagement = true;
    removeSpaceChild.mockRejectedValueOnce(new Error("insufficient power level"));
    const space = makeRoomSummary({ room_id: "!space:localhost", is_space: true, name: "Team" });
    const otherSpace = makeRoomSummary({
      room_id: "!other:localhost",
      is_space: true,
      name: "Other",
    });
    const joinedChild = makeRoomSummary({
      room_id: "!child:localhost",
      name: "Team chat",
      parent_space_ids: ["!space:localhost"],
    });
    listSpaceHierarchy.mockResolvedValue([
      {
        child: {
          room_id: "!child:localhost",
          name: "Team chat",
          topic: null,
          num_joined_members: 4,
          join_rule: "invite",
          is_space: false,
        },
        children: [],
      },
    ]);
    const store = createStore();
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const withSelectedSpace = (selectedSpace: typeof space) => (
      <Provider store={store}>
        <QueryClientProvider client={client}>
          <RoomList
            {...roomListProps({
              rooms: [space, otherSpace, joinedChild],
              mode: "space",
              selectedSpace,
            })}
          />
        </QueryClientProvider>
      </Provider>
    );
    const { rerender } = render(withSelectedSpace(space));

    fireEvent.contextMenu(await screen.findByText("Team chat"));
    fireEvent.click(await screen.findByText("Remove from space"));
    expect(await screen.findByRole("alert")).toHaveTextContent("insufficient power level");

    rerender(withSelectedSpace(otherSpace));

    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("refetches the space hierarchy after Add Existing adds a room, via the hierarchyRefreshToken prop", async () => {
    featureFlagMocks.spaceRailManagement = true;
    const space = makeRoomSummary({ room_id: "!space:localhost", is_space: true, name: "Team" });
    listSpaceHierarchy.mockResolvedValueOnce([]).mockResolvedValueOnce([
      {
        child: {
          room_id: "!new-child:localhost",
          name: "Newly added",
          topic: null,
          num_joined_members: 1,
          join_rule: "invite",
          is_space: false,
        },
        children: [],
      },
    ]);
    const store = createStore();
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const withToken = (hierarchyRefreshToken: number) => (
      <Provider store={store}>
        <QueryClientProvider client={client}>
          <RoomList
            {...roomListProps({
              rooms: [space],
              mode: "space",
              selectedSpace: space,
              hierarchyRefreshToken,
            })}
          />
        </QueryClientProvider>
      </Provider>
    );
    const { rerender } = render(withToken(0));
    await waitFor(() => expect(listSpaceHierarchy).toHaveBeenCalledTimes(1));

    rerender(withToken(1));

    await waitFor(() => expect(listSpaceHierarchy).toHaveBeenCalledTimes(2));
    expect(await screen.findByText("Newly added")).toBeInTheDocument();
  });

  it("uses the current mode/space, not a stale closure, when hierarchyRefreshToken changes after switching into space mode", async () => {
    featureFlagMocks.spaceRailManagement = true;
    const space = makeRoomSummary({ room_id: "!space:localhost", is_space: true, name: "Team" });
    listSpaceHierarchy.mockResolvedValueOnce([]).mockResolvedValueOnce([
      {
        child: {
          room_id: "!new-child:localhost",
          name: "Newly added",
          topic: null,
          num_joined_members: 1,
          join_rule: "invite",
          is_space: false,
        },
        children: [],
      },
    ]);
    const store = createStore();
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const withProps = (mode: RoomListMode, hierarchyRefreshToken: number) => (
      <Provider store={store}>
        <QueryClientProvider client={client}>
          <RoomList
            {...roomListProps({
              rooms: [space],
              mode,
              selectedSpace: mode === "space" ? space : null,
              hierarchyRefreshToken,
            })}
          />
        </QueryClientProvider>
      </Provider>
    );
    // Mounts in Home — mode/selectedSpaceId change in a *separate* later
    // render from the eventual token bump, matching the stale-closure
    // scenario a reviewer raised (and which this test disproves: a plain
    // function declaration re-created every render, called from an effect
    // that fires on the render where the token actually changed, always
    // sees that render's own `mode`/`selectedSpaceId`, not an earlier one).
    const { rerender } = render(withProps("home", 0));

    rerender(withProps("space", 0));
    await waitFor(() => expect(listSpaceHierarchy).toHaveBeenCalledTimes(1));

    rerender(withProps("space", 1));

    await waitFor(() => expect(listSpaceHierarchy).toHaveBeenCalledTimes(2));
    expect(await screen.findByText("Newly added")).toBeInTheDocument();
  });

  it("does not offer Remove from space while space_rail_management is off", async () => {
    featureFlagMocks.spaceRailManagement = false;
    const space = makeRoomSummary({ room_id: "!space:localhost", is_space: true, name: "Team" });
    const joinedChild = makeRoomSummary({
      room_id: "!child:localhost",
      name: "Team chat",
      parent_space_ids: ["!space:localhost"],
    });
    listSpaceHierarchy.mockResolvedValue([
      {
        child: {
          room_id: "!child:localhost",
          name: "Team chat",
          topic: null,
          num_joined_members: 4,
          join_rule: "invite",
          is_space: false,
        },
        children: [],
      },
    ]);
    renderRoomList(
      <RoomList
        {...roomListProps({ rooms: [space, joinedChild], mode: "space", selectedSpace: space })}
      />,
    );

    fireEvent.contextMenu(await screen.findByText("Team chat"));
    expect(screen.queryByText("Remove from space")).not.toBeInTheDocument();
  });

  it("wires Remove from space for a favourited room row, which bypasses the hierarchy view", async () => {
    featureFlagMocks.spaceRailManagement = true;
    const space = makeRoomSummary({ room_id: "!space:localhost", is_space: true, name: "Team" });
    const favouriteChild = makeRoomSummary({
      room_id: "!fav-child:localhost",
      name: "Pinned chat",
      is_favourite: true,
      parent_space_ids: ["!space:localhost"],
    });
    // `getScopedRooms` scopes favourites in space mode by hierarchy
    // membership, not `parent_space_ids` alone — the favourite row is
    // rendered separately from (and in addition to) this hierarchy fetch.
    listSpaceHierarchy.mockResolvedValue([
      {
        child: {
          room_id: "!fav-child:localhost",
          name: "Pinned chat",
          topic: null,
          num_joined_members: 1,
          join_rule: "invite",
          is_space: false,
        },
        children: [],
      },
    ]);
    renderRoomList(
      <RoomList
        {...roomListProps({ rooms: [space, favouriteChild], mode: "space", selectedSpace: space })}
      />,
    );

    fireEvent.contextMenu(await screen.findByText("Pinned chat"));
    fireEvent.click(await screen.findByText("Remove from space"));

    expect(removeSpaceChild).toHaveBeenCalledWith("!space:localhost", "!fav-child:localhost");
  });

  it("refetches the space hierarchy after removing a favourited row too, not just untagged hierarchy rows", async () => {
    featureFlagMocks.spaceRailManagement = true;
    const space = makeRoomSummary({ room_id: "!space:localhost", is_space: true, name: "Team" });
    const favouriteChild = makeRoomSummary({
      room_id: "!fav-child:localhost",
      name: "Pinned chat",
      is_favourite: true,
      parent_space_ids: ["!space:localhost"],
    });
    listSpaceHierarchy.mockResolvedValue([
      {
        child: {
          room_id: "!fav-child:localhost",
          name: "Pinned chat",
          topic: null,
          num_joined_members: 1,
          join_rule: "invite",
          is_space: false,
        },
        children: [],
      },
    ]);
    renderRoomList(
      <RoomList
        {...roomListProps({ rooms: [space, favouriteChild], mode: "space", selectedSpace: space })}
      />,
    );
    await waitFor(() => expect(listSpaceHierarchy).toHaveBeenCalledTimes(1));

    fireEvent.contextMenu(await screen.findByText("Pinned chat"));
    fireEvent.click(await screen.findByText("Remove from space"));

    await waitFor(() => expect(listSpaceHierarchy).toHaveBeenCalledTimes(2));
  });

  it("offers Remove for a favourited row visible in the hierarchy fetch before parent_space_ids has synced", async () => {
    // Add Existing's `/hierarchy` refetch can surface an already-favourited
    // room before the next `/sync` updates its `parent_space_ids` — the
    // hierarchy snapshot is the more current source here (Codex review on
    // #290, P2), so Remove must still be offered and target the right
    // space even though `parent_space_ids` doesn't list it yet.
    featureFlagMocks.spaceRailManagement = true;
    const space = makeRoomSummary({ room_id: "!space:localhost", is_space: true, name: "Team" });
    const favouriteChild = makeRoomSummary({
      room_id: "!fav-child:localhost",
      name: "Pinned chat",
      is_favourite: true,
      parent_space_ids: [],
    });
    listSpaceHierarchy.mockResolvedValue([
      {
        child: {
          room_id: "!fav-child:localhost",
          name: "Pinned chat",
          topic: null,
          num_joined_members: 1,
          join_rule: "invite",
          is_space: false,
        },
        children: [],
      },
    ]);
    renderRoomList(
      <RoomList
        {...roomListProps({ rooms: [space, favouriteChild], mode: "space", selectedSpace: space })}
      />,
    );

    fireEvent.contextMenu(await screen.findByText("Pinned chat"));
    fireEvent.click(await screen.findByText("Remove from space"));

    expect(removeSpaceChild).toHaveBeenCalledWith("!space:localhost", "!fav-child:localhost");
  });

  it("targets a favourited row's immediate nested-space parent, not the top-level selected space", async () => {
    // A descendant several levels deep in the hierarchy has its own
    // immediate parent, distinct from the top-level `selectedSpaceId` —
    // `parent_space_ids` alone can't tell these apart (Codex review on
    // #290, P2), only the hierarchy tree's own shape can.
    featureFlagMocks.spaceRailManagement = true;
    const rootSpace = makeRoomSummary({ room_id: "!root:localhost", is_space: true, name: "Root" });
    const nestedSpace = makeRoomSummary({
      room_id: "!nested:localhost",
      is_space: true,
      name: "Nested",
      parent_space_ids: ["!root:localhost"],
    });
    const favouriteChild = makeRoomSummary({
      room_id: "!fav-child:localhost",
      name: "Pinned chat",
      is_favourite: true,
      parent_space_ids: ["!nested:localhost"],
    });
    listSpaceHierarchy.mockResolvedValue([
      {
        child: {
          room_id: "!nested:localhost",
          name: "Nested",
          topic: null,
          num_joined_members: 1,
          join_rule: "invite",
          is_space: true,
        },
        children: [
          {
            child: {
              room_id: "!fav-child:localhost",
              name: "Pinned chat",
              topic: null,
              num_joined_members: 1,
              join_rule: "invite",
              is_space: false,
            },
            children: [],
          },
        ],
      },
    ]);
    renderRoomList(
      <RoomList
        {...roomListProps({
          rooms: [rootSpace, nestedSpace, favouriteChild],
          mode: "space",
          selectedSpace: rootSpace,
        })}
      />,
    );

    fireEvent.contextMenu(await screen.findByText("Pinned chat"));
    fireEvent.click(await screen.findByText("Remove from space"));

    expect(removeSpaceChild).toHaveBeenCalledWith("!nested:localhost", "!fav-child:localhost");
  });

  it("discards a manual hierarchy refetch that resolves after the user has switched to a different space", async () => {
    featureFlagMocks.spaceRailManagement = true;
    const spaceA = makeRoomSummary({
      room_id: "!space-a:localhost",
      is_space: true,
      name: "Team A",
    });
    const spaceB = makeRoomSummary({
      room_id: "!space-b:localhost",
      is_space: true,
      name: "Team B",
    });
    const childOfA = makeRoomSummary({
      room_id: "!child-a:localhost",
      name: "Chat A",
      parent_space_ids: ["!space-a:localhost"],
    });
    let resolveRefetch: (value: unknown) => void = () => {};
    listSpaceHierarchy
      .mockResolvedValueOnce([
        {
          child: {
            room_id: "!child-a:localhost",
            name: "Chat A",
            topic: null,
            num_joined_members: 1,
            join_rule: "invite",
            is_space: false,
          },
          children: [],
        },
      ])
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveRefetch = resolve;
          }),
      )
      .mockResolvedValueOnce([]);

    const store = createStore();
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const withProps = (selectedSpace: typeof spaceA, hierarchyRefreshToken: number) => (
      <Provider store={store}>
        <QueryClientProvider client={client}>
          <RoomList
            {...roomListProps({
              rooms: [spaceA, spaceB, childOfA],
              mode: "space",
              selectedSpace,
              hierarchyRefreshToken,
            })}
          />
        </QueryClientProvider>
      </Provider>
    );
    const { rerender } = render(withProps(spaceA, 0));
    await waitFor(() => expect(listSpaceHierarchy).toHaveBeenCalledTimes(1));

    // A manual refetch (e.g. from Add Existing) starts for space A but never
    // settles before the user switches to space B.
    rerender(withProps(spaceA, 1));
    await waitFor(() => expect(listSpaceHierarchy).toHaveBeenCalledTimes(2));

    rerender(withProps(spaceB, 1));
    await waitFor(() => expect(listSpaceHierarchy).toHaveBeenCalledTimes(3));

    // Now the stale space-A request finally resolves — it must not clobber
    // space B's (empty) hierarchy with space A's rooms.
    resolveRefetch([
      {
        child: {
          room_id: "!child-a:localhost",
          name: "Chat A",
          topic: null,
          num_joined_members: 1,
          join_rule: "invite",
          is_space: false,
        },
        children: [],
      },
    ]);
    await Promise.resolve();
    await Promise.resolve();

    expect(screen.queryByText("Chat A")).not.toBeInTheDocument();
  });

  it("discards a manual refetch triggered from a stale render after the user has switched spaces", async () => {
    // Covers the `currentScopeRef` fix in `refetchSpaceHierarchy`: a mutation
    // (e.g. Remove from space) kicked off while space A was selected can
    // resolve its `.then()` callback after the user has since switched to
    // space B. The stale closure's own `mode`/`selectedSpaceId` values are
    // no longer enough — the callback must consult current scope at
    // resolution time, not issue time, even for a *manually triggered*
    // refetch (not just the auto-fetch-on-selection covered by the test
    // above).
    featureFlagMocks.spaceRailManagement = true;
    const spaceA = makeRoomSummary({
      room_id: "!space-a:localhost",
      is_space: true,
      name: "Team A",
    });
    const spaceB = makeRoomSummary({
      room_id: "!space-b:localhost",
      is_space: true,
      name: "Team B",
    });
    const childOfA = makeRoomSummary({
      room_id: "!child-a:localhost",
      name: "Chat A",
      parent_space_ids: ["!space-a:localhost"],
    });

    let resolveManualRefetch: (value: unknown) => void = () => {};
    listSpaceHierarchy
      // Initial auto-fetch for space A.
      .mockResolvedValueOnce([
        {
          child: {
            room_id: "!child-a:localhost",
            name: "Chat A",
            topic: null,
            num_joined_members: 1,
            join_rule: "invite",
            is_space: false,
          },
          children: [],
        },
      ])
      // A manual refetch (bumping hierarchyRefreshToken) kicked off while
      // space A was still selected — never settles before the switch.
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveManualRefetch = resolve;
          }),
      )
      // Auto-fetch for space B once the user switches.
      .mockResolvedValueOnce([]);

    const store = createStore();
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const withProps = (selectedSpace: typeof spaceA, hierarchyRefreshToken: number) => (
      <Provider store={store}>
        <QueryClientProvider client={client}>
          <RoomList
            {...roomListProps({
              rooms: [spaceA, spaceB, childOfA],
              mode: "space",
              selectedSpace,
              hierarchyRefreshToken,
            })}
          />
        </QueryClientProvider>
      </Provider>
    );
    const { rerender } = render(withProps(spaceA, 0));
    await waitFor(() => expect(listSpaceHierarchy).toHaveBeenCalledTimes(1));

    // A manual refetch is triggered (e.g. a sibling SpaceRail row's Remove
    // from space succeeding) while space A is still selected — this is the
    // render whose closure the fix must NOT rely on.
    rerender(withProps(spaceA, 1));
    await waitFor(() => expect(listSpaceHierarchy).toHaveBeenCalledTimes(2));

    // The user switches to space B before that manual refetch resolves.
    rerender(withProps(spaceB, 1));
    await waitFor(() => expect(listSpaceHierarchy).toHaveBeenCalledTimes(3));

    // The stale manual refetch (issued for space A) now resolves — it must
    // not clobber space B's (empty) hierarchy with space A's rooms, even
    // though it was a manually-triggered refetch rather than an
    // auto-fetch-on-selection.
    resolveManualRefetch([
      {
        child: {
          room_id: "!child-a:localhost",
          name: "Chat A",
          topic: null,
          num_joined_members: 1,
          join_rule: "invite",
          is_space: false,
        },
        children: [],
      },
    ]);
    await Promise.resolve();
    await Promise.resolve();

    expect(screen.queryByText("Chat A")).not.toBeInTheDocument();
  });

  it("does not start a second hierarchy join while another is pending", async () => {
    const space = makeRoomSummary({ room_id: "!space:localhost", is_space: true, name: "Team" });
    let resolveJoin!: () => void;
    joinRoom.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          resolveJoin = resolve;
        }),
    );
    listSpaceHierarchy.mockResolvedValue([
      {
        child: {
          room_id: "!public-a:localhost",
          name: "Public A",
          topic: null,
          num_joined_members: 4,
          join_rule: "public",
          is_space: false,
        },
        children: [],
      },
      {
        child: {
          room_id: "!public-b:localhost",
          name: "Public B",
          topic: null,
          num_joined_members: 4,
          join_rule: "public",
          is_space: false,
        },
        children: [],
      },
    ]);
    renderRoomList(
      <RoomList
        {...roomListProps({
          rooms: [space],
          mode: "space",
          selectedSpace: space,
        })}
      />,
    );

    const buttons = await screen.findAllByRole("button", { name: "Join" });
    fireEvent.click(buttons[0]);
    fireEvent.click(buttons[1]);

    expect(joinRoom).toHaveBeenCalledOnce();
    resolveJoin();
  });

  it("ignores hierarchy join errors after leaving the selected space", async () => {
    const space = makeRoomSummary({ room_id: "!space:localhost", is_space: true, name: "Team" });
    let rejectJoin!: (error: Error) => void;
    joinRoom.mockImplementationOnce(
      () =>
        new Promise<void>((_resolve, reject) => {
          rejectJoin = reject;
        }),
    );
    listSpaceHierarchy.mockResolvedValue([
      {
        child: {
          room_id: "!public:localhost",
          name: "Public room",
          topic: null,
          num_joined_members: 4,
          join_rule: "public",
          is_space: false,
        },
        children: [],
      },
    ]);

    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const store = createStore();
    const renderWithProviders = (ui: ReactElement) => (
      <Provider store={store}>
        <QueryClientProvider client={client}>{ui}</QueryClientProvider>
      </Provider>
    );
    const { rerender } = render(
      renderWithProviders(
        <RoomList
          {...roomListProps({
            rooms: [space],
            mode: "space",
            selectedSpace: space,
          })}
        />,
      ),
    );

    fireEvent.click(await screen.findByRole("button", { name: "Join" }));
    rerender(renderWithProviders(<RoomList {...roomListProps({ rooms: [] })} />));
    await act(async () => {
      rejectJoin(new Error("join failed"));
      await Promise.resolve();
    });

    expect(screen.queryByText("join failed")).not.toBeInTheDocument();
  });

  it("opens joined hierarchy spaces and joins public hierarchy spaces", async () => {
    const onSelectSpace = vi.fn();
    const space = makeRoomSummary({ room_id: "!space:localhost", is_space: true, name: "Team" });
    const nestedSpace = makeRoomSummary({
      room_id: "!nested:localhost",
      name: "Nested space",
      is_space: true,
      parent_space_ids: ["!space:localhost"],
    });
    listSpaceHierarchy.mockResolvedValue([
      {
        child: {
          room_id: "!nested:localhost",
          name: "Nested space",
          topic: "Joined child space",
          num_joined_members: 3,
          join_rule: "invite",
          is_space: true,
        },
        children: [
          {
            child: {
              room_id: "!public-space:localhost",
              name: "Public nested space",
              topic: null,
              num_joined_members: 6,
              join_rule: "public",
              is_space: true,
            },
            children: [],
          },
        ],
      },
    ]);
    renderRoomList(
      <RoomList
        {...roomListProps({
          rooms: [space, nestedSpace],
          mode: "space",
          selectedSpace: space,
          onSelectSpace,
        })}
      />,
    );

    fireEvent.click(await screen.findByRole("button", { name: /Nested space/ }));
    expect(onSelectSpace).toHaveBeenCalledWith("!nested:localhost");
    fireEvent.click(screen.getByRole("button", { name: "Join" }));
    expect(joinRoom).toHaveBeenCalledWith("!public-space:localhost");
  });

  it("excludes direct rooms from the selected space hierarchy", async () => {
    const space = makeRoomSummary({ room_id: "!space:localhost", is_space: true, name: "Team" });
    const directRoom = makeRoomSummary({
      room_id: "!dm:localhost",
      name: "Alice",
      is_direct: true,
      parent_space_ids: ["!space:localhost"],
    });
    listSpaceHierarchy.mockResolvedValue([
      {
        child: {
          room_id: "!dm:localhost",
          name: "Alice",
          topic: null,
          num_joined_members: 2,
          join_rule: "invite",
          is_space: false,
        },
        children: [],
      },
    ]);
    renderRoomList(
      <RoomList
        {...roomListProps({
          rooms: [space, directRoom],
          mode: "space",
          selectedSpace: space,
        })}
      />,
    );

    await waitFor(() => expect(listSpaceHierarchy).toHaveBeenCalledWith("!space:localhost"));
    expect(screen.queryByText("Alice")).not.toBeInTheDocument();
  });

  it("shows the empty state when the selected space has only hidden hierarchy rooms", async () => {
    const space = makeRoomSummary({ room_id: "!space:localhost", is_space: true, name: "Team" });
    const directRoom = makeRoomSummary({
      room_id: "!dm:localhost",
      name: "Alice",
      is_direct: true,
      parent_space_ids: ["!space:localhost"],
    });
    listSpaceHierarchy.mockResolvedValue([
      {
        child: {
          room_id: "!dm:localhost",
          name: "Alice",
          topic: null,
          num_joined_members: 2,
          join_rule: "invite",
          is_space: false,
        },
        children: [],
      },
    ]);
    renderRoomList(
      <RoomList
        {...roomListProps({
          rooms: [space, directRoom],
          mode: "space",
          selectedSpace: space,
        })}
      />,
    );

    expect(await screen.findByText("No rooms yet")).toBeInTheDocument();
    expect(screen.queryByText("Alice")).not.toBeInTheDocument();
  });

  it("keeps tagged child spaces visible in the selected space hierarchy", async () => {
    const space = makeRoomSummary({ room_id: "!space:localhost", is_space: true, name: "Team" });
    const favouriteSpace = makeRoomSummary({
      room_id: "!fav-space:localhost",
      name: "Pinned subspace",
      is_space: true,
      is_favourite: true,
      parent_space_ids: ["!space:localhost"],
    });
    listSpaceHierarchy.mockResolvedValue([
      {
        child: {
          room_id: "!fav-space:localhost",
          name: "Pinned subspace",
          topic: null,
          num_joined_members: 2,
          join_rule: "invite",
          is_space: true,
        },
        children: [
          {
            child: {
              room_id: "!child:localhost",
              name: "Child under pinned subspace",
              topic: null,
              num_joined_members: 1,
              join_rule: "public",
              is_space: false,
            },
            children: [],
          },
        ],
      },
    ]);
    renderRoomList(
      <RoomList
        {...roomListProps({
          rooms: [space, favouriteSpace],
          mode: "space",
          selectedSpace: space,
        })}
      />,
    );

    expect(await screen.findByRole("button", { name: /Pinned subspace/ })).toBeInTheDocument();
    expect(screen.getByText("Child under pinned subspace")).toBeInTheDocument();
  });

  it("does not render children of hierarchy rooms shown in tagged sections", async () => {
    const space = makeRoomSummary({ room_id: "!space:localhost", is_space: true, name: "Team" });
    const favouriteParent = makeRoomSummary({
      room_id: "!fav-parent:localhost",
      name: "Pinned project",
      parent_space_ids: ["!space:localhost"],
      is_favourite: true,
    });
    listSpaceHierarchy.mockResolvedValue([
      {
        child: {
          room_id: "!fav-parent:localhost",
          name: "Pinned project",
          topic: null,
          num_joined_members: 2,
          join_rule: "invite",
          is_space: false,
        },
        children: [
          {
            child: {
              room_id: "!child:localhost",
              name: "Child under pinned project",
              topic: null,
              num_joined_members: 1,
              join_rule: "public",
              is_space: false,
            },
            children: [],
          },
        ],
      },
    ]);
    renderRoomList(
      <RoomList
        {...roomListProps({
          rooms: [space, favouriteParent],
          mode: "space",
          selectedSpace: space,
        })}
      />,
    );

    expect(await screen.findByText("Pinned project")).toBeInTheDocument();
    expect(screen.getByText("Favourites")).toBeInTheDocument();
    expect(screen.queryByText("Space rooms")).not.toBeInTheDocument();
    expect(screen.queryByText("Child under pinned project")).not.toBeInTheDocument();
  });

  it("does not refetch the space hierarchy when the selected space object is recreated", async () => {
    const space = makeRoomSummary({ room_id: "!space:localhost", is_space: true, name: "Team" });
    listSpaceHierarchy.mockResolvedValue([]);
    const store = createStore();
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const renderWithProviders = (selectedSpace: typeof space) => (
      <Provider store={store}>
        <QueryClientProvider client={client}>
          <RoomList
            {...roomListProps({
              rooms: [space],
              mode: "space",
              selectedSpace,
            })}
          />
        </QueryClientProvider>
      </Provider>
    );
    const { rerender } = render(renderWithProviders(space));

    expect(listSpaceHierarchy).toHaveBeenCalledWith("!space:localhost");
    rerender(renderWithProviders({ ...space }));

    expect(listSpaceHierarchy).toHaveBeenCalledOnce();
  });

  it("shows space hierarchy load errors instead of the empty state", async () => {
    const space = makeRoomSummary({ room_id: "!space:localhost", is_space: true, name: "Team" });
    listSpaceHierarchy.mockRejectedValue(new Error("hierarchy unavailable"));
    renderRoomList(
      <RoomList
        {...roomListProps({
          rooms: [space],
          mode: "space",
          selectedSpace: space,
        })}
      />,
    );

    expect(await screen.findByText("Error: hierarchy unavailable")).toBeInTheDocument();
    expect(screen.queryByText("No rooms yet")).not.toBeInTheDocument();
  });

  it("clears a stale hierarchy load error once a manual refetch succeeds", async () => {
    featureFlagMocks.spaceRailManagement = true;
    const space = makeRoomSummary({ room_id: "!space:localhost", is_space: true, name: "Team" });
    listSpaceHierarchy
      .mockRejectedValueOnce(new Error("hierarchy unavailable"))
      .mockResolvedValueOnce([]);
    const store = createStore();
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const withToken = (hierarchyRefreshToken: number) => (
      <Provider store={store}>
        <QueryClientProvider client={client}>
          <RoomList
            {...roomListProps({
              rooms: [space],
              mode: "space",
              selectedSpace: space,
              hierarchyRefreshToken,
            })}
          />
        </QueryClientProvider>
      </Provider>
    );
    const { rerender } = render(withToken(0));
    expect(await screen.findByText("Error: hierarchy unavailable")).toBeInTheDocument();

    // Connectivity recovers and a mutation (Add Existing/Remove) triggers a
    // manual refetch, which succeeds this time.
    rerender(withToken(1));

    await waitFor(() =>
      expect(screen.queryByText("Error: hierarchy unavailable")).not.toBeInTheDocument(),
    );
  });

  it("shows all non-DM rooms from Home when Show all rooms is enabled", () => {
    const child = makeRoomSummary({
      room_id: "!child:localhost",
      name: "Team chat",
      parent_space_ids: ["!space:localhost"],
    });
    const dm = makeRoomSummary({ room_id: "!dm:localhost", name: "Alice", is_direct: true });
    renderRoomList(<RoomList {...roomListProps({ rooms: [child, dm], showAllRooms: true })} />);

    expect(screen.getByText("Team chat")).toBeInTheDocument();
    expect(screen.queryByText("Alice")).not.toBeInTheDocument();
  });

  it("renders only direct rooms in DM mode", () => {
    const room = makeRoomSummary({ room_id: "!room:localhost", name: "Room" });
    const dm = makeRoomSummary({ room_id: "!dm:localhost", name: "Alice", is_direct: true });
    renderRoomList(<RoomList {...roomListProps({ rooms: [room, dm], mode: "dms" })} />);

    expect(screen.getByText("Alice")).toBeInTheDocument();
    expect(screen.queryByText("Room")).not.toBeInTheDocument();
  });

  it("keeps the All/Unread control hidden while the Spec 54 flag is off", () => {
    renderRoomList(<RoomList {...roomListProps()} />);

    expect(screen.queryByRole("group", { name: "Room filter" })).not.toBeInTheDocument();
  });

  it("filters joined rooms by authoritative unread state while preserving the active room and invites", () => {
    featureFlagMocks.roomListUnreadFilter = true;
    const activeRead = makeRoomSummary({ room_id: "!active:localhost", name: "Active read" });
    const otherRead = makeRoomSummary({ room_id: "!read:localhost", name: "Other read" });
    const unread = makeRoomSummary({
      room_id: "!unread:localhost",
      name: "Unread room",
      has_unread: true,
    });
    const invite = makeRoomSummary({
      room_id: "!invite:localhost",
      name: "Invited room",
      membership: "invite",
    });
    renderRoomList(
      <RoomList
        {...roomListProps({
          rooms: [activeRead, otherRead, unread, invite],
          activeRoomId: activeRead.room_id,
        })}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Unread" }));

    expect(screen.getByText("Active read")).toBeInTheDocument();
    expect(screen.getByText("Unread room")).toBeInTheDocument();
    expect(screen.getByText("Invited room")).toBeInTheDocument();
    expect(screen.queryByText("Other read")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "All" }));
    expect(screen.getByText("Other read")).toBeInTheDocument();
  });

  it("keeps search results constrained to unread and active rooms", () => {
    featureFlagMocks.roomListUnreadFilter = true;
    const activeRead = makeRoomSummary({ room_id: "!active:localhost", name: "Alpha active" });
    const otherRead = makeRoomSummary({ room_id: "!read:localhost", name: "Alpha read" });
    const unread = makeRoomSummary({
      room_id: "!unread:localhost",
      name: "Alpha unread",
      has_unread: true,
    });
    renderRoomList(
      <RoomList
        {...roomListProps({
          rooms: [activeRead, otherRead, unread],
          activeRoomId: activeRead.room_id,
        })}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Unread" }));
    fireEvent.change(screen.getByRole("searchbox", { name: "Search rooms" }), {
      target: { value: "alpha" },
    });

    expect(screen.getByText("Alpha active")).toBeInTheDocument();
    expect(screen.getByText("Alpha unread")).toBeInTheDocument();
    expect(screen.queryByText("Alpha read")).not.toBeInTheDocument();
  });

  it("persists the unread filter per list mode and disables reorder in the filtered view", () => {
    featureFlagMocks.roomListUnreadFilter = true;
    const unreadDm = makeRoomSummary({
      room_id: "!unread-dm:localhost",
      name: "Unread DM",
      is_direct: true,
      is_favourite: true,
      has_unread: true,
    });
    const readDm = makeRoomSummary({
      room_id: "!read-dm:localhost",
      name: "Read DM",
      is_direct: true,
      is_favourite: true,
    });
    const first = renderRoomList(
      <RoomList {...roomListProps({ rooms: [unreadDm, readDm], mode: "dms" })} />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Unread" }));
    expect(screen.getByText("Unread DM").closest("button")).toHaveAttribute(
      "data-reorder-enabled",
      "false",
    );
    expect(screen.queryByText("Read DM")).not.toBeInTheDocument();
    expect(localStorage.getItem("charm:room-list-filters")).toContain('"dms":"unread"');

    first.unmount();
    renderRoomList(<RoomList {...roomListProps({ rooms: [unreadDm, readDm], mode: "dms" })} />);
    expect(screen.getByRole("button", { name: "Unread" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.queryByText("Read DM")).not.toBeInTheDocument();
  });

  it("keeps reordering enabled when the message-preview flag is on (rows measure their own height instead)", () => {
    featureFlagMocks.roomListMessagePreview = true;
    const room = makeRoomSummary({ room_id: "!room:localhost", name: "Room" });
    renderRoomList(<RoomList {...roomListProps({ rooms: [room] })} />);

    expect(screen.getByText("Room").closest("button")).toHaveAttribute(
      "data-reorder-enabled",
      "true",
    );
  });

  it("prunes read space descendants but keeps unread and active rooms with their hierarchy ancestors", async () => {
    featureFlagMocks.roomListUnreadFilter = true;
    const space = makeRoomSummary({ room_id: "!space:localhost", name: "Team", is_space: true });
    const nested = makeRoomSummary({
      room_id: "!nested:localhost",
      name: "Nested",
      is_space: true,
      parent_space_ids: [space.room_id],
    });
    const unread = makeRoomSummary({
      room_id: "!unread-child:localhost",
      name: "Unread child",
      parent_space_ids: [nested.room_id],
      has_unread: true,
    });
    const activeRead = makeRoomSummary({
      room_id: "!active-child:localhost",
      name: "Active read child",
      parent_space_ids: [nested.room_id],
    });
    const otherRead = makeRoomSummary({
      room_id: "!read-child:localhost",
      name: "Other read child",
      parent_space_ids: [nested.room_id],
    });
    listSpaceHierarchy.mockResolvedValue([
      {
        child: hierarchyChild(nested.room_id, "Nested", true),
        children: [
          { child: hierarchyChild(unread.room_id, "Unread child"), children: [] },
          { child: hierarchyChild(activeRead.room_id, "Active read child"), children: [] },
          { child: hierarchyChild(otherRead.room_id, "Other read child"), children: [] },
          { child: hierarchyChild("!public:localhost", "Public unjoined child"), children: [] },
        ],
      },
    ]);
    renderRoomList(
      <RoomList
        {...roomListProps({
          rooms: [space, nested, unread, activeRead, otherRead],
          mode: "space",
          selectedSpace: space,
          activeRoomId: activeRead.room_id,
        })}
      />,
    );

    expect(await screen.findByText("Public unjoined child")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Unread" }));

    expect(screen.getByText("Nested")).toBeInTheDocument();
    expect(screen.getByText("Unread child")).toBeInTheDocument();
    expect(screen.getByText("Active read child")).toBeInTheDocument();
    expect(screen.queryByText("Other read child")).not.toBeInTheDocument();
    expect(screen.queryByText("Public unjoined child")).not.toBeInTheDocument();
  });

  it("keeps DM favourites reorderable when non-DM favourites exist", () => {
    const room = makeRoomSummary({
      room_id: "!room:localhost",
      name: "Room",
      is_favourite: true,
    });
    const dm = makeRoomSummary({
      room_id: "!dm:localhost",
      name: "Alice",
      is_direct: true,
      is_favourite: true,
    });
    renderRoomList(<RoomList {...roomListProps({ rooms: [room, dm], mode: "dms" })} />);

    expect(screen.getByText("Alice")).toBeInTheDocument();
    expect(screen.queryByText("Room")).not.toBeInTheDocument();
    expect(screen.getByText("Alice").closest("button")).toHaveAttribute(
      "data-reorder-enabled",
      "true",
    );
  });

  it("keeps DM low-priority rooms reorderable when non-DM low-priority rooms exist", () => {
    const room = makeRoomSummary({
      room_id: "!room:localhost",
      name: "Room",
      is_low_priority: true,
    });
    const dm = makeRoomSummary({
      room_id: "!dm:localhost",
      name: "Alice",
      is_direct: true,
      is_low_priority: true,
    });
    renderRoomList(<RoomList {...roomListProps({ rooms: [room, dm], mode: "dms" })} />);

    expect(screen.getByText("Alice")).toBeInTheDocument();
    expect(screen.queryByText("Room")).not.toBeInTheDocument();
    expect(screen.getByText("Alice").closest("button")).toHaveAttribute(
      "data-reorder-enabled",
      "true",
    );
  });

  it("filters the visible rooms by search query, scoped to the current mode by default", () => {
    const space = makeRoomSummary({ room_id: "!space:localhost", is_space: true, name: "Team" });
    const orphanMatch = makeRoomSummary({ room_id: "!orphan:localhost", name: "Alpha orphan" });
    const orphanNoMatch = makeRoomSummary({ room_id: "!other:localhost", name: "Beta orphan" });
    const spaceChildMatch = makeRoomSummary({
      room_id: "!child:localhost",
      name: "Alpha in space",
      parent_space_ids: ["!space:localhost"],
    });
    renderRoomList(
      <RoomList
        {...roomListProps({ rooms: [space, orphanMatch, orphanNoMatch, spaceChildMatch] })}
      />,
    );

    fireEvent.change(screen.getByRole("searchbox", { name: "Search rooms" }), {
      target: { value: "alpha" },
    });

    expect(screen.getByText("Alpha orphan")).toBeInTheDocument();
    expect(screen.queryByText("Beta orphan")).not.toBeInTheDocument();
    // Scoped to Home (orphan rooms only) by default — a match that's only
    // reachable via the space isn't shown without "Search everywhere".
    expect(screen.queryByText("Alpha in space")).not.toBeInTheDocument();
  });

  it("searches every joined room when Search everywhere is checked", () => {
    const space = makeRoomSummary({ room_id: "!space:localhost", is_space: true, name: "Team" });
    const spaceChildMatch = makeRoomSummary({
      room_id: "!child:localhost",
      name: "Alpha in space",
      parent_space_ids: ["!space:localhost"],
    });
    renderRoomList(<RoomList {...roomListProps({ rooms: [space, spaceChildMatch] })} />);

    fireEvent.change(screen.getByRole("searchbox", { name: "Search rooms" }), {
      target: { value: "alpha" },
    });
    expect(screen.queryByText("Alpha in space")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("checkbox", { name: "Search everywhere" }));
    expect(screen.getByText("Alpha in space")).toBeInTheDocument();
  });

  it("never shows spaces themselves as a search result", () => {
    const space = makeRoomSummary({ room_id: "!space:localhost", is_space: true, name: "Alpha" });
    renderRoomList(<RoomList {...roomListProps({ rooms: [space] })} />);

    fireEvent.change(screen.getByRole("searchbox", { name: "Search rooms" }), {
      target: { value: "alpha" },
    });
    fireEvent.click(screen.getByRole("checkbox", { name: "Search everywhere" }));

    expect(screen.getByText("No matching rooms")).toBeInTheDocument();
  });

  it("shows a no-match message when nothing satisfies the search", () => {
    const orphan = makeRoomSummary({ room_id: "!orphan:localhost", name: "Orphan" });
    renderRoomList(<RoomList {...roomListProps({ rooms: [orphan] })} />);

    fireEvent.change(screen.getByRole("searchbox", { name: "Search rooms" }), {
      target: { value: "nonexistent" },
    });

    expect(screen.getByText("No matching rooms")).toBeInTheDocument();
  });

  it("hides the Search everywhere toggle until a query is entered", () => {
    renderRoomList(<RoomList {...roomListProps()} />);

    expect(screen.queryByRole("checkbox", { name: "Search everywhere" })).not.toBeInTheDocument();

    fireEvent.change(screen.getByRole("searchbox", { name: "Search rooms" }), {
      target: { value: "a" },
    });

    expect(screen.getByRole("checkbox", { name: "Search everywhere" })).toBeInTheDocument();
  });

  it("requires a space selection even with an active search query", () => {
    renderRoomList(<RoomList {...roomListProps({ mode: "space", selectedSpace: null })} />);

    fireEvent.change(screen.getByRole("searchbox", { name: "Search rooms" }), {
      target: { value: "alpha" },
    });

    expect(screen.getByText("Select a space.")).toBeInTheDocument();
    expect(screen.queryByText("No matching rooms")).not.toBeInTheDocument();
  });

  it("shows the space-loading state instead of a stale no-match message while searching", async () => {
    listSpaceHierarchy.mockReturnValue(new Promise(() => {})); // never resolves
    const space = makeRoomSummary({ room_id: "!space:localhost", is_space: true, name: "Team" });
    renderRoomList(
      <RoomList {...roomListProps({ rooms: [space], mode: "space", selectedSpace: space })} />,
    );

    fireEvent.change(screen.getByRole("searchbox", { name: "Search rooms" }), {
      target: { value: "alpha" },
    });

    await waitFor(() => expect(screen.getByText("Loading space…")).toBeInTheDocument());
    expect(screen.queryByText("No matching rooms")).not.toBeInTheDocument();
  });

  it("resets the search when switching modes", () => {
    const orphan = makeRoomSummary({ room_id: "!orphan:localhost", name: "Orphan" });
    const dm = makeRoomSummary({ room_id: "!dm:localhost", name: "Alice", is_direct: true });
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const store = createStore();
    function renderWithMode(mode: "home" | "dms") {
      return (
        <Provider store={store}>
          <QueryClientProvider client={client}>
            <RoomList {...roomListProps({ rooms: [orphan, dm], mode })} />
          </QueryClientProvider>
        </Provider>
      );
    }
    const { rerender } = render(renderWithMode("home"));

    fireEvent.change(screen.getByRole("searchbox", { name: "Search rooms" }), {
      target: { value: "orphan" },
    });
    expect(screen.getByRole("checkbox", { name: "Search everywhere" })).toBeInTheDocument();

    rerender(renderWithMode("dms"));

    expect(screen.getByRole("searchbox", { name: "Search rooms" })).toHaveValue("");
    expect(screen.queryByRole("checkbox", { name: "Search everywhere" })).not.toBeInTheDocument();
    expect(screen.getByText("Alice")).toBeInTheDocument();
  });

  it("resets Search everywhere when the search query is cleared", () => {
    const space = makeRoomSummary({ room_id: "!space:localhost", is_space: true, name: "Team" });
    const spaceChildMatch = makeRoomSummary({
      room_id: "!child:localhost",
      name: "Alpha in space",
      parent_space_ids: ["!space:localhost"],
    });
    renderRoomList(<RoomList {...roomListProps({ rooms: [space, spaceChildMatch] })} />);

    const searchBox = screen.getByRole("searchbox", { name: "Search rooms" });
    fireEvent.change(searchBox, { target: { value: "alpha" } });
    fireEvent.click(screen.getByRole("checkbox", { name: "Search everywhere" }));
    expect(screen.getByText("Alpha in space")).toBeInTheDocument();

    fireEvent.change(searchBox, { target: { value: "" } });
    fireEvent.change(searchBox, { target: { value: "alpha" } });

    // Re-entering a query after clearing must not silently reopen already
    // scoped to "everywhere" — the out-of-scope match should be hidden again
    // until the user re-checks the box.
    expect(screen.queryByText("Alpha in space")).not.toBeInTheDocument();
    expect(screen.getByRole("checkbox", { name: "Search everywhere" })).not.toBeChecked();
  });

  it("switches context when selecting a search result outside the current scope", () => {
    const space = makeRoomSummary({ room_id: "!space:localhost", is_space: true, name: "Team" });
    const spaceChildMatch = makeRoomSummary({
      room_id: "!child:localhost",
      name: "Alpha in space",
      parent_space_ids: ["!space:localhost"],
    });
    const onSelectSearchResult = vi.fn();
    renderRoomList(
      <RoomList {...roomListProps({ rooms: [space, spaceChildMatch], onSelectSearchResult })} />,
    );

    fireEvent.change(screen.getByRole("searchbox", { name: "Search rooms" }), {
      target: { value: "alpha" },
    });
    fireEvent.click(screen.getByRole("checkbox", { name: "Search everywhere" }));
    screen.getByText("Alpha in space").click();

    expect(onSelectSearchResult).toHaveBeenCalledWith(spaceChildMatch);
  });

  it("keeps in-scope search result selections in place instead of switching context", () => {
    // Home with "Show all rooms" already surfaces space children in
    // scopedRooms, so a match here is already visible — selecting it should
    // just activate the room, not trigger the cross-scope switch callback.
    const space = makeRoomSummary({ room_id: "!space:localhost", is_space: true, name: "Team" });
    const spaceChildMatch = makeRoomSummary({
      room_id: "!child:localhost",
      name: "Alpha in space",
      parent_space_ids: ["!space:localhost"],
    });
    const onSelectRoom = vi.fn();
    const onSelectSearchResult = vi.fn();
    renderRoomList(
      <RoomList
        {...roomListProps({
          rooms: [space, spaceChildMatch],
          showAllRooms: true,
          onSelectRoom,
          onSelectSearchResult,
        })}
      />,
    );

    fireEvent.change(screen.getByRole("searchbox", { name: "Search rooms" }), {
      target: { value: "alpha" },
    });
    screen.getByText("Alpha in space").click();

    expect(onSelectRoom).toHaveBeenCalledWith("!child:localhost");
    expect(onSelectSearchResult).not.toHaveBeenCalled();
  });

  it("clears search state after selecting an in-scope result misjudged as out-of-scope while the space is loading", async () => {
    // Regression test: while the selected space's hierarchy is still
    // loading, `scopedRoomIds` is empty, so a room that actually belongs to
    // this space gets treated as an out-of-scope search result and routed
    // through `onSelectSearchResult`. If that callback lands back on the
    // *same* mode/space (as the real `selectRoomInVisibleMode` does for a
    // room whose parent space is already selected), the mode/selectedSpaceId
    // reset effect never fires because neither value changed — the search
    // box and "Search everywhere" checkbox must still clear via the
    // selection handler itself.
    listSpaceHierarchy.mockReturnValue(new Promise(() => {})); // never resolves
    const space = makeRoomSummary({ room_id: "!space:localhost", is_space: true, name: "Team" });
    const spaceChildMatch = makeRoomSummary({
      room_id: "!child:localhost",
      name: "Alpha in space",
      parent_space_ids: ["!space:localhost"],
    });
    const onSelectSearchResult = vi.fn(); // no-op stand-in for selectRoomInVisibleMode
    renderRoomList(
      <RoomList
        {...roomListProps({
          rooms: [space, spaceChildMatch],
          mode: "space",
          selectedSpace: space,
          onSelectSearchResult,
        })}
      />,
    );

    const searchBox = screen.getByRole("searchbox", { name: "Search rooms" });
    fireEvent.change(searchBox, { target: { value: "alpha" } });
    await waitFor(() => expect(screen.getByText("Loading space…")).toBeInTheDocument());
    fireEvent.click(screen.getByRole("checkbox", { name: "Search everywhere" }));
    fireEvent.click(screen.getByText("Alpha in space"));

    expect(onSelectSearchResult).toHaveBeenCalledWith(spaceChildMatch);
    expect(searchBox).toHaveValue("");
    expect(screen.queryByRole("checkbox", { name: "Search everywhere" })).not.toBeInTheDocument();
  });

  it("does not let a join failure hide already-loaded scoped search results", async () => {
    // Regression test: `handleJoin`'s catch previously wrote into the same
    // `spaceError` state as a failed hierarchy fetch, so a join/knock
    // failure — which happens *after* the hierarchy already loaded fine —
    // would incorrectly block scoped search from showing results.
    const joinedMatch = makeRoomSummary({
      room_id: "!joined:localhost",
      name: "Alpha room",
      parent_space_ids: ["!space:localhost"],
    });
    const space = makeRoomSummary({ room_id: "!space:localhost", is_space: true, name: "Team" });
    listSpaceHierarchy.mockResolvedValue([
      {
        child: {
          room_id: "!joined:localhost",
          name: "Alpha room",
          topic: null,
          num_joined_members: 4,
          join_rule: "public",
          is_space: false,
        },
        children: [],
      },
      {
        child: {
          room_id: "!public:localhost",
          name: "Public room",
          topic: null,
          num_joined_members: 4,
          join_rule: "public",
          is_space: false,
        },
        children: [],
      },
    ]);
    joinRoom.mockRejectedValueOnce(new Error("join failed"));
    renderRoomList(
      <RoomList
        {...roomListProps({ rooms: [space, joinedMatch], mode: "space", selectedSpace: space })}
      />,
    );

    await screen.findByText("Public room");
    fireEvent.click(screen.getByRole("button", { name: "Join" }));
    await waitFor(() => expect(screen.getByText("Error: join failed")).toBeInTheDocument());

    fireEvent.change(screen.getByRole("searchbox", { name: "Search rooms" }), {
      target: { value: "alpha" },
    });

    expect(await screen.findByText("Alpha room")).toBeInTheDocument();
    expect(screen.queryByText("No matching rooms")).not.toBeInTheDocument();
  });

  it("shows the hierarchy error instead of a stale no-match message while searching", async () => {
    listSpaceHierarchy.mockRejectedValue(new Error("hierarchy fetch failed"));
    const space = makeRoomSummary({ room_id: "!space:localhost", is_space: true, name: "Team" });
    renderRoomList(
      <RoomList {...roomListProps({ rooms: [space], mode: "space", selectedSpace: space })} />,
    );

    await waitFor(() => expect(listSpaceHierarchy).toHaveBeenCalled());

    fireEvent.change(screen.getByRole("searchbox", { name: "Search rooms" }), {
      target: { value: "alpha" },
    });

    await waitFor(() =>
      expect(screen.getByText("Error: hierarchy fetch failed")).toBeInTheDocument(),
    );
    expect(screen.queryByText("No matching rooms")).not.toBeInTheDocument();
  });

  it("finds an unjoined space hierarchy child by search, with its Join affordance", async () => {
    // Regression test: `rooms` (and everything derived from it, like
    // `scopedRooms`) only ever contains rooms the account has joined, so a
    // public/knock child rendered straight from `spaceHierarchy` (with a
    // Join/Request button, never joined) previously had no way to show up in
    // search at all — "No matching rooms" even though it's plainly visible
    // in the unsearched hierarchy view right below.
    const space = makeRoomSummary({ room_id: "!space:localhost", is_space: true, name: "Team" });
    listSpaceHierarchy.mockResolvedValue([
      {
        child: {
          room_id: "!unjoined:localhost",
          name: "Alpha Unjoined",
          topic: null,
          num_joined_members: 4,
          join_rule: "public",
          is_space: false,
        },
        children: [],
      },
    ]);
    renderRoomList(
      <RoomList {...roomListProps({ rooms: [space], mode: "space", selectedSpace: space })} />,
    );

    await screen.findByText("Alpha Unjoined");

    fireEvent.change(screen.getByRole("searchbox", { name: "Search rooms" }), {
      target: { value: "alpha" },
    });

    expect(screen.getByText("Alpha Unjoined")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Join" })).toBeInTheDocument();
    expect(screen.queryByText("No matching rooms")).not.toBeInTheDocument();
  });

  it("allows Search everywhere even while the selected space is still loading", async () => {
    listSpaceHierarchy.mockReturnValue(new Promise(() => {})); // never resolves
    const space = makeRoomSummary({ room_id: "!space:localhost", is_space: true, name: "Team" });
    const orphanMatch = makeRoomSummary({ room_id: "!orphan:localhost", name: "Alpha orphan" });
    renderRoomList(
      <RoomList
        {...roomListProps({ rooms: [space, orphanMatch], mode: "space", selectedSpace: space })}
      />,
    );

    fireEvent.change(screen.getByRole("searchbox", { name: "Search rooms" }), {
      target: { value: "alpha" },
    });
    await waitFor(() => expect(screen.getByText("Loading space…")).toBeInTheDocument());

    fireEvent.click(screen.getByRole("checkbox", { name: "Search everywhere" }));

    expect(screen.getByText("Alpha orphan")).toBeInTheDocument();
    expect(screen.queryByText("Loading space…")).not.toBeInTheDocument();
  });

  it("clears the loading state when a manual refetch overtakes the still-pending initial load", async () => {
    // The mount-time load never resolves on its own — standing in for it
    // still being in flight when a sibling SpaceRail's Add Existing/Remove
    // bumps `hierarchyRefreshToken`. That refetch claims the newer request
    // id, so the stale initial load's own `finally` sees itself as stale
    // and skips clearing `spaceLoading` — the refetch itself must clear it
    // instead, or the lobby stays stuck on "Loading space…" forever even
    // though `spaceHierarchy` already updated (Codex review, #290).
    const space = makeRoomSummary({ room_id: "!space:localhost", is_space: true, name: "Team" });
    listSpaceHierarchy.mockReturnValueOnce(new Promise(() => {})); // never resolves
    listSpaceHierarchy.mockResolvedValueOnce([
      {
        child: {
          room_id: "!child:localhost",
          name: "Chat",
          topic: null,
          num_joined_members: 1,
          join_rule: "invite",
          is_space: false,
        },
        children: [],
      },
    ]);
    const store = createStore();
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const withToken = (hierarchyRefreshToken: number) => (
      <Provider store={store}>
        <QueryClientProvider client={client}>
          <RoomList
            {...roomListProps({
              rooms: [space],
              mode: "space",
              selectedSpace: space,
              hierarchyRefreshToken,
            })}
          />
        </QueryClientProvider>
      </Provider>
    );
    const { rerender } = render(withToken(0));
    await waitFor(() => expect(screen.getByText("Loading space…")).toBeInTheDocument());

    rerender(withToken(1));

    await waitFor(() => expect(screen.queryByText("Loading space…")).not.toBeInTheDocument());
  });
});
