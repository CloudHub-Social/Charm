import { useEffect } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { getRoomMemberList, onRoomDetailsUpdate } from "@/lib/matrix";

export function roomMembersQueryKey(roomId: string) {
  return ["room-members", roomId] as const;
}

/**
 * The Members tab's full membership list (including banned/left — see
 * `get_room_member_list`'s doc comment for how this differs from the
 * mention-autocomplete's active-only `get_room_members`).
 *
 * `room_details:update` fires for the same state-event batches that carry
 * membership changes (kick/ban/invite/unban are all `m.room.member` state
 * events), so it doubles as this query's invalidation signal even though its
 * payload is a `RoomDetails`, not a member list.
 */
export function useRoomMembers(roomId: string | null) {
  const queryClient = useQueryClient();

  useEffect(() => {
    if (!roomId) return undefined;
    const unlisten = onRoomDetailsUpdate((details) => {
      if (details.room_id !== roomId) return;
      queryClient.invalidateQueries({ queryKey: roomMembersQueryKey(roomId) });
    });
    return () => {
      unlisten.then((fn) => fn()).catch(console.error);
    };
  }, [roomId, queryClient]);

  return useQuery({
    queryKey: roomMembersQueryKey(roomId ?? ""),
    queryFn: () => getRoomMemberList(roomId as string),
    enabled: Boolean(roomId),
  });
}
