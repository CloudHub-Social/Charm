import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { Editor } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import { ComposerLinkButton, composerLinkUrl } from "./ComposerLinkButton";

const editors: Editor[] = [];
afterEach(() => {
  cleanup();
  for (const editor of editors.splice(0)) editor.destroy();
});

function setup() {
  const editor = new Editor({ extensions: [StarterKit], content: "<p>hello</p>" });
  editors.push(editor);
  editor.commands.setTextSelection({ from: 1, to: 6 });
  render(<ComposerLinkButton editor={editor} />);
  fireEvent.click(screen.getByRole("button", { name: "Insert link" }));
  fireEvent.change(screen.getByLabelText("Link address"), {
    target: { value: "https://example.org" },
  });
  return editor;
}

describe("composer links", () => {
  it.each([
    "javascript:alert(1)",
    "data:text/html,hello",
    "/relative",
    "https://user:pass@example.org",
    "file:///private/test",
  ])("rejects unsafe or ambiguous address %s", (value) => {
    expect(composerLinkUrl(value)).toBeNull();
  });

  it.each([
    "https://example.org/",
    "http://example.org/",
    "mailto:friend@example.org",
    "tel:+15555555555",
  ])("accepts address %s", (value) => {
    expect(composerLinkUrl(value)).toBe(value);
  });

  it("links the original selection without replacing its text", () => {
    const editor = setup();
    fireEvent.click(screen.getByRole("button", { name: "Apply link" }));
    expect(editor.getHTML()).toContain('href="https://example.org/"');
    expect(editor.getText()).toBe("hello");
  });

  it("updates the existing link at a collapsed cursor without inserting text", () => {
    const editor = new Editor({
      extensions: [StarterKit],
      content: '<p><a href="https://old.example/">hello</a></p>',
    });
    editors.push(editor);
    editor.commands.setTextSelection(3);
    render(<ComposerLinkButton editor={editor} />);
    fireEvent.click(screen.getByRole("button", { name: "Insert link" }));
    fireEvent.change(screen.getByLabelText("Link address"), {
      target: { value: "https://new.example/" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Apply link" }));
    expect(editor.getText()).toBe("hello");
    expect(editor.getHTML()).toContain('href="https://new.example/"');
    expect(editor.getHTML()).not.toContain("old.example");
  });

  it("refuses to apply a stale selection after the document changes", () => {
    const editor = setup();
    editor.commands.setContent("<p>new draft</p>");
    fireEvent.click(screen.getByRole("button", { name: "Apply link" }));
    expect(screen.getByRole("alert")).toHaveTextContent("The message changed");
    expect(editor.getHTML()).not.toContain("<a");
  });

  it("closes on Escape without cancelling the surrounding composer edit", async () => {
    const cancelEdit = vi.fn();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") cancelEdit();
    };
    document.addEventListener("keydown", onKeyDown);
    try {
      const editor = setup();
      fireEvent.keyDown(screen.getByLabelText("Link address"), { key: "Escape" });
      await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
      expect(cancelEdit).not.toHaveBeenCalled();
      expect(editor.getText()).toBe("hello");
      expect(editor.getHTML()).not.toContain("<a");
    } finally {
      document.removeEventListener("keydown", onKeyDown);
    }
  });
});
