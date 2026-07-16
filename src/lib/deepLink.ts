import { getCurrent, onOpenUrl } from "@tauri-apps/plugin-deep-link";
import { isWebBuild } from "./platform";

/**
 * Extracts a target room id/alias from a deep-link URL.
 * Supports:
 *   charm://room/<url-encoded room id or alias>
 *   https://matrix.to/#/<room id or alias>   (fragment form used by the wider ecosystem)
 * Returns null if the URL isn't a recognized room link.
 */
export function parseRoomTarget(url: string): string | null {
  try {
    const charmMatch = url.match(/^charm:\/\/room\/(.+)$/);
    if (charmMatch) {
      return decodeURIComponent(charmMatch[1]);
    }

    // Parsed and scheme/host-checked (rather than a substring search over the
    // raw string) so this only ever matches a URL that's genuinely
    // `https://matrix.to/...` — not, say, a `charm://` URL that merely
    // contains that text somewhere in its query string, which a raw
    // `url.match(/matrix\.to\/#\//)` would previously have matched too.
    const parsed = new URL(url);
    if (parsed.protocol === "https:" && parsed.hostname.toLowerCase() === "matrix.to") {
      const fragmentPath = parsed.hash.replace(/^#\/?/, "").split("?", 1)[0];
      // Event permalinks add a second path component. Room navigation does
      // not consume the event yet, but it must still pass only the room id or
      // alias downstream rather than treating `<room>/<event>` as a room id.
      const [roomTarget] = fragmentPath.split("/", 1);
      if (roomTarget) return decodeURIComponent(roomTarget);
    }
  } catch {
    return null;
  }
  return null;
}

/**
 * Registers a deep-link listener and checks for a cold-launch URL, invoking
 * `onRoomTarget` with the first recognized room id/alias found. Returns an
 * unsubscribe function.
 */
export async function watchDeepLinks(onRoomTarget: (target: string) => void): Promise<() => void> {
  if (isWebBuild()) return () => {};

  const current = await getCurrent().catch(() => null);
  for (const url of current ?? []) {
    const target = parseRoomTarget(url);
    if (target) onRoomTarget(target);
  }

  const unlisten = await onOpenUrl((urls) => {
    for (const url of urls) {
      const target = parseRoomTarget(url);
      if (target) onRoomTarget(target);
    }
  });

  return unlisten;
}
