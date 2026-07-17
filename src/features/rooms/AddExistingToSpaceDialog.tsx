import { useEffect, useMemo, useRef, useState } from "react";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { addExistingSpaceChild, type RoomSummary } from "@/lib/matrix";
import { avatarColor, displayName, initials, resolveAvatar } from "./roomDisplay";

interface AddExistingToSpaceDialogProps {
  spaceId: string | null;
  spaceName: string | null;
  rooms: RoomSummary[];
  /** Room/space ids that would form a cycle or duplicate if added — the
   * target space itself, its ancestors, and its current direct children. */
  excludedIds: Set<string>;
  onOpenChange: (open: boolean) => void;
  /** Called after a successful add — lets a space's open lobby (whose room
   * list is a separately-fetched `/hierarchy` snapshot, not something Matrix
   * sync keeps current) refresh immediately instead of only after the user
   * navigates away and back. */
  onAdded?: () => void;
}

/** Spec 63's "Add Existing" flow: file an already-joined room or space under
 * `spaceId`, as opposed to `CreateJoinSpaceDialog`'s create-new/join-by-address. */
export function AddExistingToSpaceDialog({
  spaceId,
  spaceName,
  rooms,
  excludedIds,
  onOpenChange,
  onAdded,
}: AddExistingToSpaceDialogProps) {
  const [query, setQuery] = useState("");
  const [pendingId, setPendingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Mirrors `spaceId` on every render so an in-flight `handleAdd` can tell,
  // once its request settles, whether the dialog has since been re-targeted
  // at a different space — closing/updating state for a stale target would
  // otherwise dismiss (or misreport an error for) whatever the dialog is
  // *now* showing.
  const latestSpaceIdRef = useRef(spaceId);
  latestSpaceIdRef.current = spaceId;

  // Guards against stale state if `spaceId` changes while the dialog stays
  // open — `handleClose`'s reset only runs on an open->closed transition.
  useEffect(() => {
    setQuery("");
    setPendingId(null);
    setError(null);
  }, [spaceId]);

  const candidates = useMemo(() => {
    const normalizedQuery = query.trim().toLowerCase();
    return rooms
      .filter(
        (room) => !room.is_direct && room.membership === "join" && !excludedIds.has(room.room_id),
      )
      .filter((room) =>
        displayName(room.room_id, room.name).toLowerCase().includes(normalizedQuery),
      )
      .toSorted((a, b) =>
        displayName(a.room_id, a.name).localeCompare(displayName(b.room_id, b.name)),
      );
  }, [rooms, excludedIds, query]);

  function handleClose(open: boolean) {
    // Ignore dismiss attempts (Escape, outside click, the close button)
    // while a request is in flight — closing here wouldn't cancel it, so
    // the user could back out while still about to add the room, and (were
    // this not guarded) a later re-target could get closed by the earlier
    // request's own completion instead.
    if (!open && pendingId !== null) return;
    if (!open) {
      setQuery("");
      setPendingId(null);
      setError(null);
    }
    onOpenChange(open);
  }

  async function handleAdd(childRoomId: string) {
    if (!spaceId) return;
    const requestSpaceId = spaceId;
    setError(null);
    setPendingId(childRoomId);
    try {
      await addExistingSpaceChild(requestSpaceId, childRoomId);
      // The dialog may have been re-targeted at a different space while this
      // request was in flight (only possible now that dismissal is blocked
      // while pending, but the parent could still swap `spaceId` directly) —
      // don't close/notify on behalf of a target that's no longer showing.
      if (latestSpaceIdRef.current !== requestSpaceId) return;
      onAdded?.();
      handleClose(false);
    } catch (err) {
      if (latestSpaceIdRef.current !== requestSpaceId) return;
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      if (latestSpaceIdRef.current === requestSpaceId) setPendingId(null);
    }
  }

  return (
    <Dialog open={spaceId !== null} onOpenChange={handleClose}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Add existing room or space to {spaceName ?? "space"}</DialogTitle>
        </DialogHeader>
        <Input
          placeholder="Search your rooms and spaces"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        {error && (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        )}
        <div className="flex max-h-72 flex-col gap-1 overflow-y-auto">
          {candidates.length === 0 && (
            <p className="px-1 py-2 text-sm text-muted-foreground">No matching rooms or spaces.</p>
          )}
          {candidates.map((room) => (
            <button
              key={room.room_id}
              type="button"
              disabled={pendingId !== null}
              onClick={() => handleAdd(room.room_id)}
              className="flex items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm hover:bg-accent disabled:opacity-50"
            >
              <Avatar size="sm">
                <AvatarImage src={resolveAvatar(room.avatar_path, room.avatar_url)} alt="" />
                <AvatarFallback
                  style={{ background: avatarColor(room.room_id) }}
                  className="text-[10px] font-bold text-white"
                >
                  {initials(room.room_id, room.name)}
                </AvatarFallback>
              </Avatar>
              <span className="min-w-0 flex-1 truncate">
                {displayName(room.room_id, room.name)}
              </span>
              {room.is_space && (
                <span className="shrink-0 text-xs text-muted-foreground">Space</span>
              )}
            </button>
          ))}
        </div>
      </DialogContent>
    </Dialog>
  );
}
