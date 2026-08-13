import { X } from "lucide-react";
import { TooltipProvider } from "@/components/ui/tooltip";
import { useRoomDetails } from "./useRoomDetails";
import { MemberList } from "./MemberList";
import { withRoomMutationsDisabled } from "./roomMutationBarrier";

interface MembersDrawerProps {
  roomId: string;
  currentUserId: string;
  onClose: () => void;
  onNavigateToRoom?: (roomId: string) => void;
  /** Denies every moderation mutation while authoritative room state is unsafe. */
  mutationsBlocked?: boolean;
}

/**
 * A lightweight, always-on member-browse surface — mirrors Charm 1.0's
 * `MembersDrawer.tsx`: a quick member glance independent of the full
 * `RoomSettingsModal`. Reuses `MemberList` as-is rather than a parallel
 * implementation, per Spec 17's design notes.
 */
export function MembersDrawer({
  roomId,
  currentUserId,
  onClose,
  onNavigateToRoom,
  mutationsBlocked = false,
}: MembersDrawerProps) {
  const { data: details, isLoading, isError } = useRoomDetails(roomId);
  const renderedDetails =
    details && mutationsBlocked ? withRoomMutationsDisabled(details) : details;

  return (
    <div className="flex w-full shrink-0 flex-col border-l border-border bg-card md:w-80">
      <div className="flex items-center justify-between border-b border-border p-4">
        <h2 className="text-[15px] font-bold text-foreground">Members</h2>
        <button
          type="button"
          aria-label="Close members"
          onClick={onClose}
          className="flex size-8 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-accent-foreground"
        >
          <X className="size-4" />
        </button>
      </div>

      {isLoading && <p className="p-4 text-sm text-muted-foreground">Loading…</p>}

      {isError && <p className="p-4 text-sm text-destructive">Couldn't load members.</p>}

      {renderedDetails && (
        <TooltipProvider>
          <div className="min-h-0 flex-1 overflow-y-auto">
            <MemberList
              details={renderedDetails}
              currentUserId={currentUserId}
              onNavigateToRoom={onNavigateToRoom}
            />
          </div>
        </TooltipProvider>
      )}
    </div>
  );
}
