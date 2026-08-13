import { useEffect, useState } from "react";
import { logAndIgnore } from "@/lib/logAndIgnore";
import { setRoomSendQueueReadOnly } from "@/lib/matrix";
import { isWebBuild } from "@/lib/platform";

// Module-owned so mobile navigation can unmount and remount ChatShell without
// forgetting which SDK room queues this feature paused.
const pausedRoomIds = new Set<string>();
const requestedBarriers = new Map<string, string>();
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
  requestedBarriers.clear();
  commandChains.clear();
}

/**
 * Serializes native SDK send-queue barrier transitions per room. Unresolved
 * state pauses delivery without message loss; a confirmed tombstone also
 * drains pending echoes. A later authoritative writable state resumes only a
 * queue this hook previously paused, preserving unrelated send-failure state.
 */
export function useRoomSendQueueBarrier(
  roomId: string | null,
  enabled: boolean,
  readOnly: boolean,
  discardPending: boolean,
): void {
  const [retryRevision, setRetryRevision] = useState(0);

  useEffect(() => {
    if (!roomId || isWebBuild()) return;
    const desiredReadOnly = enabled && readOnly;
    const desiredDiscard = desiredReadOnly && discardPending;
    const requestedBarrier = `${desiredReadOnly}:${desiredDiscard}`;
    if (!desiredReadOnly && !pausedRoomIds.has(roomId) && !commandChains.has(roomId)) return;
    if (requestedBarriers.get(roomId) === requestedBarrier) {
      const pending = commandChains.get(roomId);
      if (!pending) return;
      let subscribed = true;
      void pending.finally(() => {
        if (subscribed && requestedBarriers.get(roomId) !== requestedBarrier) {
          setRetryRevision((revision) => revision + 1);
        }
      });
      return () => {
        subscribed = false;
      };
    }
    requestedBarriers.set(roomId, requestedBarrier);
    const generation = queueBarrierGeneration;
    let retryTimer: ReturnType<typeof setTimeout> | undefined;
    let active = true;

    const previous = commandChains.get(roomId) ?? Promise.resolve();
    const next = previous
      .catch(logAndIgnore)
      .then(() => {
        if (generation !== queueBarrierGeneration) return;
        return setRoomSendQueueReadOnly(roomId, desiredReadOnly, desiredDiscard);
      })
      .then(() => {
        if (generation !== queueBarrierGeneration) return;
        if (desiredReadOnly) pausedRoomIds.add(roomId);
        else pausedRoomIds.delete(roomId);
      })
      .catch((error: unknown) => {
        if (generation !== queueBarrierGeneration) return;
        // IPC can fail either before or after Rust changes the SDK queue.
        // Retain ownership and retry: both queue operations are idempotent,
        // while an IPC rejection cannot reveal whether Rust changed the SDK
        // queue before failing. Ownership also ensures a later writable
        // transition safely issues a resume after an ambiguous pause.
        pausedRoomIds.add(roomId);
        if (requestedBarriers.get(roomId) === requestedBarrier) {
          requestedBarriers.delete(roomId);
        }
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
  }, [discardPending, enabled, readOnly, retryRevision, roomId]);
}
