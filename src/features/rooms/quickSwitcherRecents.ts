const STORAGE_KEY_PREFIX = "charm:quickSwitcherRecents:";
const MAX_RECENT_ROOMS = 20;

function storageKey(accountId: string): string {
  return `${STORAGE_KEY_PREFIX}${encodeURIComponent(accountId)}`;
}

function parseRecentRoomIds(raw: string | null): string[] {
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return [
      ...new Set(
        parsed.filter((entry): entry is string => typeof entry === "string" && entry.length > 0),
      ),
    ].slice(0, MAX_RECENT_ROOMS);
  } catch {
    return [];
  }
}

export function readQuickSwitcherRecents(accountId: string): string[] {
  try {
    return parseRecentRoomIds(localStorage.getItem(storageKey(accountId)));
  } catch {
    return [];
  }
}

export function reconcileQuickSwitcherRecents(
  accountId: string,
  validRoomIds: ReadonlySet<string>,
): string[] {
  const current = readQuickSwitcherRecents(accountId);
  const next = current.filter((roomId) => validRoomIds.has(roomId));
  if (next.length !== current.length) persist(accountId, next);
  return next;
}

export function recordQuickSwitcherRecent(accountId: string, roomId: string): string[] {
  const current = readQuickSwitcherRecents(accountId);
  const next = [roomId, ...current.filter((candidate) => candidate !== roomId)].slice(
    0,
    MAX_RECENT_ROOMS,
  );
  persist(accountId, next);
  return next;
}

export function clearQuickSwitcherRecents(accountId: string): void {
  try {
    localStorage.removeItem(storageKey(accountId));
  } catch {
    // Best-effort local preference cleanup. An unavailable storage backend
    // already means there is no durable recent-room history to expose.
  }
}

function persist(accountId: string, roomIds: string[]): void {
  try {
    if (roomIds.length === 0) {
      localStorage.removeItem(storageKey(accountId));
    } else {
      localStorage.setItem(storageKey(accountId), JSON.stringify(roomIds));
    }
  } catch {
    // Recents are a navigation convenience, never a prerequisite for using
    // the switcher. Keep selection functional when storage is unavailable.
  }
}
