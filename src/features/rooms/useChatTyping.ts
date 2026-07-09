import { useEffect, useMemo, useRef, useState } from "react";
import { onTypingUpdate, sendTyping } from "@/lib/matrix";
import { logAndIgnore } from "@/lib/logAndIgnore";

/** How often `sendTyping(true)` is re-sent while the user keeps typing, in ms. */
const TYPING_REFRESH_MS = 4000;

function typingLabel(userIds: string[]): string {
  if (userIds.length === 0) return "";
  if (userIds.length === 1) return `${userIds[0]} is typing…`;
  if (userIds.length === 2) return `${userIds[0]} and ${userIds[1]} are typing…`;
  const [first, second, ...rest] = userIds;
  return `${first}, ${second}, and ${rest.length} other${rest.length === 1 ? "" : "s"} are typing…`;
}

export function useChatTyping(roomId: string | null, currentUserId: string) {
  const [typingUserIds, setTypingUserIds] = useState<string[]>([]);
  const lastTypingSentAt = useRef(0);

  useEffect(() => {
    // Clear on every room change, not just to `null` — otherwise switching
    // directly from room A (mid "X is typing…") to room B keeps A's typing
    // row rendered under B until B happens to get its own typing update.
    setTypingUserIds([]);
    const typingRoomId = roomId;
    if (!typingRoomId) return undefined;
    // Keyed to the room id, not the `room` object — a `room_list:update`
    // refresh gives the active room a fresh object with the same id, which
    // would otherwise re-subscribe (and briefly double-listen, since the old
    // listener's teardown is async) on every refresh instead of only on an
    // actual room change.
    const unlisten = onTypingUpdate((update) => {
      if (update.room_id !== typingRoomId) return;
      setTypingUserIds(update.user_ids.filter((id) => id !== currentUserId));
    });
    return () => {
      unlisten.then((fn) => fn()).catch(logAndIgnore);
    };
  }, [roomId, currentUserId]);

  // Keyed to the room id, not the `room` object — RoomsScreen rebuilds
  // `activeRoom` from every `room_list:update`, so a plain `[room]` dep would
  // treat "same room, refreshed object" as a room change and send a spurious
  // `sendTyping(false)` while the user is still actively typing there.
  useEffect(() => {
    const typingRoomId = roomId;
    // A room switch (or unmount) resets the throttle too — otherwise typing
    // in room A within the last 4s can suppress the first `sendTyping(true)`
    // in room B, since the throttle was keyed globally rather than per room.
    lastTypingSentAt.current = 0;
    return () => {
      if (typingRoomId) sendTyping(typingRoomId, false).catch(logAndIgnore);
    };
  }, [roomId]);

  function handleTypingInput() {
    if (!roomId) return;
    const now = Date.now();
    if (now - lastTypingSentAt.current < TYPING_REFRESH_MS) return;
    lastTypingSentAt.current = now;
    sendTyping(roomId, true).catch(logAndIgnore);
  }

  function stopTyping() {
    if (roomId) sendTyping(roomId, false).catch(logAndIgnore);
  }

  const typingText = useMemo(() => typingLabel(typingUserIds), [typingUserIds]);

  return { typingText, handleTypingInput, stopTyping };
}
