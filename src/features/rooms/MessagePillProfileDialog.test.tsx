import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { featureFlagTestHooks } from "@/featureFlags";
import {
  getMutualRooms,
  getUserProfile,
  ignoreUser,
  setRoomProfile,
  startDirectMessage,
} from "@/lib/matrix";
import { MessagePillProfileDialog } from "./MessagePillProfileDialog";

const mocks = vi.hoisted(() => ({
  clipboardWriteText: vi.fn(),
  livePresence: null as null | Record<string, unknown>,
  roomDetailsCallback: undefined as undefined | ((details: { room_id: string }) => void),
  roomListCallback: undefined as undefined | (() => void),
}));

vi.mock("@/lib/matrix", () => ({
  getUserProfile: vi.fn(),
  getMutualRooms: vi.fn(),
  ignoreUser: vi.fn(),
  setRoomProfile: vi.fn(),
  startDirectMessage: vi.fn(),
  onRoomDetailsUpdate: vi.fn((callback: (details: { room_id: string }) => void) => {
    mocks.roomDetailsCallback = callback;
    return Promise.resolve(() => {});
  }),
  onRoomListUpdate: vi.fn((callback: () => void) => {
    mocks.roomListCallback = callback;
    return Promise.resolve(() => {});
  }),
}));
vi.mock("@/features/presence/usePresence", () => ({
  usePresence: () => mocks.livePresence,
}));

function renderDialog(props: Partial<Parameters<typeof MessagePillProfileDialog>[0]> = {}) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const onClose = vi.fn();
  const onNavigateToRoom = vi.fn();
  render(
    <QueryClientProvider client={client}>
      <MessagePillProfileDialog
        profile={{ userId: "@alice:example.org", label: "Alice" }}
        onClose={onClose}
        onNavigateToRoom={onNavigateToRoom}
        {...props}
      />
    </QueryClientProvider>,
  );
  return { onClose, onNavigateToRoom };
}

