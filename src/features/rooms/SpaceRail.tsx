import {
  ChevronDown,
  DoorOpen,
  FolderPlus,
  Home,
  LogIn,
  LogOut,
  Pin,
  PinOff,
  Plus,
  Star,
  StarOff,
  UserPlus,
  Users,
} from "lucide-react";
import type { ReactNode } from "react";
import { useEffect, useMemo, useRef, useState } from "react";
import { useAtomValue } from "jotai";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { useFlag } from "@/featureFlags";
import { badgeAtom } from "@/features/shell/badgeAtom";
import { removeSpaceChild, setSpaceChildSuggested, type RoomSummary } from "@/lib/matrix";
import { cn } from "@/lib/utils";
import { AddExistingToSpaceDialog } from "./AddExistingToSpaceDialog";
import { InviteToSpaceDialog } from "./InviteToSpaceDialog";
import { LeaveSpaceDialog } from "./LeaveSpaceDialog";
import { avatarColor, displayName, initials, resolveAvatar } from "./roomDisplay";
import { moveSpaceInOrder, orderSpaceIds } from "./spaceRailPrefs";
import { useSpaceRailPrefsSync } from "./useSpaceRailPrefsSync";

export type RoomListMode = "home" | "dms" | "space";

interface SpaceRailProps {
  rooms: RoomSummary[];
  activeMode: RoomListMode;
  activeSpaceId: string | null;
  showAllRooms: boolean;
  /** Scopes locally cached pin/order state (`useSpaceRailPrefsSync`) to the
   * signed-in account, so switching accounts on the same device never
   * inherits — or overwrites — a different account's rail preferences. */
  currentUserId: string;
  onSelectHome: () => void;
  onSelectDms: () => void;
  onSelectSpace: (spaceId: string) => void;
  onCreateJoin: () => void;
}

