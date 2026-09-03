import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
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

  it("refuses to apply a stale selection after the document changes", () => {
    const editor = setup();
    editor.commands.setContent("<p>new draft</p>");
    fireEvent.click(screen.getByRole("button", { name: "Apply link" }));
    expect(screen.getByRole("alert")).toHaveTextContent("The message changed");
    expect(editor.getHTML()).not.toContain("<a");
  });
});
