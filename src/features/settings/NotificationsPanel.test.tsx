import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NotificationsPanel } from "./NotificationsPanel";
import { makeRoomSummary } from "@/features/rooms/testFixtures";

const getNotificationSettings = vi.fn();
const listRooms = vi.fn();
const addNotificationKeyword = vi.fn();
const removeNotificationKeyword = vi.fn();
const setDefaultNotificationMode = vi.fn();
const setRoomNotificationMode = vi.fn();
const setGlobalMute = vi.fn();
const setSoundEnabled = vi.fn();
const getPushStatus = vi.fn();
const onPushStatus = vi.fn();
const registerPush = vi.fn();
const unregisterPush = vi.fn();
const requestPermission = vi.fn();

vi.mock("@/lib/matrix", () => ({
  getNotificationSettings: (...args: unknown[]) => getNotificationSettings(...args),
  listRooms: (...args: unknown[]) => listRooms(...args),
  addNotificationKeyword: (...args: unknown[]) => addNotificationKeyword(...args),
  removeNotificationKeyword: (...args: unknown[]) => removeNotificationKeyword(...args),
  setDefaultNotificationMode: (...args: unknown[]) => setDefaultNotificationMode(...args),
  setRoomNotificationMode: (...args: unknown[]) => setRoomNotificationMode(...args),
  setGlobalMute: (...args: unknown[]) => setGlobalMute(...args),
  setSoundEnabled: (...args: unknown[]) => setSoundEnabled(...args),
  getPushStatus: (...args: unknown[]) => getPushStatus(...args),
  onPushStatus: (...args: unknown[]) => onPushStatus(...args),
  registerPush: (...args: unknown[]) => registerPush(...args),
  unregisterPush: (...args: unknown[]) => unregisterPush(...args),
}));

vi.mock("@tauri-apps/plugin-notification", () => ({
  requestPermission: (...args: unknown[]) => requestPermission(...args),
}));

function renderWithProviders(children: ReactNode) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={client}>{children}</QueryClientProvider>);
}

beforeEach(() => {
  getNotificationSettings.mockReset().mockResolvedValue({
    default_mode: "all_messages",
    keywords: ["urgent"],
    global_mute: false,
    sound_enabled: true,
  });
  listRooms.mockReset().mockResolvedValue([]);
  addNotificationKeyword.mockReset().mockResolvedValue(undefined);
  removeNotificationKeyword.mockReset().mockResolvedValue(undefined);
  setDefaultNotificationMode.mockReset().mockResolvedValue(undefined);
  setGlobalMute.mockReset().mockResolvedValue(undefined);
  setSoundEnabled.mockReset().mockResolvedValue(undefined);
  getPushStatus.mockReset().mockResolvedValue({
    transport: "none",
    registered: false,
    endpoint_present: false,
    last_error: null,
    available: false,
  });
  onPushStatus.mockReset().mockReturnValue(Promise.resolve(() => {}));
  registerPush.mockReset().mockResolvedValue({
    transport: "none",
    registered: false,
    endpoint_present: false,
  });
  unregisterPush.mockReset().mockResolvedValue(undefined);
  requestPermission.mockReset().mockResolvedValue("granted");
});

