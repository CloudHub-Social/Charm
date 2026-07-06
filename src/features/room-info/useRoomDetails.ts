import { useEffect } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { getRoomDetails, onRoomDetailsUpdate } from "@/lib/matrix";

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
 */
export function useRoomDetails(roomId: string | null) {
  const queryClient = useQueryClient();

  useEffect(() => {
    if (!roomId) return undefined;
    const unlisten = onRoomDetailsUpdate((details) => {
      if (details.room_id !== roomId) return;
      queryClient.setQueryData(roomDetailsQueryKey(roomId), details);
    });
    return () => {
      unlisten.then((fn) => fn()).catch(console.error);
    };
  }, [roomId, queryClient]);

  return useQuery({
    queryKey: roomDetailsQueryKey(roomId ?? ""),
    queryFn: () => getRoomDetails(roomId as string),
    enabled: Boolean(roomId),
  });
}
