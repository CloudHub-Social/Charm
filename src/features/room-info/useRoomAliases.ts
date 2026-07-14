import { useQuery } from "@tanstack/react-query";
import { getRoomLocalAliases } from "@/lib/matrix";

export function roomAliasesQueryKey(roomId: string) {
  return ["room-aliases", roomId] as const;
}

/**
 * The room's server-published (room-directory) local aliases — a network
 * fetch (`get_room_local_aliases`, unlike `RoomDetails.canonical_alias`/
 * `alt_aliases` which come off sync state), so this is its own query rather
 * than folded into `useRoomDetails`. Invalidated by the mutations in
 * `useRoomAdminActions` (`addAlias`/`removeAlias`) after they resolve — no
 * server-pushed event exists for directory alias changes the way
 * `room_details:update` covers `m.room.canonical_alias` state, so this relies
 * on that invalidation plus React Query's normal refetch-on-mount.
 */
export function useRoomAliases(roomId: string | null) {
  return useQuery({
    queryKey: roomAliasesQueryKey(roomId ?? ""),
    queryFn: () => getRoomLocalAliases(roomId as string),
    enabled: Boolean(roomId),
  });
}
