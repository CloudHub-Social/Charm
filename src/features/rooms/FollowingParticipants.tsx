import type { RoomMemberSummary } from "@/lib/matrix";
import { avatarColor, initials } from "./roomDisplay";
import { followingLabel } from "./useRoomParticipants";

interface FollowingParticipantsProps {
  participants: RoomMemberSummary[];
  expanded: boolean;
  onToggle: () => void;
}

export function FollowingParticipants({
  participants,
  expanded,
  onToggle,
}: FollowingParticipantsProps) {
  if (participants.length === 0) return null;
  return (
    <button
      type="button"
      aria-expanded={expanded}
      onClick={onToggle}
      className="w-full border-t border-border px-4 py-2 text-left text-xs text-muted-foreground hover:bg-accent/50"
    >
      {followingLabel(
        participants.map((participant) => participant.display_name ?? participant.user_id),
      )}
      {expanded && (
        <div className="mt-1.5 flex flex-col gap-1">
          {participants.map((participant) => (
            <span key={participant.user_id} className="flex items-center gap-2 text-foreground">
              <span
                className="flex size-4 shrink-0 items-center justify-center rounded-full text-[7px] font-bold text-white"
                style={{ background: avatarColor(participant.user_id) }}
              >
                {initials(participant.user_id, participant.display_name)}
              </span>
              {participant.display_name ?? participant.user_id}
            </span>
          ))}
        </div>
      )}
    </button>
  );
}
