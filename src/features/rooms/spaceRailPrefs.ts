import { atomFamily, atomWithStorage } from "jotai/utils";

export interface SpaceRailPrefs {
  /** Explicit rail order for pinned top-level spaces. Spaces not yet present
   *  here fall back to their natural (room-list) order, appended after any
   *  explicitly ordered entries. */
  order: string[];
  /** Top-level spaces the user has unpinned from the rail. Everything else
   *  defaults to pinned, so existing users see no change until they act. */
  unpinned: string[];
}

const DEFAULT_PREFS: SpaceRailPrefs = { order: [], unpinned: [] };

/**
 * Global account-data event type for the rail's pin/order state (Spec 63) —
 * no version suffix in the type string itself, matching every other
 * `social.cloudhub.charm`-namespaced identifier in this codebase (see
 * `onboardingAccountData.ts`).
 */
export const SPACE_RAIL_PREFS_ACCOUNT_DATA_TYPE = "social.cloudhub.charm.space_rail_prefs";

/** Local-only cache: instant on cold start, before the account-data round
 * trip in `useSpaceRailPrefsSync` resolves; kept in sync with it afterward.
 * Keyed per signed-in account (the storage key embeds `userId`) so switching
 * accounts on the same device/browser profile never inherits — or, worse,
 * silently rewrites — a different account's pinned/ordered spaces before its
 * own account-data read has had a chance to resolve. */
export const spaceRailPrefsAtomFamily = atomFamily((userId: string) =>
  atomWithStorage<SpaceRailPrefs>(`charm.spaceRailPrefs.${userId}`, DEFAULT_PREFS),
);

function pendingSyncStorageKey(userId: string) {
  return `charm.spaceRailPrefs.pendingSync.${userId}`;
}

/** Marks (or clears) that `userId`'s local `spaceRailPrefs` cache has an edit
 * not yet confirmed written to account data — set right before a write
 * attempt, cleared only once that write actually succeeds. Persisted (not
 * just in-memory) so it survives a restart: without it, an edit made while
 * offline that never got a chance to retry would be silently overwritten by
 * an older server value on the next launch's remote-load, since nothing else
 * distinguishes "clean" from "edited but unsynced" across a fresh mount. */
export function setSpaceRailPrefsPendingSync(userId: string, pending: boolean) {
  try {
    if (pending) {
      localStorage.setItem(pendingSyncStorageKey(userId), "1");
    } else {
      localStorage.removeItem(pendingSyncStorageKey(userId));
    }
  } catch {
    // Storage unavailable (private browsing, quota, etc.) — the in-memory
    // `dirtySinceLoadStartRef` guard still covers the common case; this is
    // only the cross-restart extension of it.
  }
}

export function hasUnsyncedSpaceRailPrefs(userId: string): boolean {
  try {
    return localStorage.getItem(pendingSyncStorageKey(userId)) === "1";
  } catch {
    return false;
  }
}

export function isSpaceRailPrefs(value: unknown): value is SpaceRailPrefs {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Record<string, unknown>;
  return (
    Array.isArray(candidate.order) &&
    candidate.order.every((id) => typeof id === "string") &&
    Array.isArray(candidate.unpinned) &&
    candidate.unpinned.every((id) => typeof id === "string")
  );
}

export function orderSpaceIds(spaceIds: string[], order: string[]): string[] {
  const rank = new Map(order.map((id, index) => [id, index]));
  return spaceIds.toSorted((a, b) => {
    const rankA = rank.get(a);
    const rankB = rank.get(b);
    if (rankA !== undefined && rankB !== undefined) return rankA - rankB;
    if (rankA !== undefined) return -1;
    if (rankB !== undefined) return 1;
    return 0;
  });
}

export function moveSpaceInOrder(
  allIds: string[],
  order: string[],
  spaceId: string,
  direction: "up" | "down",
): string[] {
  const current = orderSpaceIds(allIds, order);
  const index = current.indexOf(spaceId);
  if (index === -1) return order;
  const swapWith = direction === "up" ? index - 1 : index + 1;
  if (swapWith < 0 || swapWith >= current.length) return order;
  const swapId = current[swapWith];

  // Keep the result sparse: only `spaceId` (and, when needed, `swapId`)
  // become explicit here — every other id already absent from `order` stays
  // absent, still falling back to natural order. Fully re-materializing the
  // whole visible list into `order` on every move (the previous behavior)
  // permanently froze natural ordering for every space the user had ever
  // seen, so a newly joined space could never again interleave with
  // never-explicitly-ordered ones — it would just append after all of them.
  const next = order.filter((id) => id !== spaceId);
  const pairStart = Math.min(index, swapWith);
  // `orderSpaceIds` always ranks every explicit id above every natural one —
  // so if the pair about to become explicit isn't at the very front of
  // `current`, any still-natural id ahead of it would otherwise jump behind
  // the pair once it's added to `order`, even though this move never touched
  // it. Make those untouched leading ids explicit too, in their existing
  // relative order, so they stay exactly where they were.
  for (let i = 0; i < pairStart; i++) {
    const id = current[i];
    if (!next.includes(id)) next.push(id);
  }
  const swapPosition = next.indexOf(swapId);
  if (swapPosition === -1) {
    // `swapId` isn't explicit either. Since every explicit id ranks above
    // every natural (absent-from-`order`) one, moving `spaceId` past a
    // natural-order `swapId` requires making both explicit — appended
    // together at the end of whatever was already explicit, in their new
    // relative order, so existing explicit entries keep their positions.
    next.push(...(direction === "up" ? [spaceId, swapId] : [swapId, spaceId]));
    return next;
  }
  next.splice(direction === "up" ? swapPosition : swapPosition + 1, 0, spaceId);
  return next;
}
