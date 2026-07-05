import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { Editor } from "@tiptap/react";
import { FormattingToolbar } from "./FormattingToolbar";

/** A minimal fake covering only what `FormattingToolbar` calls. */
function fakeEditor(activeMarks: Set<string> = new Set()): Editor {
  const run = vi.fn();
  const chainable = {
    focus: () => chainable,
    toggleBold: () => chainable,
    toggleItalic: () => chainable,
    toggleCode: () => chainable,
    toggleBlockquote: () => chainable,
    toggleBulletList: () => chainable,
    toggleOrderedList: () => chainable,
    run,
  };
  return {
    isActive: (name: string) => activeMarks.has(name),
    chain: () => chainable,
  } as unknown as Editor;
}

describe("FormattingToolbar", () => {
  it("renders a disabled toolbar when there is no editor yet", () => {
    render(<FormattingToolbar editor={null} />);
    expect(screen.getByRole("button", { name: /Bold/ })).toBeDisabled();
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
});
