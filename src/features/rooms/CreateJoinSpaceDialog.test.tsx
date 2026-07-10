import { fireEvent, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi, beforeEach } from "vitest";
import { CreateJoinSpaceDialog } from "./CreateJoinSpaceDialog";
import { renderWithProviders } from "@/test/renderWithProviders";

const createSpace = vi.fn();
const joinRoom = vi.fn();

vi.mock("@/lib/matrix", () => ({
  createSpace: (...args: unknown[]) => createSpace(...args),
  joinRoom: (...args: unknown[]) => joinRoom(...args),
}));

describe("CreateJoinSpaceDialog", () => {
  beforeEach(() => {
    createSpace.mockReset();
    joinRoom.mockReset();
  });

  it("creates a space with the entered name and reports the new space id", async () => {
    createSpace.mockResolvedValue("!newspace:example.org");
    const onSpaceCreated = vi.fn();
    renderWithProviders(
      <CreateJoinSpaceDialog
        open
        onOpenChange={vi.fn()}
        onSpaceCreated={onSpaceCreated}
        onSpaceJoined={vi.fn()}
      />,
    );

    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Engineering" } });
    fireEvent.click(screen.getByRole("button", { name: "Create space" }));

    await waitFor(() => expect(onSpaceCreated).toHaveBeenCalledWith("!newspace:example.org"));
    expect(createSpace).toHaveBeenCalledWith("Engineering", undefined, undefined, false);
  });

  it("passes the entered address through as the room alias", async () => {
    createSpace.mockResolvedValue("!newspace:example.org");
    renderWithProviders(
      <CreateJoinSpaceDialog
        open
        onOpenChange={vi.fn()}
        onSpaceCreated={vi.fn()}
        onSpaceJoined={vi.fn()}
      />,
    );

    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Engineering" } });
    fireEvent.change(screen.getByLabelText("Address (optional)"), {
      target: { value: "engineering" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Create space" }));

    await waitFor(() =>
      expect(createSpace).toHaveBeenCalledWith("Engineering", undefined, "engineering", false),
    );
  });

  it("shows an error and does not close when creation fails", async () => {
    createSpace.mockRejectedValue(new Error("homeserver rejected the request"));
    const onSpaceCreated = vi.fn();
    renderWithProviders(
      <CreateJoinSpaceDialog
        open
        onOpenChange={vi.fn()}
        onSpaceCreated={onSpaceCreated}
        onSpaceJoined={vi.fn()}
      />,
    );

    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Engineering" } });
    fireEvent.click(screen.getByRole("button", { name: "Create space" }));

    await waitFor(() =>
      expect(screen.getByText("homeserver rejected the request")).toBeInTheDocument(),
    );
    expect(onSpaceCreated).not.toHaveBeenCalled();
  });

  it("requires a name before creating", () => {
    renderWithProviders(
      <CreateJoinSpaceDialog
        open
        onOpenChange={vi.fn()}
        onSpaceCreated={vi.fn()}
        onSpaceJoined={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Create space" }));

    expect(screen.getByText("Name is required.")).toBeInTheDocument();
    expect(createSpace).not.toHaveBeenCalled();
  });

  it("joins a space by address and reports the resolved room id", async () => {
    joinRoom.mockResolvedValue("!resolved:example.org");
    const onSpaceJoined = vi.fn();
    renderWithProviders(
      <CreateJoinSpaceDialog
        open
        onOpenChange={vi.fn()}
        onSpaceCreated={vi.fn()}
        onSpaceJoined={onSpaceJoined}
      />,
    );

    // Radix's Tabs activates on focus (the default "automatic" activation
    // mode), which a real click produces but jsdom's synthetic `click` alone
    // does not — focus it explicitly first, same as `RoomSettingsModal.test.tsx`.
    const joinTab = screen.getByRole("tab", { name: "Join by address" });
    joinTab.focus();
    fireEvent.click(joinTab);
    fireEvent.change(await screen.findByLabelText("Space address or ID"), {
      target: { value: "#space:example.org" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Join space" }));

    await waitFor(() => expect(onSpaceJoined).toHaveBeenCalledWith("!resolved:example.org"));
    expect(joinRoom).toHaveBeenCalledWith("#space:example.org");
  });

  it("requires an address before joining", async () => {
    renderWithProviders(
      <CreateJoinSpaceDialog
        open
        onOpenChange={vi.fn()}
        onSpaceCreated={vi.fn()}
        onSpaceJoined={vi.fn()}
      />,
    );

    // Radix's Tabs activates on focus (the default "automatic" activation
    // mode), which a real click produces but jsdom's synthetic `click` alone
    // does not — focus it explicitly first, same as `RoomSettingsModal.test.tsx`.
    const joinTab = screen.getByRole("tab", { name: "Join by address" });
    joinTab.focus();
    fireEvent.click(joinTab);
    fireEvent.click(await screen.findByRole("button", { name: "Join space" }));

    expect(screen.getByText("Enter a space address or ID.")).toBeInTheDocument();
    expect(joinRoom).not.toHaveBeenCalled();
  });

  it("clears an error from one tab when switching to the other", async () => {
    renderWithProviders(
      <CreateJoinSpaceDialog
        open
        onOpenChange={vi.fn()}
        onSpaceCreated={vi.fn()}
        onSpaceJoined={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Create space" }));
    expect(screen.getByText("Name is required.")).toBeInTheDocument();

    const joinTab = screen.getByRole("tab", { name: "Join by address" });
    joinTab.focus();
    fireEvent.click(joinTab);
    await screen.findByLabelText("Space address or ID");

    expect(screen.queryByText("Name is required.")).not.toBeInTheDocument();
  });

  it("resets to the Create new tab after closing", async () => {
    const onOpenChange = vi.fn();
    const { rerender } = renderWithProviders(
      <CreateJoinSpaceDialog
        open
        onOpenChange={onOpenChange}
        onSpaceCreated={vi.fn()}
        onSpaceJoined={vi.fn()}
      />,
    );

    const joinTab = screen.getByRole("tab", { name: "Join by address" });
    joinTab.focus();
    fireEvent.click(joinTab);
    await screen.findByLabelText("Space address or ID");

    // Escape triggers Radix's onOpenChange(false), which the dialog wires to
    // resetAndClose — same close path as the dismiss button/backdrop click.
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape", code: "Escape" });
    expect(onOpenChange).toHaveBeenCalledWith(false);

    rerender(
      <CreateJoinSpaceDialog
        open
        onOpenChange={onOpenChange}
        onSpaceCreated={vi.fn()}
        onSpaceJoined={vi.fn()}
      />,
    );

    expect(screen.getByRole("tab", { name: "Create new", selected: true })).toBeInTheDocument();
  });

  it("does not navigate if the request resolves after the dialog was dismissed mid-flight", async () => {
    let resolveCreate!: (value: string) => void;
    createSpace.mockReturnValue(
      new Promise<string>((resolve) => {
        resolveCreate = resolve;
      }),
    );
    const onOpenChange = vi.fn();
    const onSpaceCreated = vi.fn();
    renderWithProviders(
      <CreateJoinSpaceDialog
        open
        onOpenChange={onOpenChange}
        onSpaceCreated={onSpaceCreated}
        onSpaceJoined={vi.fn()}
      />,
    );

    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Engineering" } });
    fireEvent.click(screen.getByRole("button", { name: "Create space" }));
    expect(screen.getByRole("button", { name: "Creating…" })).toBeInTheDocument();

    // User dismisses the dialog while the create request is still in flight.
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape", code: "Escape" });
    expect(onOpenChange).toHaveBeenCalledWith(false);

    resolveCreate("!newspace:example.org");
    await waitFor(() => expect(createSpace).toHaveBeenCalled());
    // Give the resolved promise's `.then` a tick to run.
    await Promise.resolve();
    await Promise.resolve();

    expect(onSpaceCreated).not.toHaveBeenCalled();
  });
});
