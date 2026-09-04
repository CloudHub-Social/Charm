import { createRef } from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type * as FeatureFlagsModule from "@/featureFlags";
import { Composer, type ComposerHandle } from "./Composer";

const flags = vi.hoisted(() => ({ composerParity: false }));
vi.mock("@/featureFlags", async (importOriginal) => {
  const actual = await importOriginal<typeof FeatureFlagsModule>();
  return {
    ...actual,
    useFlag: (key: Parameters<typeof actual.useFlag>[0]) =>
      key === "composer_parity" ? flags.composerParity : actual.useFlag(key),
  };
});
beforeEach(() => {
  flags.composerParity = false;
});

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
  it("dispatches message slash commands while replying", async () => {
    flags.composerParity = true;
    const onSlashCommand = vi.fn().mockResolvedValue(true);
    const onSubmit = vi.fn();
    render(
      <Composer
        roomId="!reply-command:example.org"
        mode="reply"
        placeholder="Reply"
        onSubmit={onSubmit}
        onSlashCommand={onSlashCommand}
        onEscape={vi.fn()}
        onTypingInput={vi.fn()}
      />,
    );
    const editable = await screen.findByLabelText("Reply");
    pasteText(editable, "/plain reply body");
    fireEvent.keyDown(editable, { key: "Enter" });
    await waitFor(() => expect(onSlashCommand).toHaveBeenCalled());
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it.each(["unban", "ignore", "unignore"])(
    "resolves mention IDs for /%s in replies",
    async (command) => {
      flags.composerParity = true;
      const onSlashCommand = vi.fn();
      render(
        <Composer
          roomId={`!reply-${command}:example.org`}
          mode="reply"
          placeholder="Reply"
          onSubmit={vi.fn()}
          onSlashCommand={onSlashCommand}
          onEscape={vi.fn()}
          onTypingInput={vi.fn()}
        />,
      );
      const editable = await screen.findByLabelText("Reply");
      fireEvent.paste(editable, {
        clipboardData: {
          getData: (type: string) =>
            type === "text/html"
              ? `<p>/${command} <a data-mx-pill="true" href="https://matrix.to/#/@alice:example.org">Alice</a></p>`
              : `/${command} Alice`,
          types: ["text/html", "text/plain"],
        },
      });
      fireEvent.keyDown(editable, { key: "Enter" });
      await waitFor(() =>
        expect(onSlashCommand).toHaveBeenCalledWith({
          command,
          args: ["@alice:example.org"],
          action: true,
        }),
      );
    },
  );

  it.each([
    ["Spoiler", "span[data-mx-spoiler]"],
    ["Strikethrough", "s"],
    ["Code block", "pre"],
  ])(
    "stops active %s formatting on kill switch without stripping the draft",
    async (label, selector) => {
      flags.composerParity = true;
      const props = {
        roomId: `!kill-${label.replaceAll(" ", "-")}:example.org`,
        mode: "send" as const,
        placeholder: "Message",
        onSubmit: vi.fn(),
        onSlashCommand: vi.fn(),
        onEscape: vi.fn(),
        onTypingInput: vi.fn(),
      };
      const view = render(<Composer {...props} />);
      const editable = await screen.findByLabelText("Message");
      fireEvent.click(screen.getByRole("button", { name: label, exact: true }));
      pasteText(editable, "authored");
      expect(editable.querySelector(selector)).toHaveTextContent("authored");
      flags.composerParity = false;
      view.rerender(<Composer {...props} />);
      pasteText(editable, "new text");
      expect(editable.querySelector(selector)).toHaveTextContent("authored");
      expect(editable.querySelector(selector)).not.toHaveTextContent("new text");
      expect(editable).toHaveTextContent("new text");
    },
  );
  it("edits on bare ArrowUp only while the send composer is truly empty", async () => {
    const onEditLastMessage = vi.fn(() => true);
    render(
      <Composer
        roomId="!arrow-up:example.org"
        mode="send"
        placeholder="Message"
        onSubmit={vi.fn()}
        onSlashCommand={vi.fn()}
        onEscape={vi.fn()}
        onTypingInput={vi.fn()}
        onEditLastMessage={onEditLastMessage}
      />,
    );
    const editable = await screen.findByLabelText("Message");
    for (const modifier of ["shiftKey", "ctrlKey", "altKey", "metaKey", "isComposing"]) {
      fireEvent.keyDown(editable, { key: "ArrowUp", [modifier]: true });
    }
    expect(onEditLastMessage).not.toHaveBeenCalled();
    expect(fireEvent.keyDown(editable, { key: "ArrowUp" })).toBe(false);
    expect(onEditLastMessage).toHaveBeenCalledOnce();
    onEditLastMessage.mockClear();
    pasteText(editable, "draft");
    fireEvent.keyDown(editable, { key: "ArrowUp" });
    expect(onEditLastMessage).not.toHaveBeenCalled();
    expect(editable).toHaveTextContent("draft");
  });

  it.each(["reply", "edit"] as const)(
    "does not replace an empty %s composer on ArrowUp",
    async (mode) => {
      const onEditLastMessage = vi.fn(() => true);
      render(
        <Composer
          roomId={`!arrow-up-${mode}:example.org`}
          mode={mode}
          placeholder="Message"
          onSubmit={vi.fn()}
          onSlashCommand={vi.fn()}
          onEscape={vi.fn()}
          onTypingInput={vi.fn()}
          onEditLastMessage={onEditLastMessage}
        />,
      );
      fireEvent.keyDown(await screen.findByLabelText("Message"), { key: "ArrowUp" });
      expect(onEditLastMessage).not.toHaveBeenCalled();
    },
  );

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
    expect(screen.getByLabelText("Message general")).toHaveAttribute("spellcheck", "false");
  });

  it("updates native spellcheck on rollout and kill switch without losing the draft", async () => {
    const props = {
      roomId: "!spellcheck:example.org",
      mode: "send" as const,
      placeholder: "Message",
      onSubmit: vi.fn(),
      onSlashCommand: vi.fn(),
      onEscape: vi.fn(),
      onTypingInput: vi.fn(),
    };
    const view = render(<Composer {...props} />);
    const editable = await screen.findByLabelText("Message");
    expect(editable).toHaveAttribute("spellcheck", "false");
    pasteText(editable, "retained draft");
    flags.composerParity = true;
    view.rerender(<Composer {...props} />);
    await waitFor(() => expect(editable).toHaveAttribute("spellcheck", "true"));
    flags.composerParity = false;
    view.rerender(<Composer {...props} />);
    await waitFor(() => expect(editable).toHaveAttribute("spellcheck", "false"));
    expect(editable).toHaveTextContent("retained draft");
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

  it("updates its placeholder without discarding an in-progress message", async () => {
    const props = {
      roomId: "!room-responsive:example.org",
      mode: "send" as const,
      onSubmit: vi.fn(),
      onSlashCommand: vi.fn(),
      onEscape: vi.fn(),
      onTypingInput: vi.fn(),
    };
    const view = render(<Composer {...props} placeholder="Message General" />);
    await waitFor(() => screen.getByLabelText("Message General"));

    view.rerender(<Composer {...props} placeholder="Message" />);

    const mobileEditable = await waitFor(() => screen.getByLabelText("Message"));
    expect(mobileEditable).toHaveAttribute("placeholder", "Message");
    expect(mobileEditable.querySelector("[data-placeholder='Message']")).toBeInTheDocument();
    expect(props.onTypingInput).not.toHaveBeenCalled();

    pasteText(mobileEditable, "draft survives rotation");
    expect(props.onTypingInput).toHaveBeenCalledOnce();
    view.rerender(<Composer {...props} placeholder="Message General" />);

    expect(await screen.findByLabelText("Message General")).toHaveTextContent(
      "draft survives rotation",
    );
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
