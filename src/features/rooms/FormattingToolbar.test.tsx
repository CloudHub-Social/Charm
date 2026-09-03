import { fireEvent, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Editor } from "@tiptap/react";
import { FormattingToolbar } from "./FormattingToolbar";

const flags = vi.hoisted(() => ({ fullEmojiPicker: false, composerParity: false }));

vi.mock("@/featureFlags", () => ({
  useFlag: (key: string) =>
    (key === "full_emoji_picker" && flags.fullEmojiPicker) ||
    (key === "composer_parity" && flags.composerParity),
}));

vi.mock("./EmojiPicker", () => ({
  EmojiPicker: ({
    children,
    onSelect,
  }: {
    children: ReactNode;
    onSelect: (emoji: string) => void;
  }) => (
    <div>
      {children}
      <button type="button" onClick={() => onSelect("🧭")}>
        Choose test emoji
      </button>
    </div>
  ),
}));

/** A minimal fake covering only what `FormattingToolbar` calls. */
function fakeEditor(activeMarks: Set<string> = new Set()): Editor {
  const run = vi.fn();
  const chainable = {
    focus: () => chainable,
    toggleBold: () => chainable,
    toggleItalic: () => chainable,
    toggleCode: () => chainable,
    toggleStrike: vi.fn(() => chainable),
    toggleCodeBlock: vi.fn(() => chainable),
    toggleBlockquote: () => chainable,
    toggleBulletList: () => chainable,
    toggleOrderedList: () => chainable,
    insertContent: vi.fn(() => chainable),
    run,
  };
  return {
    isActive: (name: string) => activeMarks.has(name),
    chain: () => chainable,
  } as unknown as Editor;
}

describe("FormattingToolbar", () => {
  beforeEach(() => {
    flags.fullEmojiPicker = false;
    flags.composerParity = false;
  });

  it("renders a disabled toolbar when there is no editor yet", () => {
    render(<FormattingToolbar editor={null} />);
    expect(screen.getByRole("button", { name: /Bold/ })).toBeDisabled();
  });

  it("keeps extended formatting hidden until enabled", () => {
    render(<FormattingToolbar editor={fakeEditor()} />);
    expect(screen.queryByRole("button", { name: "Strikethrough" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Code block" })).not.toBeInTheDocument();
  });

  it("dispatches distinct strike and code-block commands when enabled", () => {
    flags.composerParity = true;
    const editor = fakeEditor(new Set(["strike", "codeBlock"]));
    render(<FormattingToolbar editor={editor} />);
    fireEvent.click(screen.getByRole("button", { name: "Strikethrough" }));
    fireEvent.click(screen.getByRole("button", { name: "Code block" }));
    expect(editor.chain().toggleStrike).toHaveBeenCalledOnce();
    expect(editor.chain().toggleCodeBlock).toHaveBeenCalledOnce();
    expect(screen.getByRole("button", { name: "Code block" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
  });

  it("reflects active marks via aria-pressed", () => {
    render(<FormattingToolbar editor={fakeEditor(new Set(["bold"]))} />);
    expect(screen.getByRole("button", { name: /Bold/ })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("button", { name: /Italic/ })).toHaveAttribute("aria-pressed", "false");
  });

  it("toggles bold when clicked", () => {
    const editor = fakeEditor();
    render(<FormattingToolbar editor={editor} />);
    fireEvent.click(screen.getByRole("button", { name: /Bold/ }));
    expect(editor.chain().focus().toggleBold().run).toHaveBeenCalled();
  });

  it("toggles every formatting command when clicked", () => {
    const editor = fakeEditor();
    render(<FormattingToolbar editor={editor} />);
    for (const name of [/Italic/, /Inline code/, /Block quote/, /Bulleted list/, /Numbered list/]) {
      fireEvent.click(screen.getByRole("button", { name }));
    }
    expect(editor.chain().focus().toggleItalic().run).toHaveBeenCalled();
  });

  it("inserts a selected emoji at the editor cursor when the flag is enabled", () => {
    flags.fullEmojiPicker = true;
    const editor = fakeEditor();
    render(<FormattingToolbar editor={editor} />);

    fireEvent.click(screen.getByRole("button", { name: "Choose test emoji" }));

    expect(editor.chain().focus().insertContent).toHaveBeenCalledWith("🧭");
    expect(editor.chain().run).toHaveBeenCalled();
  });

  it("does not expose the composer picker while the flag is disabled", () => {
    render(<FormattingToolbar editor={fakeEditor()} />);
    expect(screen.queryByRole("button", { name: "Insert emoji" })).not.toBeInTheDocument();
  });
});
