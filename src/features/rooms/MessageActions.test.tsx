import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { MessageActions } from "./MessageActions";

function renderActions(overrides: Partial<Parameters<typeof MessageActions>[0]> = {}) {
  const onReply = vi.fn();
  const onReact = vi.fn();
  const onEdit = vi.fn();
  const onDelete = vi.fn();
  const onCopy = vi.fn();

  render(
    <MessageActions
      isOwn={false}
      canRedact={false}
      onReply={onReply}
      onReact={onReact}
      onEdit={onEdit}
      onDelete={onDelete}
      onCopy={onCopy}
      {...overrides}
    />,
  );

  return { onReply, onReact, onEdit, onDelete, onCopy };
}

/** Radix's DropdownMenu opens on pointerdown, not click, in jsdom. */
function openMenu() {
  fireEvent.pointerDown(screen.getByRole("button", { name: "More actions" }), {
    button: 0,
    ctrlKey: false,
    pointerType: "mouse",
  });
}

describe("MessageActions", () => {
  it("shows Reply and Copy for a message that isn't own and can't be redacted", async () => {
    renderActions({ isOwn: false, canRedact: false });
    openMenu();

    expect(await screen.findByText("Reply")).toBeInTheDocument();
    expect(screen.getByText("Copy")).toBeInTheDocument();
    expect(screen.queryByText("Edit")).not.toBeInTheDocument();
    expect(screen.queryByText("Delete")).not.toBeInTheDocument();
  });

  it("shows Edit only when isOwn is true", async () => {
    renderActions({ isOwn: true, canRedact: false });
    openMenu();

    expect(await screen.findByText("Edit")).toBeInTheDocument();
  });

  it("shows Delete only when canRedact is true", async () => {
    renderActions({ isOwn: false, canRedact: true });
    openMenu();

    expect(await screen.findByText("Delete")).toBeInTheDocument();
  });

  it("shows both Edit and Delete for an own message the user can redact", async () => {
    renderActions({ isOwn: true, canRedact: true });
    openMenu();

    expect(await screen.findByText("Edit")).toBeInTheDocument();
    expect(screen.getByText("Delete")).toBeInTheDocument();
  });

  it("calls onReply when Reply is selected", async () => {
    const { onReply } = renderActions();
    openMenu();
    fireEvent.click(await screen.findByText("Reply"));

    expect(onReply).toHaveBeenCalledOnce();
  });

  it("calls onDelete when Delete is selected", async () => {
    const { onDelete } = renderActions({ canRedact: true });
    openMenu();
    fireEvent.click(await screen.findByText("Delete"));

    expect(onDelete).toHaveBeenCalledOnce();
  });

  it("has 44x44px hit targets for the trigger buttons", () => {
    renderActions();
    const moreButton = screen.getByRole("button", { name: "More actions" });
    const reactButton = screen.getByRole("button", { name: "React" });

    expect(moreButton.className).toContain("size-11");
    expect(reactButton.className).toContain("size-11");
  });

  it("disables relation actions (Reply/React/Edit/Delete) for a still-pending message", async () => {
    renderActions({ isOwn: true, canRedact: true, disableRelationActions: true });
    openMenu();

    expect(screen.getByRole("button", { name: "React" })).toBeDisabled();
    const reply = (await screen.findByText("Reply")).closest('[role="menuitem"]');
    const edit = screen.getByText("Edit").closest('[role="menuitem"]');
    const del = screen.getByText("Delete").closest('[role="menuitem"]');
    const copy = screen.getByText("Copy").closest('[role="menuitem"]');

    expect(reply).toHaveAttribute("data-disabled");
    expect(edit).toHaveAttribute("data-disabled");
    expect(del).toHaveAttribute("data-disabled");
    // Copy only needs the already-known body text, so it stays enabled even
    // on a pending message.
    expect(copy).not.toHaveAttribute("data-disabled");
  });
});
