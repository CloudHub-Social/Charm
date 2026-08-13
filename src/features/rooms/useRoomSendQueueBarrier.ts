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
      .catch((error: unknown) => {
        // A pause failure is conservatively still treated as owned: the
        // backend disables the queue before it drains local echoes, so an
        // abort error can leave the queue safely paused. A resume failure,
        // however, must restore ownership so the next mount/transition
        // retries instead of permanently believing the queue is writable.
        if (!desiredReadOnly && !pausedRoomIds.has(roomId)) pausedRoomIds.add(roomId);
        logAndIgnore(error);
      });
    commandChains.set(roomId, next);
    void next.finally(() => {
      if (commandChains.get(roomId) === next) commandChains.delete(roomId);
    });
  }, [enabled, readOnly, roomId]);
}
