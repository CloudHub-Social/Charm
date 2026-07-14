import { find } from "linkifyjs";
import { sanitizeMatrixHtml } from "../composerSanitize";

/**
 * Finds the first http(s) URL in `text`, or `null` if none.
 */
function firstHttpUrl(text: string): string | null {
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

/**
 * Returns the first http(s) URL found in a message, preferring
 * `formattedBody` over the plain-text `body` fallback when both are
 * available, or `null` if none. Charm 1.0 parity: only the first URL in a
 * message gets a preview card, matching Matrix client conventions
 * generally. Uses `linkifyjs`'s `find` — the same URL-detection engine
 * `RichMessageContent` already uses via `linkify-react` for the plain-text
 * message body — so a preview is offered for exactly the URLs that already
 * render as clickable links.
 *
 * `find(text, "url")` matches any URL scheme linkify recognizes (`ftp://`,
 * `file://`, etc.), not just http(s) — the homeserver's `/preview_url`
 * endpoint only makes sense for a fetchable web page, so a non-http(s) match
 * is skipped in favor of the first http(s) one instead of being returned (or
 * silently sent to `get_url_preview` as a doomed request that also blocks a
 * real, later http(s) URL from getting its own preview).
 *
 * Privacy: a URL that's only reachable via the plain-text `body` because
 * it's concealed in `formattedBody` behind `<span data-mx-spoiler>`
 * (`RichMessageContent`'s `Spoiler`) must not trigger a preview fetch —
 * that would unfurl (and thus reveal, via the resulting title/thumbnail)
 * spoilered content the sender explicitly hid pending the reader's
 * deliberate reveal click. So when `formattedBody` is present, the URL
 * search runs against its sanitized text content with spoiler nodes
 * stripped first, rather than against `body`.
 */
export function firstUrlInText(body: string, formattedBody?: string | null): string | null {
  if (!formattedBody) return firstHttpUrl(body);

  const doc = new DOMParser().parseFromString(sanitizeMatrixHtml(formattedBody), "text/html");
  doc.querySelectorAll("[data-mx-spoiler]").forEach((node) => node.remove());
  // Search both the remaining visible text and any surviving `<a href>`
  // targets — a link's href doesn't have to equal its link text (e.g. a
  // pill-styled permalink, or `[label](url)`-style markdown rendering), so
  // textContent alone would miss it.
  const hrefs = Array.from(doc.querySelectorAll("a[href]"))
    .map((a) => a.getAttribute("href"))
    .filter((href): href is string => href !== null);
  return firstHttpUrl([doc.body.textContent ?? "", ...hrefs].join(" "));
}
