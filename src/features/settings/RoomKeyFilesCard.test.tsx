import { act, fireEvent, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderWithProviders, wrapWithProviders } from "@/test/renderWithProviders";
import { RoomKeyFilesCard as Entry, RoomKeyFilesProvider } from "./RoomKeyFilesCard";

function RoomKeyFilesCard({
  enabled = true,
  settingsOpen = true,
}: {
  enabled?: boolean;
  settingsOpen?: boolean;
}) {
  return (
    <RoomKeyFilesProvider enabled={enabled}>
      {settingsOpen && <Entry enabled={enabled} />}
    </RoomKeyFilesProvider>
  );
}

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
  it("keeps progress and the result visible after the Settings entry unmounts", async () => {
    let finish!: (value: {
      completed: boolean;
      imported_count: number;
      total_count: number;
    }) => void;
    importRoomKeys.mockReturnValueOnce(
      new Promise((resolve) => {
        finish = resolve;
      }),
    );
    const { client, rerender } = renderWithProviders(<RoomKeyFilesCard />);
    fireEvent.click(screen.getByRole("button", { name: "Import keys" }));
    fireEvent.change(screen.getByLabelText("Passphrase"), {
      target: { value: "private-passphrase" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Choose file" }));
    await waitFor(() => expect(importRoomKeys).toHaveBeenCalledOnce());
    rerender(wrapWithProviders(<RoomKeyFilesCard settingsOpen={false} />, client));
    expect(screen.getByRole("button", { name: "Importing…" })).toBeDisabled();
    expect(screen.queryByRole("button", { name: "Import keys" })).not.toBeInTheDocument();
    expect(client.getMutationCache().getAll()).toEqual([]);
    await act(async () => finish({ completed: true, imported_count: 2, total_count: 2 }));
    expect(await screen.findByRole("status")).toHaveTextContent("Imported 2 of 2 room keys.");
    expect(screen.queryByLabelText("Passphrase")).not.toBeInTheDocument();
    expect(client.getMutationCache().getAll()).toEqual([]);
  });
  it.each(["", "short"])("accepts an existing import passphrase %j", async (passphrase) => {
    renderWithProviders(<RoomKeyFilesCard />);
    fireEvent.click(screen.getByRole("button", { name: "Import keys" }));
    fireEvent.change(screen.getByLabelText("Passphrase"), { target: { value: passphrase } });
    fireEvent.click(screen.getByRole("button", { name: "Choose file" }));
    await waitFor(() => expect(importRoomKeys).toHaveBeenCalledWith(passphrase));
  });

  it("counts export characters as Unicode code points", () => {
    renderWithProviders(<RoomKeyFilesCard />);
    fireEvent.click(screen.getByRole("button", { name: "Export keys" }));
    for (const count of [4, 8]) {
      const value = "🔑".repeat(count);
      fireEvent.change(screen.getByLabelText("Passphrase"), { target: { value } });
      fireEvent.change(screen.getByLabelText("Confirm passphrase"), { target: { value } });
      const submit = screen.getByRole("button", { name: "Choose destination" });
      if (count === 4) expect(submit).toBeDisabled();
      else expect(submit).toBeEnabled();
    }
  });

  it.each(["Import keys", "Export keys"])("bounds UTF-8 bytes for %s", (action) => {
    renderWithProviders(<RoomKeyFilesCard />);
    fireEvent.click(screen.getByRole("button", { name: action }));
    for (const count of [256, 257]) {
      const value = "🔑".repeat(count);
      fireEvent.change(screen.getByLabelText("Passphrase"), { target: { value } });
      if (action === "Export keys") {
        fireEvent.change(screen.getByLabelText("Confirm passphrase"), { target: { value } });
      }
      const submit = screen.getByRole("button", {
        name: action === "Import keys" ? "Choose file" : "Choose destination",
      });
      if (count === 256) expect(submit).toBeEnabled();
      else expect(submit).toBeDisabled();
    }
  });

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
    const { client, rerender } = renderWithProviders(<RoomKeyFilesCard />);
    fireEvent.click(screen.getByRole("button", { name: "Import keys" }));
    fireEvent.change(screen.getByLabelText("Passphrase"), {
      target: { value: "long-enough-passphrase" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Choose file" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Importing…" })).toBeDisabled());

    rerender(wrapWithProviders(<RoomKeyFilesCard enabled={false} />, client));
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Import keys" })).not.toBeInTheDocument();

    expect(screen.queryByRole("button", { name: "Close" })).not.toBeInTheDocument();
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