export function SpaceRail({
  rooms,
  activeMode,
  activeSpaceId,
  showAllRooms,
  currentUserId,
  onSelectHome,
  onSelectDms,
  onSelectSpace,
  onCreateJoin,
}: SpaceRailProps) {
  const managementEnabled = useFlag("space_rail_management");
  const [openFolders, setOpenFolders] = useState<Record<string, boolean>>({});
  const [prefs, setPrefs] = useSpaceRailPrefsSync(currentUserId);
  const [inviteTarget, setInviteTarget] = useState<{ spaceId: string; name: string } | null>(null);
  const [leaveTarget, setLeaveTarget] = useState<{ spaceId: string; name: string } | null>(null);
  const [addExistingTarget, setAddExistingTarget] = useState<{
    spaceId: string;
    name: string;
  } | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const actionErrorTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    return () => {
      if (actionErrorTimeoutRef.current) clearTimeout(actionErrorTimeoutRef.current);
    };
  }, []);
  function reportActionError(err: unknown) {
    setActionError(err instanceof Error ? err.message : String(err));
    if (actionErrorTimeoutRef.current) clearTimeout(actionErrorTimeoutRef.current);
    actionErrorTimeoutRef.current = setTimeout(() => setActionError(null), 5000);
  }
  const badge = useAtomValue(badgeAtom);
  const { topLevelSpaces, childSpacesByParent, parentSpaceIdsByChild, directRooms } =
    useMemo(() => {
      const spaces = rooms.filter((room) => room.is_space);
      const knownSpaceIds = new Set(spaces.map((space) => space.room_id));
      const children = new Map<string, RoomSummary[]>();
      const parents = new Map<string, string[]>();
      for (const space of spaces) {
        for (const parentId of space.parent_space_ids) {
          parents.set(space.room_id, [...(parents.get(space.room_id) ?? []), parentId]);
          if (knownSpaceIds.has(parentId)) {
            const list = children.get(parentId) ?? [];
            list.push(space);
            children.set(parentId, list);
          }
        }
      }
      const rootSpaces = spaces.filter((space) =>
        space.parent_space_ids.every((parentId) => !knownSpaceIds.has(parentId)),
      );
      const reachableSpaceIds = new Set<string>();
      const stack = [...rootSpaces];
      while (stack.length > 0) {
        const space = stack.pop();
        if (!space || reachableSpaceIds.has(space.room_id)) continue;
        reachableSpaceIds.add(space.room_id);
        stack.push(...(children.get(space.room_id) ?? []));
      }
      const rootlessSpaces = spaces.filter((space) => !reachableSpaceIds.has(space.room_id));
      return {
        topLevelSpaces: [...rootSpaces, ...rootlessSpaces],
        childSpacesByParent: children,
        parentSpaceIdsByChild: parents,
        directRooms: rooms.filter((room) => room.is_direct),
      };
    }, [rooms]);
  // Behind the `space_rail_management` flag: with it off, every top-level
  // space stays pinned in its natural (room-list) order, matching this
  // component's pre-Spec-63 behavior exactly — `prefs` never influences
  // rendering, and the sync effects in `useSpaceRailPrefsSync` become inert
  // reads/writes of a value nothing displays.
  const unpinnedIds = useMemo(
    () => (managementEnabled ? new Set(prefs.unpinned) : new Set<string>()),
    [managementEnabled, prefs.unpinned],
  );
  const pinnedTopLevelSpaces = useMemo(() => {
    if (!managementEnabled) return topLevelSpaces;
    const pinned = topLevelSpaces.filter((space) => !unpinnedIds.has(space.room_id));
    const order = orderSpaceIds(
      pinned.map((space) => space.room_id),
      prefs.order,
    );
    const byId = new Map(pinned.map((space) => [space.room_id, space]));
    return order
      .map((id) => byId.get(id))
      .filter((space): space is RoomSummary => space !== undefined);
  }, [managementEnabled, topLevelSpaces, unpinnedIds, prefs.order]);
  const unpinnedTopLevelSpaces = useMemo(
    () =>
      managementEnabled ? topLevelSpaces.filter((space) => unpinnedIds.has(space.room_id)) : [],
    [managementEnabled, topLevelSpaces, unpinnedIds],
  );

  function setPinned(spaceId: string, pinned: boolean) {
    setPrefs((prev) => ({
      ...prev,
      unpinned: pinned
        ? prev.unpinned.filter((id) => id !== spaceId)
        : prev.unpinned.includes(spaceId)
          ? prev.unpinned
          : [...prev.unpinned, spaceId],
    }));
  }

  function moveSpace(spaceId: string, direction: "up" | "down") {
    setPrefs((prev) => ({
      ...prev,
      order: moveSpaceInOrder(
        pinnedTopLevelSpaces.map((space) => space.room_id),
        prev.order,
        spaceId,
        direction,
      ),
    }));
  }

  const directUnreadCount = directRooms.filter((room) => room.has_unread).length;
  const directHighlightCount = directRooms.reduce((sum, room) => sum + room.unread_count, 0);
  const homeBadge = useMemo(() => getHomeBadge(rooms, showAllRooms), [rooms, showAllRooms]);
  const hiddenDirectBadgesBySpace = useMemo(
    () => getHiddenDirectBadgesBySpace(directRooms, parentSpaceIdsByChild),
    [directRooms, parentSpaceIdsByChild],
  );

  useEffect(() => {
    if (!activeSpaceId) return;
    const parentsToOpen: Record<string, boolean> = {};
    const seen = new Set<string>();
    const stack = [...(parentSpaceIdsByChild.get(activeSpaceId) ?? [])];
    while (stack.length > 0) {
      const parentId = stack.pop();
      if (!parentId || seen.has(parentId)) continue;
      seen.add(parentId);
      parentsToOpen[parentId] = true;
      stack.push(...(parentSpaceIdsByChild.get(parentId) ?? []));
    }
    if (Object.keys(parentsToOpen).length === 0) return;
    setOpenFolders((prev) => ({ ...prev, ...parentsToOpen }));
  }, [activeSpaceId, parentSpaceIdsByChild]);

  function spaceBadge(spaceId: string) {
    const raw = badge?.spaces[spaceId];
    const hidden = hiddenDirectBadgesBySpace.get(spaceId);
    return {
      unread: Math.max(0, (raw?.total_unread ?? 0) - (hidden?.unread ?? 0)),
      highlight: Math.max(0, (raw?.total_highlight ?? 0) - (hidden?.highlight ?? 0)),
    };
  }

  function renderSpaceEntry(
    space: RoomSummary,
    topLevel: boolean,
    parentId: string | null,
    ancestorIds = new Set<string>(),
  ) {
    const nextAncestorIds = new Set(ancestorIds);
    nextAncestorIds.add(space.room_id);
    const children = childSpacesByParent.get(space.room_id) ?? [];
    const visibleChildren = children.filter((child) => !nextAncestorIds.has(child.room_id));
    const folderOpen = openFolders[space.room_id] ?? false;
    const counts = spaceBadge(space.room_id);
    const label = displayName(space.room_id, space.name);
    const pinned = topLevel && !unpinnedIds.has(space.room_id);
    const pinnedIndex = topLevel
      ? pinnedTopLevelSpaces.findIndex((s) => s.room_id === space.room_id)
      : -1;
    const entryTrigger = (
      <div className="relative flex h-11 w-14 items-center justify-center">
        {visibleChildren.length > 0 && (
          <button
            type="button"
            aria-label={`${folderOpen ? "Collapse" : "Expand"} ${label}`}
            className="absolute left-0 flex size-4 items-center justify-center rounded-sm text-muted-foreground hover:bg-accent hover:text-foreground"
            onClick={() => setOpenFolders((prev) => ({ ...prev, [space.room_id]: !folderOpen }))}
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
          unread={counts.unread}
          highlight={counts.highlight}
          onClick={() => onSelectSpace(space.room_id)}
        />
      </div>
    );
    return (
      <div key={space.room_id} className="flex flex-col items-center gap-1">
        {managementEnabled ? (
          <ContextMenu>
            <ContextMenuTrigger asChild>{entryTrigger}</ContextMenuTrigger>
            <ContextMenuContent>
              <ContextMenuItem onSelect={() => onSelectSpace(space.room_id)}>
                <LogIn aria-hidden="true" />
                Open lobby
              </ContextMenuItem>
              <ContextMenuItem
                onSelect={() => setInviteTarget({ spaceId: space.room_id, name: label })}
              >
                <UserPlus aria-hidden="true" />
                Invite
              </ContextMenuItem>
              {topLevel && (
                <>
                  <ContextMenuSeparator />
                  <ContextMenuItem onSelect={() => setPinned(space.room_id, !pinned)}>
                    {pinned ? <PinOff aria-hidden="true" /> : <Pin aria-hidden="true" />}
                    {pinned ? "Unpin from sidebar" : "Pin to sidebar"}
                  </ContextMenuItem>
                  {pinned && (
                    <>
                      <ContextMenuItem
                        disabled={pinnedIndex <= 0}
                        onSelect={() => moveSpace(space.room_id, "up")}
                      >
                        Move up
                      </ContextMenuItem>
                      <ContextMenuItem
                        disabled={
                          pinnedIndex === -1 || pinnedIndex >= pinnedTopLevelSpaces.length - 1
                        }
                        onSelect={() => moveSpace(space.room_id, "down")}
                      >
                        Move down
                      </ContextMenuItem>
                    </>
                  )}
                </>
              )}
              <ContextMenuSeparator />
              <ContextMenuItem
                onSelect={() => setAddExistingTarget({ spaceId: space.room_id, name: label })}
              >
                <FolderPlus aria-hidden="true" />
                Add existing…
              </ContextMenuItem>
              {parentId && (
                <>
                  <ContextMenuItem
                    onSelect={() =>
                      setSpaceChildSuggested(parentId, space.room_id, true).catch(reportActionError)
                    }
                  >
                    <Star aria-hidden="true" />
                    Mark as suggested
                  </ContextMenuItem>
                  <ContextMenuItem
                    onSelect={() =>
                      setSpaceChildSuggested(parentId, space.room_id, false).catch(
                        reportActionError,
                      )
                    }
                  >
                    <StarOff aria-hidden="true" />
                    Unmark as suggested
                  </ContextMenuItem>
                  <ContextMenuItem
                    onSelect={() =>
                      removeSpaceChild(parentId, space.room_id).catch(reportActionError)
                    }
                  >
                    <DoorOpen aria-hidden="true" />
                    Remove from space
                  </ContextMenuItem>
                </>
              )}
              <ContextMenuSeparator />
              <ContextMenuItem
                variant="destructive"
                onSelect={() => setLeaveTarget({ spaceId: space.room_id, name: label })}
              >
                <LogOut aria-hidden="true" />
                Leave
              </ContextMenuItem>
            </ContextMenuContent>
          </ContextMenu>
        ) : (
          entryTrigger
        )}
        {folderOpen && visibleChildren.length > 0 && (
          <div className="flex flex-col gap-1 rounded-md border border-border/60 p-1">
            {visibleChildren.map((child) =>
              renderSpaceEntry(child, false, space.room_id, nextAncestorIds),
            )}
          </div>
        )}
      </div>
    );
  }

  return (
    <TooltipProvider>
      {actionError && (
        <div
          role="alert"
          className="fixed bottom-3 left-3 z-50 max-w-xs rounded-md border border-destructive/50 bg-background px-3 py-2 text-sm text-destructive shadow-md"
        >
          {actionError}
        </div>
      )}
      <aside className="flex w-[72px] shrink-0 flex-col items-center border-r border-border bg-muted/25 py-3">
        <nav className="flex min-h-0 flex-1 flex-col items-center gap-2" aria-label="Spaces">
          <RailIconButton
            label="Home"
            active={activeMode === "home"}
            unread={homeBadge.unread}
            highlight={homeBadge.highlight}
            onClick={onSelectHome}
          >
            <Home aria-hidden="true" />
          </RailIconButton>
          <fieldset className="m-0 flex min-w-0 flex-col items-center gap-1 border-0 p-0">
            <legend className="sr-only">Direct messages</legend>
            <RailIconButton
              label="Direct messages"
              active={activeMode === "dms"}
              unread={directUnreadCount}
              highlight={directHighlightCount}
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
          <div className="flex min-h-0 flex-1 flex-col items-center gap-2 overflow-y-auto px-2 pt-1">
            {pinnedTopLevelSpaces.map((space) => renderSpaceEntry(space, true, null))}
            {unpinnedTopLevelSpaces.length > 0 && (
              <>
                <div className="my-1 h-px w-8 bg-border" />
                <div className="flex flex-col items-center gap-2 opacity-60">
                  {unpinnedTopLevelSpaces.map((space) => renderSpaceEntry(space, true, null))}
                </div>
              </>
            )}
          </div>
        </nav>
        <RailIconButton label="Create or join space" active={false} onClick={onCreateJoin}>
          <Plus aria-hidden="true" />
        </RailIconButton>
      </aside>
      <InviteToSpaceDialog
        spaceId={inviteTarget?.spaceId ?? null}
        spaceName={inviteTarget?.name ?? null}
        onOpenChange={(open) => {
          if (!open) setInviteTarget(null);
        }}
      />
      <LeaveSpaceDialog
        spaceId={leaveTarget?.spaceId ?? null}
        spaceName={leaveTarget?.name ?? null}
        onOpenChange={(open) => {
          if (!open) setLeaveTarget(null);
        }}
      />
      <AddExistingToSpaceDialog
        spaceId={addExistingTarget?.spaceId ?? null}
        spaceName={addExistingTarget?.name ?? null}
        rooms={rooms}
        excludedIds={
          addExistingTarget
            ? addExistingChildExclusions(addExistingTarget.spaceId, rooms, parentSpaceIdsByChild)
            : new Set()
        }
        onOpenChange={(open) => {
          if (!open) setAddExistingTarget(null);
        }}
      />
    </TooltipProvider>
  );
}

/** Rooms/spaces that can't be added as a child of `spaceId` without creating
 * a duplicate or a cycle: the space itself, its ancestors, and its current
 * direct children. */
function addExistingChildExclusions(
  spaceId: string,
  rooms: RoomSummary[],
  parentSpaceIdsByChild: Map<string, string[]>,
) {
  const excluded = new Set<string>([
    spaceId,
    ...collectAncestorSpaceIds(spaceId, parentSpaceIdsByChild),
  ]);
  for (const room of rooms) {
    if (room.parent_space_ids.includes(spaceId)) {
      excluded.add(room.room_id);
    }
  }
  return excluded;
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
            "relative flex size-11 items-center justify-center rounded-md border border-transparent bg-background transition-colors hover:border-border hover:bg-accent/70",
          )}
        >
          {/* Ring lives on the (rounded-full) avatar itself, not the
              (rounded-md) outer button — a ring on the button would render
              as a rounded-square around the whole tile instead of a circle
              around the avatar. The button keeps a neutral bg-background
              regardless of active state so a transparent avatar image can't
              pick up the rail's own bg-muted/25 showing through. */}
          <Avatar size="sm" className={cn(active && "ring-2 ring-primary")}>
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

