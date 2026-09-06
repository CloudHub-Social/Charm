import { Editor } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";
import { afterEach, describe, expect, it } from "vitest";
import { serializeComposerContent } from "./composerSerialize";
import { MatrixSpoiler } from "./spoilerExtension";

const editors: Editor[] = [];
afterEach(() => {
  for (const editor of editors.splice(0)) editor.destroy();
});

function editorFor(content: string) {
  const editor = new Editor({ extensions: [StarterKit, MatrixSpoiler], content });
  editors.push(editor);
  return editor;
}

describe("MatrixSpoiler", () => {
  it("toggles a selected spoiler and serializes the Matrix wire mark", () => {
    const editor = editorFor("<p>secret</p>");
    editor.chain().setTextSelection({ from: 1, to: 7 }).toggleMark("matrixSpoiler").run();
    const serialized = serializeComposerContent(editor.getHTML(), editor.getText());
    expect(serialized.body).toBe("secret");
    expect(serialized.formattedBody).toBe('<p><span data-mx-spoiler="">secret</span></p>');
    editor.commands.toggleMark("matrixSpoiler");
    expect(serializeComposerContent(editor.getHTML(), editor.getText()).formattedBody).toBeNull();
  });

  it("preserves spoiler reasons and nested formatting through draft/edit round trips", () => {
    const editor = editorFor(
      '<p><span data-mx-spoiler="plot &amp; twist"><strong>secret</strong></span></p>',
    );
    const html = serializeComposerContent(editor.getHTML(), editor.getText()).formattedBody!;
    const restored = editorFor(html);
    const span = new DOMParser()
      .parseFromString(restored.getHTML(), "text/html")
      .querySelector("span");
    expect(span?.getAttribute("data-mx-spoiler")).toBe("plot & twist");
    expect(restored.getHTML()).toContain("<strong>");
    expect(restored.getText()).toBe("secret");
  });

  it("does not turn ordinary spans into spoilers", () => {
    const editor = editorFor("<p><span>ordinary text</span></p>");
    expect(editor.getHTML()).not.toContain("data-mx-spoiler");
    expect(serializeComposerContent(editor.getHTML(), editor.getText()).formattedBody).toBeNull();
  });
});
