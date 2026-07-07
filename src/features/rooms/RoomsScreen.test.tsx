import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { RoomsScreen } from "./RoomsScreen";
import type { RoomSummary } from "@/lib/matrix";

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

vi.mock("@/features/room-info/RoomInfoPanel", () => ({
  RoomInfoPanel: () => <div>room-info-panel</div>,
}));

vi.mock("./ChatShell", () => ({
  ChatShell: ({ room: activeRoom }: { room: RoomSummary | null }) => (
    <div>chat-content:{activeRoom?.room_id ?? "none"}</div>
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
});
