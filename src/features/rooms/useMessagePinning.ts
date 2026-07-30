import { useAtom } from "jotai";
import { useFlag } from "@/featureFlags";
import { useRoomDetails } from "@/features/room-info/useRoomDetails";
import {
  noRoomPinnedMessagesDrawerOpenAtom,
  pinnedMessagesDrawerOpenAtomFamily,
} from "@/features/room-info/roomInfoAtoms";
import { isWebBuild } from "@/lib/platform";
import type { RoomSummary } from "@/lib/matrix";

/**
 * Owns ChatShell's message-pinning integration state. Keeping the feature
 * gate, room-details projection, and room-scoped drawer atom together makes
 * it harder for one pinning surface to accidentally remain visible while the
 * rest of the feature is dark. Pinning is also unconditionally unavailable in
 * the web companion: its transport and server do not implement
 * `get_pinned_messages`, `pin_event`, or `unpin_event`.
 */
export function useMessagePinning(room: RoomSummary | null) {
  const enabled = useFlag("message_pinning") && !isWebBuild();
  const [drawerOpen, setDrawerOpen] = useAtom(
    room ? pinnedMessagesDrawerOpenAtomFamily(room.room_id) : noRoomPinnedMessagesDrawerOpenAtom,
  );
  const { data: roomDetails } = useRoomDetails(room?.room_id ?? null);

  return {
    enabled,
    drawerOpen,
    setDrawerOpen,
    pinnedEventIds: enabled ? (roomDetails?.pinned_event_ids ?? []) : [],
    canPinMessages: enabled && (roomDetails?.can?.set_pinned_events ?? false),
  };
}
