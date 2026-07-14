import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import type { RoomSummary } from "@/lib/matrix";
import { avatarColor, displayName, initials, resolveAvatar } from "./roomDisplay";

interface RoomInviteItemProps {
  room: RoomSummary;
  pending: boolean;
  onAccept: () => void;
  onDecline: () => void;
}

export function RoomInviteItem({ room, pending, onAccept, onDecline }: RoomInviteItemProps) {
  const inviter = room.inviter_display_name ?? room.inviter_user_id;

  return (
    <div className="flex items-center gap-3 rounded-md border border-border bg-card px-3 py-2">
      <Avatar>
        <AvatarImage src={resolveAvatar(room.avatar_path, room.avatar_url)} alt="" />
        <AvatarFallback
          style={{ background: avatarColor(room.room_id) }}
          className="font-bold text-white"
        >
          {initials(room.room_id, room.name)}
        </AvatarFallback>
      </Avatar>
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-semibold text-foreground">
          {displayName(room.room_id, room.name)}
        </p>
        <p className="truncate text-xs text-muted-foreground">
          {inviter ? `${inviter} invited you` : "Room invitation"}
        </p>
        <div className="mt-2 flex gap-2">
          <Button size="xs" disabled={pending} onClick={onAccept}>
            {pending ? "Working…" : "Accept"}
          </Button>
          <Button size="xs" variant="outline" disabled={pending} onClick={onDecline}>
            Decline
          </Button>
        </div>
      </div>
    </div>
  );
}