function getHomeBadge(rooms: RoomSummary[], showAllRooms: boolean) {
  return rooms
    .filter(
      (room) =>
        !room.is_space &&
        !room.is_direct &&
        (showAllRooms || room.parent_space_ids.length === 0) &&
        room.has_unread,
    )
    .reduce(
      (counts, room) => ({
        unread: counts.unread + 1,
        highlight: counts.highlight + room.unread_count,
      }),
      { unread: 0, highlight: 0 },
    );
}

function getHiddenDirectBadgesBySpace(
  directRooms: RoomSummary[],
  parentSpaceIdsByChild: Map<string, string[]>,
) {
  const badges = new Map<string, { unread: number; highlight: number }>();
  for (const room of directRooms) {
    const parentIds = new Set(room.parent_space_ids);
    for (const parentId of room.parent_space_ids) {
      for (const ancestorId of collectAncestorSpaceIds(parentId, parentSpaceIdsByChild)) {
        parentIds.add(ancestorId);
      }
    }
    for (const spaceId of parentIds) {
      const current = badges.get(spaceId) ?? { unread: 0, highlight: 0 };
      badges.set(spaceId, {
        unread: current.unread + (room.has_unread ? 1 : 0),
        highlight: current.highlight + room.unread_count,
      });
    }
  }
  return badges;
}

function collectAncestorSpaceIds(spaceId: string, parentSpaceIdsByChild: Map<string, string[]>) {
  const ancestors: string[] = [];
  const visited = new Set<string>();
  const stack = [...(parentSpaceIdsByChild.get(spaceId) ?? [])];
  while (stack.length > 0) {
    const parentId = stack.pop();
    if (!parentId || visited.has(parentId)) continue;
    visited.add(parentId);
    ancestors.push(parentId);
    stack.push(...(parentSpaceIdsByChild.get(parentId) ?? []));
  }
  return ancestors;
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
