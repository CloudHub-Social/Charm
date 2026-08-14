import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type * as MatrixModule from "@/lib/matrix";
import { PollDialog } from "./PollDialog";

const createPoll = vi.fn();

vi.mock("@/lib/matrix", async () => {
  const actual = await vi.importActual<typeof MatrixModule>("@/lib/matrix");
  return { ...actual, createPoll: (...args: unknown[]) => createPoll(...args) };
});

beforeEach(() => {
  createPoll.mockReset().mockResolvedValue("txn-poll");
});

describe("PollDialog", () => {
  it("creates a disclosed poll from a question and two options", async () => {
    const onOpenChange = vi.fn();
    render(<PollDialog open roomId="!room:example.org" onOpenChange={onOpenChange} />);

    fireEvent.change(screen.getByLabelText("Question"), { target: { value: "Lunch?" } });
    fireEvent.change(screen.getByLabelText("Option 1"), { target: { value: "Pizza" } });
    fireEvent.change(screen.getByLabelText("Option 2"), { target: { value: "Tacos" } });
    fireEvent.click(screen.getByRole("button", { name: "Create poll" }));

    await waitFor(() =>
      expect(createPoll).toHaveBeenCalledWith(
        "!room:example.org",
        "Lunch?",
        ["Pizza", "Tacos"],
        true,
      ),
    );
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("rejects duplicate options before sending", () => {
    render(<PollDialog open roomId="!room:example.org" onOpenChange={vi.fn()} />);
    fireEvent.change(screen.getByLabelText("Question"), { target: { value: "Lunch?" } });
    fireEvent.change(screen.getByLabelText("Option 1"), { target: { value: "Pizza" } });
    fireEvent.change(screen.getByLabelText("Option 2"), { target: { value: "pizza" } });
    fireEvent.click(screen.getByRole("button", { name: "Create poll" }));

    expect(screen.getByRole("alert")).toHaveTextContent("Each option must be unique.");
    expect(createPoll).not.toHaveBeenCalled();
  });
});
