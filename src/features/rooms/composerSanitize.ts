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
  "class",
];

/**
 * Sanitizes untrusted HTML (either the composer's own `getHTML()` output
 * before send, or an incoming event's `formatted_body` before render)
 * against the Matrix-permitted tag/attr allowlist. Strips everything else —
 * including `<script>`, event-handler attributes (`onerror`, etc.), and
 * `javascript:`/`data:` URLs in `href`/`src` (DOMPurify's default URL
 * sanitization already blocks these; the allowlist above is the extra,
 * Matrix-specific restriction).
 */
export function sanitizeMatrixHtml(dirtyHtml: string): string {
  return DOMPurify.sanitize(dirtyHtml, {
    ALLOWED_TAGS,
    ALLOWED_ATTR,
    ALLOW_DATA_ATTR: false,
  });
}
