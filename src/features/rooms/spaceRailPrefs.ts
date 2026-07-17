import { atomWithStorage } from "jotai/utils";

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

/** Persisted client-side (not yet synced via account data — see Spec 63). */
export const spaceRailPrefsAtom = atomWithStorage<SpaceRailPrefs>(
  "charm.spaceRailPrefs",
  DEFAULT_PREFS,
);

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
  const next = [...current];
  [next[index], next[swapWith]] = [next[swapWith], next[index]];
  return next;
}