describe("MessagePillProfileDialog", () => {
  beforeEach(() => {
    featureFlagTestHooks.reset();
    featureFlagTestHooks.setCache({ presence_privacy_controls: true });
    mocks.livePresence = null;
    mocks.roomDetailsCallback = undefined;
    mocks.roomListCallback = undefined;
    vi.mocked(getUserProfile).mockReset();
    vi.mocked(getMutualRooms).mockReset();
    vi.mocked(ignoreUser).mockReset().mockResolvedValue(undefined);
    vi.mocked(setRoomProfile).mockReset().mockResolvedValue(undefined);
    vi.mocked(startDirectMessage).mockReset().mockResolvedValue("!dm:example.org");
    mocks.clipboardWriteText.mockReset().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText: mocks.clipboardWriteText },
    });
  });

  it("shows the pill identity and closes through the dialog control", () => {
    const { onClose } = renderDialog();

    expect(screen.getByRole("heading", { name: "Alice" })).toBeInTheDocument();
    expect(screen.getByText("@alice:example.org")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("loads canonical profile details and navigates to a mutual room", async () => {
    vi.mocked(getUserProfile).mockResolvedValue({
      user_id: "@alice:example.org",
      display_name: "Alice Global",
      avatar_url: null,
      avatar_path: null,
      room_display_name: "Alice Here",
      room_avatar_url: null,
      room_avatar_path: null,
      presence: {
        user_id: "@alice:example.org",
        presence: "online",
        status_msg: "Writing tests",
        last_active_ago_ms: 5 * 60_000,
      },
    });
    vi.mocked(getMutualRooms).mockResolvedValue([
      {
        room_id: "!mutual:example.org",
        name: "Mutual Room",
        avatar_url: null,
        avatar_path: null,
        is_direct: false,
        is_space: false,
      },
    ]);

    const { onClose, onNavigateToRoom } = renderDialog({
      detailed: true,
      roomId: "!current:example.org",
    });

    expect(await screen.findByRole("heading", { name: "Alice Here" })).toBeInTheDocument();
    expect(screen.getByText("Global profile: Alice Global")).toBeInTheDocument();
    expect(screen.getByText("Online · Writing tests")).toBeInTheDocument();
    expect(screen.getByText("Active 5m ago")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Copy ID" }));
    fireEvent.click(screen.getByRole("button", { name: "Copy link" }));
    expect(mocks.clipboardWriteText).toHaveBeenNthCalledWith(1, "@alice:example.org");
    expect(mocks.clipboardWriteText).toHaveBeenNthCalledWith(
      2,
      "https://matrix.to/#/@alice:example.org",
    );
    fireEvent.click(screen.getByRole("button", { name: "Mutual Room" }));
    expect(onNavigateToRoom).toHaveBeenCalledWith("!mutual:example.org");
    expect(onClose).toHaveBeenCalledOnce();
    expect(getUserProfile).toHaveBeenCalledWith("@alice:example.org", "!current:example.org");
  });

  it("opens a direct message and blocks another user from the card", async () => {
    vi.mocked(getUserProfile).mockResolvedValue({
      user_id: "@alice:example.org",
      display_name: "Alice",
      avatar_url: null,
      avatar_path: null,
      room_display_name: null,
      room_avatar_url: null,
      room_avatar_path: null,
      presence: null,
    });
    vi.mocked(getMutualRooms).mockResolvedValue([]);
    const { onClose, onNavigateToRoom } = renderDialog({
      detailed: true,
      currentUserId: "@me:example.org",
    });
    await screen.findByRole("heading", { name: "Alice" });

    fireEvent.click(screen.getByRole("button", { name: "Message" }));
    await vi.waitFor(() => expect(startDirectMessage).toHaveBeenCalledWith("@alice:example.org"));
    expect(onNavigateToRoom).toHaveBeenCalledWith("!dm:example.org");
    expect(onClose).toHaveBeenCalledOnce();

    fireEvent.click(screen.getByRole("button", { name: "Block" }));
    await vi.waitFor(() => expect(ignoreUser).toHaveBeenCalledWith("@alice:example.org"));
  });

  it("reports profile action failures", async () => {
    vi.mocked(getUserProfile).mockResolvedValue({
      user_id: "@alice:example.org",
      display_name: "Alice",
      avatar_url: null,
      avatar_path: null,
      room_display_name: null,
      room_avatar_url: null,
      room_avatar_path: null,
      presence: null,
    });
    vi.mocked(getMutualRooms).mockResolvedValue([]);
    vi.mocked(startDirectMessage).mockRejectedValue(new Error("offline"));
    vi.mocked(ignoreUser).mockRejectedValue(new Error("offline"));
    renderDialog({
      detailed: true,
      currentUserId: "@me:example.org",
      onNavigateToRoom: vi.fn(),
    });
    await screen.findByRole("heading", { name: "Alice" });

    fireEvent.click(screen.getByRole("button", { name: "Message" }));
    fireEvent.click(screen.getByRole("button", { name: "Block" }));

    expect(await screen.findByText("That profile action could not be completed.")).toBeVisible();
  });

  it("hosts power-level-gated moderation actions", async () => {
    vi.mocked(getUserProfile).mockResolvedValue({
      user_id: "@alice:example.org",
      display_name: "Alice",
      avatar_url: null,
      avatar_path: null,
      room_display_name: null,
      room_avatar_url: null,
      room_avatar_path: null,
      presence: null,
    });
    vi.mocked(getMutualRooms).mockResolvedValue([]);
    const onSetPowerLevel = vi.fn();
    const onKick = vi.fn();
    const onBan = vi.fn();
    renderDialog({
      detailed: true,
      currentUserId: "@me:example.org",
      moderationActions: {
        canSetPowerLevel: false,
        canKick: true,
        canBan: true,
        onSetPowerLevel,
        onKick,
        onBan,
      },
    });
    await screen.findByRole("heading", { name: "Alice" });

    expect(screen.getByRole("button", { name: "Set power level" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Kick" }));
    fireEvent.click(screen.getByRole("button", { name: "Ban" }));
    expect(onSetPowerLevel).not.toHaveBeenCalled();
    expect(onKick).toHaveBeenCalledOnce();
    expect(onBan).toHaveBeenCalledOnce();
  });

  it("updates the signed-in user's room-scoped profile", async () => {
    vi.mocked(getUserProfile).mockResolvedValue({
      user_id: "@alice:example.org",
      display_name: "Alice",
      avatar_url: "mxc://example.org/global",
      avatar_path: null,
      room_display_name: "Alice Here",
      room_avatar_url: "mxc://example.org/room",
      room_avatar_path: null,
      presence: null,
    });
    vi.mocked(getMutualRooms).mockResolvedValue([]);
    renderDialog({
      detailed: true,
      currentUserId: "@alice:example.org",
      roomId: "!room:example.org",
    });
    fireEvent.click(await screen.findByRole("button", { name: "Edit room profile" }));
    fireEvent.change(screen.getByLabelText("Display name in this room"), {
      target: { value: "Alice Local" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save room profile" }));

    await vi.waitFor(() =>
      expect(setRoomProfile).toHaveBeenCalledWith(
        "!room:example.org",
        "Alice Local",
        "mxc://example.org/room",
      ),
    );
  });

  it("clears and cancels room-scoped profile edits", async () => {
    vi.mocked(getUserProfile).mockResolvedValue({
      user_id: "@alice:example.org",
      display_name: null,
      avatar_url: null,
      avatar_path: null,
      room_display_name: null,
      room_avatar_url: "mxc://example.org/room",
      room_avatar_path: null,
      presence: null,
    });
    vi.mocked(getMutualRooms).mockResolvedValue([]);
    renderDialog({
      detailed: true,
      currentUserId: "@alice:example.org",
      roomId: "!room:example.org",
    });

    fireEvent.click(await screen.findByRole("button", { name: "Edit room profile" }));
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    fireEvent.click(screen.getByRole("button", { name: "Edit room profile" }));
    fireEvent.change(screen.getByLabelText("Avatar MXC URL in this room"), {
      target: { value: "" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save room profile" }));

    await vi.waitFor(() =>
      expect(setRoomProfile).toHaveBeenCalledWith("!room:example.org", null, null),
    );
  });

  it("reports profile loading and room-profile update failures", async () => {
    vi.mocked(getUserProfile).mockRejectedValue(new Error("offline"));
    vi.mocked(getMutualRooms).mockResolvedValue([]);
    renderDialog({ detailed: true });
    expect(await screen.findByText("Profile details could not be loaded.")).toBeVisible();

    vi.mocked(getUserProfile).mockResolvedValue({
      user_id: "@alice:example.org",
      display_name: "Alice",
      avatar_url: null,
      avatar_path: null,
      room_display_name: null,
      room_avatar_url: null,
      room_avatar_path: null,
      presence: null,
    });
    vi.mocked(setRoomProfile).mockRejectedValue(new Error("denied"));
    const { onClose } = renderDialog({
      profile: { userId: "@bob:example.org", label: "Bob" },
      detailed: true,
      currentUserId: "@bob:example.org",
      roomId: "!room:example.org",
    });
    fireEvent.click(await screen.findByRole("button", { name: "Edit room profile" }));
    fireEvent.click(screen.getByRole("button", { name: "Save room profile" }));
    expect(await screen.findByText("Room profile could not be updated.")).toBeVisible();
    expect(onClose).not.toHaveBeenCalled();
  });

  it("shows a room id when a mutual room has no name and navigation is unavailable", async () => {
    vi.mocked(getUserProfile).mockResolvedValue({
      user_id: "@alice:example.org",
      display_name: "Alice",
      avatar_url: null,
      avatar_path: null,
      room_display_name: null,
      room_avatar_url: null,
      room_avatar_path: null,
      presence: null,
    });
    vi.mocked(getMutualRooms).mockResolvedValue([
      {
        room_id: "!unnamed:example.org",
        name: null,
        avatar_url: null,
        avatar_path: null,
        is_direct: false,
        is_space: false,
      },
    ]);
    renderDialog({ detailed: true, onNavigateToRoom: undefined });

    expect(await screen.findByRole("button", { name: "!unnamed:example.org" })).toBeDisabled();
  });

  it("hides status detail when presence privacy controls are disabled", async () => {
    featureFlagTestHooks.setCache({ presence_privacy_controls: false });
    vi.mocked(getUserProfile).mockResolvedValue({
      user_id: "@alice:example.org",
      display_name: "Alice",
      avatar_url: null,
      avatar_path: null,
      room_display_name: null,
      room_avatar_url: null,
      room_avatar_path: null,
      presence: {
        user_id: "@alice:example.org",
        presence: "unavailable",
        status_msg: "Private status",
        last_active_ago_ms: null,
      },
    });
    vi.mocked(getMutualRooms).mockRejectedValue(new Error("offline"));

    renderDialog({ detailed: true });

    expect(await screen.findByText("Away")).toBeInTheDocument();
    expect(screen.queryByText(/Global profile:/)).not.toBeInTheDocument();
    expect(screen.queryByText(/Private status/)).not.toBeInTheDocument();
    expect(await screen.findByRole("alert", { name: "" })).toHaveTextContent(
      "Mutual rooms could not be loaded.",
    );
  });

  it("shows the normalized Busy label for feature-enabled profile presence", async () => {
    featureFlagTestHooks.setCache({ avatar_presence_visuals: true });
    vi.mocked(getUserProfile).mockResolvedValue({
      user_id: "@alice:example.org",
      display_name: "Alice",
      avatar_url: null,
      avatar_path: null,
      room_display_name: null,
      room_avatar_url: null,
      room_avatar_path: null,
      presence: {
        user_id: "@alice:example.org",
        presence: "dnd",
        status_msg: null,
        last_active_ago_ms: null,
      },
    });
    vi.mocked(getMutualRooms).mockRejectedValue(new Error("offline"));

    renderDialog({ detailed: true });

    expect(await screen.findByText("Busy")).toBeInTheDocument();
    expect(screen.queryByText("dnd")).not.toBeInTheDocument();
  });

  it("refreshes an open room profile after a membership-state update", async () => {
    vi.mocked(getUserProfile)
      .mockResolvedValueOnce({
        user_id: "@alice:example.org",
        display_name: "Alice",
        avatar_url: null,
        avatar_path: null,
        room_display_name: "Alice Here",
        room_avatar_url: null,
        room_avatar_path: null,
        presence: null,
      })
      .mockResolvedValueOnce({
        user_id: "@alice:example.org",
        display_name: "Alice",
        avatar_url: null,
        avatar_path: null,
        room_display_name: "Alice Updated",
        room_avatar_url: null,
        room_avatar_path: null,
        presence: null,
      });
    vi.mocked(getMutualRooms).mockResolvedValue([]);
    renderDialog({ detailed: true, roomId: "!current:example.org" });
    expect(await screen.findByRole("heading", { name: "Alice Here" })).toBeInTheDocument();

    await act(async () => {
      mocks.roomDetailsCallback?.({ room_id: "!current:example.org" });
    });

    expect(await screen.findByRole("heading", { name: "Alice Updated" })).toBeInTheDocument();
  });

  it("refreshes mutual rooms when any joined-room state changes", async () => {
    vi.mocked(getUserProfile).mockResolvedValue({
      user_id: "@alice:example.org",
      display_name: "Alice",
      avatar_url: null,
      avatar_path: null,
      room_display_name: null,
      room_avatar_url: null,
      room_avatar_path: null,
      presence: null,
    });
    vi.mocked(getMutualRooms)
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([
        {
          room_id: "!new-mutual:example.org",
          name: "New Mutual",
          avatar_url: null,
          avatar_path: null,
          is_direct: false,
          is_space: false,
        },
      ]);
    renderDialog({ detailed: true, roomId: "!current:example.org" });
    await screen.findByRole("heading", { name: "Alice" });

    await act(async () => {
      mocks.roomDetailsCallback?.({ room_id: "!other:example.org" });
    });

    expect(await screen.findByRole("button", { name: "New Mutual" })).toBeInTheDocument();
  });

  it("refetches mutual rooms after an update races the initial request", async () => {
    let resolveInitial: ((rooms: []) => void) | undefined;
    vi.mocked(getUserProfile).mockResolvedValue({
      user_id: "@alice:example.org",
      display_name: "Alice",
      avatar_url: null,
      avatar_path: null,
      room_display_name: null,
      room_avatar_url: null,
      room_avatar_path: null,
      presence: null,
    });
    vi.mocked(getMutualRooms)
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveInitial = resolve;
          }),
      )
      .mockResolvedValueOnce([
        {
          room_id: "!new-mutual:example.org",
          name: "New Mutual",
          avatar_url: null,
          avatar_path: null,
          is_direct: false,
          is_space: false,
        },
      ]);

    renderDialog({ detailed: true, roomId: "!current:example.org" });
    await screen.findByRole("heading", { name: "Alice" });
    await act(async () => {
      mocks.roomDetailsCallback?.({ room_id: "!other:example.org" });
      resolveInitial?.([]);
    });

    expect(await screen.findByRole("button", { name: "New Mutual" })).toBeInTheDocument();
  });

  it("refetches a profile after a membership update races the initial request", async () => {
    let resolveInitial: ((profile: Awaited<ReturnType<typeof getUserProfile>>) => void) | undefined;
    vi.mocked(getUserProfile)
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveInitial = resolve;
          }),
      )
      .mockResolvedValueOnce({
        user_id: "@alice:example.org",
        display_name: "Alice Updated",
        avatar_url: null,
        avatar_path: null,
        room_display_name: null,
        room_avatar_url: null,
        room_avatar_path: null,
        presence: null,
      });
    vi.mocked(getMutualRooms).mockResolvedValue([]);
    renderDialog({ detailed: true, roomId: "!current:example.org" });

    await act(async () => {
      mocks.roomDetailsCallback?.({ room_id: "!current:example.org" });
      resolveInitial?.({
        user_id: "@alice:example.org",
        display_name: "Alice Initial",
        avatar_url: null,
        avatar_path: null,
        room_display_name: null,
        room_avatar_url: null,
        room_avatar_path: null,
        presence: null,
      });
    });

    expect(await screen.findByRole("heading", { name: "Alice Updated" })).toBeInTheDocument();
  });
});
