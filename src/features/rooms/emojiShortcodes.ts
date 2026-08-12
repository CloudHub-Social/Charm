/**
 * A compact, hand-picked shortcode fast path for the composer's `:`
 * autocomplete. Spec 38's full Unicode dataset stays in the lazy-loaded
 * browse picker, so ordinary typing does not pull that large chunk into the
 * initial composer bundle.
 */
export const EMOJI_SHORTCODES: Record<string, string> = {
  smile: "😄",
  smiley: "😃",
  grin: "😁",
  laughing: "😆",
  joy: "😂",
  wink: "😉",
  blush: "😊",
  heart: "❤️",
  heart_eyes: "😍",
  thumbsup: "👍",
  thumbsdown: "👎",
  clap: "👏",
  fire: "🔥",
  tada: "🎉",
  eyes: "👀",
  thinking: "🤔",
  cry: "😢",
  sob: "😭",
  angry: "😠",
  wave: "👋",
  pray: "🙏",
  rocket: "🚀",
  100: "💯",
  check: "✅",
  x: "❌",
  warning: "⚠️",
};

export function searchEmoji(query: string): Array<{ shortcode: string; emoji: string }> {
  const q = query.toLowerCase();
  return Object.entries(EMOJI_SHORTCODES)
    .filter(([shortcode]) => shortcode.startsWith(q))
    .map(([shortcode, emoji]) => ({ shortcode, emoji }));
}

/**
 * Resolves any `:shortcode:` occurrences in `text` to their glyph — used at
 * send time so `:smile:` typed without ever opening the autocomplete menu
 * still resolves (acceptance criterion 4).
 */
export function resolveInlineShortcodes(text: string): string {
  return text.replace(/:([a-z0-9_+-]+):/gi, (match, shortcode: string) => {
    const emoji = EMOJI_SHORTCODES[shortcode.toLowerCase()];
    return emoji ?? match;
  });
}
