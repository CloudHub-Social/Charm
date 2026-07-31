import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import {
  listManageableSpaceChildren,
  onRoomDetailsUpdate,
  removeSpaceChild,
  type RoomSummary,
  type SpaceChild,
} from "@/lib/matrix";
import { AddExistingToSpaceDialog } from "@/features/rooms/AddExistingToSpaceDialog";

interface SpaceChildrenSettingsProps {
  spaceId: string;
  spaceName: string | null;
  rooms: RoomSummary[];
  canEdit: boolean;
  onChanged?: () => void;
}

function queryKey(spaceId: string) {
  return ["space-settings-children", spaceId] as const;
}

export function SpaceChildrenSettings({
  spaceId,
  spaceName,
  rooms,
  canEdit,
  onChanged,
}: SpaceChildrenSettingsProps) {
  const queryClient = useQueryClient();
  const optimisticAddedIdsRef = useRef(new Set<string>());
  const optimisticRemovedIdsRef = useRef(new Set<string>());
  const [addOpen, setAddOpen] = useState(false);
  const [pendingId, setPendingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const {
    data: children = [],
    isLoading,
    isError,
    isFetching,
  } = useQuery({
    queryKey: queryKey(spaceId),
    queryFn: async () => {
      const fetched = await listManageableSpaceChildren(spaceId);
      const fetchedIds = new Set(fetched.map((child) => child.room_id));
      for (const childId of optimisticAddedIdsRef.current) {
        if (fetchedIds.has(childId)) optimisticAddedIdsRef.current.delete(childId);
      }
      for (const childId of optimisticRemovedIdsRef.current) {
        if (!fetchedIds.has(childId)) optimisticRemovedIdsRef.current.delete(childId);
      }
      const cached = queryClient.getQueryData<SpaceChild[]>(queryKey(spaceId)) ?? [];
      return [
        ...fetched.filter((child) => !optimisticRemovedIdsRef.current.has(child.room_id)),
        ...cached.filter(
          (child) =>
            optimisticAddedIdsRef.current.has(child.room_id) && !fetchedIds.has(child.room_id),
        ),
      ];
    },
    refetchOnMount: "always",
  });
  const excludedIds = useMemo(
    () => childCandidateExclusions(spaceId, rooms, children),
    [children, rooms, spaceId],
  );

  async function refresh() {
    await queryClient.invalidateQueries({ queryKey: queryKey(spaceId) });
  }

  useEffect(() => {
    // Sync emits this for joined-room state changes, including
    // m.space.child. That is the authoritative point to replace optimistic
    // additions with the server-confirmed hierarchy snapshot.
    const unlisten = onRoomDetailsUpdate((details) => {
      if (details.room_id === spaceId) {
        void queryClient.invalidateQueries({ queryKey: queryKey(spaceId) });
        onChanged?.();
      }
    });
    return () => {
      void unlisten.then((stop) => stop());
    };
  }, [onChanged, queryClient, spaceId]);

  useEffect(() => {
    if (!canEdit) setAddOpen(false);
  }, [canEdit]);

  async function remove(child: SpaceChild) {
    setError(null);
    setPendingId(child.room_id);
    try {
      await removeSpaceChild(spaceId, child.room_id);
      optimisticRemovedIdsRef.current.add(child.room_id);
      queryClient.setQueryData<SpaceChild[]>(queryKey(spaceId), (current = []) =>
        current.filter((candidate) => candidate.room_id !== child.room_id),
      );
    } catch (err) {
      optimisticRemovedIdsRef.current.delete(child.room_id);
      setError(err instanceof Error ? err.message : String(err));
      await refresh().catch(() => {});
    } finally {
      onChanged?.();
      setPendingId(null);
    }
  }

  return (
    <div className="flex max-w-lg flex-col gap-4 p-4">
      <div className="flex items-center justify-between gap-3">
        <div>
          <h3 className="text-sm font-semibold text-foreground">Child rooms and spaces</h3>
          <p className="text-xs text-muted-foreground">
            Manage the rooms and subspaces published by this space.
          </p>
        </div>
        <Button
          size="sm"
          disabled={!canEdit || pendingId !== null || isFetching || isError}
          onClick={() => setAddOpen(true)}
        >
          Add existing
        </Button>
      </div>

      {!canEdit && (
        <p className="text-sm text-muted-foreground">
          You need a higher power level to change this space's children.
        </p>
      )}
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
      {isLoading && <p className="text-sm text-muted-foreground">Loading children…</p>}
      {isError && <p className="text-sm text-destructive">Couldn't load space children.</p>}
      {!isLoading && !isError && children.length === 0 && (
        <p className="text-sm text-muted-foreground">This space has no published children.</p>
      )}
      <div className="flex flex-col divide-y divide-border rounded-md border border-border">
        {children.map((child) => (
          <div key={child.room_id} className="flex items-center gap-3 px-3 py-2">
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm font-medium">{child.name ?? child.room_id}</p>
              <p className="truncate text-xs text-muted-foreground">
                {child.is_space ? "Space" : "Room"}
                {child.topic ? ` · ${child.topic}` : ""}
              </p>
            </div>
            <Button
              aria-label={`Remove ${child.name ?? child.room_id} from space`}
              size="sm"
              variant="outline"
              disabled={!canEdit || pendingId !== null || isFetching}
              onClick={() => remove(child)}
            >
              {pendingId === child.room_id ? "Removing…" : "Remove"}
            </Button>
          </div>
        ))}
      </div>

      <AddExistingToSpaceDialog
        spaceId={addOpen ? spaceId : null}
        spaceName={spaceName}
        rooms={rooms}
        excludedIds={excludedIds}
        onOpenChange={setAddOpen}
        onAdded={(childRoomId) => {
          optimisticAddedIdsRef.current.add(childRoomId);
          const room = rooms.find((candidate) => candidate.room_id === childRoomId);
          queryClient.setQueryData<SpaceChild[]>(queryKey(spaceId), (current = []) => [
            ...current.filter((candidate) => candidate.room_id !== childRoomId),
            {
              room_id: childRoomId,
              name: room?.name ?? null,
              topic: null,
              num_joined_members: 0,
              join_rule: "other",
              is_space: room?.is_space ?? false,
            },
          ]);
        }}
        onSettled={(outcome, targetSpaceId) => {
          if (targetSpaceId !== spaceId) return;
          // Preserve a successful optimistic add until sync confirms it.
          // Failures are ambiguous writes, so reconcile those immediately.
          if (outcome === "failure") void refresh();
          else onChanged?.();
        }}
      />
    </div>
  );
}

function childCandidateExclusions(
  spaceId: string,
  rooms: RoomSummary[],
  children: SpaceChild[],
): Set<string> {
  const parentsByChild = new Map(rooms.map((room) => [room.room_id, room.parent_space_ids]));
  const ancestors = new Set<string>();
  const stack = [...(parentsByChild.get(spaceId) ?? [])];
  while (stack.length > 0) {
    const parentId = stack.pop();
    if (!parentId || ancestors.has(parentId)) continue;
    ancestors.add(parentId);
    stack.push(...(parentsByChild.get(parentId) ?? []));
  }
  return new Set([spaceId, ...ancestors, ...children.map((child) => child.room_id)]);
}
