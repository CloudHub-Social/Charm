import { fireEvent, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { RoomAliasManagement } from "./RoomAliasManagement";
import { makeRoomDetails, openDropdownMenu } from "./testUtils";
import { renderWithProviders } from "@/test/renderWithProviders";

const getRoomLocalAliases = vi.fn();
const checkRoomAliasAvailable = vi.fn().mockResolvedValue(true);
const addRoomAlias = vi.fn().mockResolvedValue(undefined);
const removeRoomAlias = vi.fn().mockResolvedValue(undefined);
const setCanonicalAlias = vi.fn().mockResolvedValue(undefined);
const removeAltAlias = vi.fn().mockResolvedValue(undefined);
const getProfile = vi.fn().mockResolvedValue({
  user_id: "@me:example.org",
  display_name: null,
  avatar_url: null,
});

vi.mock("@/lib/matrix", () => ({
  // `useRoomAdminActions` (used by `RoomAliasManagement`) unconditionally
  // builds mutations for the full room-admin surface, not just aliases —
  // stub the rest as never-called functions so importing it doesn't depend
  // on which of its wrappers this suite happens to exercise.
  setRoomName: vi.fn(),
  setRoomTopic: vi.fn(),
  setRoomAvatar: vi.fn(),
  removeRoomAvatar: vi.fn(),
  setRoomJoinRule: vi.fn(),
  setRoomHistoryVisibility: vi.fn(),
  enableRoomEncryption: vi.fn(),
  setMemberPowerLevel: vi.fn(),
  setRoomPowerLevelThresholds: vi.fn(),
  inviteMember: vi.fn(),
  kickMember: vi.fn(),
  banMember: vi.fn(),
  unbanMember: vi.fn(),
  getRoomLocalAliases: (...args: unknown[]) => getRoomLocalAliases(...args),
  checkRoomAliasAvailable: (...args: unknown[]) => checkRoomAliasAvailable(...args),
  addRoomAlias: (...args: unknown[]) => addRoomAlias(...args),
  removeRoomAlias: (...args: unknown[]) => removeRoomAlias(...args),
  setCanonicalAlias: (...args: unknown[]) => setCanonicalAlias(...args),
  removeAltAlias: (...args: unknown[]) => removeAltAlias(...args),
  getProfile: (...args: unknown[]) => getProfile(...args),
}));

describe("RoomAliasManagement", () => {
  it("renders the room's published aliases", async () => {
    getRoomLocalAliases.mockResolvedValue(["#general:example.org", "#lobby:example.org"]);
    const details = makeRoomDetails();
    renderWithProviders(<RoomAliasManagement details={details} />);

    expect(await screen.findByText("#general:example.org")).toBeInTheDocument();
    expect(screen.getByText("#lobby:example.org")).toBeInTheDocument();
  });

  it("shows an empty state when there are no published aliases", async () => {
    getRoomLocalAliases.mockResolvedValue([]);
    renderWithProviders(<RoomAliasManagement details={makeRoomDetails()} />);

    expect(await screen.findByText("No published addresses yet.")).toBeInTheDocument();
  });

  it("surfaces an error when loading aliases fails", async () => {
    getRoomLocalAliases.mockRejectedValue(new Error("network error"));
    renderWithProviders(<RoomAliasManagement details={makeRoomDetails()} />);

    expect(await screen.findByText("Couldn't load room addresses.")).toBeInTheDocument();
  });

  it("adds a new alias built from the local part and the signed-in user's server name", async () => {
    getRoomLocalAliases.mockResolvedValue([]);
    const details = makeRoomDetails({ room_id: "!test:example.org" });
    renderWithProviders(<RoomAliasManagement details={details} />);

    await screen.findByText("No published addresses yet.");
    fireEvent.change(screen.getByLabelText("New alias local part"), {
      target: { value: "team-room" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Add" }));

    await waitFor(() => {
      expect(addRoomAlias).toHaveBeenCalledWith(details.room_id, "#team-room:example.org");
    });
  });

  it("uses the signed-in user's homeserver, not the room's, for federated rooms", async () => {
    getProfile.mockResolvedValueOnce({
      user_id: "@me:my-homeserver.example",
      display_name: null,
      avatar_url: null,
    });
    getRoomLocalAliases.mockResolvedValue([]);
    const details = makeRoomDetails({ room_id: "!test:someone-elses-server.example" });
    renderWithProviders(<RoomAliasManagement details={details} />);

    await screen.findByText("No published addresses yet.");
    expect(await screen.findByText(":my-homeserver.example")).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText("New alias local part"), {
      target: { value: "team-room" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Add" }));

    await waitFor(() => {
      expect(addRoomAlias).toHaveBeenCalledWith(
        details.room_id,
        "#team-room:my-homeserver.example",
      );
    });
  });

  it("surfaces an add-alias error (e.g. already taken) inline", async () => {
    getRoomLocalAliases.mockResolvedValue([]);
    addRoomAlias.mockRejectedValueOnce(new Error("Room alias already taken"));
    const details = makeRoomDetails({ room_id: "!test:example.org" });
    renderWithProviders(<RoomAliasManagement details={details} />);

    await screen.findByText("No published addresses yet.");
    fireEvent.change(screen.getByLabelText("New alias local part"), {
      target: { value: "taken" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Add" }));

    expect(await screen.findByText("Room alias already taken")).toBeInTheDocument();
  });

  it("surfaces an already-in-use error from the availability pre-check without calling addRoomAlias", async () => {
    getRoomLocalAliases.mockResolvedValue([]);
    checkRoomAliasAvailable.mockResolvedValueOnce(false);
    const details = makeRoomDetails({ room_id: "!test:example.org" });
    renderWithProviders(<RoomAliasManagement details={details} />);

    await screen.findByText("No published addresses yet.");
    fireEvent.change(screen.getByLabelText("New alias local part"), {
      target: { value: "unavailable" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Add" }));

    expect(await screen.findByText("That alias is already in use")).toBeInTheDocument();
    expect(addRoomAlias).not.toHaveBeenCalledWith(details.room_id, "#unavailable:example.org");
  });

  it("removes an existing alias", async () => {
    getRoomLocalAliases.mockResolvedValue(["#general:example.org"]);
    const details = makeRoomDetails();
    renderWithProviders(<RoomAliasManagement details={details} />);

    await screen.findByText("#general:example.org");
    fireEvent.click(screen.getByRole("button", { name: "Remove" }));

    await waitFor(() => {
      expect(removeRoomAlias).toHaveBeenCalledWith("#general:example.org");
    });
  });

  it("clears a removed alias from alt_aliases when it wasn't canonical", async () => {
    getRoomLocalAliases.mockResolvedValue(["#alt:example.org"]);
    const details = makeRoomDetails({
      canonical_alias: "#general:example.org",
      alt_aliases: ["#alt:example.org"],
    });
    renderWithProviders(<RoomAliasManagement details={details} />);

    await screen.findByText("#alt:example.org");
    fireEvent.click(screen.getByRole("button", { name: "Remove" }));

    await waitFor(() => {
      expect(removeRoomAlias).toHaveBeenCalledWith("#alt:example.org");
    });
    await waitFor(() => {
      expect(removeAltAlias).toHaveBeenCalledWith(details.room_id, "#alt:example.org");
    });
    expect(setCanonicalAlias).not.toHaveBeenCalled();
  });

  it("offers alt_aliases as canonical-alias dropdown options", async () => {
    getRoomLocalAliases.mockResolvedValue([]);
    const details = makeRoomDetails({ alt_aliases: ["#alt-only:example.org"] });
    renderWithProviders(<RoomAliasManagement details={details} />);

    await screen.findByText("No published addresses yet.");
    openDropdownMenu("None");
    expect(
      await screen.findByText("#alt-only:example.org", { selector: "[role=menuitemradio]" }),
    ).toBeInTheDocument();
  });

  it("sets the canonical alias via the dropdown", async () => {
    getRoomLocalAliases.mockResolvedValue(["#general:example.org"]);
    const details = makeRoomDetails();
    renderWithProviders(<RoomAliasManagement details={details} />);

    await screen.findByText("#general:example.org");
    openDropdownMenu("None");
    fireEvent.click(
      await screen.findByText("#general:example.org", { selector: "[role=menuitemradio]" }),
    );

    await waitFor(() => {
      expect(setCanonicalAlias).toHaveBeenCalledWith(details.room_id, "#general:example.org");
    });
  });

  it("clears the canonical alias via the None option", async () => {
    getRoomLocalAliases.mockResolvedValue(["#general:example.org"]);
    const details = makeRoomDetails({ canonical_alias: "#general:example.org" });
    renderWithProviders(<RoomAliasManagement details={details} />);

    await screen.findByText("#general:example.org", { selector: "button" });
    openDropdownMenu("#general:example.org");
    fireEvent.click(await screen.findByText("None", { selector: "[role=menuitemradio]" }));

    await waitFor(() => {
      expect(setCanonicalAlias).toHaveBeenCalledWith(details.room_id, null);
    });
  });

  it("disables add/remove/canonical controls when set_canonical_alias is false", async () => {
    getRoomLocalAliases.mockResolvedValue(["#general:example.org"]);
    const details = makeRoomDetails({
      can: { ...makeRoomDetails().can, set_canonical_alias: false },
    });
    renderWithProviders(<RoomAliasManagement details={details} />);

    await screen.findByText("#general:example.org");
    expect(screen.getByRole("button", { name: "Remove" })).toBeDisabled();
    expect(screen.getByLabelText("New alias local part")).toBeDisabled();
    expect(screen.getByRole("button", { name: "Add" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "None" })).toBeDisabled();
  });
});
