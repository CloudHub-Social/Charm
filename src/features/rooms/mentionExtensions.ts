import Mention from "@tiptap/extension-mention";
import { mergeAttributes } from "@tiptap/core";

/**
 * `@` user mentions. Renders as a `matrix.to` anchor (per the spec) rather
 * than the default plain `<span>` Mention ships with, so the sanitized
 * `formatted_body` carries a real Matrix permalink other clients can follow.
 */
/**
 * The bare Matrix id (`@alice:example.org`, `!room:example.org`) already
 * carries its own sigil — only a real display name needs one prepended, or
 * a label-less mention renders as e.g. `@@alice:example.org`.
 */
function pillText(sigil: string, label: string | null, id: string): string {
  return label ? `${sigil}${label}` : id;
}

/**
 * Reconstructs a mention node's `{id, label}` from its rendered anchor —
 * needed so a saved draft's HTML (e.g. from `useRoomDraft`, reloaded after
 * switching rooms and back) re-parses back into a real mention node instead
 * of collapsing to a plain link/text run, which would silently drop it from
 * `m.mentions` on the next send. `idPrefix` disambiguates user vs. room
 * anchors, since both share the same `data-mx-pill` marker.
 */
function parseMentionAnchor(idPrefix: string) {
  return (element: HTMLElement | string) => {
    if (typeof element === "string") return false;
    const href = element.getAttribute("href") ?? "";
    const id = href.replace("https://matrix.to/#/", "");
    if (!id.startsWith(idPrefix)) return false;
    const text = element.textContent ?? "";
    return { id, label: text === id ? null : text.replace(/^[@#]/, "") };
  };
}

export const UserMention = Mention.extend({
  name: "userMention",
  parseHTML() {
    return [{ tag: "a[data-mx-pill]", getAttrs: parseMentionAnchor("@") }];
  },
  renderHTML({ node, HTMLAttributes }) {
    const id = node.attrs.id as string;
    return [
      "a",
      mergeAttributes(HTMLAttributes, {
        href: `https://matrix.to/#/${id}`,
        "data-mx-pill": "true",
      }),
      pillText("@", node.attrs.label as string | null, id),
    ];
  },
}).configure({
  suggestion: { char: "@" },
});

/** `#` room mentions — same matrix.to-anchor rendering as {@link UserMention}. */
export const RoomMention = Mention.extend({
  name: "roomMention",
  parseHTML() {
    return [{ tag: "a[data-mx-pill]", getAttrs: parseMentionAnchor("!") }];
  },
  renderHTML({ node, HTMLAttributes }) {
    const id = node.attrs.id as string;
    return [
      "a",
      mergeAttributes(HTMLAttributes, {
        href: `https://matrix.to/#/${id}`,
        "data-mx-pill": "true",
      }),
      pillText("#", node.attrs.label as string | null, id),
    ];
  },
}).configure({
  suggestion: { char: "#" },
});
