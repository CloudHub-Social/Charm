import { useEffect } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { getRoomDetails, onRoomDetailsUpdate } from "@/lib/matrix";
import { roomMembersQueryKey } from "./useRoomMembers";
import { logAndIgnore } from "@/lib/logAndIgnore";

export function roomDetailsQueryKey(roomId: string) {
  return ["room-details", roomId] as const;
}

/**
 * `RoomDetails` for the right panel's Info tab — seeded by `get_room_details`,
 * kept fresh by `room_details:update` (emitted from the sync loop whenever a
 * batch of state events lands for this room; see `mod.rs`'s
 * `emit_room_updates`). No polling: the event listener writes straight into
 * the query cache via `setQueryData` rather than invalidating + refetching,
 * since the event payload already *is* the fresh `RoomDetails`.
 *
 * Also invalidates the room-members query here (not just in `useRoomMembers`):
 * this hook runs at the always-mounted `RoomInfoPanel` level, while
 * `useRoomMembers` only runs while the Members tab is actually mounted —
 * Radix unmounts inactive `TabsContent`, so a listener that only lived there
 * would miss a remote invite/kick/ban while the user was on the Info tab,
 * leaving the member list stale (beyond its `staleTime`) when they switch
 * back.
 */
export function useRoomDetails(roomId: string | null) {
  const queryClient = useQueryClient();

  useEffect(() => {
    if (!roomId) return undefined;
    const unlisten = onRoomDetailsUpdate((details) => {
      if (details.room_id !== roomId) return;
      queryClient.setQueryData(roomDetailsQueryKey(roomId), details);
      queryClient.invalidateQueries({ queryKey: roomMembersQueryKey(roomId) });
    });
    return () => {
      unlisten.then((fn) => fn()).catch(logAndIgnore);
    };
  }, [roomId, queryClient]);

  return useQuery({
    queryKey: roomDetailsQueryKey(roomId ?? ""),
    queryFn: () => getRoomDetails(roomId as string),
    enabled: Boolean(roomId),
  });
}
