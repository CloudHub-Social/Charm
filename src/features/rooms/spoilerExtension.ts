import { Mark, mergeAttributes } from "@tiptap/core";

/** Matrix-specific schema adapter using TipTap's maintained mark machinery.
 * Keep parsing active even when the toolbar flag is off: editing an existing
 * spoiler must not silently discard its concealment. The composer shows the
 * author's text with an explicit visual treatment; received content uses Spoiler.
 */
export const MatrixSpoiler = Mark.create({
  name: "matrixSpoiler",
  addAttributes() {
    return {
      reason: {
        default: "",
        parseHTML: (element) => element.getAttribute("data-mx-spoiler") ?? "",
        renderHTML: (attributes) => ({ "data-mx-spoiler": attributes.reason }),
      },
    };
  },
  parseHTML() {
    return [{ tag: "span[data-mx-spoiler]" }];
  },
  renderHTML({ HTMLAttributes }) {
    return [
      "span",
      mergeAttributes(HTMLAttributes, { class: "rounded bg-muted underline decoration-dotted" }),
      0,
    ];
  },
});
