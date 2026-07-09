import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { createStore, Provider } from "jotai";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { RoomsScreen } from "./RoomsScreen";
import { membersDrawerOpenAtomFamily, roomSettingsAtom } from "@/features/room-info/roomInfoAtoms";
import type { RoomSummary } from "@/lib/matrix";

const mockUseAdaptiveLayout = vi.fn(() => "desktop");
vi.mock("@/features/shell/useAdaptiveLayout", () => ({
  useAdaptiveLayout: () => mockUseAdaptiveLayout(),
}));

const listRooms = vi.fn();
const onRoomListUpdate = vi.fn();
const resolveRoomAlias = vi.fn();
const setFocusedRoom = vi.fn();

vi.mock("@/lib/matrix", () => ({
  listRooms: (...args: unknown[]) => listRooms(...args),
  onRoomListUpdate: (...args: unknown[]) => onRoomListUpdate(...args),
  resolveRoomAlias: (...args: unknown[]) => resolveRoomAlias(...args),
  setFocusedRoom: (...args: unknown[]) => setFocusedRoom(...args),
}));

vi.mock("@/features/presence/usePresence", () => ({
  usePresenceListener: () => {},
}));

vi.mock("@/features/shell/useBadgeListener", () => ({
  useBadgeListener: () => {},
}));

vi.mock("@/features/verification/VerificationOverlay", () => ({
  VerificationOverlay: () => null,
}));

vi.mock("@/features/settings/SettingsScreen", () => ({
  SettingsScreen: () => null,
}));

vi.mock("@/features/room-info/MembersDrawer", () => ({
  MembersDrawer: () => <div>members-drawer</div>,
}));

vi.mock("@/features/room-info/RoomSettingsModal", () => ({
  RoomSettingsModal: () => null,
}));

// `RoomsScreen` calls `useRoomDetails` directly (to keep its `room_details:update`
// listener alive regardless of whether the modal/drawer are open) — stub it so
// these tests, which aren't exercising that data-fetching behavior, don't need a
// `QueryClientProvider` in the tree.
vi.mock("@/features/room-info/useRoomDetails", () => ({
  useRoomDetails: () => ({ data: undefined, isLoading: false }),
}));

vi.mock("./ChatShell", () => ({
  ChatShell: ({ room: activeRoom }: { room: RoomSummary | null }) => (
    <div>chat-content:{activeRoom?.room_id ?? "none"}</div>
  ),
}));

vi.mock("./SpaceRail", () => ({
  SpaceRail: ({
    activeMode,
    activeSpaceId,
    onSelectSpace,
    onCreateJoin,
  }: {
    activeMode: string;
    activeSpaceId: string | null;
    onSelectSpace: (spaceId: string) => void;
    onCreateJoin: () => void;
  }) => (
    <div>
      space-rail:{activeMode}:{activeSpaceId ?? "none"}
      <button type="button" onClick={() => onSelectSpace("!other-space:example.org")}>
        select-other-space
      </button>
      <button type="button" onClick={onCreateJoin}>
        create-join
      </button>
    </div>
  ),
}));

vi.mock("./RoomList", () => ({
  RoomList: ({
    rooms,
    onSelectRoom,
  }: {
    rooms: RoomSummary[];
    onSelectRoom: (id: string) => void;
  }) => (
    <div>
      {rooms.map((r) => (
        <button key={r.room_id} type="button" onClick={() => onSelectRoom(r.room_id)}>
          {r.room_id}
        </button>
      ))}
    </div>
  ),
}));

function room(overrides: Partial<RoomSummary>): RoomSummary {
  return {
    room_id: "!a:example.org",
    name: "Room A",
    unread_count: 0,
    unread_messages: 0,
    is_marked_unread: false,
    is_muted: false,
    notification_mode: null,
    is_favourite: false,
    is_low_priority: false,
    manual_order: null,
    is_space: false,
    parent_space_ids: [],
    is_direct: false,
    has_unread: false,
    avatar_url: null,
    avatar_path: null,
    dm_peer_user_id: null,
    ...overrides,
  };
}

