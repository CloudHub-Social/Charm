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
  Settings,
  Star,
  StarOff,
  UserPlus,
  Users,
} from "lucide-react";
import type { ReactNode } from "react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useDrag } from "@use-gesture/react";
import { useAtomValue } from "jotai";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { useFlag } from "@/featureFlags";
import { badgeAtom } from "@/features/shell/badgeAtom";
import {
  getRoomDetails,
  removeSpaceChild,
  setSpaceParent,
  setSpaceChildSuggested,
  type RoomPermissions,
  type RoomSummary,
} from "@/lib/matrix";
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
  onCreateUnderSpace?: (spaceId: string) => void;
  onOpenSettings?: (spaceId: string) => void;
  /** Called after "Add Existing" or "Remove from space" successfully edits a
   * space's children — lets a sibling `RoomList` showing that space's lobby
   * (a separately-fetched `/hierarchy` snapshot Matrix sync doesn't keep
   * current) refresh immediately. */
  onSpaceChildrenChanged?: () => void;
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
  onCreateUnderSpace,
  onOpenSettings,
  onSpaceChildrenChanged,
}: SpaceRailProps) {
  const managementEnabled = useFlag("space_rail_management");
  const hierarchyReorganizationEnabled = useFlag("space_hierarchy_reorganization");
  const contextMenuEnabled = managementEnabled || hierarchyReorganizationEnabled;
  const [openFolders, setOpenFolders] = useState<Record<string, boolean>>({});
  const [prefs, setPrefs] = useSpaceRailPrefsSync(currentUserId);
  const [inviteTarget, setInviteTarget] = useState<{ spaceId: string; name: string } | null>(null);
  const [leaveTarget, setLeaveTarget] = useState<{ spaceId: string; name: string } | null>(null);
  const [addExistingTarget, setAddExistingTarget] = useState<{
    spaceId: string;
    name: string;
  } | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [spaceDrop, setSpaceDrop] = useState<{
    sourceId: string;
    targetId: string | null;
    invalid: boolean;
  } | null>(null);
  const spaceDropRef = useRef<typeof spaceDrop>(null);
  const [spaceParentMutationPending, setSpaceParentMutationPending] = useState(false);
  const [moveTarget, setMoveTarget] = useState<{
    spaceId: string;
    name: string;
    parentId: string | null;
  } | null>(null);
  const railRef = useRef<HTMLElement | null>(null);
  const railScrollRef = useRef<HTMLDivElement | null>(null);
  const actionErrorTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    return () => {
      if (actionErrorTimeoutRef.current) clearTimeout(actionErrorTimeoutRef.current);
    };
  }, []);
  // Keyed by room_id. Fetched on every context-menu open (rather than for
  // every rail entry up front, and rather than cached for the component's
  // lifetime) — `RoomPermissions` isn't part of `RoomSummary`/the sync
  // loop's push updates, so a stale one-shot cache would keep showing a
  // demoted member's old (too-permissive) or a promoted member's old
  // (too-restrictive) gating until an unrelated remount. Re-fetching per
  // open keeps it current at the only point it's actually read. A failed
  // fetch is swallowed, not surfaced via `reportActionError` — the user
  // didn't take an action yet, and the gated items simply stay disabled.
  const [permissionsById, setPermissionsById] = useState<Record<string, RoomPermissions>>({});
  // Per-room request generation counter, not a plain "in flight" boolean —
  // closing and reopening the menu while the first request for the same
  // room is still pending must still issue a fresh request (the user's
  // power level could have changed in between), rather than letting that
  // first request's now-possibly-stale response populate the reopened
  // menu. Each call bumps the room's generation and only applies its own
  // response if it's still the latest generation by the time it resolves.
  const permissionsRequestGeneration = useRef<Map<string, number>>(new Map());
  function ensurePermissionsLoaded(roomId: string) {
    const generation = (permissionsRequestGeneration.current.get(roomId) ?? 0) + 1;
    permissionsRequestGeneration.current.set(roomId, generation);
    // Drop any previously fetched value for this room before the new
    // request lands, rather than leaving it visible mid-refetch — a stale
    // `true` from the prior open would otherwise stay clickable for the
    // gap between "menu reopened" and "fresh permissions arrived".
    setPermissionsById((prev) => {
      if (!(roomId in prev)) return prev;
      const { [roomId]: _stale, ...rest } = prev;
      return rest;
    });
    getRoomDetails(roomId)
      .then((details) => {
        if (permissionsRequestGeneration.current.get(roomId) !== generation) return;
        setPermissionsById((prev) => ({ ...prev, [roomId]: details.can }));
      })
      .catch(() => {
        if (permissionsRequestGeneration.current.get(roomId) !== generation) return;
        setPermissionsById((prev) => {
          const { [roomId]: _removed, ...rest } = prev;
          return rest;
        });
      });
  }
  function reportActionError(err: unknown) {
    setActionError(err instanceof Error ? err.message : String(err));
    if (actionErrorTimeoutRef.current) clearTimeout(actionErrorTimeoutRef.current);
    actionErrorTimeoutRef.current = setTimeout(() => setActionError(null), 5000);
  }
  const updateSpaceDrop = useCallback(
    (sourceId: string, clientX: number, clientY: number) => {
      const element = document.elementFromPoint(clientX, clientY);
      const targetId =
        element?.closest<HTMLElement>("[data-space-drop-id]")?.dataset.spaceDropId ?? null;
      const source = rooms.find((room) => room.room_id === sourceId);
      const insideRail = railRef.current?.contains(element) ?? false;
      const resolvedTarget = insideRail ? targetId : null;
      const invalid =
        resolvedTarget === sourceId ||
        (insideRail && resolvedTarget === null) ||
        (resolvedTarget !== null &&
          collectDescendantSpaceIds(sourceId, rooms).has(resolvedTarget)) ||
        (insideRail && resolvedTarget === null) ||
        (!insideRail && (source?.parent_space_ids.length ?? 0) === 0);
      const scrollBounds = railScrollRef.current?.getBoundingClientRect();
      const scrollContainer = railScrollRef.current;
      if (scrollBounds && typeof scrollContainer?.scrollBy === "function") {
        if (clientY < scrollBounds.top + 32) scrollContainer.scrollBy({ top: -16 });
        if (clientY > scrollBounds.bottom - 32) {
          scrollContainer.scrollBy({ top: 16 });
        }
      }
      const nextDrop = { sourceId, targetId: resolvedTarget, invalid };
      spaceDropRef.current = nextDrop;
      setSpaceDrop(nextDrop);
    },
    [rooms],
  );
  const mutateSpaceParent = useCallback(
    (sourceId: string, targetId: string | null) => {
      if (spaceParentMutationPending) return;
      // `RoomSummary.parent_space_ids` deliberately does not expose which
      // edge is canonical. Do not skip a drop merely because the target is
      // already one of the Matrix parents: the command may still need to
      // promote that noncanonical relationship to Charm's canonical parent.
      setSpaceParentMutationPending(true);
      setSpaceParent(sourceId, targetId ?? undefined)
        .catch(reportActionError)
        .finally(() => {
          setSpaceParentMutationPending(false);
          // The two Matrix state writes are not atomic. Always refetch after
          // success or failure so a partial server-side mutation is rendered
          // truthfully instead of leaving the pre-drag hierarchy on screen.
          onSpaceChildrenChanged?.();
        });
    },
    [onSpaceChildrenChanged, rooms, spaceParentMutationPending],
  );
  const finishSpaceDrop = useCallback(
    (sourceId: string) => {
      const drop = spaceDropRef.current;
      spaceDropRef.current = null;
      setSpaceDrop(null);
      if (!drop || drop.sourceId !== sourceId || drop.invalid) return;
      const source = rooms.find((room) => room.room_id === sourceId);
      if (drop.targetId === null && (source?.parent_space_ids.length ?? 0) === 0) return;
      mutateSpaceParent(sourceId, drop.targetId);
    },
    [mutateSpaceParent, rooms],
  );
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
    // Power-level gates (Spec 63 known gap): default to disabled until each
    // room's `RoomPermissions` has been fetched, rather than showing an
    // action that would just fail server-side for members without the
    // required power level. `Invite`/`Add existing…` are gated by this
    // space's own permissions; `Suggested`/`Remove` mutate the *parent's*
    // `m.space.child` edge, so they're gated by the parent's permissions.
    const ownPermissions = permissionsById[space.room_id];
    const parentPermissions = parentId ? permissionsById[parentId] : undefined;
    const canInvite = ownPermissions?.invite ?? false;
    const canEditOwnChildren = ownPermissions?.set_space_child ?? false;
    const canEditParentChildren = parentPermissions?.set_space_child ?? false;
    const entryTrigger = (
      <div className="relative flex h-11 w-14 items-center justify-center">
        {visibleChildren.length > 0 && (
          <button
            type="button"
            aria-label={`${folderOpen ? "Collapse" : "Expand"} ${label}`}
            className="absolute left-0 z-10 flex size-4 items-center justify-center rounded-sm text-muted-foreground hover:bg-accent hover:text-foreground"
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
          dragEnabled={hierarchyReorganizationEnabled && !spaceParentMutationPending}
          dropState={
            spaceDrop?.targetId === space.room_id
              ? spaceDrop.invalid
                ? "invalid"
                : "valid"
              : spaceDrop?.sourceId === space.room_id
                ? "source"
                : "idle"
          }
          onDragMove={updateSpaceDrop}
          onDragEnd={finishSpaceDrop}
        />
      </div>
    );
    return (
      <div key={space.room_id} className="flex flex-col items-center gap-1">
        {contextMenuEnabled ? (
          <ContextMenu
            onOpenChange={(open) => {
              if (!open) return;
              ensurePermissionsLoaded(space.room_id);
              if (parentId) ensurePermissionsLoaded(parentId);
            }}
          >
            <ContextMenuTrigger asChild>{entryTrigger}</ContextMenuTrigger>
            <ContextMenuContent>
              <ContextMenuItem onSelect={() => onSelectSpace(space.room_id)}>
                <LogIn aria-hidden="true" />
                Open lobby
              </ContextMenuItem>
              {managementEnabled && (
                <ContextMenuItem
                  disabled={!canInvite}
                  onSelect={() => setInviteTarget({ spaceId: space.room_id, name: label })}
                >
                  <UserPlus aria-hidden="true" />
                  Invite
                </ContextMenuItem>
              )}
              {managementEnabled && topLevel && (
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
              {managementEnabled && <ContextMenuSeparator />}
              {managementEnabled && (
                <ContextMenuItem
                  disabled={!canEditOwnChildren}
                  onSelect={() => setAddExistingTarget({ spaceId: space.room_id, name: label })}
                >
                  <FolderPlus aria-hidden="true" />
                  Add existing…
                </ContextMenuItem>
              )}
              {hierarchyReorganizationEnabled && onCreateUnderSpace && (
                <ContextMenuItem
                  disabled={!canEditOwnChildren}
                  onSelect={() => onCreateUnderSpace(space.room_id)}
                >
                  <Plus aria-hidden="true" />
                  Create subspace
                </ContextMenuItem>
              )}
              {hierarchyReorganizationEnabled && onOpenSettings && (
                <ContextMenuItem onSelect={() => onOpenSettings(space.room_id)}>
                  <Settings aria-hidden="true" />
                  Settings
                </ContextMenuItem>
              )}
              {hierarchyReorganizationEnabled && (
                <ContextMenuItem
                  disabled={spaceParentMutationPending}
                  onSelect={() =>
                    setMoveTarget({ spaceId: space.room_id, name: label, parentId })
                  }
                >
                  Move to space…
                </ContextMenuItem>
              )}
              {hierarchyReorganizationEnabled && parentId && (
                <ContextMenuItem
                  disabled={spaceParentMutationPending}
                  onSelect={() => mutateSpaceParent(space.room_id, null)}
                >
                  Move to top level
                </ContextMenuItem>
              )}
              {managementEnabled && parentId && (
                <>
                  <ContextMenuItem
                    disabled={!canEditParentChildren}
                    onSelect={() =>
                      setSpaceChildSuggested(parentId, space.room_id, true).catch(reportActionError)
                    }
                  >
                    <Star aria-hidden="true" />
                    Mark as suggested
                  </ContextMenuItem>
                  <ContextMenuItem
                    disabled={!canEditParentChildren}
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
                    disabled={!canEditParentChildren}
                    onSelect={() =>
                      removeSpaceChild(parentId, space.room_id)
                        .then(onSpaceChildrenChanged)
                        .catch(reportActionError)
                    }
                  >
                    <DoorOpen aria-hidden="true" />
                    Remove from space
                  </ContextMenuItem>
                </>
              )}
              {managementEnabled && (
                <>
                  <ContextMenuSeparator />
                  <ContextMenuItem
                    variant="destructive"
                    onSelect={() => setLeaveTarget({ spaceId: space.room_id, name: label })}
                  >
                    <LogOut aria-hidden="true" />
                    Leave
                  </ContextMenuItem>
                </>
              )}
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
      <aside
        ref={railRef}
        className="flex w-[72px] shrink-0 flex-col items-center border-r border-border bg-muted/25 py-3"
      >
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
          <div
            ref={railScrollRef}
            className="flex min-h-0 flex-1 flex-col items-center gap-2 overflow-y-auto px-2 pt-1"
          >
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
        onLeft={(spaceId) => {
          // The rail's own `activeSpaceId` prop won't update until the
          // parent re-renders with the left space gone from `rooms` — if
          // that was the space currently open, redirect out of it now
          // rather than leaving the room list stuck showing a space the
          // user no longer has access to.
          if (spaceId === activeSpaceId) onSelectHome();
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
        onAdded={onSpaceChildrenChanged}
      />
      <Dialog open={moveTarget !== null} onOpenChange={(open) => !open && setMoveTarget(null)}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>Move {moveTarget?.name}</DialogTitle>
            <DialogDescription>Choose a new parent space.</DialogDescription>
          </DialogHeader>
          <div className="flex max-h-72 flex-col gap-1 overflow-y-auto">
            {moveTarget &&
              rooms
                .filter(
                  (room) =>
                    room.is_space &&
                    room.room_id !== moveTarget.spaceId &&
                    !collectDescendantSpaceIds(moveTarget.spaceId, rooms).has(room.room_id),
                )
                .map((room) => (
                  <button
                    key={room.room_id}
                    type="button"
                    className="min-h-11 rounded-md px-3 text-left text-sm hover:bg-accent"
                    onClick={() => {
                      mutateSpaceParent(moveTarget.spaceId, room.room_id);
                      setMoveTarget(null);
                    }}
                  >
                    {displayName(room.room_id, room.name)}
                  </button>
                ))}
          </div>
        </DialogContent>
      </Dialog>
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
  dragEnabled: boolean;
  dropState: "idle" | "source" | "valid" | "invalid";
  onDragMove: (spaceId: string, clientX: number, clientY: number) => void;
  onDragEnd: (spaceId: string) => void;
}

function SpaceButton({
  space,
  active,
  unread,
  highlight,
  onClick,
  dragEnabled,
  dropState,
  onDragMove,
  onDragEnd,
}: SpaceButtonProps) {
  const label = displayName(space.room_id, space.name);
  const accessibleLabel = labelWithBadge(label, unread, highlight);
  const [dragging, setDragging] = useState(false);
  const [dragOffset, setDragOffset] = useState<[number, number]>([0, 0]);
  const draggedRef = useRef(false);
  const bind = useDrag(
    ({ down, first, last, movement, xy, event }) => {
      if (!dragEnabled) return;
      if ("pointerType" in event && event.pointerType && event.pointerType !== "mouse") return;
      if (first) draggedRef.current = false;
      if (down && (Math.abs(movement[0]) > 3 || Math.abs(movement[1]) > 3)) {
        draggedRef.current = true;
      }
      setDragging(down);
      setDragOffset(down ? [movement[0], movement[1]] : [0, 0]);
      if (down) onDragMove(space.room_id, xy[0], xy[1]);
      if (last && draggedRef.current) onDragEnd(space.room_id);
    },
    { filterTaps: true, enabled: dragEnabled },
  );
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          {...bind()}
          type="button"
          data-space-drop-id={space.room_id}
          aria-label={accessibleLabel}
          aria-current={active ? "page" : undefined}
          data-drop-invalid={dropState === "invalid" ? "true" : undefined}
          onClick={() => {
            if (!draggedRef.current) onClick();
            draggedRef.current = false;
          }}
          style={{
            transform: dragging ? `translate(${dragOffset[0]}px, ${dragOffset[1]}px)` : undefined,
            position: dragging ? "relative" : undefined,
            zIndex: dragging ? 20 : undefined,
            touchAction: dragEnabled ? "pan-y" : undefined,
            pointerEvents: dragging ? "none" : undefined,
          }}
          className={cn(
            "relative flex size-11 items-center justify-center rounded-md border border-transparent bg-background transition-colors hover:border-border hover:bg-accent/70",
            dropState === "valid" && "border-primary bg-accent ring-2 ring-primary/40",
            dropState === "invalid" && "border-destructive bg-destructive/10",
            dropState === "source" && "opacity-70",
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

function collectDescendantSpaceIds(spaceId: string, rooms: RoomSummary[]) {
  const childrenByParent = new Map<string, string[]>();
  for (const room of rooms) {
    if (!room.is_space) continue;
    for (const parentId of room.parent_space_ids) {
      childrenByParent.set(parentId, [...(childrenByParent.get(parentId) ?? []), room.room_id]);
    }
  }
  const descendants = new Set<string>();
  const stack = [...(childrenByParent.get(spaceId) ?? [])];
  while (stack.length > 0) {
    const next = stack.pop();
    if (!next || descendants.has(next)) continue;
    descendants.add(next);
    stack.push(...(childrenByParent.get(next) ?? []));
  }
  return descendants;
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
