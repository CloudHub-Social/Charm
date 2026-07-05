import Mention from "@tiptap/extension-mention";
import { mergeAttributes } from "@tiptap/core";

/**
 * `@` user mentions. Renders as a `matrix.to` anchor (per the spec) rather
 * than the default plain `<span>` Mention ships with, so the sanitized
 * `formatted_body` carries a real Matrix permalink other clients can follow.
 */
export const UserMention = Mention.extend({
  name: "userMention",
  renderHTML({ node, HTMLAttributes }) {
    const id = node.attrs.id as string;
    return [
      "a",
      mergeAttributes(HTMLAttributes, {
        href: `https://matrix.to/#/${id}`,
        "data-mx-pill": "true",
      }),
      `@${(node.attrs.label as string | null) ?? id}`,
    ];
  },
}).configure({
  suggestion: { char: "@" },
});

/** `#` room mentions — same matrix.to-anchor rendering as {@link UserMention}. */
export const RoomMention = Mention.extend({
  name: "roomMention",
  renderHTML({ node, HTMLAttributes }) {
    const id = node.attrs.id as string;
    return [
      "a",
      mergeAttributes(HTMLAttributes, {
        href: `https://matrix.to/#/${id}`,
        "data-mx-pill": "true",
      }),
      `#${(node.attrs.label as string | null) ?? id}`,
    ];
  },
}).configure({
  suggestion: { char: "#" },
});
