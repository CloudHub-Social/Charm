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

/**
 * Global account-data event type for the rail's pin/order state (Spec 63) —
 * no version suffix in the type string itself, matching every other
 * `social.cloudhub.charm`-namespaced identifier in this codebase (see
 * `onboardingAccountData.ts`).
 */
export const SPACE_RAIL_PREFS_ACCOUNT_DATA_TYPE = "social.cloudhub.charm.space_rail_prefs";

/** Local-only cache: instant on cold start, before the account-data round
 * trip in `useSpaceRailPrefsSync` resolves; kept in sync with it afterward. */
export const spaceRailPrefsAtom = atomWithStorage<SpaceRailPrefs>(
  "charm.spaceRailPrefs",
  DEFAULT_PREFS,
);

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
  const next = [...current];
  [next[index], next[swapWith]] = [next[swapWith], next[index]];
  return next;
}
