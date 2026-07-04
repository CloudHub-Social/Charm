import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { cn } from "@/lib/utils";
import type { RoomSummary } from "@/lib/matrix";
import { avatarColor, displayName, initials } from "./roomDisplay";

interface RoomListItemProps {
  room: RoomSummary;
  active: boolean;
  onSelect: () => void;
}

export function RoomListItem({ room, active, onSelect }: RoomListItemProps) {
  const unread = room.unread_count > 0;

  return (
    <button
      onClick={onSelect}
      className={cn(
        "flex min-h-11 w-full items-center gap-3 rounded-md px-3 py-2 text-left transition-colors",
        active ? "bg-accent" : "hover:bg-accent/50",
      )}
    >
      <Avatar>
        <AvatarFallback
          style={{ background: avatarColor(room.room_id) }}
          className="font-bold text-white"
        >
          {initials(room.room_id, room.name)}
        </AvatarFallback>
      </Avatar>
      <div className="flex min-w-0 flex-1 items-baseline justify-between gap-2">
        <span
          className={cn(
            "truncate text-sm",
            unread ? "font-bold text-foreground" : "font-medium text-secondary-foreground",
          )}
        >
          {displayName(room.room_id, room.name)}
        </span>
        {unread && (
          <span className="flex h-[18px] min-w-[18px] shrink-0 items-center justify-center rounded-full bg-primary px-1 text-[11px] font-bold text-primary-foreground">
            {room.unread_count}
          </span>
        )}
      </div>
    </button>
  );
}
