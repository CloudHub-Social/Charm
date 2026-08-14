import type { RoomTombstoneDetails } from "@bindings/RoomTombstoneDetails";
import type { RoomSummary } from "@/lib/matrix";

export interface ChatShellProps {
  room: RoomSummary | null;
  currentUserId: string;
  onBack?: () => void;
  onNavigateToRoom?: (roomIdentifier: string) => void;
  onNavigateToProfileRoom?: (roomId: string) => void;
  currentTombstone?: RoomTombstoneDetails | null;
  currentRoomStateResolved?: boolean;
  onFollowRoomUpgrade?: (roomId: string) => Promise<void>;
  /**
   * An event id to scroll to as soon as it's loaded in this room's timeline
   * (Spec 12's Saved Messages "jump to message"). Set by the caller after
   * selecting the bookmark's room; cleared via `onJumpHandled` once the jump
   * completes (found and scrolled to) or definitively fails (not reachable
   * even after `loadTimelineAroundEvent`), so a stale target doesn't
   * re-trigger a jump on some unrelated later render.
   */
  jumpToEventId?: string | null;
  onJumpHandled?: () => void;
}
