import { find } from "linkifyjs";

/**
 * Returns the first http(s) URL found in `text`, or `null` if none.
 * Charm 1.0 parity: only the first URL in a message gets a preview card,
 * matching Matrix client conventions generally. Uses `linkifyjs`'s `find` —
 * the same URL-detection engine `RichMessageContent` already uses via
 * `linkify-react` for the plain-text message body — so a preview is offered
 * for exactly the URLs that already render as clickable links.
 *
 * `find(text, "url")` matches any URL scheme linkify recognizes (`ftp://`,
 * `file://`, etc.), not just http(s) — the homeserver's `/preview_url`
 * endpoint only makes sense for a fetchable web page, so a non-http(s) match
 * is skipped in favor of the first http(s) one instead of being returned (or
 * silently sent to `get_url_preview` as a doomed request that also blocks a
 * real, later http(s) URL from getting its own preview).
 */
export function firstUrlInText(text: string): string | null {
  const matches = find(text, "url");
  const httpMatch = matches.find((match) => {
    try {
      const protocol = new URL(match.href).protocol;
      return protocol === "http:" || protocol === "https:";
    } catch {
      return false;
    }
  });
  return httpMatch?.href ?? null;
}
