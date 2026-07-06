import { sanitizeMatrixHtml } from "./composerSanitize";

export interface SerializedComposerContent {
  body: string;
  formattedBody: string | null;
  mentions: string[] | null;
}

/**
 * TipTap always wraps even plain text in a `<p>` (and inserts `<br>` for
 * soft line breaks) — so a message with zero real formatting still arrives
 * here as e.g. `<p>hello</p>`. Stripping just those two structural tags
 * before checking for any remaining tag is what distinguishes "genuinely
 * unformatted" (send `text_plain` only) from "actually has a `<strong>`/
 * `<em>`/list/etc." (send `formatted_body` too) — per the spec's acceptance
 * criterion that an unformatted message must not carry a wasteful
 * `formatted_body`.
 */
function hasRealFormatting(sanitizedHtml: string): boolean {
  const stripped = sanitizedHtml.replace(/<\/?p>/gi, "").replace(/<br\s*\/?>/gi, "");
  return /<[a-z]/i.test(stripped);
}

/**
 * Turns a TipTap editor's raw `getHTML()`/`getText()` output into the
 * Matrix wire shape: a sanitized `formattedBody` (or `null` when the
 * message has no real formatting, per {@link hasRealFormatting}) plus the
 * plain `body`. `rawHtml` is sanitized against the Matrix-permitted
 * allowlist here — this is the one place on the send path that gate runs,
 * so every caller (real editor, tests, future callers) gets it for free
 * rather than needing to remember to call it themselves.
 */
export function serializeComposerContent(
  rawHtml: string,
  plainText: string,
  mentionUserIds: string[] = [],
): SerializedComposerContent {
  const sanitized = sanitizeMatrixHtml(rawHtml);
  const formattedBody = hasRealFormatting(sanitized) ? sanitized : null;

  return {
    body: plainText,
    formattedBody,
    mentions: mentionUserIds.length > 0 ? mentionUserIds : null,
  };
}
