import type { PresenceUpdate, RoomSummary } from "@/lib/matrix";
import { ArrowLeft, Info, MoreVertical, Pin, Settings } from "lucide-react";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { PresenceDot } from "@/features/presence/PresenceDot";
import { cn } from "@/lib/utils";
import { avatarColor, displayName, initials, resolveAvatar } from "./roomDisplay";

interface ChatHeaderProps {
  room: RoomSummary;
  mobile: boolean;
  onBack?: () => void;
  presence: PresenceUpdate | null;
  membersDrawerOpen: boolean;
  onToggleMembers: () => void;
  messagePinningEnabled: boolean;
  pinnedMessagesDrawerOpen: boolean;
  pinnedMessageCount: number;
  onTogglePinnedMessages: () => void;
  onOpenRoomSettings: () => void;
}

export function ChatHeader({
  room,
  mobile,
  onBack,
  presence,
  membersDrawerOpen,
  onToggleMembers,
  messagePinningEnabled,
  pinnedMessagesDrawerOpen,
  pinnedMessageCount,
  onTogglePinnedMessages,
  onOpenRoomSettings,
}: ChatHeaderProps) {
  return (
    <div
      className={cn(
        "flex items-center justify-between border-b border-border",
        mobile ? "h-14 gap-1 px-1.5" : "gap-2 p-4",
      )}
    >
      {mobile && (
        <button
          type="button"
          aria-label="Back to chats"
          onClick={onBack}
          className="flex size-11 shrink-0 items-center justify-center rounded-full text-foreground hover:bg-accent"
        >
          <ArrowLeft className="size-5" />
        </button>
      )}
      <div className="flex min-w-0 items-center gap-2 text-[15px] font-bold text-foreground">
        <Avatar size="sm">
          <AvatarImage src={resolveAvatar(room.avatar_path, room.avatar_url)} alt="" />
          <AvatarFallback
            style={{ background: avatarColor(room.room_id) }}
            className="font-bold text-white"
          >
            {initials(room.room_id, room.name)}
          </AvatarFallback>
          {room.is_direct && (
            <PresenceDot
              presence={presence?.presence}
              statusMsg={presence?.status_msg}
              lastActiveAgoMs={presence?.last_active_ago_ms}
              updateToken={presence}
            />
          )}
        </Avatar>
        <span className="truncate">{displayName(room.room_id, room.name)}</span>
      </div>
      {mobile ? (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              aria-label="Room actions"
              className="flex size-11 shrink-0 items-center justify-center rounded-full text-muted-foreground hover:bg-accent hover:text-accent-foreground"
            >
              <MoreVertical className="size-5" />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="min-w-48">
            <DropdownMenuItem className="min-h-11" onSelect={onToggleMembers}>
              <Info />
              {membersDrawerOpen ? "Hide members" : "Show members"}
            </DropdownMenuItem>
            {messagePinningEnabled && (
              <DropdownMenuItem className="min-h-11" onSelect={onTogglePinnedMessages}>
                <Pin />
                {pinnedMessagesDrawerOpen ? "Hide pinned messages" : "Pinned messages"}
                {pinnedMessageCount > 0 && ` (${pinnedMessageCount})`}
              </DropdownMenuItem>
            )}
            <DropdownMenuItem className="min-h-11" onSelect={onOpenRoomSettings}>
              <Settings />
              Room settings
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      ) : (
        <div className="flex shrink-0 items-center gap-1">
          <button
            type="button"
            aria-label={membersDrawerOpen ? "Hide members" : "Show members"}
            aria-pressed={membersDrawerOpen}
            onClick={onToggleMembers}
            className={cn(
              "flex size-8 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-accent-foreground",
              membersDrawerOpen && "bg-accent text-accent-foreground",
            )}
          >
            <Info className="size-4" />
          </button>
          {messagePinningEnabled && (
            <button
              type="button"
              aria-label={
                pinnedMessagesDrawerOpen ? "Hide pinned messages" : "Show pinned messages"
              }
              aria-pressed={pinnedMessagesDrawerOpen}
              onClick={onTogglePinnedMessages}
              className={cn(
                "relative flex size-8 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-accent-foreground",
                pinnedMessagesDrawerOpen && "bg-accent text-accent-foreground",
              )}
            >
              <Pin className="size-4" />
              {pinnedMessageCount > 0 && (
                <span className="absolute -right-1 -top-1 flex h-4 min-w-4 items-center justify-center rounded-full bg-primary px-1 text-[10px] font-bold leading-none text-primary-foreground">
                  {pinnedMessageCount}
                </span>
              )}
            </button>
          )}
          <button
            type="button"
            aria-label="Room settings"
            onClick={onOpenRoomSettings}
            className="flex size-8 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-accent-foreground"
          >
            <Settings className="size-4" />
          </button>
        </div>
      )}
    </div>
  );
}
