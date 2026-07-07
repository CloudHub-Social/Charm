import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { createStore } from "jotai";
import { describe, expect, it, vi } from "vitest";
import { RoomSettingsModal } from "./RoomSettingsModal";
import { roomSettingsAtom } from "./roomInfoAtoms";
import { makeRoomDetails } from "./testUtils";
import { AppProviders } from "@/providers";
import { TooltipProvider } from "@/components/ui/tooltip";
import { QueryClient } from "@tanstack/react-query";

const mockUseAdaptiveLayout = vi.fn(() => "desktop");
vi.mock("@/features/shell/useAdaptiveLayout", () => ({
  useAdaptiveLayout: () => mockUseAdaptiveLayout(),
}));

const getRoomDetails = vi.fn();
const getRoomMemberList = vi.fn().mockResolvedValue([]);

vi.mock("@/lib/matrix", () => ({
  getRoomDetails: (...args: unknown[]) => getRoomDetails(...args),
  getRoomMemberList: (...args: unknown[]) => getRoomMemberList(...args),
  onRoomDetailsUpdate: vi.fn().mockResolvedValue(() => {}),
  setRoomName: vi.fn().mockResolvedValue(undefined),
  setRoomTopic: vi.fn().mockResolvedValue(undefined),
  setRoomAvatar: vi.fn().mockResolvedValue(undefined),
  removeRoomAvatar: vi.fn().mockResolvedValue(undefined),
  setRoomJoinRule: vi.fn().mockResolvedValue(undefined),
  setRoomHistoryVisibility: vi.fn().mockResolvedValue(undefined),
  enableRoomEncryption: vi.fn().mockResolvedValue(undefined),
  setMemberPowerLevel: vi.fn().mockResolvedValue(undefined),
  setRoomPowerLevelThresholds: vi.fn().mockResolvedValue(undefined),
  inviteMember: vi.fn().mockResolvedValue(undefined),
  kickMember: vi.fn().mockResolvedValue(undefined),
  banMember: vi.fn().mockResolvedValue(undefined),
  unbanMember: vi.fn().mockResolvedValue(undefined),
}));

function renderModal(
  target: { roomId: string; section: "general" | "members" | "permissions" } | null,
) {
  const store = createStore();
  store.set(roomSettingsAtom, target);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return {
    store,
    ...render(
      <AppProviders client={client} store={store}>
        <TooltipProvider>
          <RoomSettingsModal currentUserId="@evie:localhost" />
        </TooltipProvider>
      </AppProviders>,
    ),
  };
}

describe("RoomSettingsModal", () => {
  it("is closed when no room settings target is set", () => {
    renderModal(null);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("opens directly to the requested section and shows the left-nav split", async () => {
    const details = makeRoomDetails({ name: "Design Team" });
    getRoomDetails.mockResolvedValue(details);

    renderModal({ roomId: details.room_id, section: "permissions" });

    expect(await screen.findByText("Power level thresholds")).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "General" })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "Members" })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "Permissions", selected: true })).toBeInTheDocument();
  });

  it("does not fetch the member list until the Members tab is opened", async () => {
    const details = makeRoomDetails({ name: "Design Team" });
    getRoomDetails.mockResolvedValue(details);
    getRoomMemberList.mockClear();

    renderModal({ roomId: details.room_id, section: "general" });
    await screen.findByDisplayValue("Design Team");
    expect(getRoomMemberList).not.toHaveBeenCalled();

    const membersTab = screen.getByRole("tab", { name: "Members" });
    membersTab.focus();
    fireEvent.click(membersTab);

    await waitFor(() => expect(getRoomMemberList).toHaveBeenCalledWith(details.room_id));
  });

  it("switches sections via the left-nav tabs", async () => {
    const details = makeRoomDetails({ name: "Design Team" });
    getRoomDetails.mockResolvedValue(details);

    renderModal({ roomId: details.room_id, section: "general" });
    await screen.findByDisplayValue("Design Team");

    const membersTab = screen.getByRole("tab", { name: "Members" });
    // Radix's Tabs activates on focus (the default "automatic" activation
    // mode), which a real click produces but jsdom's synthetic `click` alone
    // does not — focus it explicitly first, same as `SettingsScreen.test.tsx`.
    membersTab.focus();
    fireEvent.click(membersTab);

    await waitFor(() => expect(screen.getByLabelText("Search members")).toBeInTheDocument());
  });

  it("preserves an unsaved General edit across switching to another section and back", async () => {
    const details = makeRoomDetails({ name: "Design Team" });
    getRoomDetails.mockResolvedValue(details);

    renderModal({ roomId: details.room_id, section: "general" });
    const nameField = await screen.findByDisplayValue("Design Team");
    fireEvent.change(nameField, { target: { value: "Draft Name" } });

    const membersTab = screen.getByRole("tab", { name: "Members" });
    membersTab.focus();
    fireEvent.click(membersTab);
    await waitFor(() => expect(screen.getByLabelText("Search members")).toBeInTheDocument());

    const generalTab = screen.getByRole("tab", { name: "General" });
    generalTab.focus();
    fireEvent.click(generalTab);

    await waitFor(() => expect(screen.getByDisplayValue("Draft Name")).toBeInTheDocument());
  });

  it("shows a dismissible error message when the details fetch fails", async () => {
    getRoomDetails.mockRejectedValue(new Error("network error"));

    renderModal({ roomId: "!fails:localhost", section: "general" });

    expect(await screen.findByText("Couldn't load room settings.")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Close room settings" }));

    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
  });

  it("switches the nav to a horizontal top bar on mobile widths", async () => {
    mockUseAdaptiveLayout.mockReturnValue("mobile");
    const details = makeRoomDetails({ name: "Design Team" });
    getRoomDetails.mockResolvedValue(details);

    renderModal({ roomId: details.room_id, section: "general" });
    await screen.findByDisplayValue("Design Team");

    expect(screen.getByRole("tablist")).toHaveAttribute("aria-orientation", "horizontal");
    mockUseAdaptiveLayout.mockReturnValue("desktop");
  });

  it("closes and clears the target when dismissed", async () => {
    const details = makeRoomDetails({ name: "Design Team" });
    getRoomDetails.mockResolvedValue(details);

    const { store } = renderModal({ roomId: details.room_id, section: "general" });
    await screen.findByDisplayValue("Design Team");

    act(() => {
      fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
    });

    await waitFor(() => expect(store.get(roomSettingsAtom)).toBeNull());
  });
});
