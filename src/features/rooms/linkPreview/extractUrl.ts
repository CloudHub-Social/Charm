import { find } from "linkifyjs";

/**
 * Returns the first http(s) URL found in `text`, or `null` if none.
 * Charm 1.0 parity: only the first URL in a message gets a preview card,
 * matching Matrix client conventions generally. Uses `linkifyjs`'s `find` —
 * the same URL-detection engine `RichMessageContent` already uses via
 * `linkify-react` for the plain-text message body — so a preview is offered
 * for exactly the URLs that already render as clickable links.
 */
export function firstUrlInText(text: string): string | null {
  const matches = find(text, "url");
  return matches.length > 0 ? matches[0].href : null;
}
