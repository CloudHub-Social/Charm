import { useQuery } from "@tanstack/react-query";
import { getRoomMemberList } from "@/lib/matrix";

export function roomMembersQueryKey(roomId: string) {
  return ["room-members", roomId] as const;
}

/**
 * The Members tab's full membership list (including banned/left — see
 * `get_room_member_list`'s doc comment for how this differs from the
 * mention-autocomplete's active-only `get_room_members`).
 *
 * No `room_details:update` listener here — `useRoomDetails` (always mounted
 * at the `RoomInfoPanel` level, unlike this hook which only runs while the
 * Members tab is mounted) already invalidates this query key on that event,
 * so the member list stays fresh even while the user is on the Info tab.
 */
export function useRoomMembers(roomId: string | null) {
  return useQuery({
    queryKey: roomMembersQueryKey(roomId ?? ""),
    queryFn: () => getRoomMemberList(roomId as string),
    enabled: Boolean(roomId),
  });
}
