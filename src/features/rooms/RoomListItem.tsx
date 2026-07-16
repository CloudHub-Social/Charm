import { BellOff } from "lucide-react";
import { useAtomValue } from "jotai";
import type { CSSProperties } from "react";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import { PresenceDot } from "@/features/presence/PresenceDot";
import { showUnreadCountsAtom } from "@/features/appearance/atoms";
import { useFlag } from "@/featureFlags";
import { usePresence } from "@/features/presence/usePresence";
import { cn } from "@/lib/utils";
import type { RoomSummary } from "@/lib/matrix";
import { avatarColor, displayName, initials, resolveAvatar } from "./roomDisplay";

interface RoomListItemProps {
  room: RoomSummary;
  active: boolean;
  onSelect: () => void;
  onToggleFavourite?: () => void;
  onToggleLowPriority?: () => void;
  onToggleMuted?: () => void;
  onMarkRead?: () => void;
  onMarkUnread?: () => void;
  /** Spread onto the root element by the drag-reorder gesture in `RoomList.tsx`. */
  dragHandleProps?: Record<string, unknown>;
  style?: CSSProperties;
}

export function RoomListItem({
  room,
  active,
  onSelect,
  onToggleFavourite,
  onToggleLowPriority,
  onToggleMuted,
  onMarkRead,
  onMarkUnread,
  dragHandleProps,
  style,
}: RoomListItemProps) {
  const unread = room.has_unread;
  const showUnreadCounts = useAtomValue(showUnreadCountsAtom);
  const ambientUnreadCountEnabled = useFlag("room_list_unread_filter") && showUnreadCounts;
  const showNotificationCount = room.unread_count > 0;
  const showAmbientUnreadCount =
    !showNotificationCount && unread && ambientUnreadCountEnabled && room.unread_messages > 0;
  const presence = usePresence(room.is_direct ? room.dm_peer_user_id : null);
  const messagePreviewEnabled = useFlag("room_list_message_preview");
  const preview = room.last_message_preview;
  const previewSenderLabel = preview?.sender_display_name ?? preview?.sender_id.split(":")[0];

  const button = (
    <button
      onClick={onSelect}
      style={style}
      className={cn(
        "flex min-h-11 w-full items-center gap-3 rounded-md px-3 py-2 text-left transition-colors",
        active ? "bg-accent" : "hover:bg-accent/50",
      )}
      {...dragHandleProps}
    >
      <Avatar>
        <AvatarImage src={resolveAvatar(room.avatar_path, room.avatar_url)} alt="" />
        <AvatarFallback
          style={{ background: avatarColor(room.room_id) }}
          className="font-bold text-white"
        >
          {initials(room.room_id, room.name)}
        </AvatarFallback>
        {room.is_direct && <PresenceDot presence={presence?.presence} />}
      </Avatar>
      <div className="flex min-w-0 flex-1 flex-col justify-center gap-0.5">
        <div className="flex min-w-0 items-baseline justify-between gap-2">
          <span className="flex min-w-0 items-center gap-1.5">
            {room.is_marked_unread && (
              <span className="flex shrink-0 items-center">
                <span aria-hidden="true" className="size-2 rounded-full bg-primary" />
                <span className="sr-only">Marked unread</span>
              </span>
            )}
            <span
              className={cn(
                "truncate text-sm",
                unread ? "font-bold text-foreground" : "font-medium text-secondary-foreground",
              )}
            >
              {displayName(room.room_id, room.name)}
            </span>
            {room.is_muted && (
              <BellOff aria-label="Muted" className="size-3.5 shrink-0 text-muted-foreground" />
            )}
          </span>
          {/* `bg-primary-solid` (not `bg-primary`): solid fill under
              near-white text — see button.tsx's comment / tokens.css.
              Precedence: numeric badge (unread_count > 0) > plain unread dot
              (has_unread but nothing counts as a notification) > bold
              room-name text alone. The dot is additive — bold text still
              applies whenever `unread` is true. Suppressed when
              `is_marked_unread` is true: `has_unread` is already true in that
              case (see `has_unread` in rooms.rs), and the name-prefix "Marked
              unread" dot above already covers it — without this guard both
              dots would render for the same room. */}
          {showNotificationCount ? (
            <span
              aria-label={`${room.unread_count} notifications`}
              className="flex h-[18px] min-w-[18px] shrink-0 items-center justify-center rounded-full bg-primary-solid px-1 text-[11px] font-bold text-primary-foreground"
            >
              {room.unread_count}
            </span>
          ) : showAmbientUnreadCount ? (
            <span
              aria-label={`${room.unread_messages} unread messages`}
              className="flex h-[18px] min-w-[18px] shrink-0 items-center justify-center rounded-full bg-secondary px-1 text-[11px] font-bold text-secondary-foreground"
            >
              {room.unread_messages}
            </span>
          ) : (
            !room.is_marked_unread &&
            room.has_unread && (
              <span className="flex shrink-0 items-center">
                <span aria-hidden="true" className="size-2 rounded-full bg-primary" />
                <span className="sr-only">Unread</span>
              </span>
            )
          )}
        </div>
        {messagePreviewEnabled && preview && (
          <p className="min-w-0 truncate text-xs text-muted-foreground">
            {previewSenderLabel && <span className="font-medium">{previewSenderLabel}: </span>}
            {preview.text}
          </p>
        )}
      </div>
    </button>
  );

  const hasMenuActions =
    onToggleFavourite || onToggleLowPriority || onToggleMuted || onMarkRead || onMarkUnread;
  if (!hasMenuActions) {
    return button;
  }

  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>{button}</ContextMenuTrigger>
      <ContextMenuContent>
        {onToggleFavourite && (
          <ContextMenuItem onSelect={onToggleFavourite}>
            {room.is_favourite ? "Remove from Favourites" : "Add to Favourites"}
          </ContextMenuItem>
        )}
        {onToggleLowPriority && (
          <ContextMenuItem onSelect={onToggleLowPriority}>
            {room.is_low_priority ? "Remove from Low priority" : "Move to Low priority"}
          </ContextMenuItem>
        )}
        {onToggleMuted && (
          <ContextMenuItem onSelect={onToggleMuted}>
            {room.is_muted ? "Unmute" : "Mute"}
          </ContextMenuItem>
        )}
        {(onMarkRead || onMarkUnread) && <ContextMenuSeparator />}
        {onMarkRead && <ContextMenuItem onSelect={onMarkRead}>Mark as read</ContextMenuItem>}
        {onMarkUnread && <ContextMenuItem onSelect={onMarkUnread}>Mark as unread</ContextMenuItem>}
      </ContextMenuContent>
    </ContextMenu>
  );
}
