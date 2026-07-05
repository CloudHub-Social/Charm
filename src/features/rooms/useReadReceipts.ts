import { useEffect, useMemo, useReducer } from "react";
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
    // Only the most recent receipt per user matters — a later receipt always
    // supersedes an earlier one for that same user, regardless of which
    // event either points at.
    const existing = next.get(receipt.user_id);
    if (!existing || existing.ts_ms <= receipt.ts_ms) {
      next.set(receipt.user_id, receipt);
    }
  }
  return next;
}

type Action = { type: "reset" } | { type: "apply"; receipts: EventReceipt[] };

function reducer(state: Map<string, EventReceipt>, action: Action): Map<string, EventReceipt> {
  if (action.type === "reset") return new Map();
  return applyReceipts(state, action.receipts);
}

/**
 * Tracks read receipts for a single room: the latest receipt per user
 * (`lastReadByUser`), and its derived inverse grouped by event id
 * (`receiptsByEvent`) for rendering an avatar stack under whichever message
 * each user most recently read. Filters out `ownUserId` — a client never
 * shows its own read-receipt avatar back at itself.
 *
 * Keyed to a single `roomId`: receipt updates for other rooms are ignored,
 * so a component using this for room A doesn't re-render on room B's
 * traffic.
 */
export function useReadReceipts(roomId: string | null, ownUserId: string) {
  const [lastReadByUser, dispatch] = useReducer(reducer, new Map<string, EventReceipt>());

  useEffect(() => {
    // Switching rooms starts from a clean slate — a receipt from the
    // previous room shouldn't linger and appear attached to the new room's
    // messages.
    dispatch({ type: "reset" });
  }, [roomId]);

  useEffect(() => {
    if (!roomId) return undefined;
    const unlisten = onReceiptsUpdate((update) => {
      if (update.room_id !== roomId) return;
      const filtered = update.receipts.filter((r) => r.user_id !== ownUserId);
      dispatch({ type: "apply", receipts: filtered });
    });
    return () => {
      unlisten.then((fn) => fn());
    };
  }, [roomId, ownUserId]);

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
