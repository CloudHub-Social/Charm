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

function isValidMatrixId(id: string, sigil: string): boolean {
  if (!id.startsWith(sigil)) return false;
  const separator = id.indexOf(":", 1);
  if (separator <= 1) return false;
  const localpart = id.slice(1, separator);
  const serverName = id.slice(separator + 1);
  const invalidLocalpart = Array.from(localpart).some(
    (character) => character === ":" || /\s/u.test(character) || character.charCodeAt(0) <= 0x1f,
  );
  const invalidServerName = Array.from(serverName).some(
    (character) => /\s/u.test(character) || character.charCodeAt(0) <= 0x1f,
  );
  // URL parsing normalizes `https://example.org:` to `https://example.org/`,
  // but Matrix's `server-name = host [ ":" port ]` requires at least one
  // port digit when the separator is present. Check the source spelling
  // before URL normalization can erase that malformed empty port.
  if (!serverName || serverName.endsWith(":") || invalidLocalpart || invalidServerName)
    return false;
  try {
    const parsed = new URL(`https://${serverName}`);
    return (
      parsed.hostname.length > 0 &&
      parsed.username === "" &&
      parsed.password === "" &&
      parsed.pathname === "/" &&
      parsed.search === "" &&
      parsed.hash === ""
    );
  } catch {
    return false;
  }
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
    const permalinkPrefix = "https://matrix.to/#/";
    if (!href.startsWith(permalinkPrefix)) return false;
    const fragment = href.slice(permalinkPrefix.length);
    const rawServerSeparator = fragment.indexOf(":", 1);
    const parameterSeparator = fragment.indexOf(
      "?",
      rawServerSeparator >= 0 ? rawServerSeparator + 1 : 0,
    );
    const withoutParameters =
      parameterSeparator >= 0 ? fragment.slice(0, parameterSeparator) : fragment;
    let id = "";
    for (const candidate of [fragment, withoutParameters]) {
      try {
        const decoded = decodeURIComponent(candidate);
        if (isValidMatrixId(decoded, idPrefix)) {
          id = decoded;
          break;
        }
      } catch {
        // Try the query-stripped legacy spelling next.
      }
    }
    if (!id) return false;
    const text = element.textContent ?? "";
    return { id, label: text === id ? null : text.replace(/^[@#]/, "") };
  };
}

function encodeMatrixIdForPermalink(id: string): string {
  // `encodeURIComponent` deliberately leaves `!` unescaped, but Matrix
  // permalinks use an encoded sigil consistently for both user and room IDs.
  return encodeURIComponent(id).replaceAll("!", "%21");
}

export const UserMention = Mention.extend({
  name: "userMention",
  // StarterKit's generic Link mark parses anchors at priority 1000. Matrix
  // pills are a more specific node shape and must win before that fallback.
  priority: 1100,
  parseHTML() {
    return [
      {
        // Match the stable pill marker and validate/decode the href in
        // getAttrs. URL fragments and percent-encoded sigils are not
        // matched consistently by every DOMParser/CSS-selector path used by
        // ProseMirror clipboard parsing, which previously collapsed a pasted
        // pill to its display label before slash-command dispatch.
        tag: "a[data-mx-pill]",
        priority: 1200,
        getAttrs: parseMentionAnchor("@"),
      },
    ];
  },
  // `editor.getText()`'s plain `body` must carry the real Matrix id, not the
  // display label the pill shows — a plain-text client has no other way to
  // resolve "Alice" back to a specific `@alice:example.org`, and two members
  // can share a display name.
  renderText({ node }) {
    return node.attrs.id as string;
  },
  renderHTML({ node, HTMLAttributes }) {
    const id = node.attrs.id as string;
    return [
      "a",
      mergeAttributes(HTMLAttributes, {
        href: `https://matrix.to/#/${encodeMatrixIdForPermalink(id)}`,
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
  priority: 1100,
  parseHTML() {
    return [
      {
        tag: "a[data-mx-pill]",
        priority: 1200,
        getAttrs: parseMentionAnchor("!"),
      },
    ];
  },
  renderText({ node }) {
    return node.attrs.id as string;
  },
  renderHTML({ node, HTMLAttributes }) {
    const id = node.attrs.id as string;
    return [
      "a",
      mergeAttributes(HTMLAttributes, {
        href: `https://matrix.to/#/${encodeMatrixIdForPermalink(id)}`,
        "data-mx-pill": "true",
      }),
      pillText("#", node.attrs.label as string | null, id),
    ];
  },
}).configure({
  suggestion: { char: "#" },
});
