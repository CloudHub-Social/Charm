import { ChevronDown, Home, Plus, Users } from "lucide-react";
import type { ReactNode } from "react";
import { useMemo, useState } from "react";
import { useAtomValue } from "jotai";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { badgeAtom } from "@/features/shell/badgeAtom";
import type { RoomSummary } from "@/lib/matrix";
import { cn } from "@/lib/utils";
import { avatarColor, displayName, initials, resolveAvatar } from "./roomDisplay";

export type RoomListMode = "home" | "dms" | "space";

interface SpaceRailProps {
  rooms: RoomSummary[];
  activeMode: RoomListMode;
  activeSpaceId: string | null;
  onSelectHome: () => void;
  onSelectDms: () => void;
  onSelectSpace: (spaceId: string) => void;
  onCreateJoin: () => void;
}

export function SpaceRail({
  rooms,
  activeMode,
  activeSpaceId,
  onSelectHome,
  onSelectDms,
  onSelectSpace,
  onCreateJoin,
}: SpaceRailProps) {
  const [openFolders, setOpenFolders] = useState<Record<string, boolean>>({});
  const badge = useAtomValue(badgeAtom);
  const { topLevelSpaces, childSpacesByParent, directRooms } = useMemo(() => {
    const spaces = rooms.filter((room) => room.is_space);
    const knownSpaceIds = new Set(spaces.map((space) => space.room_id));
    const children = new Map<string, RoomSummary[]>();
    for (const space of spaces) {
      for (const parentId of space.parent_space_ids) {
        if (!knownSpaceIds.has(parentId)) continue;
        const list = children.get(parentId) ?? [];
        list.push(space);
        children.set(parentId, list);
      }
    }
    return {
      topLevelSpaces: spaces.filter((space) =>
        space.parent_space_ids.every((parentId) => !knownSpaceIds.has(parentId)),
      ),
      childSpacesByParent: children,
      directRooms: rooms.filter((room) => room.is_direct),
    };
  }, [rooms]);

  return (
    <TooltipProvider>
      <aside className="flex w-[72px] shrink-0 flex-col items-center border-r border-border bg-muted/25 py-3">
        <nav className="flex min-h-0 flex-1 flex-col items-center gap-2" aria-label="Spaces">
          <RailIconButton
            label="Home"
            active={activeMode === "home"}
            unread={badge?.total_unread ?? 0}
            highlight={badge?.total_highlight ?? 0}
            onClick={onSelectHome}
          >
            <Home aria-hidden="true" />
          </RailIconButton>
          <fieldset className="m-0 flex min-w-0 flex-col items-center gap-1 border-0 p-0">
            <legend className="sr-only">Direct messages</legend>
            <RailIconButton
              label="Direct messages"
              active={activeMode === "dms"}
              unread={directRooms.filter((room) => room.has_unread).length}
              onClick={onSelectDms}
            >
              <Users aria-hidden="true" />
            </RailIconButton>
            <div className="flex flex-col gap-1">
              {directRooms
                .filter((room) => room.has_unread)
                .slice(0, 3)
                .map((room) => (
                  <Tooltip key={room.room_id}>
                    <TooltipTrigger asChild>
                      <span className="block">
                        <Avatar size="sm">
                          <AvatarImage
                            src={resolveAvatar(room.avatar_path, room.avatar_url)}
                            alt=""
                          />
                          <AvatarFallback
                            style={{ background: avatarColor(room.room_id) }}
                            className="text-[10px] font-bold text-white"
                          >
                            {initials(room.room_id, room.name)}
                          </AvatarFallback>
                        </Avatar>
                      </span>
                    </TooltipTrigger>
                    <TooltipContent side="right">
                      {displayName(room.room_id, room.name)}
                    </TooltipContent>
                  </Tooltip>
                ))}
            </div>
          </fieldset>
          <div className="my-1 h-px w-8 bg-border" />
          <div className="flex min-h-0 flex-1 flex-col items-center gap-2 overflow-y-auto px-2">
            {topLevelSpaces.map((space) => {
              const children = childSpacesByParent.get(space.room_id) ?? [];
              const folderOpen = openFolders[space.room_id] ?? false;
              return (
                <div key={space.room_id} className="flex flex-col items-center gap-1">
                  <div className="relative flex h-11 w-14 items-center justify-center">
                    {children.length > 0 && (
                      <button
                        type="button"
                        aria-label={`${folderOpen ? "Collapse" : "Expand"} ${displayName(
                          space.room_id,
                          space.name,
                        )}`}
                        className="absolute left-0 flex size-4 items-center justify-center rounded-sm text-muted-foreground hover:bg-accent hover:text-foreground"
                        onClick={() =>
                          setOpenFolders((prev) => ({ ...prev, [space.room_id]: !folderOpen }))
                        }
                      >
                        <ChevronDown
                          aria-hidden="true"
                          className={cn("size-3 transition-transform", !folderOpen && "-rotate-90")}
                        />
                      </button>
                    )}
                    <SpaceButton
                      space={space}
                      active={activeMode === "space" && activeSpaceId === space.room_id}
                      unread={badge?.spaces[space.room_id]?.total_unread ?? 0}
                      highlight={badge?.spaces[space.room_id]?.total_highlight ?? 0}
                      onClick={() => onSelectSpace(space.room_id)}
                    />
                  </div>
                  {folderOpen && children.length > 0 && (
                    <div className="flex flex-col gap-1 rounded-md border border-border/60 p-1">
                      {children.map((child) => (
                        <SpaceButton
                          key={child.room_id}
                          space={child}
                          active={activeMode === "space" && activeSpaceId === child.room_id}
                          unread={badge?.spaces[child.room_id]?.total_unread ?? 0}
                          highlight={badge?.spaces[child.room_id]?.total_highlight ?? 0}
                          onClick={() => onSelectSpace(child.room_id)}
                        />
                      ))}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </nav>
        <RailIconButton label="Create or join space" active={false} onClick={onCreateJoin}>
          <Plus aria-hidden="true" />
        </RailIconButton>
      </aside>
    </TooltipProvider>
  );
}

interface RailIconButtonProps {
  label: string;
  active: boolean;
  unread?: number;
  highlight?: number;
  onClick: () => void;
  children: ReactNode;
}

function RailIconButton({
  label,
  active,
  unread = 0,
  highlight = 0,
  onClick,
  children,
}: RailIconButtonProps) {
  const accessibleLabel = labelWithBadge(label, unread, highlight);
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          aria-label={accessibleLabel}
          aria-current={active ? "page" : undefined}
          onClick={onClick}
          className={cn(
            "relative flex size-11 items-center justify-center rounded-md border text-foreground transition-colors",
            active
              ? "border-primary/50 bg-accent"
              : "border-transparent bg-background hover:border-border hover:bg-accent/70",
          )}
        >
          {children}
          <BadgeDot unread={unread} highlight={highlight} />
        </button>
      </TooltipTrigger>
      <TooltipContent side="right">{label}</TooltipContent>
    </Tooltip>
  );
}

interface SpaceButtonProps {
  space: RoomSummary;
  active: boolean;
  unread: number;
  highlight: number;
  onClick: () => void;
}

function SpaceButton({ space, active, unread, highlight, onClick }: SpaceButtonProps) {
  const label = displayName(space.room_id, space.name);
  const accessibleLabel = labelWithBadge(label, unread, highlight);
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          aria-label={accessibleLabel}
          aria-current={active ? "page" : undefined}
          onClick={onClick}
          className={cn(
            "relative flex size-11 items-center justify-center rounded-md border transition-colors",
            active
              ? "border-primary/50 bg-accent"
              : "border-transparent bg-background hover:border-border hover:bg-accent/70",
          )}
        >
          <Avatar size="sm">
            <AvatarImage src={resolveAvatar(space.avatar_path, space.avatar_url)} alt="" />
            <AvatarFallback
              style={{ background: avatarColor(space.room_id) }}
              className="text-xs font-bold text-white"
            >
              {initials(space.room_id, space.name)}
            </AvatarFallback>
          </Avatar>
          <BadgeDot unread={unread} highlight={highlight} />
        </button>
      </TooltipTrigger>
      <TooltipContent side="right">{label}</TooltipContent>
    </Tooltip>
  );
}

function labelWithBadge(label: string, unread: number, highlight: number) {
  const counts = [
    unread > 0 ? `${unread} unread` : null,
    highlight > 0 ? `${highlight} mentions` : null,
  ].filter(Boolean);
  return counts.length > 0 ? `${label}, ${counts.join(", ")}` : label;
}

function BadgeDot({ unread, highlight }: { unread: number; highlight: number }) {
  if (unread <= 0 && highlight <= 0) return null;
  const label = highlight > 0 ? highlight : unread;
  return (
    <span
      className={cn(
        "absolute -right-1 -top-1 flex h-4 min-w-4 items-center justify-center rounded-full px-1 text-[10px] font-bold",
        highlight > 0
          ? "bg-primary-solid text-primary-foreground"
          : "bg-muted-foreground text-background",
      )}
    >
      {label}
    </span>
  );
}
