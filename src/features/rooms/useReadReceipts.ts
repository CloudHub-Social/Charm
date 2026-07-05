import { useEffect, useMemo } from "react";
import { atom } from "jotai";
import { atomFamily } from "jotai/utils";
import { useAtomValue, useStore } from "jotai";
import type { EventReceipt } from "@/lib/matrix";
import { onReceiptsUpdate } from "@/lib/matrix";

/** `event_id` -> the user ids who have a read receipt on it. */
export type ReceiptsByEvent = Map<string, string[]>;

function applyReceipts(
  state: Map<string, EventReceipt>,
  incoming: EventReceipt[],
): Map<string, EventReceipt> {
  if (incoming.length === 0) return state;
  const next = new Map(state);
  for (const receipt of incoming) {
    // `m.receipt` events are deltas that *replace* a user's prior
    // acknowledgement for the same receipt type/thread — always apply the
    // incoming one. Gating on `ts_ms` would be wrong: it's frequently absent
    // (mapped to 0 by the Rust side) or can be lower than a stale existing
    // value, which would otherwise drop a legitimate newer receipt.
    next.set(receipt.user_id, receipt);
  }
  return next;
}

/**
 * One atom per room id, holding the latest receipt per user seen for that
 * room. Deliberately cached at the atomFamily level rather than reset on
 * every room switch: `m.receipt` updates are push-only deltas with no
 * refetch/replay path, so wiping this on switch would blank out
 * already-observed avatars every time the user revisits a room until a new
 * receipt happened to arrive.
 */
const receiptsAtomFamily = atomFamily((roomId: string) => {
  const roomReceiptsAtom = atom<Map<string, EventReceipt>>(new Map());
  roomReceiptsAtom.debugLabel = `receipts:${roomId}`;
  return roomReceiptsAtom;
});

/** Used as the atomFamily key when no room is active, so it's never written to. */
const NO_ROOM = "__no_room__";

/**
 * Tracks read receipts for a single room: the latest receipt per user
 * (`lastReadByUser`), and its derived inverse grouped by event id
 * (`receiptsByEvent`) for rendering an avatar stack under whichever message
 * each user most recently read. Filters out `ownUserId` — a client never
 * shows its own read-receipt avatar back at itself.
 *
 * The `onReceiptsUpdate` subscription is *not* gated to `roomId` — it applies
 * every incoming update to that update's own room's atom, regardless of
 * which room is currently active, so switching back to a previously-viewed
 * room shows its cached receipts immediately rather than starting empty.
 */
export function useReadReceipts(roomId: string | null, ownUserId: string) {
  const store = useStore();
  const lastReadByUser = useAtomValue(receiptsAtomFamily(roomId ?? NO_ROOM));

  useEffect(() => {
    const unlisten = onReceiptsUpdate((update) => {
      const filtered = update.receipts.filter((r) => r.user_id !== ownUserId);
      if (filtered.length === 0) return;
      store.set(receiptsAtomFamily(update.room_id), (prev) => applyReceipts(prev, filtered));
    });
    return () => {
      unlisten.then((fn) => fn()).catch(console.error);
    };
  }, [store, ownUserId]);

  const receiptsByEvent = useMemo(() => {
    const byEvent: ReceiptsByEvent = new Map();
    for (const receipt of lastReadByUser.values()) {
      const users = byEvent.get(receipt.event_id) ?? [];
      users.push(receipt.user_id);
      byEvent.set(receipt.event_id, users);
    }
    return byEvent;
  }, [lastReadByUser]);

  return { lastReadByUser, receiptsByEvent };
}
