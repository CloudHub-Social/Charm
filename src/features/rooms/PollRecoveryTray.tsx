import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  discardPollEnd,
  discardPollVote,
  getPendingPollRelations,
  retryPollEnd,
  retryPollVote,
  type PendingPollRelation,
  type RoomMessageSummary,
} from "@/lib/matrix";

interface PollRecoveryTrayProps {
  roomId: string;
  loadedMessages: readonly Pick<RoomMessageSummary, "event_id">[];
}

export function PollRecoveryTray({ roomId, loadedMessages }: PollRecoveryTrayProps) {
  const [relations, setRelations] = useState<PendingPollRelation[]>([]);
  const [busyTransactionId, setBusyTransactionId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const activeRoomId = useRef(roomId);
  activeRoomId.current = roomId;
  const loadedEventIds = useMemo(
    () => new Set(loadedMessages.map((message) => message.event_id)),
    [loadedMessages],
  );
  const refresh = useCallback(async () => {
    const pending = await getPendingPollRelations(roomId);
    if (activeRoomId.current !== roomId) return;
    setRelations(
      pending.filter((relation) => relation.failed && !loadedEventIds.has(relation.poll_event_id)),
    );
  }, [loadedEventIds, roomId]);

  useEffect(() => {
    let active = true;
    let retryTimer: number | undefined;
    const load = async () => {
      try {
        await refresh();
      } catch {
        // The durable queue remains authoritative; retry while this room is open.
      } finally {
        if (active) retryTimer = window.setTimeout(() => void load(), 2_000);
      }
    };
    void load();
    return () => {
      active = false;
      if (retryTimer !== undefined) window.clearTimeout(retryTimer);
    };
  }, [refresh]);

  async function mutate(relation: PendingPollRelation, action: "retry" | "discard") {
    setBusyTransactionId(relation.transaction_id);
    setError(null);
    try {
      const changed =
        relation.kind === "vote"
          ? action === "retry"
            ? await retryPollVote(roomId, relation.poll_event_id, relation.transaction_id)
            : await discardPollVote(roomId, relation.poll_event_id, relation.transaction_id)
          : action === "retry"
            ? await retryPollEnd(roomId, relation.poll_event_id, relation.transaction_id)
            : await discardPollEnd(roomId, relation.poll_event_id, relation.transaction_id);
      if (!changed) setError("That failed poll action was already handled elsewhere.");
      await refresh();
    } catch {
      setError(
        `The failed poll ${relation.kind} could not be ${action === "retry" ? "retried" : "discarded"}.`,
      );
    } finally {
      setBusyTransactionId(null);
    }
  }

  if (relations.length === 0) return null;

  return (
    <section aria-label="Poll send recovery" className="flex flex-col gap-2 px-4 pb-2">
      {relations.map((relation) => {
        const busy = busyTransactionId === relation.transaction_id;
        return (
          <div
            key={relation.transaction_id}
            className="flex items-center gap-2 rounded-md border border-destructive/40 bg-card px-3 py-2 text-[13px]"
          >
            <span className="min-w-0 flex-1 text-foreground">
              A poll {relation.kind === "vote" ? "vote" : "close"} failed to send.
            </span>
            <button
              type="button"
              disabled={busy}
              onClick={() => void mutate(relation, "retry")}
              className="rounded bg-primary-solid px-2.5 py-1 text-primary-foreground hover:opacity-90 disabled:opacity-50"
            >
              Retry
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={() => void mutate(relation, "discard")}
              className="rounded px-2.5 py-1 text-muted-foreground hover:bg-accent disabled:opacity-50"
            >
              Discard
            </button>
          </div>
        );
      })}
      {error && <p className="text-xs text-destructive">{error}</p>}
    </section>
  );
}
