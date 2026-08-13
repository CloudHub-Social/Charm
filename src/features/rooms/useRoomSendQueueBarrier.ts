import { useEffect, useState } from "react";
import { logAndIgnore } from "@/lib/logAndIgnore";
import { setRoomSendQueueReadOnly } from "@/lib/matrix";
import { isWebBuild } from "@/lib/platform";

// Module-owned so mobile navigation can unmount and remount ChatShell without
// forgetting which SDK room queues this feature paused.
const pausedRoomIds = new Set<string>();
const commandChains = new Map<string, Promise<void>>();
let queueBarrierGeneration = 0;

/**
 * Drops account-scoped queue ownership on logout and invalidates commands
 * that were waiting behind another room transition. Already-started IPC is
 * allowed to settle, but its result cannot mutate the next session's state.
 */
export function resetRoomSendQueueBarrier(): void {
  queueBarrierGeneration += 1;
  pausedRoomIds.clear();
  commandChains.clear();
}

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
  const [retryRevision, setRetryRevision] = useState(0);

  useEffect(() => {
    if (!roomId || isWebBuild()) return;
    const desiredReadOnly = enabled && readOnly;
    if (pausedRoomIds.has(roomId) === desiredReadOnly) return;
    if (desiredReadOnly) pausedRoomIds.add(roomId);
    else pausedRoomIds.delete(roomId);
    const generation = queueBarrierGeneration;
    let retryTimer: ReturnType<typeof setTimeout> | undefined;
    let active = true;

    const previous = commandChains.get(roomId) ?? Promise.resolve();
    const next = previous
      .catch(logAndIgnore)
      .then(() => {
        if (generation !== queueBarrierGeneration) return;
        return setRoomSendQueueReadOnly(roomId, desiredReadOnly);
      })
      .then(() => undefined)
      .catch((error: unknown) => {
        if (generation !== queueBarrierGeneration) return;
        // IPC can fail either before or after Rust changes the SDK queue.
        // Restore the pre-command ownership state and retry: both queue
        // enable/disable operations are idempotent, while assuming either
        // outcome could leave a tombstoned room writable (or a live room
        // permanently paused).
        if (desiredReadOnly) pausedRoomIds.delete(roomId);
        else pausedRoomIds.add(roomId);
        logAndIgnore(error);
        if (active) {
          retryTimer = setTimeout(() => {
            if (generation === queueBarrierGeneration) {
              setRetryRevision((revision) => revision + 1);
            }
          }, 1_000);
        }
      });
    commandChains.set(roomId, next);
    void next.finally(() => {
      if (generation === queueBarrierGeneration && commandChains.get(roomId) === next) {
        commandChains.delete(roomId);
      }
    });
    return () => {
      active = false;
      clearTimeout(retryTimer);
    };
  }, [enabled, readOnly, retryRevision, roomId]);
}
