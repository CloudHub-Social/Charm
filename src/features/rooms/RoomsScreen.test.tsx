import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { createStore, Provider } from "jotai";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { RoomsScreen } from "./RoomsScreen";
import { membersDrawerOpenAtomFamily, roomSettingsAtom } from "@/features/room-info/roomInfoAtoms";
import type { RoomSummary } from "@/lib/matrix";

const mockUseAdaptiveLayout = vi.fn(() => "desktop");
const mockUseFlag = vi.fn(() => true);
vi.mock("@/features/shell/useAdaptiveLayout", () => ({
  useAdaptiveLayout: () => mockUseAdaptiveLayout(),
}));

vi.mock("@/featureFlags", () => ({
  useFlag: () => mockUseFlag(),
}));

const listRooms = vi.fn();
const onRoomListUpdate = vi.fn();
const resolveRoomAlias = vi.fn();
const setFocusedRoom = vi.fn();
const acceptInvite = vi.fn();
const declineInvite = vi.fn();

vi.mock("@/lib/matrix", () => ({
  acceptInvite: (...args: unknown[]) => acceptInvite(...args),
  declineInvite: (...args: unknown[]) => declineInvite(...args),
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
  ChatShell: ({
    room: activeRoom,
    onBack,
    onNavigateToRoom,
  }: {
    room: RoomSummary | null;
    onBack: () => void;
    onNavigateToRoom: (roomIdentifier: string) => void;
  }) => (
    <div>
      chat-content:{activeRoom?.room_id ?? "none"}
      <button type="button" onClick={onBack}>
        back-to-chats
      </button>
      <button type="button" onClick={() => onNavigateToRoom("!b:example.org")}>
        direct-room-pill
      </button>
      <button type="button" onClick={() => onNavigateToRoom("#b:example.org")}>
        alias-room-pill
      </button>
    </div>
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

vi.mock("./CreateJoinSpaceDialog", () => ({
  CreateJoinSpaceDialog: ({
    open,
    onSpaceJoined,
  }: {
    open: boolean;
    onSpaceJoined: (spaceId: string) => void;
  }) =>
    open ? (
      <div>
        create-join-dialog
        <button type="button" onClick={() => onSpaceJoined("!newly-joined:example.org")}>
          join-new-space
        </button>
      </div>
    ) : null,
}));

vi.mock("./RoomList", () => ({
  RoomList: ({
    rooms,
    onSelectRoom,
    onAcceptInvite,
    onDeclineInvite,
  }: {
    rooms: RoomSummary[];
    onSelectRoom: (id: string) => void;
    onAcceptInvite: (id: string) => Promise<void>;
    onDeclineInvite: (id: string) => Promise<void>;
  }) => (
    <div>
      {rooms.map((r) => (
        <div key={r.room_id}>
          <button type="button" onClick={() => onSelectRoom(r.room_id)}>
            {r.room_id}
          </button>
          {r.membership === "invite" && (
            <>
              <button type="button" onClick={() => onAcceptInvite(r.room_id)}>
                accept:{r.room_id}
              </button>
              <button type="button" onClick={() => onDeclineInvite(r.room_id)}>
                decline:{r.room_id}
              </button>
            </>
          )}
        </div>
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
    membership: "join",
    inviter_user_id: null,
    inviter_display_name: null,
    last_message_preview: null,
    ...overrides,
  };
}

beforeEach(() => {
  mockUseAdaptiveLayout.mockReset().mockReturnValue("desktop");
  mockUseFlag.mockReset().mockReturnValue(true);
  listRooms.mockReset().mockResolvedValue([room({ room_id: "!a:example.org" })]);
  onRoomListUpdate.mockReset().mockResolvedValue(vi.fn());
  resolveRoomAlias.mockReset();
  setFocusedRoom.mockReset().mockResolvedValue(undefined);
  acceptInvite.mockReset().mockResolvedValue(undefined);
  declineInvite.mockReset().mockResolvedValue(undefined);
});

function renderRoomsScreen() {
  return render(
    <RoomsScreen
      currentUserId="@me:example.org"
      deepLinkRoomId={null}
      onDeepLinkConsumed={() => {}}
      onLoggedOut={() => {}}
    />,
  );
}

describe("RoomsScreen", () => {
  it("hides pending invites while the room-invites flag is disabled", async () => {
    mockUseFlag.mockReturnValue(false);
    const invite = room({ room_id: "!invite:example.org", membership: "invite" });
    listRooms.mockResolvedValue([invite, room({ room_id: "!joined:example.org" })]);

    renderRoomsScreen();

    expect(await screen.findByText("chat-content:!joined:example.org")).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: `accept:${invite.room_id}` }),
    ).not.toBeInTheDocument();
  });

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

  it("consumes a deep link to an invite without selecting its timeline", async () => {
    const invite = room({
      room_id: "!invite:example.org",
      membership: "invite",
      inviter_user_id: "@alice:example.org",
    });
    listRooms.mockResolvedValue([invite, room({ room_id: "!joined:example.org" })]);
    const onDeepLinkConsumed = vi.fn();

    const { rerender } = render(
      <RoomsScreen
        currentUserId="@me:example.org"
        deepLinkRoomId={invite.room_id}
        onDeepLinkConsumed={onDeepLinkConsumed}
        onLoggedOut={() => {}}
      />,
    );

    await waitFor(() => expect(onDeepLinkConsumed).toHaveBeenCalledOnce());
    expect(screen.getByRole("button", { name: `accept:${invite.room_id}` })).toBeInTheDocument();
    expect(screen.getByText("chat-content:none")).toBeInTheDocument();

    rerender(
      <RoomsScreen
        currentUserId="@me:example.org"
        deepLinkRoomId={null}
        onDeepLinkConsumed={onDeepLinkConsumed}
        onLoggedOut={() => {}}
      />,
    );

    await waitFor(() => expect(screen.getByText("chat-content:none")).toBeInTheDocument());
    expect(screen.getByRole("button", { name: `accept:${invite.room_id}` })).toBeInTheDocument();
  });

  it("auto-selects a joined room after declining a deep-linked invite", async () => {
    const invite = room({
      room_id: "!invite:example.org",
      membership: "invite",
      inviter_user_id: "@alice:example.org",
    });
    const joined = room({ room_id: "!joined:example.org" });
    listRooms.mockReset().mockResolvedValueOnce([invite, joined]).mockResolvedValueOnce([joined]);
    const onDeepLinkConsumed = vi.fn();

    const { rerender } = render(
      <RoomsScreen
        currentUserId="@me:example.org"
        deepLinkRoomId={invite.room_id}
        onDeepLinkConsumed={onDeepLinkConsumed}
        onLoggedOut={() => {}}
      />,
    );
    await waitFor(() => expect(onDeepLinkConsumed).toHaveBeenCalledOnce());
    expect(screen.getByText("chat-content:none")).toBeInTheDocument();

    rerender(
      <RoomsScreen
        currentUserId="@me:example.org"
        deepLinkRoomId={null}
        onDeepLinkConsumed={onDeepLinkConsumed}
        onLoggedOut={() => {}}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: `decline:${invite.room_id}` }));

    await waitFor(() => expect(declineInvite).toHaveBeenCalledWith(invite.room_id));
    expect(await screen.findByText(`chat-content:${joined.room_id}`)).toBeInTheDocument();
  });

  it("keeps post-accept navigation ahead of the initial room fallback", async () => {
    const invite = room({
      room_id: "!invite:example.org",
      membership: "invite",
      inviter_user_id: "@alice:example.org",
    });
    const fallback = room({ room_id: "!fallback:example.org" });
    const joinedInvite = room({ room_id: invite.room_id, membership: "join" });
    listRooms
      .mockReset()
      .mockResolvedValueOnce([invite, fallback])
      .mockResolvedValueOnce([fallback, joinedInvite]);
    const onDeepLinkConsumed = vi.fn();

    const { rerender } = render(
      <RoomsScreen
        currentUserId="@me:example.org"
        deepLinkRoomId={invite.room_id}
        onDeepLinkConsumed={onDeepLinkConsumed}
        onLoggedOut={() => {}}
      />,
    );
    await waitFor(() => expect(onDeepLinkConsumed).toHaveBeenCalledOnce());
    rerender(
      <RoomsScreen
        currentUserId="@me:example.org"
        deepLinkRoomId={null}
        onDeepLinkConsumed={onDeepLinkConsumed}
        onLoggedOut={() => {}}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: `accept:${invite.room_id}` }));

    expect(await screen.findByText(`chat-content:${invite.room_id}`)).toBeInTheDocument();
    expect(screen.queryByText(`chat-content:${fallback.room_id}`)).not.toBeInTheDocument();
  });

  it("keeps a deep-linked space selected when declining an unrelated invite", async () => {
    const space = room({ room_id: "!space:example.org", is_space: true });
    const invite = room({
      room_id: "!invite:example.org",
      membership: "invite",
      inviter_user_id: "@alice:example.org",
    });
    const joined = room({ room_id: "!joined:example.org" });
    listRooms
      .mockReset()
      .mockResolvedValueOnce([space, invite, joined])
      .mockResolvedValueOnce([space, joined]);

    const { rerender } = render(
      <RoomsScreen
        currentUserId="@me:example.org"
        deepLinkRoomId={space.room_id}
        onDeepLinkConsumed={() => {}}
        onLoggedOut={() => {}}
      />,
    );
    await screen.findByText(`space-rail:space:${space.room_id}`);
    rerender(
      <RoomsScreen
        currentUserId="@me:example.org"
        deepLinkRoomId={null}
        onDeepLinkConsumed={() => {}}
        onLoggedOut={() => {}}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: `decline:${invite.room_id}` }));
    await waitFor(() => expect(declineInvite).toHaveBeenCalledWith(invite.room_id));
    expect(screen.getByText(`space-rail:space:${space.room_id}`)).toBeInTheDocument();
    expect(screen.getByText("chat-content:none")).toBeInTheDocument();
  });

  it("auto-selects a joined room when a deep-linked invite is revoked", async () => {
    const invite = room({
      room_id: "!invite:example.org",
      membership: "invite",
      inviter_user_id: "@alice:example.org",
    });
    const joined = room({ room_id: "!joined:example.org" });
    listRooms.mockResolvedValue([invite, joined]);

    const { rerender } = render(
      <RoomsScreen
        currentUserId="@me:example.org"
        deepLinkRoomId={invite.room_id}
        onDeepLinkConsumed={() => {}}
        onLoggedOut={() => {}}
      />,
    );
    await screen.findByRole("button", { name: `decline:${invite.room_id}` });
    rerender(
      <RoomsScreen
        currentUserId="@me:example.org"
        deepLinkRoomId={null}
        onDeepLinkConsumed={() => {}}
        onLoggedOut={() => {}}
      />,
    );

    const roomListListener = onRoomListUpdate.mock.calls[0]?.[0] as
      | ((rooms: RoomSummary[]) => void)
      | undefined;
    act(() => roomListListener?.([joined]));

    expect(await screen.findByText(`chat-content:${joined.room_id}`)).toBeInTheDocument();
  });

  it("keeps a deep link pending until the first sync-driven room list includes it", async () => {
    const onDeepLinkConsumed = vi.fn();
    const target = room({ room_id: "!late:example.org" });
    listRooms.mockResolvedValue([]);

    render(
      <RoomsScreen
        currentUserId="@me:example.org"
        deepLinkRoomId={target.room_id}
        onDeepLinkConsumed={onDeepLinkConsumed}
        onLoggedOut={() => {}}
      />,
    );

    await screen.findByText("chat-content:none");
    expect(onDeepLinkConsumed).not.toHaveBeenCalled();

    const roomListListener = onRoomListUpdate.mock.calls[0]?.[0] as
      | ((rooms: RoomSummary[]) => void)
      | undefined;
    act(() => roomListListener?.([target]));

    expect(await screen.findByText(`chat-content:${target.room_id}`)).toBeInTheDocument();
    expect(onDeepLinkConsumed).toHaveBeenCalledOnce();
  });

  it("consumes a stale deep link after a sync-driven room list omits it", async () => {
    const onDeepLinkConsumed = vi.fn();
    listRooms.mockResolvedValue([]);

    render(
      <RoomsScreen
        currentUserId="@me:example.org"
        deepLinkRoomId="!missing:example.org"
        onDeepLinkConsumed={onDeepLinkConsumed}
        onLoggedOut={() => {}}
      />,
    );

    await screen.findByText("chat-content:none");
    expect(onDeepLinkConsumed).not.toHaveBeenCalled();

    const roomListListener = onRoomListUpdate.mock.calls[0]?.[0] as
      | ((rooms: RoomSummary[]) => void)
      | undefined;
    act(() => roomListListener?.([]));

    await waitFor(() => expect(onDeepLinkConsumed).toHaveBeenCalledOnce());
    expect(screen.getByText("chat-content:none")).toBeInTheDocument();
  });

  it("opens the create/join space dialog without changing the current selection", async () => {
    listRooms.mockResolvedValue([
      room({ room_id: "!space:example.org", name: "Team", is_space: true }),
      room({ room_id: "!room:example.org", name: "Room" }),
    ]);

    render(
      <RoomsScreen
        currentUserId="@me:example.org"
        deepLinkRoomId={null}
        onDeepLinkConsumed={() => {}}
        onLoggedOut={() => {}}
      />,
    );
    await screen.findByText("space-rail:home:none");
    await screen.findByText("chat-content:!room:example.org");
    expect(screen.queryByText("create-join-dialog")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "create-join" }));

    expect(screen.getByText("create-join-dialog")).toBeInTheDocument();
    // Opening the dialog is a pure overlay — it must not disturb whatever
    // room/space was already selected underneath it.
    expect(screen.getByText("space-rail:home:none")).toBeInTheDocument();
    expect(screen.getByText("chat-content:!room:example.org")).toBeInTheDocument();
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

  it("stays on a space just created/joined via the dialog instead of falling back on the next room-list sync", async () => {
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
    // Still no active room — this is the exact "dialog opened while no chat
    // is active" state the fix targets.
    await screen.findByText("chat-content:none");

    fireEvent.click(screen.getByRole("button", { name: "create-join" }));
    fireEvent.click(screen.getByRole("button", { name: "join-new-space" }));
    await screen.findByText("space-rail:space:!newly-joined:example.org");

    // The room-list sync that surfaces the newly joined space arrives after
    // navigation, same as the real create_space/join_room round trip.
    const updateRooms = onRoomListUpdate.mock.calls[0][0] as (rooms: RoomSummary[]) => void;
    act(() => {
      updateRooms([
        room({ room_id: "!space:example.org", name: "Team", is_space: true }),
        room({ room_id: "!room:example.org", name: "Room" }),
        room({ room_id: "!newly-joined:example.org", name: "New Space", is_space: true }),
      ]);
    });

    // Must still be on the newly joined space, not auto-selected back to
    // "!room:example.org" the way a normal navigation would allow.
    expect(screen.getByText("space-rail:space:!newly-joined:example.org")).toBeInTheDocument();
    expect(screen.getByText("chat-content:none")).toBeInTheDocument();
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

  it("returns to the mobile list when the active room disappears", async () => {
    mockUseAdaptiveLayout.mockReturnValue("mobile");
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

    const updateRooms = onRoomListUpdate.mock.calls[0][0] as (rooms: RoomSummary[]) => void;
    act(() => {
      updateRooms([room({ room_id: "!b:example.org", name: "Room B" })]);
    });

    await screen.findByRole("button", { name: "!b:example.org" });
    expect(screen.getByRole("navigation", { name: "Primary" })).toBeInTheDocument();
    expect(screen.queryByText(/chat-content:/)).not.toBeInTheDocument();
  });

  it("does not resync focus when room metadata changes for the same active room", async () => {
    const hasFocus = vi.spyOn(document, "hasFocus").mockReturnValue(true);
    render(
      <RoomsScreen
        currentUserId="@me:example.org"
        deepLinkRoomId={null}
        onDeepLinkConsumed={() => {}}
        onLoggedOut={() => {}}
      />,
    );
    // Initial null state, room selection, and AppShell's controlled view
    // transition each synchronize focus. Wait for all three before isolating
    // the metadata-only update this regression test exercises.
    await waitFor(() => expect(setFocusedRoom).toHaveBeenCalledTimes(3));
    expect(setFocusedRoom).toHaveBeenLastCalledWith("!a:example.org");
    setFocusedRoom.mockClear();

    const updateRooms = onRoomListUpdate.mock.calls[0][0] as (rooms: RoomSummary[]) => void;
    act(() => {
      updateRooms([room({ room_id: "!a:example.org", unread_count: 1 })]);
    });

    await waitFor(() =>
      expect(screen.getByText("chat-content:!a:example.org")).toBeInTheDocument(),
    );
    expect(setFocusedRoom).not.toHaveBeenCalled();
    hasFocus.mockRestore();
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

  it("accepts an invite, refreshes the snapshot, and opens the joined room", async () => {
    const invite = room({
      room_id: "!invite:example.org",
      membership: "invite",
      inviter_user_id: "@alice:example.org",
    });
    const joined = room({ room_id: invite.room_id, membership: "join" });
    listRooms.mockReset().mockResolvedValueOnce([invite]).mockResolvedValueOnce([joined]);

    renderRoomsScreen();
    fireEvent.click(await screen.findByRole("button", { name: `accept:${invite.room_id}` }));

    await waitFor(() => expect(acceptInvite).toHaveBeenCalledWith(invite.room_id));
    expect(await screen.findByText(`chat-content:${invite.room_id}`)).toBeInTheDocument();
  });

  it("waits for a room-list update when the post-accept snapshot is still invited", async () => {
    const invite = room({
      room_id: "!invite:example.org",
      membership: "invite",
      inviter_user_id: "@alice:example.org",
    });
    const joined = room({ room_id: invite.room_id, membership: "join" });
    listRooms.mockReset().mockResolvedValue([invite]);

    renderRoomsScreen();
    fireEvent.click(await screen.findByRole("button", { name: `accept:${invite.room_id}` }));

    await waitFor(() => expect(acceptInvite).toHaveBeenCalledWith(invite.room_id));
    expect(screen.getByText("chat-content:none")).toBeInTheDocument();

    const roomListListener = onRoomListUpdate.mock.calls[0]?.[0] as
      | ((rooms: RoomSummary[]) => void)
      | undefined;
    expect(roomListListener).toBeTypeOf("function");
    act(() => roomListListener?.([joined]));

    expect(await screen.findByText(`chat-content:${invite.room_id}`)).toBeInTheDocument();
  });

  it("uses the refreshed snapshot when an accepted room belongs to a space", async () => {
    const invite = room({
      room_id: "!invite:example.org",
      membership: "invite",
      inviter_user_id: "@alice:example.org",
    });
    const space = room({ room_id: "!space:example.org", is_space: true });
    const joined = room({
      room_id: invite.room_id,
      membership: "join",
      parent_space_ids: [space.room_id],
    });
    listRooms.mockReset().mockResolvedValueOnce([invite]).mockResolvedValueOnce([space, joined]);

    renderRoomsScreen();
    fireEvent.click(await screen.findByRole("button", { name: `accept:${invite.room_id}` }));

    expect(await screen.findByText(`chat-content:${invite.room_id}`)).toBeInTheDocument();
    expect(screen.getByText(`space-rail:space:${space.room_id}`)).toBeInTheDocument();
  });

  it("declines an invite and removes it after refreshing the snapshot", async () => {
    const invite = room({
      room_id: "!invite:example.org",
      membership: "invite",
      inviter_user_id: "@alice:example.org",
    });
    listRooms.mockReset().mockResolvedValueOnce([invite]).mockResolvedValueOnce([]);

    renderRoomsScreen();
    fireEvent.click(await screen.findByRole("button", { name: `decline:${invite.room_id}` }));

    await waitFor(() => expect(declineInvite).toHaveBeenCalledWith(invite.room_id));
    await waitFor(() =>
      expect(
        screen.queryByRole("button", { name: `decline:${invite.room_id}` }),
      ).not.toBeInTheDocument(),
    );
  });

  it("navigates joined room-id and alias pills through the visible room context", async () => {
    listRooms.mockResolvedValue([
      room({ room_id: "!a:example.org" }),
      room({ room_id: "!b:example.org" }),
    ]);
    resolveRoomAlias.mockResolvedValue("!b:example.org");
    render(
      <RoomsScreen
        currentUserId="@me:example.org"
        deepLinkRoomId={null}
        onDeepLinkConsumed={() => {}}
        onLoggedOut={() => {}}
      />,
    );

    await screen.findByText("chat-content:!a:example.org");
    fireEvent.click(screen.getByRole("button", { name: "direct-room-pill" }));
    await screen.findByText("chat-content:!b:example.org");

    fireEvent.click(screen.getByRole("button", { name: "alias-room-pill" }));
    await waitFor(() => expect(resolveRoomAlias).toHaveBeenCalledWith("#b:example.org"));
  });

  it("uses the latest room list when an alias finishes resolving", async () => {
    let finishAliasResolution: ((roomId: string) => void) | undefined;
    resolveRoomAlias.mockReturnValue(
      new Promise<string>((resolve) => {
        finishAliasResolution = resolve;
      }),
    );
    render(
      <RoomsScreen
        currentUserId="@me:example.org"
        deepLinkRoomId={null}
        onDeepLinkConsumed={() => {}}
        onLoggedOut={() => {}}
      />,
    );

    await screen.findByText("chat-content:!a:example.org");
    fireEvent.click(screen.getByRole("button", { name: "alias-room-pill" }));
    const updateRooms = onRoomListUpdate.mock.calls[0][0] as (rooms: RoomSummary[]) => void;
    act(() => {
      updateRooms([room({ room_id: "!a:example.org" }), room({ room_id: "!b:example.org" })]);
    });
    await act(async () => finishAliasResolution?.("!b:example.org"));

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

    // The room header's back action navigates to the list — the room is still
    // "active" but no longer on-screen, so it must stop reading as focused.
    fireEvent.click(screen.getByRole("button", { name: "back-to-chats" }));

    await waitFor(() => expect(setFocusedRoom).toHaveBeenCalledWith(null));
    hasFocus.mockRestore();
  });
});
