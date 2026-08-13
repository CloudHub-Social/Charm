import { useEffect } from "react";
import { logAndIgnore } from "@/lib/logAndIgnore";
import { setRoomSendQueueReadOnly } from "@/lib/matrix";
import { isWebBuild } from "@/lib/platform";

// Module-owned so mobile navigation can unmount and remount ChatShell without
// forgetting which SDK room queues this feature paused.
const pausedRoomIds = new Set<string>();
const commandChains = new Map<string, Promise<void>>();

/**
 * Serializes native SDK send-queue barrier transitions per room. A transition
 * to read-only drains and pauses the queue; a later authoritative writable
 * state resumes only a queue this hook previously paused, preserving queues
 * disabled by unrelated send failures.
 */
export function useRoomSendQueueBarrier(
  roomId: string | null,
  enabled: boolean,
  readOnly: boolean,
): void {
  useEffect(() => {
    if (!roomId || isWebBuild()) return;
    const desiredReadOnly = enabled && readOnly;
    if (pausedRoomIds.has(roomId) === desiredReadOnly) return;
    if (desiredReadOnly) pausedRoomIds.add(roomId);
    else pausedRoomIds.delete(roomId);

    const previous = commandChains.get(roomId) ?? Promise.resolve();
    const next = previous
      .catch(logAndIgnore)
      .then(() => setRoomSendQueueReadOnly(roomId, desiredReadOnly))
      .then(() => undefined)
      .catch(logAndIgnore);
    commandChains.set(roomId, next);
    void next.finally(() => {
      if (commandChains.get(roomId) === next) commandChains.delete(roomId);
    });
  }, [enabled, readOnly, roomId]);
}
