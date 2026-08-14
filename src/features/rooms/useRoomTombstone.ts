import { useMemo } from "react";
import type { RoomTombstoneDetails } from "@bindings/RoomTombstoneDetails";
import type { TimelineItemSummary } from "@bindings/TimelineItemSummary";

export function useRoomTombstone(
  enabled: boolean,
  currentTombstone: RoomTombstoneDetails | null,
  timelineItems: TimelineItemSummary[],
) {
  return useMemo(() => {
    if (!enabled) return null;
    if (currentTombstone) return currentTombstone;
    for (let index = timelineItems.length - 1; index >= 0; index -= 1) {
      const item = timelineItems[index];
      if (item.kind === "state" && item.state_key === "" && item.change.type === "tombstone") {
        const { body, replacement_room_id: replacementRoomId } = item.change;
        if (body === null || replacementRoomId === null) return null;
        return { body, replacement_room_id: replacementRoomId };
      }
    }
    return null;
  }, [currentTombstone, enabled, timelineItems]);
}
