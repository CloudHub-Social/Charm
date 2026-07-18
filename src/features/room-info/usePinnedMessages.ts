import { useQuery } from "@tanstack/react-query";
import { getPinnedMessages } from "@/lib/matrix";

// Review fix: `pinnedEventIds` is included as an array, not `.join(",")`ed —
// Matrix event ids are opaque strings with no guarantee against containing
// a comma, so a joined key could collide between two genuinely different
// id lists. React Query keys are matched by deep equality, so passing the
// array itself is both safe and unambiguous.
export function pinnedMessagesQueryKey(roomId: string, pinnedEventIds: readonly string[]) {
  return ["pinned-messages", roomId, pinnedEventIds] as const;
}

/**
 * Resolves `roomId`'s currently-pinned events for the pinned-messages panel.
 * Keyed on the *contents* of `pinnedEventIds` (not just `roomId`) so a
 * pin/unpin — which arrives as a fresh `RoomDetails.pinned_event_ids` array
 * via `useRoomDetails`'s `room_details:update` listener — naturally
 * refetches under a new query key, without this hook needing its own
 * `room_details:update` subscription. `enabled` only once the panel is
 * actually open (callers pass `null` for `roomId` while closed), matching
 * `useRoomMembers`'s lazy-fetch convention.
 */
export function usePinnedMessages(roomId: string | null, pinnedEventIds: readonly string[]) {
  return useQuery({
    queryKey: pinnedMessagesQueryKey(roomId ?? "", pinnedEventIds),
    queryFn: () => getPinnedMessages(roomId as string),
    enabled: Boolean(roomId),
  });
}
