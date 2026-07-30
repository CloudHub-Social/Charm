import { useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import {
  listSpaceChildren,
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
}

function queryKey(spaceId: string) {
  return ["space-settings-children", spaceId] as const;
}

export function SpaceChildrenSettings({
  spaceId,
  spaceName,
  rooms,
  canEdit,
}: SpaceChildrenSettingsProps) {
  const queryClient = useQueryClient();
  const [addOpen, setAddOpen] = useState(false);
  const [pendingId, setPendingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const {
    data: children = [],
    isLoading,
    isError,
  } = useQuery({
    queryKey: queryKey(spaceId),
    queryFn: () => listSpaceChildren(spaceId),
  });
  const excludedIds = useMemo(
    () => childCandidateExclusions(spaceId, rooms, children),
    [children, rooms, spaceId],
  );

  async function refresh() {
    await queryClient.invalidateQueries({ queryKey: queryKey(spaceId) });
  }

  async function remove(child: SpaceChild) {
    setError(null);
    setPendingId(child.room_id);
    try {
      await removeSpaceChild(spaceId, child.room_id);
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
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
          disabled={!canEdit || pendingId !== null}
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
              size="sm"
              variant="outline"
              disabled={!canEdit || pendingId !== null}
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
        onAdded={() => void refresh()}
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
