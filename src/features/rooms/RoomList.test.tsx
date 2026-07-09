import type { ReactElement } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen } from "@testing-library/react";
import { createStore, Provider } from "jotai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { badgeAtom } from "@/features/shell/badgeAtom";
import { RoomList } from "./RoomList";
import { makeRoomSummary } from "./testFixtures";

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
const listSpaceChildren = vi.fn().mockResolvedValue([]);
const joinRoom = vi.fn().mockResolvedValue(undefined);
const knockRoom = vi.fn().mockResolvedValue(undefined);
// Never resolves — these tests don't care about the header profile chip
// (see useOwnProfile.test.tsx for that), just that rendering it doesn't blow up.
const getOwnProfile = vi.fn().mockReturnValue(new Promise(() => {}));
const onSelfProfileUpdate = vi.fn().mockResolvedValue(() => {});

vi.mock("@/lib/matrix", () => ({
  setRoomFavourite: (...args: unknown[]) => setRoomFavourite(...args),
  setRoomLowPriority: (...args: unknown[]) => setRoomLowPriority(...args),
  setRoomMuted: (...args: unknown[]) => setRoomMuted(...args),
  setRoomMarkedUnread: (...args: unknown[]) => setRoomMarkedUnread(...args),
  setRoomManualOrder: (...args: unknown[]) => setRoomManualOrder(...args),
  markRoomRead: (...args: unknown[]) => markRoomRead(...args),
  listSpaceChildren: (...args: unknown[]) => listSpaceChildren(...args),
  joinRoom: (...args: unknown[]) => joinRoom(...args),
  knockRoom: (...args: unknown[]) => knockRoom(...args),
  getOwnProfile: () => getOwnProfile(),
  onSelfProfileUpdate: (...args: unknown[]) => onSelfProfileUpdate(...args),
}));

// @use-gesture/react's useDrag attaches real pointer-event listeners; none of
// these tests exercise the drag interaction itself (see roomSections.test.ts
// for the reorder math), so bind() only needs to return an empty prop object.
vi.mock("@use-gesture/react", () => ({
  useDrag: () => () => ({}),
}));

afterEach(() => {
  vi.clearAllMocks();
  vi.unstubAllEnvs();
});

describe("RoomList", () => {
  it("shows the empty state when there are no rooms", () => {
    renderRoomList(<RoomList rooms={[]} activeRoomId={null} onSelectRoom={() => {}} />);
    expect(screen.getByText("No rooms yet")).toBeInTheDocument();
  });

  it("renders section headers with per-section counts", () => {
    const fav = makeRoomSummary({
      room_id: "!fav:localhost",
      name: "Fav room",
      is_favourite: true,
    });
    const plain = makeRoomSummary({ room_id: "!plain:localhost", name: "Plain room" });
    renderRoomList(<RoomList rooms={[fav, plain]} activeRoomId={null} onSelectRoom={() => {}} />);

    expect(screen.getByText("Favourites")).toBeInTheDocument();
    expect(screen.getByText("Fav room")).toBeInTheDocument();
    expect(screen.getByText("Plain room")).toBeInTheDocument();
    // "Low priority" section has zero rooms and should not render at all.
    expect(screen.queryByText("Low priority")).not.toBeInTheDocument();
  });

  it("renders a clickable header for a space with grouped child rooms", () => {
    const space = makeRoomSummary({ room_id: "!space:localhost", is_space: true, name: "Team" });
    const child = makeRoomSummary({
      room_id: "!child:localhost",
      name: "Team chat",
      parent_space_ids: ["!space:localhost"],
    });
    renderRoomList(<RoomList rooms={[space, child]} activeRoomId={null} onSelectRoom={() => {}} />);

    expect(screen.getAllByText("Team").length).toBeGreaterThan(0);
    expect(screen.getByText("Team chat")).toBeInTheDocument();
  });

  it("calls onSelectRoom when a room is clicked", () => {
    const onSelectRoom = vi.fn();
    const room = makeRoomSummary({ name: "general" });
    renderRoomList(<RoomList rooms={[room]} activeRoomId={null} onSelectRoom={onSelectRoom} />);
    screen.getByText("general").click();
    expect(onSelectRoom).toHaveBeenCalledWith(room.room_id);
  });

  it("wires the context menu's favourite/mute/mark actions to their IPC calls", async () => {
    const room = makeRoomSummary({ name: "general" });
    renderRoomList(<RoomList rooms={[room]} activeRoomId={null} onSelectRoom={() => {}} />);

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
  });

  it("hides the mute action in web builds while the companion lacks notification prefs", async () => {
    vi.stubEnv("VITE_CHARM_BUILD_TARGET", "web");
    const room = makeRoomSummary({ name: "general" });
    renderRoomList(<RoomList rooms={[room]} activeRoomId={null} onSelectRoom={() => {}} />);

    fireEvent.contextMenu(screen.getByText("general"));

    expect(await screen.findByText("Add to Favourites")).toBeInTheDocument();
    expect(screen.queryByText("Mute")).not.toBeInTheDocument();
  });

  it("shows no badge when badgeAtom is null or total_unread is zero", () => {
    renderRoomList(<RoomList rooms={[]} activeRoomId={null} onSelectRoom={() => {}} />);
    expect(screen.queryByLabelText(/unread rooms/)).not.toBeInTheDocument();
  });

  it("shows the total_unread count in the header badge", () => {
    const store = createStore();
    store.set(badgeAtom, { total_unread: 3, total_highlight: 0, spaces: {} });
    renderRoomList(<RoomList rooms={[]} activeRoomId={null} onSelectRoom={() => {}} />, store);
    expect(screen.getByLabelText("3 unread rooms")).toHaveTextContent("3");
  });

  it("prefers the mention count when total_highlight is nonzero", () => {
    const store = createStore();
    store.set(badgeAtom, { total_unread: 5, total_highlight: 2, spaces: {} });
    renderRoomList(<RoomList rooms={[]} activeRoomId={null} onSelectRoom={() => {}} />, store);
    expect(screen.getByLabelText("5 unread rooms, 2 mentions")).toHaveTextContent("2");
  });

  it("opens the space browser when a space header is clicked", async () => {
    const space = makeRoomSummary({ room_id: "!space:localhost", is_space: true, name: "Team" });
    const child = makeRoomSummary({
      room_id: "!child:localhost",
      name: "Team chat",
      parent_space_ids: ["!space:localhost"],
    });
    renderRoomList(<RoomList rooms={[space, child]} activeRoomId={null} onSelectRoom={() => {}} />);

    fireEvent.click(screen.getByRole("button", { name: "Team" }));
    expect(listSpaceChildren).toHaveBeenCalledWith("!space:localhost");
    expect(await screen.findByText("Browse and join rooms in this space.")).toBeInTheDocument();
  });

  it("hides the space browser affordance in web builds", () => {
    vi.stubEnv("VITE_CHARM_BUILD_TARGET", "web");
    const space = makeRoomSummary({ room_id: "!space:localhost", is_space: true, name: "Team" });
    const child = makeRoomSummary({
      room_id: "!child:localhost",
      name: "Team chat",
      parent_space_ids: ["!space:localhost"],
    });
    renderRoomList(<RoomList rooms={[space, child]} activeRoomId={null} onSelectRoom={() => {}} />);

    fireEvent.click(screen.getByRole("button", { name: "Team1" }));

    expect(listSpaceChildren).not.toHaveBeenCalled();
    expect(screen.queryByText("Browse and join rooms in this space.")).not.toBeInTheDocument();
  });
});
