import { useAtomValue } from "jotai";
import { useDrag } from "@use-gesture/react";
import { SettingsIcon } from "lucide-react";
import { useMemo, useState } from "react";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { PresenceDot } from "@/features/presence/PresenceDot";
import { useOwnProfile } from "@/features/profile/useOwnProfile";
import { useSettingsNavigation } from "@/features/settings/useSettingsNavigation";
import { badgeAtom } from "@/features/shell/badgeAtom";
import {
  markRoomRead,
  setRoomFavourite,
  setRoomLowPriority,
  setRoomManualOrder,
  setRoomMarkedUnread,
  setRoomMuted,
  type RoomSummary,
} from "@/lib/matrix";
import { cn } from "@/lib/utils";
import { RoomListItem } from "./RoomListItem";
import { RoomListSection } from "./SpaceSection";
import { SpaceBrowser } from "./SpaceBrowser";
import { groupRoomsIntoSections, planManualReorder } from "./roomSections";
import { avatarColor, displayName, initials, resolveAvatar } from "./roomDisplay";
import { logAndIgnore } from "@/lib/logAndIgnore";

interface RoomListProps {
  rooms: RoomSummary[];
  activeRoomId: string | null;
  onSelectRoom: (id: string) => void;
}

// Matches RoomListItem's `min-h-11` (2.75rem) row height plus its `gap-0.5`
// spacing — used to translate a drag's pixel delta into a target index.
const ROW_HEIGHT_PX = 46;

function reorderWithin(sectionRooms: RoomSummary[], roomId: string, targetIndex: number) {
  const updates = planManualReorder(sectionRooms, roomId, targetIndex);
  for (const { room_id, order } of updates) {
    setRoomManualOrder(room_id, order).catch(logAndIgnore);
  }
}

export function RoomList({ rooms, activeRoomId, onSelectRoom }: RoomListProps) {
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [browsingSpace, setBrowsingSpace] = useState<RoomSummary | null>(null);
  const { data: ownProfile } = useOwnProfile();
  const { openSettings } = useSettingsNavigation();
  const badge = useAtomValue(badgeAtom);

  const sections = useMemo(() => groupRoomsIntoSections(rooms), [rooms]);

  function isExpanded(key: string): boolean {
    return expanded[key] ?? true;
  }

  function renderSectionRooms(sectionRooms: RoomSummary[]) {
    return sectionRooms.map((room, index) => (
      <DraggableRoomRow
        key={room.room_id}
        room={room}
        index={index}
        sectionRooms={sectionRooms}
        active={room.room_id === activeRoomId}
        onSelect={() => onSelectRoom(room.room_id)}
        onReorder={(targetIndex) => reorderWithin(sectionRooms, room.room_id, targetIndex)}
      />
    ));
  }

  const allEmpty =
    sections.favourites.length === 0 &&
    sections.spaceGroups.length === 0 &&
    sections.rooms.length === 0 &&
    sections.lowPriority.length === 0;

  return (
    <aside className="flex w-[280px] shrink-0 flex-col border-r border-border">
      <div className="flex items-center justify-between gap-2 p-4">
        {ownProfile ? (
          <div className="flex min-w-0 items-center gap-2">
            <Avatar size="sm">
              <AvatarImage src={resolveAvatar(ownProfile.avatar_path)} alt="" />
              <AvatarFallback
                style={{ background: avatarColor(ownProfile.user_id) }}
                className="font-bold text-white"
              >
                {initials(ownProfile.user_id, ownProfile.display_name)}
              </AvatarFallback>
              <PresenceDot presence={ownProfile.presence} />
            </Avatar>
            <span className="truncate text-base font-bold text-foreground">
              {ownProfile.display_name ?? ownProfile.user_id}
            </span>
          </div>
        ) : (
          <span className="text-base font-bold text-foreground">Charm</span>
        )}
        <div className="flex shrink-0 items-center gap-2">
          {badge && badge.total_unread > 0 && (
            <span
              className={cn(
                "flex h-[18px] min-w-[18px] items-center justify-center rounded-full px-1 text-[11px] font-bold",
                badge.total_highlight > 0
                  ? "bg-primary text-primary-foreground"
                  : "bg-muted text-muted-foreground",
              )}
              aria-label={`${badge.total_unread} unread rooms${
                badge.total_highlight > 0 ? `, ${badge.total_highlight} mentions` : ""
              }`}
            >
              {badge.total_highlight > 0 ? badge.total_highlight : badge.total_unread}
            </span>
          )}
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label="Open settings"
            onClick={() => openSettings("account")}
          >
            <SettingsIcon />
          </Button>
        </div>
      </div>
      <div className="flex-1 overflow-y-auto px-2 pb-2">
        {allEmpty ? (
          <p className="px-3 py-2 text-sm text-muted-foreground">No rooms yet</p>
        ) : (
          <div className="flex flex-col gap-2">
            <RoomListSection
              title="Favourites"
              count={sections.favourites.length}
              expanded={isExpanded("favourites")}
              onExpandedChange={(v) => setExpanded((prev) => ({ ...prev, favourites: v }))}
            >
              {renderSectionRooms(sections.favourites)}
            </RoomListSection>

            {sections.spaceGroups.map(({ space, rooms: spaceRooms }) => (
              <div key={space.room_id}>
                <button
                  onClick={() => setBrowsingSpace(space)}
                  className="w-full truncate rounded-md px-3 py-1 text-left text-xs font-semibold text-muted-foreground hover:text-foreground"
                >
                  {displayName(space.room_id, space.name)}
                </button>
                <RoomListSection
                  title={displayName(space.room_id, space.name)}
                  count={spaceRooms.length}
                  expanded={isExpanded(space.room_id)}
                  onExpandedChange={(v) => setExpanded((prev) => ({ ...prev, [space.room_id]: v }))}
                >
                  {renderSectionRooms(spaceRooms)}
                </RoomListSection>
              </div>
            ))}

            <RoomListSection
              title="Rooms"
              count={sections.rooms.length}
              expanded={isExpanded("rooms")}
              onExpandedChange={(v) => setExpanded((prev) => ({ ...prev, rooms: v }))}
            >
              {renderSectionRooms(sections.rooms)}
            </RoomListSection>

            <RoomListSection
              title="Low priority"
              count={sections.lowPriority.length}
              expanded={isExpanded("lowPriority")}
              onExpandedChange={(v) => setExpanded((prev) => ({ ...prev, lowPriority: v }))}
            >
              {renderSectionRooms(sections.lowPriority)}
            </RoomListSection>
          </div>
        )}
      </div>
      <SpaceBrowser
        space={browsingSpace}
        onOpenChange={(open) => !open && setBrowsingSpace(null)}
      />
    </aside>
  );
}

