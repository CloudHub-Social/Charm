import { ChevronRight, Home, MessageCircle, Plus, UsersRound } from "lucide-react";
import { useMemo, type ReactNode } from "react";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import type { RoomSummary } from "@/lib/matrix";
import { avatarColor, displayName, initials, resolveAvatar } from "./roomDisplay";
import type { RoomListMode } from "./SpaceRail";
import { cn } from "@/lib/utils";

interface MobileSpacesViewProps {
  rooms: RoomSummary[];
  activeMode: RoomListMode;
  activeSpaceId: string | null;
  showAllRooms: boolean;
  onSelectHome: () => void;
  onSelectDms: () => void;
  onSelectSpace: (spaceId: string) => void;
  onCreateJoin: () => void;
}

interface SpaceEntry {
  room: RoomSummary;
  depth: number;
}

export function MobileSpacesView({
  rooms,
  activeMode,
  activeSpaceId,
  showAllRooms,
  onSelectHome,
  onSelectDms,
  onSelectSpace,
  onCreateJoin,
}: MobileSpacesViewProps) {
  const { spaces, unreadSpaceIds } = useMemo(
    () => ({ spaces: flattenSpaces(rooms), unreadSpaceIds: getUnreadSpaceIds(rooms) }),
    [rooms],
  );
  const homeUnread = rooms.filter(
    (room) =>
      !room.is_space &&
      !room.is_direct &&
      (showAllRooms || room.parent_space_ids.length === 0) &&
      room.has_unread,
  ).length;
  const dmUnread = rooms.filter((room) => room.is_direct && room.has_unread).length;

  return (
    <main className="flex min-h-0 min-w-0 flex-1 flex-col bg-[var(--ux-sidebar-bg)] pt-[env(safe-area-inset-top)] text-foreground">
      <header className="flex min-h-20 items-end justify-between border-b border-[var(--ux-shell-border)] px-5 pb-3">
        <div>
          <p className="text-xs font-semibold uppercase tracking-[0.14em] text-muted-foreground">
            Navigation
          </p>
          <h1 className="mt-0.5 text-2xl font-bold tracking-[-0.025em]">Spaces</h1>
        </div>
        <button
          type="button"
          onClick={onCreateJoin}
          className="flex size-11 items-center justify-center rounded-full text-[var(--ux-selection-strong)] transition active:bg-[var(--ux-selection)] active:opacity-70 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ux-shell-focus)]"
          aria-label="Add or join a space"
        >
          <Plus className="size-5" aria-hidden="true" />
        </button>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto px-3 py-3">
        <div className="overflow-hidden rounded-2xl bg-[var(--ux-content-raised)]">
          <DestinationRow
            icon={<Home className="size-5" aria-hidden="true" />}
            label="Home"
            detail="All conversations"
            count={homeUnread}
            active={activeMode === "home"}
            onClick={onSelectHome}
          />
          <div className="ml-16 border-t border-[var(--ux-shell-border)]" />
          <DestinationRow
            icon={<MessageCircle className="size-5" aria-hidden="true" />}
            label="Direct messages"
            detail="People and small groups"
            count={dmUnread}
            active={activeMode === "dms"}
            onClick={onSelectDms}
          />
        </div>

        <div className="mb-1 mt-6 flex items-center justify-between px-3">
          <h2 className="text-xs font-semibold uppercase tracking-[0.14em] text-muted-foreground">
            Your spaces
          </h2>
          <span className="text-xs text-muted-foreground">{spaces.length}</span>
        </div>
        {spaces.length === 0 ? (
          <button
            type="button"
            onClick={onCreateJoin}
            className="mt-2 flex min-h-24 w-full items-center gap-3 rounded-2xl border border-dashed border-[var(--ux-shell-border-strong)] px-4 text-left text-sm text-muted-foreground transition active:bg-[var(--ux-selection)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ux-shell-focus)]"
          >
            <span className="flex size-10 items-center justify-center rounded-xl bg-[var(--ux-selection)] text-[var(--ux-selection-strong)]">
              <UsersRound className="size-5" aria-hidden="true" />
            </span>
            <span>
              <span className="block font-semibold text-foreground">Create or join a space</span>
              Group related rooms without changing how conversations work.
            </span>
          </button>
        ) : (
          <div className="overflow-hidden rounded-2xl bg-[var(--ux-content-raised)]">
            {spaces.map(({ room, depth }, index) => {
              const active = activeMode === "space" && activeSpaceId === room.room_id;
              const attention = unreadSpaceIds.has(room.room_id);
              const label = displayName(room.room_id, room.name);
              return (
                <div key={room.room_id}>
                  {index > 0 && <div className="ml-16 border-t border-[var(--ux-shell-border)]" />}
                  <button
                    type="button"
                    aria-current={active ? "page" : undefined}
                    aria-label={`${label}${attention ? ", unread activity" : ""}`}
                    onClick={() => onSelectSpace(room.room_id)}
                    className={cn(
                      "relative flex min-h-16 w-full items-center gap-3 px-3 text-left transition active:opacity-65 focus-visible:z-10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--ux-shell-focus)]",
                      active && "bg-[var(--ux-selection)]",
                    )}
                    style={{ paddingInlineStart: 12 + Math.min(depth, 2) * 18 }}
                  >
                    {active && (
                      <span
                        aria-hidden="true"
                        className="absolute inset-y-3 left-0 w-1 rounded-r-full bg-[var(--ux-selection-strong)]"
                      />
                    )}
                    <Avatar size="lg" className="size-11 shrink-0 rounded-[15px_12px_14px_13px]">
                      <AvatarImage src={resolveAvatar(room.avatar_path, room.avatar_url)} alt="" />
                      <AvatarFallback
                        style={{ background: avatarColor(room.room_id) }}
                        className="text-xs font-bold text-white"
                      >
                        {initials(room.room_id, room.name)}
                      </AvatarFallback>
                    </Avatar>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm font-semibold">{label}</span>
                      <span className="mt-0.5 block truncate text-xs text-muted-foreground">
                        {depth > 0 ? "Nested space" : "Space"}
                      </span>
                    </span>
                    {attention && (
                      <span
                        className="size-2.5 rounded-full bg-[var(--ux-rail-unread)]"
                        aria-hidden="true"
                      />
                    )}
                    <ChevronRight className="size-4 text-muted-foreground" aria-hidden="true" />
                  </button>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </main>
  );
}

function DestinationRow({
  icon,
  label,
  detail,
  count,
  active,
  onClick,
}: {
  icon: ReactNode;
  label: string;
  detail: string;
  count: number;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      aria-current={active ? "page" : undefined}
      onClick={onClick}
      className={cn(
        "relative flex min-h-16 w-full items-center gap-3 px-3 text-left transition active:opacity-65 focus-visible:z-10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--ux-shell-focus)]",
        active && "bg-[var(--ux-selection)]",
      )}
    >
      {active && (
        <span
          aria-hidden="true"
          className="absolute inset-y-3 left-0 w-1 rounded-r-full bg-[var(--ux-selection-strong)]"
        />
      )}
      <span className="flex size-11 shrink-0 items-center justify-center rounded-xl bg-[var(--ux-selection)] text-[var(--ux-selection-strong)]">
        {icon}
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm font-semibold">{label}</span>
        <span className="mt-0.5 block truncate text-xs text-muted-foreground">{detail}</span>
      </span>
      {count > 0 && (
        <span className="flex min-w-6 items-center justify-center rounded-full bg-[var(--ux-badge)] px-1.5 py-0.5 text-xs font-bold text-[var(--ux-badge-text)]">
          {count}
        </span>
      )}
      <ChevronRight className="size-4 text-muted-foreground" aria-hidden="true" />
    </button>
  );
}

function flattenSpaces(rooms: RoomSummary[]): SpaceEntry[] {
  const spaces = rooms.filter((room) => room.is_space);
  const knownIds = new Set(spaces.map((room) => room.room_id));
  const children = new Map<string, RoomSummary[]>();
  for (const space of spaces) {
    for (const parentId of space.parent_space_ids) {
      if (!knownIds.has(parentId)) continue;
      children.set(parentId, [...(children.get(parentId) ?? []), space]);
    }
  }
  const roots = spaces.filter(
    (space) => !space.parent_space_ids.some((parentId) => knownIds.has(parentId)),
  );
  const entries: SpaceEntry[] = [];
  const visited = new Set<string>();
  const visit = (space: RoomSummary, depth: number) => {
    if (visited.has(space.room_id)) return;
    visited.add(space.room_id);
    entries.push({ room: space, depth });
    for (const child of children.get(space.room_id) ?? []) visit(child, depth + 1);
  };
  for (const root of roots) visit(root, 0);
  for (const rootless of spaces) visit(rootless, 0);
  return entries;
}

function getUnreadSpaceIds(rooms: RoomSummary[]): Set<string> {
  const parentIdsBySpace = new Map(
    rooms.filter((room) => room.is_space).map((room) => [room.room_id, room.parent_space_ids]),
  );
  const unreadSpaceIds = new Set<string>();
  for (const room of rooms) {
    if (!room.has_unread) continue;
    const pending = room.is_space
      ? [room.room_id, ...room.parent_space_ids]
      : room.parent_space_ids;
    while (pending.length > 0) {
      const spaceId = pending.pop();
      if (!spaceId || unreadSpaceIds.has(spaceId)) continue;
      unreadSpaceIds.add(spaceId);
      pending.push(...(parentIdsBySpace.get(spaceId) ?? []));
    }
  }
  return unreadSpaceIds;
}
