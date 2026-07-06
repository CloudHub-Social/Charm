import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { RoomSettingsForm } from "./RoomSettingsForm";
import { makeRoomDetails, openDropdownMenu, renderWithProviders } from "./testUtils";

/**
 * Scopes the Save button lookup to whichever field's row it sits in — the
 * form has more than one "Save" button. `closest`, not `parentElement`: a
 * disabled field is wrapped in an extra `PermissionGate` tooltip span, so the
 * ancestor depth to the shared row container isn't constant.
 */
function saveButtonFor(fieldLabel: string) {
  const field = screen.getByLabelText(fieldLabel);
  const row = field.closest(".flex.flex-col.gap-2") as HTMLElement;
  return within(row).getByRole("button", { name: "Save" });
}

const openFileDialog = vi.fn();
const setRoomAvatar = vi.fn().mockResolvedValue(undefined);
const setRoomJoinRule = vi.fn().mockResolvedValue(undefined);
const setRoomHistoryVisibility = vi.fn().mockResolvedValue(undefined);
const enableRoomEncryption = vi.fn().mockResolvedValue(undefined);

vi.mock("@tauri-apps/plugin-dialog", () => ({
  open: (...args: unknown[]) => openFileDialog(...args),
}));

// `useRoomAdminActions` calls `useMutation` for every action unconditionally,
// so every wrapper it wraps needs a mock here even if this file's tests only
// exercise a few of them — same full-module-mock convention as
// `ChatShell.test.tsx`.
vi.mock("@/lib/matrix", () => ({
  setRoomName: vi.fn().mockResolvedValue(undefined),
  setRoomTopic: vi.fn().mockResolvedValue(undefined),
  setRoomAvatar: (...args: unknown[]) => setRoomAvatar(...args),
  removeRoomAvatar: vi.fn().mockResolvedValue(undefined),
  setRoomJoinRule: (...args: unknown[]) => setRoomJoinRule(...args),
  setRoomHistoryVisibility: (...args: unknown[]) => setRoomHistoryVisibility(...args),
  enableRoomEncryption: (...args: unknown[]) => enableRoomEncryption(...args),
  setMemberPowerLevel: vi.fn().mockResolvedValue(undefined),
  setRoomPowerLevelThresholds: vi.fn().mockResolvedValue(undefined),
  inviteMember: vi.fn().mockResolvedValue(undefined),
  kickMember: vi.fn().mockResolvedValue(undefined),
  banMember: vi.fn().mockResolvedValue(undefined),
  unbanMember: vi.fn().mockResolvedValue(undefined),
}));

describe("RoomSettingsForm", () => {
  it("disables the name field and save button when can.set_name is false", () => {
    const details = makeRoomDetails({ can: { ...makeRoomDetails().can, set_name: false } });
    renderWithProviders(<RoomSettingsForm details={details} />);

    const nameField = screen.getByLabelText("Room name");
    expect(nameField).toBeDisabled();
    fireEvent.change(nameField, { target: { value: "New Name" } });
    expect(saveButtonFor("Room name")).toBeDisabled();
  });

  it("enables the name field, and the save button once its value changes, when can.set_name is true", () => {
    const details = makeRoomDetails();
    renderWithProviders(<RoomSettingsForm details={details} />);

    const nameField = screen.getByLabelText("Room name");
    expect(nameField).toBeEnabled();
    expect(saveButtonFor("Room name")).toBeDisabled();

    fireEvent.change(nameField, { target: { value: "New Name" } });
    expect(saveButtonFor("Room name")).toBeEnabled();
  });

  it("shows a permanent encrypted indicator instead of the enable button once a room is encrypted", () => {
    const details = makeRoomDetails({ is_encrypted: true });
    renderWithProviders(<RoomSettingsForm details={details} />);

    expect(screen.getByText(/encrypted/i)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Enable encryption" })).not.toBeInTheDocument();
  });

  it("requires confirmation before enabling encryption, then sends the request", async () => {
    const details = makeRoomDetails({ is_encrypted: false });
    renderWithProviders(<RoomSettingsForm details={details} />);

    fireEvent.click(screen.getByRole("button", { name: "Enable encryption" }));
    expect(enableRoomEncryption).not.toHaveBeenCalled();

    const dialog = await screen.findByRole("dialog");
    fireEvent.click(within(dialog).getByRole("button", { name: "Enable encryption" }));
    await waitFor(() => {
      expect(enableRoomEncryption).toHaveBeenCalledWith(details.room_id);
    });
  });

  it("uploads a picked file as the new avatar", async () => {
    openFileDialog.mockResolvedValue("/tmp/new-avatar.png");
    const details = makeRoomDetails();
    renderWithProviders(<RoomSettingsForm details={details} />);

    fireEvent.click(screen.getByRole("button", { name: "Upload new avatar" }));

    await waitFor(() => {
      expect(setRoomAvatar).toHaveBeenCalledWith(details.room_id, "/tmp/new-avatar.png");
    });
  });

  it("changes the join rule via the dropdown", async () => {
    const details = makeRoomDetails({ join_rule: "invite" });
    renderWithProviders(<RoomSettingsForm details={details} />);

    openDropdownMenu("Invite only");
    fireEvent.click(await screen.findByText("Public — anyone can join"));

    await waitFor(() => {
      expect(setRoomJoinRule).toHaveBeenCalledWith(details.room_id, "public");
    });
  });

  it("changes history visibility via the dropdown", async () => {
    const details = makeRoomDetails({ history_visibility: "shared" });
    renderWithProviders(<RoomSettingsForm details={details} />);

    openDropdownMenu("Members, including before they joined");
    fireEvent.click(await screen.findByText("Members, from when they joined"));

    await waitFor(() => {
      expect(setRoomHistoryVisibility).toHaveBeenCalledWith(details.room_id, "joined");
    });
  });
});