interface DraggableRoomRowProps {
  room: RoomSummary;
  index: number;
  sectionRooms: RoomSummary[];
  active: boolean;
  onSelect: () => void;
  onReorder: (targetIndex: number) => void;
}

function DraggableRoomRow({
  room,
  index,
  sectionRooms,
  active,
  onSelect,
  onReorder,
}: DraggableRoomRowProps) {
  const [dragOffset, setDragOffset] = useState(0);
  const [dragging, setDragging] = useState(false);

  const bind = useDrag(
    ({ movement: [, my], down }) => {
      setDragging(down);
      setDragOffset(down ? my : 0);
      if (!down) {
        const targetIndex = Math.round(index + my / ROW_HEIGHT_PX);
        const clamped = Math.max(0, Math.min(targetIndex, sectionRooms.length - 1));
        if (clamped !== index) {
          onReorder(clamped);
        }
      }
    },
    {
      axis: "y",
      filterTaps: true,
    },
  );

  return (
    <RoomListItem
      room={room}
      active={active}
      onSelect={onSelect}
      onToggleFavourite={() =>
        setRoomFavourite(room.room_id, !room.is_favourite).catch(logAndIgnore)
      }
      onToggleLowPriority={() =>
        setRoomLowPriority(room.room_id, !room.is_low_priority).catch(logAndIgnore)
      }
      onToggleMuted={() => setRoomMuted(room.room_id, !room.is_muted).catch(logAndIgnore)}
      onMarkRead={() => markRoomRead(room.room_id).catch(logAndIgnore)}
      onMarkUnread={() => setRoomMarkedUnread(room.room_id, true).catch(logAndIgnore)}
      dragHandleProps={bind()}
      style={{
        transform: dragging ? `translateY(${dragOffset}px)` : undefined,
        position: dragging ? "relative" : undefined,
        zIndex: dragging ? 10 : undefined,
        // Only opt out of touch scrolling while a drag is actually in
        // progress — applying this unconditionally would swallow a normal
        // vertical scroll gesture that merely starts on a room row.
        touchAction: dragging ? "none" : undefined,
      }}
    />
  );
}
