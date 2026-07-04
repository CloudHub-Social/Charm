import { RoomListItem } from "./RoomListItem";
import type { RoomSummary } from "@/lib/matrix";

interface RoomListProps {
  rooms: RoomSummary[];
  activeRoomId: string | null;
  onSelectRoom: (id: string) => void;
}

export function RoomList({ rooms, activeRoomId, onSelectRoom }: RoomListProps) {
  return (
    <aside className="flex w-[280px] shrink-0 flex-col border-r border-border">
      <div className="flex items-center justify-between p-4">
        <span className="text-base font-bold text-foreground">Charm</span>
      </div>
      <div className="flex-1 overflow-y-auto px-2 pb-2">
        {rooms.length === 0 ? (
          <p className="px-3 py-2 text-sm text-muted-foreground">No rooms yet</p>
        ) : (
          <div className="flex flex-col gap-0.5">
            {rooms.map((room) => (
              <RoomListItem
                key={room.room_id}
                room={room}
                active={room.room_id === activeRoomId}
                onSelect={() => onSelectRoom(room.room_id)}
              />
            ))}
          </div>
        )}
      </div>
    </aside>
  );
}