beforeEach(() => {
  mockUseAdaptiveLayout.mockReset().mockReturnValue("desktop");
  listRooms.mockReset().mockResolvedValue([room({ room_id: "!a:example.org" })]);
  onRoomListUpdate.mockReset().mockResolvedValue(vi.fn());
  resolveRoomAlias.mockReset();
  setFocusedRoom.mockReset().mockResolvedValue(undefined);
});

describe("RoomsScreen", () => {
  it("auto-selects the first room and tells Rust it has focus", async () => {
    const hasFocus = vi.spyOn(document, "hasFocus").mockReturnValue(true);
    render(
      <RoomsScreen
        currentUserId="@me:example.org"
        deepLinkRoomId={null}
        onDeepLinkConsumed={() => {}}
        onLoggedOut={() => {}}
      />,
    );

    await screen.findByText("chat-content:!a:example.org");
    await waitFor(() => expect(setFocusedRoom).toHaveBeenCalledWith("!a:example.org"));
    hasFocus.mockRestore();
  });

  it("auto-selects the first room visible in the default Home scope", async () => {
    listRooms.mockResolvedValue([
      room({ room_id: "!dm:example.org", name: "Alice", is_direct: true }),
      room({
        room_id: "!child:example.org",
        name: "Child",
        parent_space_ids: ["!space:example.org"],
      }),
      room({ room_id: "!orphan:example.org", name: "Orphan" }),
    ]);

    render(
      <RoomsScreen
        currentUserId="@me:example.org"
        deepLinkRoomId={null}
        onDeepLinkConsumed={() => {}}
        onLoggedOut={() => {}}
      />,
    );

    await screen.findByText("chat-content:!orphan:example.org");
    expect(screen.queryByText("chat-content:!dm:example.org")).not.toBeInTheDocument();
  });

  it("falls back to selecting the first non-space room when Home has no visible rooms", async () => {
    listRooms.mockResolvedValue([
      room({ room_id: "!dm:example.org", name: "Alice", is_direct: true }),
      room({
        room_id: "!child:example.org",
        name: "Child",
        parent_space_ids: ["!space:example.org"],
      }),
    ]);

    render(
      <RoomsScreen
        currentUserId="@me:example.org"
        deepLinkRoomId={null}
        onDeepLinkConsumed={() => {}}
        onLoggedOut={() => {}}
      />,
    );

    await screen.findByText("chat-content:!dm:example.org");
  });

  it("selects the lexicographically lowest joined parent space for multi-parent rooms", async () => {
    listRooms.mockResolvedValue([
      room({ room_id: "!z-space:example.org", is_space: true }),
      room({ room_id: "!a-space:example.org", is_space: true }),
      room({
        room_id: "!child:example.org",
        name: "Child",
        parent_space_ids: ["!z-space:example.org", "!a-space:example.org"],
      }),
    ]);

    render(
      <RoomsScreen
        currentUserId="@me:example.org"
        deepLinkRoomId={null}
        onDeepLinkConsumed={() => {}}
        onLoggedOut={() => {}}
      />,
    );

    await screen.findByText("chat-content:!child:example.org");
    expect(screen.getByText("space-rail:space:!a-space:example.org")).toBeInTheDocument();
  });

  it("opens deep-linked spaces as spaces instead of chat rooms", async () => {
    listRooms.mockResolvedValue([
      room({ room_id: "!space:example.org", name: "Team", is_space: true }),
      room({ room_id: "!room:example.org", name: "Room" }),
    ]);

    render(
      <RoomsScreen
        currentUserId="@me:example.org"
        deepLinkRoomId="!space:example.org"
        onDeepLinkConsumed={() => {}}
        onLoggedOut={() => {}}
      />,
    );

    await screen.findByText("space-rail:space:!space:example.org");
    expect(screen.getByText("chat-content:none")).toBeInTheDocument();
  });

  it("does not auto-select a room after a consumed space deep link clears", async () => {
    listRooms.mockResolvedValue([
      room({ room_id: "!space:example.org", name: "Team", is_space: true }),
      room({ room_id: "!room:example.org", name: "Room" }),
    ]);
    const onDeepLinkConsumed = vi.fn();

    const { rerender } = render(
      <RoomsScreen
        currentUserId="@me:example.org"
        deepLinkRoomId="!space:example.org"
        onDeepLinkConsumed={onDeepLinkConsumed}
        onLoggedOut={() => {}}
      />,
    );
    await screen.findByText("space-rail:space:!space:example.org");
    expect(onDeepLinkConsumed).toHaveBeenCalledOnce();

    rerender(
      <RoomsScreen
        currentUserId="@me:example.org"
        deepLinkRoomId={null}
        onDeepLinkConsumed={onDeepLinkConsumed}
        onLoggedOut={() => {}}
      />,
    );

    await waitFor(() =>
      expect(screen.getByText("space-rail:space:!space:example.org")).toBeInTheDocument(),
    );
    expect(screen.getByText("chat-content:none")).toBeInTheDocument();
  });

  it("auto-selects a room when create/join exits a consumed space deep link", async () => {
    listRooms.mockResolvedValue([
      room({ room_id: "!space:example.org", name: "Team", is_space: true }),
      room({ room_id: "!room:example.org", name: "Room" }),
    ]);

    const { rerender } = render(
      <RoomsScreen
        currentUserId="@me:example.org"
        deepLinkRoomId="!space:example.org"
        onDeepLinkConsumed={() => {}}
        onLoggedOut={() => {}}
      />,
    );
    await screen.findByText("space-rail:space:!space:example.org");

    rerender(
      <RoomsScreen
        currentUserId="@me:example.org"
        deepLinkRoomId={null}
        onDeepLinkConsumed={() => {}}
        onLoggedOut={() => {}}
      />,
    );
    await screen.findByText("chat-content:none");

    fireEvent.click(screen.getByRole("button", { name: "create-join" }));

    await screen.findByText("space-rail:home:none");
    expect(screen.getByText("chat-content:!room:example.org")).toBeInTheDocument();
  });

  it("keeps create/join in Home when only DMs are selectable", async () => {
    listRooms.mockResolvedValue([
      room({ room_id: "!space:example.org", name: "Team", is_space: true }),
      room({ room_id: "!dm:example.org", name: "Alice", is_direct: true }),
    ]);

    const { rerender } = render(
      <RoomsScreen
        currentUserId="@me:example.org"
        deepLinkRoomId="!space:example.org"
        onDeepLinkConsumed={() => {}}
        onLoggedOut={() => {}}
      />,
    );
    await screen.findByText("space-rail:space:!space:example.org");

    rerender(
      <RoomsScreen
        currentUserId="@me:example.org"
        deepLinkRoomId={null}
        onDeepLinkConsumed={() => {}}
        onLoggedOut={() => {}}
      />,
    );
    await screen.findByText("chat-content:none");

    fireEvent.click(screen.getByRole("button", { name: "create-join" }));

    await screen.findByText("space-rail:home:none");
    expect(screen.getByText("chat-content:none")).toBeInTheDocument();
  });

  it("clears the space deep-link guard when another space is selected", async () => {
    listRooms.mockResolvedValue([
      room({ room_id: "!space:example.org", name: "Team", is_space: true }),
      room({ room_id: "!other-space:example.org", name: "Other", is_space: true }),
      room({ room_id: "!room:example.org", name: "Room" }),
    ]);

    const { rerender } = render(
      <RoomsScreen
        currentUserId="@me:example.org"
        deepLinkRoomId="!space:example.org"
        onDeepLinkConsumed={() => {}}
        onLoggedOut={() => {}}
      />,
    );
    await screen.findByText("space-rail:space:!space:example.org");

    rerender(
      <RoomsScreen
        currentUserId="@me:example.org"
        deepLinkRoomId={null}
        onDeepLinkConsumed={() => {}}
        onLoggedOut={() => {}}
      />,
    );
    await screen.findByText("chat-content:none");

    fireEvent.click(screen.getByRole("button", { name: "select-other-space" }));
    await screen.findByText("space-rail:space:!other-space:example.org");

    const updateRooms = onRoomListUpdate.mock.calls[0][0] as (rooms: RoomSummary[]) => void;
    act(() => {
      updateRooms([
        room({ room_id: "!space:example.org", name: "Team", is_space: true }),
        room({ room_id: "!other-space:example.org", name: "Other", is_space: true }),
        room({ room_id: "!room:example.org", name: "Room" }),
      ]);
    });

    await screen.findByText("chat-content:!room:example.org");
  });

  it("returns to the mobile list when a space deep link arrives from room detail", async () => {
    mockUseAdaptiveLayout.mockReturnValue("mobile");
    listRooms.mockResolvedValue([
      room({ room_id: "!room:example.org", name: "Room" }),
      room({ room_id: "!space:example.org", name: "Team", is_space: true }),
    ]);

    const { rerender } = render(
      <RoomsScreen
        currentUserId="@me:example.org"
        deepLinkRoomId={null}
        onDeepLinkConsumed={() => {}}
        onLoggedOut={() => {}}
      />,
    );
    await screen.findByText("chat-content:!room:example.org");

    rerender(
      <RoomsScreen
        currentUserId="@me:example.org"
        deepLinkRoomId="!space:example.org"
        onDeepLinkConsumed={() => {}}
        onLoggedOut={() => {}}
      />,
    );

    await screen.findByText("space-rail:space:!space:example.org");
    expect(screen.getByRole("button", { name: /chats/i })).toHaveAttribute("aria-current", "page");
    expect(screen.queryByText(/chat-content:/)).not.toBeInTheDocument();
  });

  it("clears focus when the window loses focus", async () => {
    // jsdom doesn't tie `document.hasFocus()` to blur/focus events firing on
    // `window`, so drive it directly rather than relying on jsdom to
    // simulate real OS-level focus loss.
    const hasFocus = vi.spyOn(document, "hasFocus").mockReturnValue(true);
    render(
      <RoomsScreen
        currentUserId="@me:example.org"
        deepLinkRoomId={null}
        onDeepLinkConsumed={() => {}}
        onLoggedOut={() => {}}
      />,
    );
    await screen.findByText("chat-content:!a:example.org");
    setFocusedRoom.mockClear();

    hasFocus.mockReturnValue(false);
    fireEvent(window, new Event("blur"));

    await waitFor(() => expect(setFocusedRoom).toHaveBeenCalledWith(null));
    hasFocus.mockRestore();
  });

  it("restores focus tracking when the window regains focus", async () => {
    const hasFocus = vi.spyOn(document, "hasFocus").mockReturnValue(true);
    render(
      <RoomsScreen
        currentUserId="@me:example.org"
        deepLinkRoomId={null}
        onDeepLinkConsumed={() => {}}
        onLoggedOut={() => {}}
      />,
    );
    await screen.findByText("chat-content:!a:example.org");
    hasFocus.mockReturnValue(false);
    fireEvent(window, new Event("blur"));
    await waitFor(() => expect(setFocusedRoom).toHaveBeenCalledWith(null));
    setFocusedRoom.mockClear();

    hasFocus.mockReturnValue(true);
    fireEvent(window, new Event("focus"));

    await waitFor(() => expect(setFocusedRoom).toHaveBeenCalledWith("!a:example.org"));
    hasFocus.mockRestore();
  });

  it("clears focus on unmount", async () => {
    const { unmount } = render(
      <RoomsScreen
        currentUserId="@me:example.org"
        deepLinkRoomId={null}
        onDeepLinkConsumed={() => {}}
        onLoggedOut={() => {}}
      />,
    );
    await screen.findByText("chat-content:!a:example.org");
    setFocusedRoom.mockClear();

    unmount();

    expect(setFocusedRoom).toHaveBeenCalledWith(null);
  });

  it("clears focus while the room settings modal is open", async () => {
    const hasFocus = vi.spyOn(document, "hasFocus").mockReturnValue(true);
    const store = createStore();
    render(
      <Provider store={store}>
        <RoomsScreen
          currentUserId="@me:example.org"
          deepLinkRoomId={null}
          onDeepLinkConsumed={() => {}}
          onLoggedOut={() => {}}
        />
      </Provider>,
    );
    await screen.findByText("chat-content:!a:example.org");
    await waitFor(() => expect(setFocusedRoom).toHaveBeenCalledWith("!a:example.org"));
    setFocusedRoom.mockClear();

    store.set(roomSettingsAtom, { roomId: "!a:example.org", section: "general" });
    fireEvent(window, new Event("focus"));

    await waitFor(() => expect(setFocusedRoom).toHaveBeenCalledWith(null));
    hasFocus.mockRestore();
  });

  it("selecting a room updates the active room and its chat content", async () => {
    listRooms.mockResolvedValue([
      room({ room_id: "!a:example.org" }),
      room({ room_id: "!b:example.org", name: "Room B" }),
    ]);
    render(
      <RoomsScreen
        currentUserId="@me:example.org"
        deepLinkRoomId={null}
        onDeepLinkConsumed={() => {}}
        onLoggedOut={() => {}}
      />,
    );
    await screen.findByText("chat-content:!a:example.org");

    fireEvent.click(screen.getAllByText("!b:example.org")[0]);

    await screen.findByText("chat-content:!b:example.org");
  });

  it("closes the members drawer when the layout narrows to mobile", async () => {
    mockUseAdaptiveLayout.mockReturnValue("desktop");
    const store = createStore();
    store.set(membersDrawerOpenAtomFamily("!a:example.org"), true);

    const { rerender } = render(
      <Provider store={store}>
        <RoomsScreen
          currentUserId="@me:example.org"
          deepLinkRoomId={null}
          onDeepLinkConsumed={() => {}}
          onLoggedOut={() => {}}
        />
      </Provider>,
    );
    await screen.findByText("chat-content:!a:example.org");
    expect(store.get(membersDrawerOpenAtomFamily("!a:example.org"))).toBe(true);

    mockUseAdaptiveLayout.mockReturnValue("mobile");
    rerender(
      <Provider store={store}>
        <RoomsScreen
          currentUserId="@me:example.org"
          deepLinkRoomId={null}
          onDeepLinkConsumed={() => {}}
          onLoggedOut={() => {}}
        />
      </Provider>,
    );

    await waitFor(() =>
      expect(store.get(membersDrawerOpenAtomFamily("!a:example.org"))).toBe(false),
    );
  });

  it("does not force-close a members drawer opened while already on mobile", async () => {
    mockUseAdaptiveLayout.mockReturnValue("mobile");
    const store = createStore();

    render(
      <Provider store={store}>
        <RoomsScreen
          currentUserId="@me:example.org"
          deepLinkRoomId={null}
          onDeepLinkConsumed={() => {}}
          onLoggedOut={() => {}}
        />
      </Provider>,
    );
    await screen.findByText("chat-content:!a:example.org");

    // Opening the drawer *while already mobile* (no desktop -> mobile
    // transition involved) must not be immediately reset — only an actual
    // transition should force it closed.
    store.set(membersDrawerOpenAtomFamily("!a:example.org"), true);

    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(store.get(membersDrawerOpenAtomFamily("!a:example.org"))).toBe(true);
  });

  it("does not report the active room as focused while a mobile list tab is showing", async () => {
    mockUseAdaptiveLayout.mockReturnValue("mobile");
    const hasFocus = vi.spyOn(document, "hasFocus").mockReturnValue(true);

    render(
      <RoomsScreen
        currentUserId="@me:example.org"
        deepLinkRoomId={null}
        onDeepLinkConsumed={() => {}}
        onLoggedOut={() => {}}
      />,
    );
    // AppShell auto-switches to the detail view once a room is selected, so
    // the room reads as focused right after auto-select.
    await waitFor(() => expect(setFocusedRoom).toHaveBeenCalledWith("!a:example.org"));
    setFocusedRoom.mockClear();

    // Tapping the Chats tab navigates back to the list — the room is still
    // "active" but no longer on-screen, so it must stop reading as focused.
    fireEvent.click(screen.getByRole("button", { name: /chats/i }));

    await waitFor(() => expect(setFocusedRoom).toHaveBeenCalledWith(null));
    hasFocus.mockRestore();
  });
});
