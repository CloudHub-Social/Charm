import { createRef } from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Composer, type ComposerHandle } from "./Composer";

vi.mock("@/lib/matrix", () => ({
  getRoomMembers: vi.fn().mockResolvedValue([]),
  listRooms: vi.fn().mockResolvedValue([]),
}));

// TipTap's `EditorInstanceManager` retains editor state independent of
// React's own unmount timing — without an explicit `cleanup()` between
// tests, the next test's `screen.getByLabelText` can still find the
// previous test's contenteditable node still attached, causing pasted text
// to accumulate across tests instead of starting from an empty doc.
afterEach(cleanup);

/** Simulates typing by pasting plain text into the contenteditable — jsdom
 * has no real IME/keypress-to-DOM-mutation pipeline, but ProseMirror's paste
 * handling is real DOM event handling that inserts clipboard text into the
 * doc, so this exercises the actual editor rather than a fake. */
function pasteText(editable: Element, text: string) {
  fireEvent.paste(editable, {
    clipboardData: {
      getData: (type: string) => (type === "text/plain" ? text : ""),
      types: ["text/plain"],
    },
  });
}

describe("Composer", () => {
  it("renders the formatting toolbar and an editable region", async () => {
    render(
      <Composer
        roomId="!room-1:example.org"
        mode="send"
        placeholder="Message general"
        onSubmit={vi.fn()}
        onSlashCommand={vi.fn()}
        onEscape={vi.fn()}
        onTypingInput={vi.fn()}
      />,
    );

    expect(screen.getByRole("toolbar", { name: "Formatting" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Bold/ })).toBeInTheDocument();
    await waitFor(() => expect(screen.getByLabelText("Message general")).toBeInTheDocument());
  });

  it("can collapse the formatting toolbar for a compact mobile composer", async () => {
    render(
      <Composer
        roomId="!room-mobile:example.org"
        mode="send"
        placeholder="Message"
        onSubmit={vi.fn()}
        onSlashCommand={vi.fn()}
        onEscape={vi.fn()}
        onTypingInput={vi.fn()}
        showFormattingToolbar={false}
      />,
    );

    expect(screen.queryByRole("toolbar", { name: "Formatting" })).not.toBeInTheDocument();
    await waitFor(() => expect(screen.getByLabelText("Message")).toBeInTheDocument());
  });

  it("does not render the autocomplete popover before any trigger is typed", () => {
    render(
      <Composer
        roomId="!room-2:example.org"
        mode="send"
        placeholder="Message general"
        onSubmit={vi.fn()}
        onSlashCommand={vi.fn()}
        onEscape={vi.fn()}
        onTypingInput={vi.fn()}
      />,
    );
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
  });

  it("submits on Enter with the typed plain text", async () => {
    const onSubmit = vi.fn();
    const ref = createRef<ComposerHandle>();
    render(
      <Composer
        ref={ref}
        roomId="!room-3:example.org"
        mode="send"
        placeholder="Message general"
        onSubmit={onSubmit}
        onSlashCommand={vi.fn()}
        onEscape={vi.fn()}
        onTypingInput={vi.fn()}
      />,
    );
    const editable = await waitFor(() => screen.getByLabelText("Message general"));
    pasteText(editable, "hello world");
    fireEvent.keyDown(editable, { key: "Enter" });

    expect(onSubmit).toHaveBeenCalledWith(
      expect.objectContaining({ body: "hello world", formattedBody: null }),
    );
  });

  it("does not submit on Shift+Enter", async () => {
    const onSubmit = vi.fn();
    render(
      <Composer
        roomId="!room-4:example.org"
        mode="send"
        placeholder="Message general"
        onSubmit={onSubmit}
        onSlashCommand={vi.fn()}
        onEscape={vi.fn()}
        onTypingInput={vi.fn()}
      />,
    );
    const editable = await waitFor(() => screen.getByLabelText("Message general"));
    pasteText(editable, "hello");
    fireEvent.keyDown(editable, { key: "Enter", shiftKey: true });

    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("routes a recognized slash command to onSlashCommand instead of onSubmit", async () => {
    const onSubmit = vi.fn();
    const onSlashCommand = vi.fn();
    render(
      <Composer
        roomId="!room-5:example.org"
        mode="send"
        placeholder="Message general"
        onSubmit={onSubmit}
        onSlashCommand={onSlashCommand}
        onEscape={vi.fn()}
        onTypingInput={vi.fn()}
      />,
    );
    const editable = await waitFor(() => screen.getByLabelText("Message general"));
    pasteText(editable, "/me waves");
    fireEvent.keyDown(editable, { key: "Enter" });

    expect(onSlashCommand).toHaveBeenCalledWith({ command: "me", args: ["waves"] });
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("resolves emoji shortcodes in slash-command args before parsing", async () => {
    const onSlashCommand = vi.fn();
    render(
      <Composer
        roomId="!room-12:example.org"
        mode="send"
        placeholder="Message general"
        onSubmit={vi.fn()}
        onSlashCommand={onSlashCommand}
        onEscape={vi.fn()}
        onTypingInput={vi.fn()}
      />,
    );
    const editable = await waitFor(() => screen.getByLabelText("Message general"));
    pasteText(editable, "/me :wave:");
    fireEvent.keyDown(editable, { key: "Enter" });

    expect(onSlashCommand).toHaveBeenCalledWith({ command: "me", args: ["👋"] });
  });

  it("does not submit an empty message on Enter", async () => {
    const onSubmit = vi.fn();
    render(
      <Composer
        roomId="!room-6:example.org"
        mode="send"
        placeholder="Message general"
        onSubmit={onSubmit}
        onSlashCommand={vi.fn()}
        onEscape={vi.fn()}
        onTypingInput={vi.fn()}
      />,
    );
    const editable = await waitFor(() => screen.getByLabelText("Message general"));
    fireEvent.keyDown(editable, { key: "Enter" });
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("calls onEscape when Escape is pressed and no menu is open", async () => {
    const onEscape = vi.fn();
    render(
      <Composer
        roomId="!room-7:example.org"
        mode="send"
        placeholder="Message general"
        onSubmit={vi.fn()}
        onSlashCommand={vi.fn()}
        onEscape={onEscape}
        onTypingInput={vi.fn()}
      />,
    );
    fireEvent.keyDown(document, { key: "Escape" });
    expect(onEscape).toHaveBeenCalled();
  });

  it("calls onTypingInput as the user types", async () => {
    const onTypingInput = vi.fn();
    render(
      <Composer
        roomId="!room-8:example.org"
        mode="send"
        placeholder="Message general"
        onSubmit={vi.fn()}
        onSlashCommand={vi.fn()}
        onEscape={vi.fn()}
        onTypingInput={onTypingInput}
      />,
    );
    const editable = await waitFor(() => screen.getByLabelText("Message general"));
    pasteText(editable, "hi");
    expect(onTypingInput).toHaveBeenCalled();
  });

  it("exposes an imperative submit() the parent's Send button can call", async () => {
    const onSubmit = vi.fn();
    const ref = createRef<ComposerHandle>();
    render(
      <Composer
        ref={ref}
        roomId="!room-9:example.org"
        mode="send"
        placeholder="Message general"
        onSubmit={onSubmit}
        onSlashCommand={vi.fn()}
        onEscape={vi.fn()}
        onTypingInput={vi.fn()}
      />,
    );
    const editable = await waitFor(() => screen.getByLabelText("Message general"));
    pasteText(editable, "hello");
    ref.current?.submit();
    expect(onSubmit).toHaveBeenCalledWith(expect.objectContaining({ body: "hello" }));
  });

  it("unescapes a leading // to a literal / instead of running it as a command", async () => {
    const onSubmit = vi.fn();
    const onSlashCommand = vi.fn();
    render(
      <Composer
        roomId="!room-11:example.org"
        mode="send"
        placeholder="Message general"
        onSubmit={onSubmit}
        onSlashCommand={onSlashCommand}
        onEscape={vi.fn()}
        onTypingInput={vi.fn()}
      />,
    );
    const editable = await waitFor(() => screen.getByLabelText("Message general"));
    pasteText(editable, "//usr/bin/env");
    fireEvent.keyDown(editable, { key: "Enter" });

    expect(onSlashCommand).not.toHaveBeenCalled();
    expect(onSubmit).toHaveBeenCalledWith(expect.objectContaining({ body: "/usr/bin/env" }));
  });

  it("preloads initialHtml in edit mode", async () => {
    render(
      <Composer
        roomId="!room-10:example.org"
        mode="edit"
        initialHtml="<p><strong>bold text</strong></p>"
        placeholder="Edit message"
        onSubmit={vi.fn()}
        onSlashCommand={vi.fn()}
        onEscape={vi.fn()}
        onTypingInput={vi.fn()}
      />,
    );
    expect(await screen.findByText("bold text")).toBeInTheDocument();
  });
});
