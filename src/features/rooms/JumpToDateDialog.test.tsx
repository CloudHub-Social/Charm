import { act, fireEvent, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type * as MatrixModule from "@/lib/matrix";
import { renderWithProviders } from "@/test/renderWithProviders";
import { JumpToDateDialog } from "./JumpToDateDialog";

const getEventAtTimestamp = vi.fn();

vi.mock("@/lib/matrix", async (importOriginal) => ({
  ...(await importOriginal<typeof MatrixModule>()),
  getEventAtTimestamp: (...args: unknown[]) => getEventAtTimestamp(...args),
}));

describe("JumpToDateDialog", () => {
  it("resolves local midnight forward and closes after finding an event", async () => {
    getEventAtTimestamp.mockResolvedValue("$target:example.org");
    const onResolved = vi.fn();
    const onOpenChange = vi.fn();
    renderWithProviders(
      <JumpToDateDialog
        open
        roomId="!room:example.org"
        onOpenChange={onOpenChange}
        onResolved={onResolved}
      />,
    );

    fireEvent.change(screen.getByLabelText("Date"), { target: { value: "2025-02-03" } });
    await act(async () => screen.getByRole("button", { name: "Jump" }).click());

    expect(getEventAtTimestamp).toHaveBeenCalledWith(
      "!room:example.org",
      new Date("2025-02-03T00:00:00").getTime(),
      "forward",
    );
    expect(onResolved).toHaveBeenCalledWith({
      eventId: "$target:example.org",
      timestampMs: new Date("2025-02-03T00:00:00").getTime(),
    });
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("ignores a lookup that resolves after the dialog closes", async () => {
    let resolveLookup: ((eventId: string) => void) | undefined;
    getEventAtTimestamp.mockReturnValue(
      new Promise((resolve) => {
        resolveLookup = resolve;
      }),
    );
    const onResolved = vi.fn();
    const onOpenChange = vi.fn();
    renderWithProviders(
      <JumpToDateDialog
        open
        roomId="!room:example.org"
        onOpenChange={onOpenChange}
        onResolved={onResolved}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Jump" }));
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    await act(async () => resolveLookup?.("$late:example.org"));

    expect(onResolved).not.toHaveBeenCalled();
  });

  it("ignores a lookup that resolves after the dialog unmounts", async () => {
    let resolveLookup: ((eventId: string) => void) | undefined;
    getEventAtTimestamp.mockReturnValue(
      new Promise((resolve) => {
        resolveLookup = resolve;
      }),
    );
    const onResolved = vi.fn();
    const { unmount } = renderWithProviders(
      <JumpToDateDialog
        open
        roomId="!room:example.org"
        onOpenChange={vi.fn()}
        onResolved={onResolved}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Jump" }));
    unmount();
    await act(async () => resolveLookup?.("$late:example.org"));

    expect(onResolved).not.toHaveBeenCalled();
  });

  it("shows a bounded error when the server has no event near the date", async () => {
    getEventAtTimestamp.mockRejectedValue(new Error("server detail"));
    renderWithProviders(
      <JumpToDateDialog
        open
        roomId="!room:example.org"
        onOpenChange={vi.fn()}
        onResolved={vi.fn()}
      />,
    );

    await act(async () => screen.getByRole("button", { name: "Jump" }).click());

    expect(screen.getByRole("alert")).toHaveTextContent(
      "No message was found on or after that date.",
    );
    expect(screen.getByRole("alert")).not.toHaveTextContent("server detail");
  });
});
