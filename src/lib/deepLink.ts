import { getCurrent, onOpenUrl } from "@tauri-apps/plugin-deep-link";

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

    const matrixToMatch = url.match(/matrix\.to\/#\/([^?]+)/);
    if (matrixToMatch) {
      return decodeURIComponent(matrixToMatch[1]);
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
