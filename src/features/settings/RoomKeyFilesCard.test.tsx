import { act, fireEvent, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderWithProviders } from "@/test/renderWithProviders";
import { RoomKeyFilesCard } from "./RoomKeyFilesCard";

const exportRoomKeys = vi.fn();
const importRoomKeys = vi.fn();

vi.mock("@/lib/matrix", () => ({
  exportRoomKeys: (...args: unknown[]) => exportRoomKeys(...args),
  importRoomKeys: (...args: unknown[]) => importRoomKeys(...args),
}));

beforeEach(() => {
  exportRoomKeys.mockReset().mockResolvedValue({ completed: true });
  importRoomKeys.mockReset().mockResolvedValue({
    completed: true,
    imported_count: 12,
    total_count: 14,
  });
});

describe("RoomKeyFilesCard", () => {
  it("blocks dismissal until the native transfer settles", async () => {
    let finish!: (value: {
      completed: boolean;
      imported_count: number;
      total_count: number;
    }) => void;
    importRoomKeys.mockReturnValue(
      new Promise((resolve) => {
        finish = resolve;
      }),
    );
    renderWithProviders(<RoomKeyFilesCard />);
    fireEvent.click(screen.getByRole("button", { name: "Import keys" }));
    fireEvent.change(screen.getByLabelText("Passphrase"), {
      target: { value: "long-enough-passphrase" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Choose file" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Importing…" })).toBeDisabled());

    expect(screen.queryByRole("button", { name: "Close", exact: true })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Cancel" })).toBeDisabled();
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
    fireEvent.pointerDown(document.body);
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    expect(screen.getByLabelText("Passphrase")).toHaveValue("long-enough-passphrase");

    await act(async () => {
      finish({ completed: false, imported_count: 0, total_count: 0 });
    });
    await waitFor(() => expect(screen.getByRole("button", { name: "Cancel" })).toBeEnabled());
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("requires matching export passphrases before opening the native picker", async () => {
    renderWithProviders(<RoomKeyFilesCard />);

    fireEvent.click(screen.getByRole("button", { name: "Export keys" }));
    const submit = screen.getByRole("button", { name: "Choose destination" });
    fireEvent.change(screen.getByLabelText("Passphrase"), {
      target: { value: "long-enough-passphrase" },
    });
    fireEvent.change(screen.getByLabelText("Confirm passphrase"), {
      target: { value: "does-not-match" },
    });
    expect(submit).toBeDisabled();

    fireEvent.change(screen.getByLabelText("Confirm passphrase"), {
      target: { value: "long-enough-passphrase" },
    });
    fireEvent.click(submit);

    await waitFor(() => expect(exportRoomKeys).toHaveBeenCalledWith("long-enough-passphrase"));
    expect(await screen.findByRole("status")).toHaveTextContent(
      "Encrypted room keys exported successfully.",
    );
  });

  it("reports SDK import counts", async () => {
    renderWithProviders(<RoomKeyFilesCard />);

    fireEvent.click(screen.getByRole("button", { name: "Import keys" }));
    fireEvent.change(screen.getByLabelText("Passphrase"), {
      target: { value: "long-enough-passphrase" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Choose file" }));

    await waitFor(() => expect(importRoomKeys).toHaveBeenCalledWith("long-enough-passphrase"));
    expect(await screen.findByRole("status")).toHaveTextContent("Imported 12 of 14 room keys.");
  });

  it("keeps the dialog open when the native picker is cancelled", async () => {
    importRoomKeys.mockResolvedValue({ completed: false, imported_count: 0, total_count: 0 });
    renderWithProviders(<RoomKeyFilesCard />);

    fireEvent.click(screen.getByRole("button", { name: "Import keys" }));
    fireEvent.change(screen.getByLabelText("Passphrase"), {
      target: { value: "long-enough-passphrase" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Choose file" }));

    await waitFor(() => expect(importRoomKeys).toHaveBeenCalled());
    expect(screen.getByRole("dialog")).toBeInTheDocument();
  });
});
