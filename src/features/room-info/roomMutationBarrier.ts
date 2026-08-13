import type { RoomDetails } from "@/lib/matrix";

/** Returns a room-details view whose every server mutation permission is denied. */
export function withRoomMutationsDisabled(details: RoomDetails): RoomDetails {
  return {
    ...details,
    can: Object.fromEntries(
      Object.keys(details.can).map((key) => [key, false]),
    ) as RoomDetails["can"],
  };
}
