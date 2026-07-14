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
 * Walks `node`'s subtree in document order, pushing plain text as
 * encountered and, for a non-pill anchor, its `href` right at the anchor's
 * own position (before descending into the anchor's link-text children) —
 * so a later `push` call always corresponds to later content, keeping
 * "first URL" meaningful once search candidates come from more than one
 * kind of node (plain text and hrefs interleaved).
 */
function collectOrderedSearchText(node: Node, out: string[]): void {
  if (node.nodeType === Node.TEXT_NODE) {
    out.push(node.textContent ?? "");
    return;
  }
  if (node.nodeType !== Node.ELEMENT_NODE) return;

  const el = node as Element;
  if (el.tagName === "A" && el.hasAttribute("href") && !el.hasAttribute("data-mx-pill")) {
    out.push(el.getAttribute("href") ?? "");
  }
  el.childNodes.forEach((child) => collectOrderedSearchText(child, out));
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
 * search runs against its sanitized content with spoiler nodes stripped
 * first, rather than against `body`.
 *
 * A Matrix pill (`<a data-mx-pill href="https://matrix.to/#/...">`,
 * `RichMessageContent`'s user/room mention chip) isn't a link the sender
 * meant to share — `RichMessageContent` itself renders it as a pill, not a
 * clickable external link — so its href is excluded from the search too;
 * otherwise an ordinary @mention would trigger an unfurl of a matrix.to URL.
 *
 * The search walks the DOM in document order (text and non-pill anchor
 * hrefs interleaved as encountered) rather than searching all text then all
 * hrefs, so a bare URL that appears later in the message can't jump ahead
 * of an earlier labeled link.
 */
export function firstUrlInText(body: string, formattedBody?: string | null): string | null {
  if (!formattedBody) return firstHttpUrl(body);

  const doc = new DOMParser().parseFromString(sanitizeMatrixHtml(formattedBody), "text/html");
  doc.querySelectorAll("[data-mx-spoiler]").forEach((node) => node.remove());
  const parts: string[] = [];
  collectOrderedSearchText(doc.body, parts);
  return firstHttpUrl(parts.join(" "));
}