describe("NotificationsPanel", () => {
  it("adds a keyword", async () => {
    renderWithProviders(<NotificationsPanel />);

    const input = await screen.findByLabelText("Add a keyword");
    fireEvent.change(input, { target: { value: "urgent2" } });
    fireEvent.click(screen.getByRole("button", { name: "Add" }));

    await waitFor(() => expect(addNotificationKeyword).toHaveBeenCalledWith("urgent2"));
  });

  it("removes a keyword", async () => {
    renderWithProviders(<NotificationsPanel />);

    fireEvent.click(await screen.findByRole("button", { name: "Remove keyword urgent" }));

    await waitFor(() => expect(removeNotificationKeyword).toHaveBeenCalledWith("urgent"));
  });

  it("changes the default notification mode and refetches rooms (their effective mode may have shifted)", async () => {
    renderWithProviders(<NotificationsPanel />);
    await waitFor(() => expect(listRooms).toHaveBeenCalledTimes(1));

    // Radix's DropdownMenu opens on pointerdown, not click, in jsdom.
    fireEvent.pointerDown(await screen.findByRole("button", { name: "All messages" }), {
      button: 0,
      ctrlKey: false,
      pointerType: "mouse",
    });
    fireEvent.click(await screen.findByText("Mute"));

    await waitFor(() => expect(setDefaultNotificationMode).toHaveBeenCalledWith("mute"));
    await waitFor(() => expect(listRooms).toHaveBeenCalledTimes(2));
  });

  it("toggles global mute and refetches rooms (their effective mode may have shifted)", async () => {
    renderWithProviders(<NotificationsPanel />);
    await waitFor(() => expect(listRooms).toHaveBeenCalledTimes(1));

    fireEvent.click(await screen.findByLabelText("Mute all rooms"));

    await waitFor(() => expect(setGlobalMute).toHaveBeenCalledWith(true));
    await waitFor(() => expect(listRooms).toHaveBeenCalledTimes(2));
  });

  it("adds a keyword via Enter", async () => {
    renderWithProviders(<NotificationsPanel />);

    const input = await screen.findByLabelText("Add a keyword");
    fireEvent.change(input, { target: { value: "on-call" } });
    fireEvent.keyDown(input, { key: "Enter" });

    await waitFor(() => expect(addNotificationKeyword).toHaveBeenCalledWith("on-call"));
  });

  it("changes a per-room notification mode override and refetches the room list to reflect it", async () => {
    listRooms.mockResolvedValue([
      makeRoomSummary({ room_id: "!general:localhost", name: "General", is_muted: false }),
    ]);
    setRoomNotificationMode.mockResolvedValue(undefined);
    renderWithProviders(<NotificationsPanel />);
    await waitFor(() => expect(listRooms).toHaveBeenCalledTimes(1));

    const roomModeButtons = await screen.findAllByRole("button", { name: "All messages" });
    fireEvent.pointerDown(roomModeButtons[roomModeButtons.length - 1], {
      button: 0,
      ctrlKey: false,
      pointerType: "mouse",
    });
    fireEvent.click(await screen.findByText("Mute"));

    await waitFor(() =>
      expect(setRoomNotificationMode).toHaveBeenCalledWith("!general:localhost", "mute"),
    );
    // The mutation's success invalidates the rooms query — without that,
    // this row would keep showing "All messages" until an unrelated remount.
    await waitFor(() => expect(listRooms).toHaveBeenCalledTimes(2));
  });

  it("shows a mentions-and-keywords-only room override accurately, not folded into All messages", async () => {
    listRooms.mockResolvedValue([
      makeRoomSummary({
        room_id: "!watercooler:localhost",
        name: "Watercooler",
        is_muted: false,
        notification_mode: "mentions_and_keywords_only",
      }),
    ]);
    renderWithProviders(<NotificationsPanel />);
    await screen.findByText("Watercooler");

    // The *default* mode picker (settings.default_mode: "all_messages" from
    // the `beforeEach` mock) also renders an "All messages" button, so this
    // asserts there's exactly one — the default's — and not a second one for
    // this room's row, which would mean the override got folded away.
    expect(await screen.findByRole("button", { name: "Mentions & keywords only" })).toBeVisible();
    expect(screen.getAllByRole("button", { name: "All messages" })).toHaveLength(1);
  });

  it("shows 'not available' when the platform has no push transport at all", async () => {
    getPushStatus.mockResolvedValue({
      transport: "none",
      registered: false,
      endpoint_present: false,
      last_error: null,
      available: false,
    });
    renderWithProviders(<NotificationsPanel />);

    expect(
      await screen.findByText(
        "Not available on this platform — desktop relies on the always-on sync loop instead.",
      ),
    ).toBeVisible();
    expect(
      screen.queryByRole("button", { name: "Turn on push notifications" }),
    ).not.toBeInTheDocument();
    expect(screen.queryByText(/requires a UnifiedPush distributor/)).not.toBeInTheDocument();
  });

  it("suggests installing a UnifiedPush distributor when Android push registration fails", async () => {
    getPushStatus.mockResolvedValue({
      transport: "none",
      registered: false,
      endpoint_present: false,
      last_error: "timed out waiting for a UnifiedPush/FCM endpoint",
      available: true,
    });
    renderWithProviders(<NotificationsPanel />);

    expect(
      await screen.findByText(
        "Android push requires a UnifiedPush distributor (for example, ntfy). Install one, then turn on push notifications.",
      ),
    ).toBeVisible();
    expect(screen.getByRole("button", { name: "Turn on push notifications" })).toBeVisible();
  });

  it("does not prompt for a distributor after push is intentionally turned off", async () => {
    getPushStatus.mockResolvedValue({
      transport: "none",
      registered: false,
      endpoint_present: false,
      last_error: null,
      available: true,
    });
    renderWithProviders(<NotificationsPanel />);

    await screen.findByText(/Transport: Not registered yet/);
    expect(screen.queryByText(/requires a UnifiedPush distributor/)).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Turn on push notifications" })).toBeVisible();
  });

  it("does not prompt for a distributor on unrelated endpoint errors", async () => {
    getPushStatus.mockResolvedValue({
      transport: "none",
      registered: false,
      endpoint_present: false,
      last_error: "homeserver endpoint returned 503",
      available: true,
    });
    renderWithProviders(<NotificationsPanel />);

    expect(await screen.findByText("homeserver endpoint returned 503")).toBeVisible();
    expect(screen.queryByText(/requires a UnifiedPush distributor/)).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Turn on push notifications" })).toBeVisible();
  });

  it("requests OS notification permission before registering push, on a platform where it's available", async () => {
    getPushStatus.mockResolvedValue({
      transport: "unified_push",
      registered: false,
      endpoint_present: false,
      last_error: null,
      available: true,
    });
    renderWithProviders(<NotificationsPanel />);

    fireEvent.click(await screen.findByRole("button", { name: "Turn on push notifications" }));

    await waitFor(() => expect(requestPermission).toHaveBeenCalled());
    await waitFor(() => expect(registerPush).toHaveBeenCalled());
  });

  it("does not register push if the notification permission is denied", async () => {
    getPushStatus.mockResolvedValue({
      transport: "unified_push",
      registered: false,
      endpoint_present: false,
      last_error: null,
      available: true,
    });
    requestPermission.mockResolvedValue("denied");
    renderWithProviders(<NotificationsPanel />);

    fireEvent.click(await screen.findByRole("button", { name: "Turn on push notifications" }));

    await waitFor(() => expect(requestPermission).toHaveBeenCalled());
    // Give the denied-permission branch a turn to (not) call registerPush.
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(registerPush).not.toHaveBeenCalled();
  });
});
