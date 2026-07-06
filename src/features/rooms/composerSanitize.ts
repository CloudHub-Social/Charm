import DOMPurify from "dompurify";

/**
 * Strict allowlist matching the Matrix spec's permitted HTML subset for
 * `formatted_body` (https://spec.matrix.org/latest/client-server-api/#mroommessage-msgtypes),
 * used on BOTH the send path (`serializeComposerContent`, below) and the
 * render path (wherever an incoming `formatted_body` is displayed) — the
 * editor producing only "nice" HTML is not a security boundary, so both
 * directions run through this same allowlist rather than trusting one side.
 */
const ALLOWED_TAGS = [
  "font",
  "del",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "blockquote",
  "p",
  "a",
  "ul",
  "ol",
  "sup",
  "sub",
  "li",
  "b",
  "i",
  "u",
  "strong",
  "em",
  "strike",
  "s",
  "code",
  "hr",
  "br",
  "div",
  "table",
  "thead",
  "tbody",
  "tr",
  "th",
  "td",
  "caption",
  "pre",
  "span",
  "img",
  "details",
  "summary",
];

const ALLOWED_ATTR = [
  "href",
  "name",
  "target",
  "src",
  "alt",
  "width",
  "height",
  "data-mx-color",
  "data-mx-bg-color",
  "data-mx-spoiler",
  "data-mx-pill",
];

// `<img>` is otherwise-allowed spec HTML, but per the Matrix spec its `src`
// must be an `mxc://` URI, not an arbitrary URL — this app has no `mxc://`
// resolver wired into the render path yet (that's `resolve_media`'s job,
// gated on the event/room context this sanitizer doesn't have), so any
// `https://...` src would otherwise have the WebView fetch it directly,
// leaking the viewer's IP/activity to whatever URL a remote sender chose
// (and rendering non-Matrix content that isn't actually a Matrix image).
// Registered once at module load — DOMPurify hooks are global to the
// imported instance, and this is the only place in the app that uses it.
DOMPurify.addHook("uponSanitizeAttribute", (node, data) => {
  if (node.nodeName.toLowerCase() === "img" && data.attrName === "src") {
    if (!data.attrValue.startsWith("mxc://")) {
      data.keepAttr = false;
    }
  }
});

/**
 * Sanitizes untrusted HTML (either the composer's own `getHTML()` output
 * before send, or an incoming event's `formatted_body` before render)
 * against the Matrix-permitted tag/attr allowlist. Strips everything else —
 * including `<script>`, event-handler attributes (`onerror`, etc.), and
 * `javascript:`/`data:` URLs in `href`/`src` (DOMPurify's default URL
 * sanitization already blocks these; the allowlist above is the extra,
 * Matrix-specific restriction). `class` is deliberately not allowlisted:
 * the Matrix formatted-body subset has no notion of arbitrary CSS classes,
 * and allowing it would let a remote `formatted_body` apply this app's own
 * Tailwind utilities (e.g. `fixed inset-0 z-50`) inside the bubble.
 */
export function sanitizeMatrixHtml(dirtyHtml: string): string {
  return DOMPurify.sanitize(dirtyHtml, {
    ALLOWED_TAGS,
    ALLOWED_ATTR,
    // DOMPurify's default URI scheme allowlist has no notion of `mxc://` —
    // extend it (rather than disabling URI validation) so an `mxc://` `src`
    // survives to reach the `uponSanitizeAttribute` hook above, which is the
    // thing actually enforcing "only mxc://" for `<img>`.
    ALLOWED_URI_REGEXP: /^(?:(?:https?|mailto|tel|mxc):|[^a-z]|[a-z+.-]+(?:[^a-z+.\-:]|$))/i,
  });
}

/**
 * Escapes plain text for safe use as TipTap `content` HTML — needed when
 * preloading a message's plain `body` (not `formatted_body`) into the edit
 * composer: TipTap parses its `content` prop as HTML, so an unformatted
 * message containing literal markup (`<b>hi</b>`, `<img onerror=...>`)
 * would otherwise be interpreted as real formatting/markup the moment edit
 * mode opens, before the user has touched anything. Converts `\n` to `<br>`
 * after escaping — a raw newline in an HTML string is collapsible
 * whitespace, so a plain multi-line message (sent via Shift+Enter) would
 * otherwise lose its line breaks the moment it's reopened for editing.
 */
export function escapeHtmlText(text: string): string {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;")
    .replaceAll("\n", "<br>");
}
