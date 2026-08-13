import { useEffect, useRef } from "react";
import { logAndIgnore } from "@/lib/logAndIgnore";
import { setRoomSendQueueReadOnly } from "@/lib/matrix";
import { isWebBuild } from "@/lib/platform";

/**
 * Serializes native SDK send-queue barrier transitions per room. A transition
 * to read-only drains and pauses the queue; a later authoritative writable
 * state resumes only a queue this hook previously paused, preserving queues
 * disabled by unrelated send failures.
 */
export function useRoomSendQueueBarrier(roomId: string, enabled: boolean, readOnly: boolean): void {
  const pausedRoomIdsRef = useRef(new Set<string>());
  const commandChainsRef = useRef(new Map<string, Promise<void>>());

  useEffect(() => {
    if (!roomId || isWebBuild()) return;
    const pausedRoomIds = pausedRoomIdsRef.current;
    const desiredReadOnly = enabled && readOnly;
    if (pausedRoomIds.has(roomId) === desiredReadOnly) return;
    if (desiredReadOnly) pausedRoomIds.add(roomId);
    else pausedRoomIds.delete(roomId);

    const chains = commandChainsRef.current;
    const previous = chains.get(roomId) ?? Promise.resolve();
    const next = previous
      .catch(logAndIgnore)
      .then(() => setRoomSendQueueReadOnly(roomId, desiredReadOnly))
      .then(() => undefined)
      .catch(logAndIgnore);
    chains.set(roomId, next);
    void next.finally(() => {
      if (chains.get(roomId) === next) chains.delete(roomId);
    });
  }, [enabled, readOnly, roomId]);
}
