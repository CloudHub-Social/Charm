import { useEffect, useState } from "react";
import { getRoomMembers, type RoomMemberSummary } from "@/lib/matrix";
import { logAndIgnore } from "@/lib/logAndIgnore";

/**
 * Active members of a room, for the "following the conversation" bar.
 * Reuses the same active-only `get_room_members` the mention autocomplete
 * uses (see its doc comment) rather than the Members-tab's full
 * `get_room_member_list` — banned/left accounts aren't "following" anything.
 */
export function useRoomParticipants(roomId: string | null): RoomMemberSummary[] {
  const [participants, setParticipants] = useState<RoomMemberSummary[]>([]);

  useEffect(() => {
    setParticipants([]);
    if (!roomId) return undefined;
    let cancelled = false;
    getRoomMembers(roomId)
      .then((members) => {
        if (!cancelled) setParticipants(members);
      })
      .catch(logAndIgnore);
    return () => {
      cancelled = true;
    };
  }, [roomId]);

  return participants;
}

/** "Alice, Bob, and Carol are following the conversation" (oxford-comma'd, collapsing past 3 into "and N others"). */
export function followingLabel(names: string[]): string {
  if (names.length === 0) return "";
  if (names.length === 1) return `${names[0]} is following the conversation`;
  if (names.length <= 3) return `${names.join(", ")} are following the conversation`;
  const shown = names.slice(0, 3);
  return `${shown.join(", ")}, and ${names.length - 3} others are following the conversation`;
}
