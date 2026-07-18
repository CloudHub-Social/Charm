import { useEffect, useRef, useState } from "react";
import { onTypingUpdate } from "@/lib/matrix";
import { logAndIgnore } from "@/lib/logAndIgnore";
import { TYPING_AUTO_HIDE_MS } from "./useChatTyping";

/**
 * Tracks which rooms currently have someone typing, across *every* room —
 * not just the open one (`useChatTyping`'s job). A single subscription is
 * shared by the whole `RoomList`, rather than one `onTypingUpdate` listener
 * per row, since `m.typing` updates arrive per room regardless of which rows
 * are mounted.
 *
 * Mirrors `useChatTyping`'s auto-hide behavior (Spec 05): a sender's client
 * is expected to send its own `sendTyping(false)`, but a per-room timer
 * covers the case where it doesn't (crash, network drop) so a room doesn't
 * show "typing" forever.
 */
export function useRoomListTyping(currentUserId: string): Set<string> {
  const [typingRoomIds, setTypingRoomIds] = useState<Set<string>>(new Set());
  const autoHideTimersRef = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());

  useEffect(() => {
    let cancelled = false;
    const timers = autoHideTimersRef.current;
    const unlisten = onTypingUpdate((update) => {
      if (cancelled) return;
      const othersTyping = update.user_ids.some((id) => id !== currentUserId);
      clearTimeout(timers.get(update.room_id));
      timers.delete(update.room_id);
      setTypingRoomIds((previous) => {
        const hadRoom = previous.has(update.room_id);
        if (othersTyping === hadRoom) return previous;
        const next = new Set(previous);
        if (othersTyping) next.add(update.room_id);
        else next.delete(update.room_id);
        return next;
      });
      if (othersTyping) {
        timers.set(
          update.room_id,
          setTimeout(() => {
            if (cancelled) return;
            timers.delete(update.room_id);
            setTypingRoomIds((previous) => {
              if (!previous.has(update.room_id)) return previous;
              const next = new Set(previous);
              next.delete(update.room_id);
              return next;
            });
          }, TYPING_AUTO_HIDE_MS),
        );
      }
    });
    return () => {
      cancelled = true;
      for (const timer of timers.values()) clearTimeout(timer);
      timers.clear();
      unlisten.then((fn) => fn()).catch(logAndIgnore);
    };
  }, [currentUserId]);

  return typingRoomIds;
}
